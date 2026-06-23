import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';
import { searchMarketsByKeywords, upsertMarket } from '../market/marketRepository';
import { resolveMarket, resolveMarketById } from '../market/marketResolver';
import { fetchGammaMarketById } from '../market/polymarketGammaClient';
import { runPolicyEngine, type AccountState, type UsageState, type MarketState } from '../policy/policyEngine';
import { simulateTrade, createSimulatorState } from '../simulator/paperTradingSimulator';
import { buildNormalizedOrder } from '../clob/orderBuilder';
import { ClobTradingClientImpl } from '../clob/clobTradingClient';
import { parseTradeIntentFromJSON } from '../parser/tradeIntentParser';
import { writeAudit } from '../db/auditRepository';
import { resolveLlmApiKey } from '../utils/llmKeyStore';
import type { StoredPolicy } from '../types/policy';

const chatSimStates = new Map<string, ReturnType<typeof createSimulatorState>>();

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const CHAT_MODEL = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5';
const MAX_TOOL_ROUNDS = 5;

export interface ExecutedToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
}

type UserMessage = { role: 'user' | 'assistant'; content: string };

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_markets',
      description: 'Search for prediction markets by topic or keyword. Returns matching markets with current YES/NO prices.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search topic, e.g. "Bitcoin", "US election", "World Cup winner"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_portfolio',
      description: 'Get the current portfolio: budget remaining, open positions, and recent orders.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_trade',
      description: 'Place a trade. Only call this when the user has explicitly confirmed the exact market. If search returns multiple markets, ask the user which one they mean BEFORE calling this tool.',
      parameters: {
        type: 'object',
        properties: {
          marketQuery: { type: 'string', description: 'Exact full market title from search results — copy it verbatim' },
          outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Which outcome token to trade' },
          side: { type: 'string', enum: ['BUY', 'SELL'], description: 'BUY or SELL' },
          maxSpendUSDC: { type: 'number', description: 'Max USDC to spend. Required for BUY orders.' },
          maxFraction: { type: 'number', description: 'For SELL only: fraction of current position to sell (1.0 = sell all, 0.5 = sell half). Use this instead of maxSpendUSDC for sells.' },
          limitPrice: { type: 'number', description: 'Limit price 0.01–0.99; omit to use current market price' },
          rationale: { type: 'string', description: 'Brief reason for the trade' },
          confidence: { type: 'number', description: 'Confidence 0–1 (e.g. 0.8 = 80%)' },
        },
        required: ['marketQuery', 'outcome', 'side', 'rationale', 'confidence'],
      },
    },
  },
];

function buildSystemPrompt(policy: StoredPolicy, accountState: AccountState, liveMode: boolean): string {
  const t = policy.policyJson.trading;
  const expiresAt = new Date(policy.policyJson.expiresAt).toLocaleDateString();
  return `You are a helpful prediction market trading assistant for the Polymarket Agent demo.

You can:
- Search for markets and explain what they mean
- Check the user's current portfolio and positions
- Place paper trades (no real money) when the user asks you to

Agent policy (signed by user, enforced deterministically):
- Budget remaining: $${accountState.budgetRemainingUSDC.toFixed(2)} of $${t.maxBudgetUSDC.toFixed(2)} total
- Max order size: $${t.maxOrderSizeUSDC.toFixed(2)} USDC per trade
- Max daily spend: $${t.maxDailySpendUSDC.toFixed(2)} USDC
- Policy expires: ${expiresAt}

Mode: ${liveMode ? 'LIVE trading — trades submit real orders to Polymarket with real money.' : 'Paper trading — trades are simulated, no real money.'}
Safety: Every trade you place is validated by a deterministic policy engine. You cannot bypass it.

How search works:
- search_markets returns candidates by keyword matching. YOU are responsible for semantic selection — read the titles and descriptions and pick the one that best fits what the user asked for.
- If the right market is clear from the results, confirm it with the user ("I found: [title]. Is this the one?").
- If no good match exists, tell the user directly.
- Never call search_markets more than once per user message.

Before calling place_trade you MUST have confirmed ALL of:
1. The exact market (show the user the title and get confirmation)
2. The outcome (YES or NO)
3. The amount — for BUY: ask "How much would you like to spend?" if not specified; for SELL: use maxFraction (1.0 = all, 0.5 = half)

When calling place_trade: set marketQuery to the EXACT full market title from search results. Do NOT invent or guess a marketId — omit it entirely.
For SELL trades: set maxFraction, never maxSpendUSDC.

CRITICAL: Never tell the user a trade was placed unless the place_trade tool was called and returned success. If you did not call the tool, do not claim you did.`;
}

async function toolSearchMarkets(args: { query: string }) {
  const db = getDb();
  const rawQuery = args.query.trim();

  // Split into meaningful keywords (length > 1, skip common stopwords)
  const STOPS = new Set(['in', 'on', 'at', 'to', 'of', 'or', 'an', 'is', 'be', 'do', 'it', 'vs', 'by', 'if', 'as']);
  const keywords = rawQuery.split(/\s+/).filter(w => w.length > 1 && !STOPS.has(w.toLowerCase()));

  if (keywords.length === 0) {
    // No useful keywords — return top active markets
    const top = db.prepare(`SELECT market_id, title, description, liquidity_usdc, category FROM markets WHERE status='active' ORDER BY liquidity_usdc DESC LIMIT 8`).all() as Array<{ market_id: string; title: string; description: string; liquidity_usdc: number; category: string }>;
    return { found: top.length, markets: top.map(r => ({ id: r.market_id, title: r.title, description: r.description?.slice(0, 120) ?? '', liquidity: Math.round(r.liquidity_usdc), category: r.category })) };
  }

  // Score each market by how many keywords appear (as substrings) in title or description.
  // Return all markets that match at least ONE keyword, sorted by match count then liquidity.
  const scoreParts = keywords.map(() => `(CASE WHEN instr(lower(title), ?) > 0 OR instr(lower(description), ?) > 0 THEN 1 ELSE 0 END)`).join(' + ');
  const filterParts = keywords.map(() => `(instr(lower(title), ?) > 0 OR instr(lower(description), ?) > 0)`).join(' OR ');
  const scoreParams = keywords.flatMap(k => [k.toLowerCase(), k.toLowerCase()]);
  const filterParams = keywords.flatMap(k => [k.toLowerCase(), k.toLowerCase()]);

  const rows = (db.prepare(`
    SELECT market_id, title, description, liquidity_usdc, category,
           (${scoreParts}) AS kw_score
    FROM markets
    WHERE status = 'active' AND (${filterParts})
    ORDER BY kw_score DESC, liquidity_usdc DESC
    LIMIT 10
  `).all(...scoreParams, ...filterParams)) as Array<{ market_id: string; title: string; description: string; liquidity_usdc: number; category: string; kw_score: number }>;

  if (rows.length === 0) {
    return { found: 0, markets: [], note: `No active markets found matching "${rawQuery}". The market may not exist yet.` };
  }

  // Sibling expansion: if any result is a "X vs. Y" draw market with a date,
  // also pull in "Will X win on DATE?" and "Will Y win on DATE?" markets so both
  // sides of a matchup are visible even though they don't mention the opponent.
  const merged = [...rows];
  const seenIds = new Set(rows.map(r => r.market_id));
  const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
  const VS_RE = /Will (.+?) vs\.\s*(.+?) end/i;
  for (const r of rows) {
    const dateM = r.title.match(DATE_RE);
    const vsM = r.title.match(VS_RE);
    if (!dateM || !vsM) continue;
    const [, team1, team2] = vsM;
    const date = dateM[1];
    const siblings = (db.prepare(`
      SELECT market_id, title, description, liquidity_usdc, category, 0 AS kw_score
      FROM markets
      WHERE status = 'active' AND title LIKE ?
        AND (instr(lower(title), ?) > 0 OR instr(lower(title), ?) > 0)
      LIMIT 4
    `).all(`%${date}%`, team1.toLowerCase(), team2.toLowerCase())) as Array<{ market_id: string; title: string; description: string; liquidity_usdc: number; category: string; kw_score: number }>;
    for (const s of siblings) {
      if (!seenIds.has(s.market_id)) { merged.push(s); seenIds.add(s.market_id); }
    }
  }

  return {
    found: merged.length,
    markets: merged.map(r => ({
      id: r.market_id,
      title: r.title,
      description: r.description?.slice(0, 120) ?? '',
      liquidity: Math.round(r.liquidity_usdc),
      category: r.category,
    })),
  };
}

async function toolGetPortfolio(agentWalletId: string, policy: StoredPolicy): Promise<unknown> {
  const db = getDb();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  // Refresh live fills from the CLOB so positions reflect executed trades (no-op for paper).
  if (process.env.ENABLE_LIVE_TRADING === 'true') {
    try { await new ClobTradingClientImpl().reconcileLiveFills(agentWalletId); }
    catch (err) { logger.warn({ agentWalletId, err }, 'portfolio fill reconcile failed'); }
  }

  const totalSpent = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE -(f.price*f.size) END),0) as total
    FROM fills f JOIN orders o ON o.id=f.order_id WHERE o.agent_wallet_id=?
  `).get(agentWalletId) as { total: number }).total;

  const dailySpend = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE -(f.price*f.size) END),0) as total
    FROM fills f JOIN orders o ON o.id=f.order_id WHERE o.agent_wallet_id=? AND f.created_at>=?
  `).get(agentWalletId, todayMs) as { total: number }).total;

  const positions = db.prepare(`
    SELECT COALESCE(m.title, o.market_id) as market_title,
      COALESCE(mt.outcome,'') as outcome,
      SUM(CASE WHEN o.side='BUY' THEN f.size ELSE -f.size END) as net_shares,
      COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE 0 END),0) as buy_cost
    FROM fills f JOIN orders o ON o.id=f.order_id
    LEFT JOIN markets m ON m.market_id=o.market_id
    LEFT JOIN market_tokens mt ON mt.token_id=o.token_id
    WHERE o.agent_wallet_id=? GROUP BY o.market_id, o.token_id HAVING net_shares>0.001
    ORDER BY buy_cost DESC LIMIT 10
  `).all(agentWalletId) as Array<{ market_title: string; outcome: string; net_shares: number; buy_cost: number }>;

  const t = policy.policyJson.trading;
  return {
    budgetRemainingUSDC: Math.max(0, t.maxBudgetUSDC - totalSpent).toFixed(2),
    dailySpendUSDC: dailySpend.toFixed(2),
    dailyLimitUSDC: t.maxDailySpendUSDC.toFixed(2),
    openPositions: positions.map(p => ({
      market: p.market_title,
      outcome: p.outcome,
      shares: p.net_shares.toFixed(2),
      costBasis: p.buy_cost.toFixed(2),
    })),
  };
}

async function toolPlaceTrade(
  args: { marketQuery: string; marketId?: string; outcome: 'YES' | 'NO'; side: 'BUY' | 'SELL'; maxSpendUSDC?: number; maxFraction?: number; limitPrice?: number; rationale?: string; confidence?: number },
  policy: StoredPolicy,
  agentWalletId: string
): Promise<unknown> {
  logger.info({ agentWalletId, args }, 'place_trade invoked');
  // Enforce required amounts before doing any DB work
  if (args.side === 'BUY' && !args.maxSpendUSDC) {
    logger.info({ agentWalletId }, 'place_trade: missing BUY amount');
    return { success: false, needsAmount: true, error: 'Amount not specified. Ask the user how much USDC they want to spend before placing this trade.' };
  }
  if (args.side === 'SELL' && !args.maxFraction && !args.maxSpendUSDC) {
    logger.info({ agentWalletId }, 'place_trade: missing SELL quantity');
    return { success: false, needsAmount: true, error: 'Sell quantity not specified. Use maxFraction (1.0 = sell all, 0.5 = sell half).' };
  }

  // Resolve market — prefer exact ID lookup, then exact title match, then fuzzy search
  let resolveResult;
  if (args.marketId) {
    resolveResult = await resolveMarketById(args.marketId);
  } else {
    // Try exact title match first (avoids ambiguity when LLM echoes back the full title)
    const db2 = getDb();
    const exactRow = db2.prepare(
      "SELECT market_id FROM markets WHERE lower(title) = lower(?) AND status = 'active'"
    ).get(args.marketQuery) as { market_id: string } | undefined;
    if (exactRow) {
      resolveResult = await resolveMarketById(exactRow.market_id);
    } else {
      resolveResult = await resolveMarket(args.marketQuery);
    }
  }

  if (resolveResult.candidates.length === 0) {
    logger.info({ agentWalletId, marketQuery: args.marketQuery, marketId: args.marketId }, 'place_trade: market not found');
    return { success: false, error: resolveResult.refusalReason ?? 'Market not found' };
  }

  // If multiple candidates and no exact marketId, ask user to clarify
  if (resolveResult.candidates.length > 1 && resolveResult.ambiguous) {
    logger.info({ agentWalletId, marketQuery: args.marketQuery, candidates: resolveResult.candidates.length }, 'place_trade: ambiguous market');
    return {
      success: false,
      ambiguous: true,
      message: 'Multiple markets matched. Ask the user which one they mean.',
      candidates: resolveResult.candidates.slice(0, 5).map(c => ({ id: c.marketId, title: c.title })),
    };
  }

  let resolvedMarket = resolveResult.candidates[0];

  // Refresh market data on-demand if stale — avoids blocking trades on markets
  // that aren't in the high-volume ingestion pass.
  const DATA_AGE_MS = Date.now() - resolvedMarket.dataUpdatedAt.getTime();
  if (DATA_AGE_MS > 60_000) { // older than 1 minute → refresh before policy check
    try {
      const fresh = await fetchGammaMarketById(resolvedMarket.marketId);
      if (fresh) {
        upsertMarket(fresh);
        const refreshed = await resolveMarketById(resolvedMarket.marketId);
        if (refreshed.candidates.length > 0) resolvedMarket = refreshed.candidates[0];
      }
    } catch (err) {
      logger.warn({ marketId: resolvedMarket.marketId, err }, 'On-demand market refresh failed — using cached data');
    }
  }

  // Use live market price if limitPrice not specified.
  // Guard against 0/null from stale orderbook data — nullish coalescing won't catch 0.
  const rawAsk = resolvedMarket.bestAsk;
  const rawBid = resolvedMarket.bestBid;
  const livePrice = args.side === 'BUY'
    ? (rawAsk && rawAsk >= 0.01 ? rawAsk : 0.5)
    : (rawBid && rawBid >= 0.01 ? rawBid : 0.5);
  // Clamp to schema-valid range [0.01, 0.99] regardless of input
  const limitPrice = Math.max(0.01, Math.min(0.99, args.limitPrice ?? livePrice));

  const parseResult = parseTradeIntentFromJSON({
    action: 'trade',
    side: args.side,
    outcome: args.outcome,
    marketQuery: resolvedMarket.title,
    marketId: resolvedMarket.marketId,
    maxSpendUSDC: args.maxSpendUSDC,
    maxFraction: args.maxFraction,
    limitPrice,
    orderType: 'GTC',
    rationale: args.rationale ?? 'Placed via agent chat',
    confidence: args.confidence ?? 0.5,
  });

  if (!parseResult.success || !parseResult.intent) {
    return { success: false, error: parseResult.errorMessage };
  }

  const intent = parseResult.intent;
  // Override price with live market price regardless of what was parsed
  intent.limitPrice = limitPrice;

  // Resolve maxFraction → actual share count so the policy engine can evaluate the order
  if (intent.maxFraction !== undefined && !intent.size) {
    const db0 = getDb();
    const tokenId0 = intent.outcome === 'YES' ? resolvedMarket.yesTokenId : resolvedMarket.noTokenId;
    const posRow = db0.prepare(`
      SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.size ELSE -f.size END), 0) AS net_shares
      FROM fills f JOIN orders o ON o.id = f.order_id
      WHERE o.agent_wallet_id = ? AND o.market_id = ? AND o.token_id = ?
    `).get(agentWalletId, resolvedMarket.marketId, tokenId0) as { net_shares: number };
    if (posRow.net_shares <= 0) {
      return { success: false, error: `No ${intent.outcome} shares held in "${resolvedMarket.title}"` };
    }
    intent.size = Math.round(posRow.net_shares * intent.maxFraction * 100) / 100;
  }

  const db = getDb();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const totalSpent = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE -(f.price*f.size) END),0) as total
    FROM fills f JOIN orders o ON o.id=f.order_id WHERE o.agent_wallet_id=?
  `).get(agentWalletId) as { total: number }).total;

  const dailySpend = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE -(f.price*f.size) END),0) as total
    FROM fills f JOIN orders o ON o.id=f.order_id WHERE o.agent_wallet_id=? AND f.created_at>=?
  `).get(agentWalletId, todayMs) as { total: number }).total;

  const openOrderCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM orders WHERE agent_wallet_id=? AND status IN ('open','pending','partially_filled')
  `).get(agentWalletId) as { cnt: number }).cnt;

  const accountState: AccountState = {
    budgetRemainingUSDC: policy.policyJson.trading.maxBudgetUSDC - totalSpent,
    dailySpendUSDC: dailySpend,
    openOrderCount,
    positionSizeByMarket: {},
  };

  const hourAgo = Date.now() - 3_600_000;
  const llmReqs = (db.prepare('SELECT COUNT(*) as cnt FROM llm_usage WHERE policy_id=? AND created_at>=?').get(policy.id, hourAgo) as { cnt: number }).cnt;
  const llmSpend = (db.prepare('SELECT COALESCE(SUM(actual_cost_usdc),0) as total FROM llm_usage WHERE policy_id=? AND created_at>=?').get(policy.id, todayMs) as { total: number }).total;

  const usageState: UsageState = {
    llmRequestsLastHour: llmReqs,
    llmSpendTodayUSDC: llmSpend,
    policyActive: policy.status === 'active',
    policyExpired: policy.expiresAt.getTime() < Date.now(),
    sessionKeyRevoked: policy.status === 'revoked',
    intentNonceUsed: false,
  };

  const tokenId = args.outcome === 'YES' ? resolvedMarket.yesTokenId : resolvedMarket.noTokenId;
  const spreadBps = resolvedMarket.bestBid != null && resolvedMarket.bestAsk != null
    ? Math.round((resolvedMarket.bestAsk - resolvedMarket.bestBid) / resolvedMarket.bestAsk * 10_000) : 50;

  const marketState: MarketState = {
    marketId: resolvedMarket.marketId,
    tokenId,
    spreadBps,
    bestBid: resolvedMarket.bestBid,
    bestAsk: resolvedMarket.bestAsk,
    liquidityUsdc: resolvedMarket.liquidityUsdc,
    dataAgeMs: Date.now() - resolvedMarket.dataUpdatedAt.getTime(),
    isActive: resolvedMarket.status === 'active',
  };

  const policyDecision = runPolicyEngine({ intent, policy: policy.policyJson, resolvedMarket, accountState, usageState, marketState });
  if (!policyDecision.allowed) {
    logger.info({ agentWalletId, reasons: policyDecision.reasons, market: resolvedMarket.title }, 'place_trade: policy denied');
    return { success: false, policyDenied: true, reasons: policyDecision.reasons, market: resolvedMarket.title };
  }

  const tradeIntentId = uuidv4();

  // Insert trade_intents row first — orders table FK requires it
  db.prepare(`
    INSERT INTO trade_intents (id, user_id, agent_wallet_id, policy_id, session_key_address, raw_input, structured_intent_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    tradeIntentId, policy.userId, agentWalletId, policy.id,
    policy.sessionKeyAddress,
    `chat: ${args.side} ${args.outcome} ${args.marketQuery}`,
    JSON.stringify(intent),
    Date.now(),
  );

  const agentRow = db.prepare('SELECT paper_mode FROM agent_wallets WHERE id = ?').get(agentWalletId) as { paper_mode: number } | undefined;
  const liveEnabled = process.env.ENABLE_LIVE_TRADING === 'true' && agentRow?.paper_mode === 0;

  if (!liveEnabled) {
    // Paper trading path
    if (!chatSimStates.has(agentWalletId)) {
      chatSimStates.set(agentWalletId, createSimulatorState(agentWalletId, policy.policyJson.trading.maxBudgetUSDC));
    }
    const simState = chatSimStates.get(agentWalletId)!;
    const marketPrice = args.side === 'BUY' ? (resolvedMarket.bestAsk ?? intent.limitPrice) : (resolvedMarket.bestBid ?? intent.limitPrice);

    const simResult = simulateTrade(simState, {
      intent, resolvedMarket, marketPrice,
      agentWalletId, userId: policy.userId, policyId: policy.id, tradeIntentId,
    });
    Object.assign(simState, simResult.newState);

    writeAudit({
      userId: policy.userId, agentWalletId, policyId: policy.id,
      actorType: 'agent', actorId: 'chat',
      action: 'order.submitted',
      details: { orderId: simResult.orderId, market: resolvedMarket.title, outcome: args.outcome, side: args.side, mode: 'paper', source: 'chat' },
    });

    return {
      success: true, mode: 'paper',
      market: resolvedMarket.title, side: args.side, outcome: args.outcome,
      fillPrice: simResult.fillPrice, fillSize: simResult.fillSize, partialFill: simResult.partialFill,
      orderId: simResult.orderId,
    };
  }

  // Live trading path
  const maxLive = parseFloat(process.env.MAX_GLOBAL_LIVE_ORDER_USDC ?? '1');
  const orderValueUsdc = intent.maxSpendUSDC ?? (intent.size ? intent.size * intent.limitPrice : 0);
  if (orderValueUsdc > maxLive) {
    return { success: false, error: `Order value $${orderValueUsdc.toFixed(2)} exceeds the live cap ($${maxLive}). Lower the amount.` };
  }

  const buildResult = buildNormalizedOrder(intent, resolvedMarket, agentWalletId, tradeIntentId);
  if (!buildResult.success || !buildResult.order) {
    return { success: false, error: `Order build failed: ${buildResult.errorMessage}` };
  }
  const order = buildResult.order;

  // Persist the order row up front so it (and its eventual fills) are tracked. The live path
  // previously never inserted into `orders`, so live fills/positions were invisible to the portfolio.
  const orderId = uuidv4();
  const nowMs = Date.now();
  db.prepare(`
    INSERT INTO orders (id, trade_intent_id, agent_wallet_id, market_id, token_id, side, price, size, order_type, expiration, idempotency_key, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    orderId, tradeIntentId, agentWalletId,
    order.marketId, order.tokenId, order.side, order.price, order.size, order.orderType,
    order.expirationTimestamp ?? null, order.idempotencyKey, nowMs, nowMs,
  );

  const clobClient = new ClobTradingClientImpl();
  let signedOrder: unknown;
  try {
    signedOrder = await clobClient.createSignedOrder(agentWalletId, order);
  } catch (err) {
    db.prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), orderId);
    const msg = err instanceof Error ? err.message : 'Sign failed';
    return { success: false, error: `Failed to sign order: ${msg}` };
  }

  const postResult = await clobClient.postOrder(agentWalletId, signedOrder, order.orderType);

  if (postResult.clobOrderId) {
    db.prepare(`UPDATE orders SET clob_order_id = ?, status = 'open', updated_at = ? WHERE id = ?`)
      .run(postResult.clobOrderId, Date.now(), orderId);
    // Record any immediate fill so the portfolio reflects the executed trade.
    try { await clobClient.reconcileLiveFills(agentWalletId); }
    catch (err) { logger.warn({ agentWalletId, err }, 'post-trade fill reconcile failed'); }
  } else {
    db.prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), orderId);
  }

  writeAudit({
    userId: policy.userId, agentWalletId, policyId: policy.id,
    actorType: 'agent', actorId: 'chat',
    action: postResult.success ? 'order.submitted' : 'order.failed',
    details: { tradeIntentId, clobOrderId: postResult.clobOrderId, market: resolvedMarket.title, outcome: args.outcome, side: args.side, mode: 'live', source: 'chat' },
  });

  if (!postResult.success) {
    return { success: false, error: `CLOB submission failed: ${postResult.errorMessage}` };
  }

  return {
    success: true, mode: 'live',
    market: resolvedMarket.title, side: args.side, outcome: args.outcome,
    clobOrderId: postResult.clobOrderId,
    limitPrice: intent.limitPrice,
    orderValue: orderValueUsdc,
  };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  policy: StoredPolicy,
  agentWalletId: string
): Promise<unknown> {
  switch (name) {
    case 'search_markets':
      return toolSearchMarkets(args as { query: string });
    case 'get_portfolio':
      return toolGetPortfolio(agentWalletId, policy);
    case 'place_trade':
      return toolPlaceTrade(
        args as { marketQuery: string; outcome: 'YES' | 'NO'; side: 'BUY' | 'SELL'; maxSpendUSDC?: number; limitPrice?: number },
        policy,
        agentWalletId
      );
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export async function runAgentChat(
  userMessages: UserMessage[],
  policy: StoredPolicy,
  agentWalletId: string
): Promise<{ response: string; toolCalls: ExecutedToolCall[] }> {
  const apiKey = resolveLlmApiKey(agentWalletId);
  if (!apiKey) {
    return { response: "No OpenRouter API key is configured for this agent. Add your key in Agent Setup → OpenRouter API Key.", toolCalls: [] };
  }

  const db = getDb();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const totalSpent = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE -(f.price*f.size) END),0) as total
    FROM fills f JOIN orders o ON o.id=f.order_id WHERE o.agent_wallet_id=?
  `).get(agentWalletId) as { total: number }).total;

  const accountState: AccountState = {
    budgetRemainingUSDC: policy.policyJson.trading.maxBudgetUSDC - totalSpent,
    dailySpendUSDC: 0,
    openOrderCount: 0,
    positionSizeByMarket: {},
  };

  const agentRow = db.prepare('SELECT paper_mode FROM agent_wallets WHERE id = ?').get(agentWalletId) as { paper_mode: number } | undefined;
  const liveMode = process.env.ENABLE_LIVE_TRADING === 'true' && agentRow?.paper_mode === 0;

  const client = new OpenAI({ baseURL: OPENROUTER_BASE, apiKey });
  const systemPrompt = buildSystemPrompt(policy, accountState, liveMode);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...userMessages,
  ];

  const allToolCalls: ExecutedToolCall[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.5,
      max_tokens: 1500,
    });

    const choice = response.choices[0];
    if (!choice) break;

    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      logger.info({ agentWalletId, round, toolsCalledThisTurn: allToolCalls.map(t => t.name) }, 'chat turn finished without (further) tool calls');
      return { response: msg.content ?? '', toolCalls: allToolCalls };
    }
    logger.info({ agentWalletId, round, tools: msg.tool_calls.map(t => t.function.name) }, 'chat LLM requested tool calls');

    // Execute all tool calls in this round
    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* empty args */ }

      let result: unknown;
      let error: string | undefined;
      try {
        result = await executeTool(tc.function.name, args, policy, agentWalletId);
      } catch (err) {
        error = err instanceof Error ? err.message : 'Tool execution failed';
        result = { error };
        logger.error({ tool: tc.function.name, err }, 'Chat tool execution error');
      }

      allToolCalls.push({ name: tc.function.name, args, result, error });
      toolResults.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }

    messages.push(...toolResults);
  }

  return { response: 'I ran into an issue processing your request. Please try again.', toolCalls: allToolCalls };
}

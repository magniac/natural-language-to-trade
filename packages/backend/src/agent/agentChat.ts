import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';
import { searchMarketsByKeywords, upsertMarket } from '../market/marketRepository';
import { resolveMarket, resolveMarketById } from '../market/marketResolver';
import { fetchGammaMarketById } from '../market/polymarketGammaClient';
import { runPolicyEngine, runHyperliquidPolicy, runHyperliquidLeveragePolicy, type AccountState, type UsageState, type MarketState } from '../policy/policyEngine';
import { HyperliquidClient } from '../clob/hyperliquidClient';
import { hasHlCreds } from '../utils/hyperliquidKeyStore';
import { simulateTrade, createSimulatorState } from '../simulator/paperTradingSimulator';
import { buildNormalizedOrder } from '../clob/orderBuilder';
import { ClobTradingClientImpl } from '../clob/clobTradingClient';
import { selectTradeLimitPrice } from '../clob/marketPricing';
import { localStatusFromClobPost, recordImmediateMatchedFill, repairMatchedFillsForAgent } from '../clob/fillAccounting';
import { parseTradeIntentFromJSON } from '../parser/tradeIntentParser';
import { writeAudit } from '../db/auditRepository';
import { resolveLlmApiKey } from '../utils/llmKeyStore';
import type { StoredPolicy } from '../types/policy';

const chatSimStates = new Map<string, ReturnType<typeof createSimulatorState>>();

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const CHAT_MODEL = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.6';
const MAX_TOOL_ROUNDS = 5;

// Matches text that asserts a trade was actually completed (not offers/questions like
// "shall I place the trade?"). Used to catch the model claiming success without calling place_trade.
const CLAIMS_TRADE_DONE = /\b(i'?(?:ve| have)?\s*(?:just\s+)?(?:placed|made|executed|submitted|bought|sold|purchased)\b|(?:trade|order|buy|sell|purchase)\s+(?:is|was|has been|been)\s+(?:now\s+|successfully\s+)?(?:placed|submitted|executed|filled|completed?|live|done|confirmed)|successfully\s+(?:placed|bought|sold|executed|submitted)|(?:placed|submitted|filled|confirmed)\s+(?:your|the|a)\s+(?:order|trade|buy|sell)|order\s+(?:placed|submitted|filled|confirmed|complete))\b/i;
// Negated / not-yet statements that should NOT be treated as a completion claim.
const TRADE_NEGATED = /\b(no\s+(?:trade|order)|not\s+(?:yet\s+)?(?:placed|submitted|executed|been)|have\s?n'?t|has\s?n'?t|did\s?n'?t|wo\s?n'?t|was\s?n'?t|is\s?n'?t|never\s+placed|nothing\s+(?:was|has been)|yet\s+to\s+be|hasn't\s+been)\b/i;

export interface ExecutedToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
}

/** Produce a safe, deterministic reply when the model goes silent after using a tool. */
export function buildToolFallbackResponse(toolCalls: ExecutedToolCall[]): string | null {
  const last = toolCalls[toolCalls.length - 1];
  if (!last) return null;

  const result = last.result as Record<string, unknown> | undefined;
  if (last.name === 'place_trade') {
    if (result?.success === true) {
      return 'The trade was submitted successfully. See the order details below.';
    }
    if (result?.policyDenied === true) {
      const reasons = Array.isArray(result.reasons) ? result.reasons.map(String).join('; ') : '';
      return `I couldn't place the trade because the policy engine denied it${reasons ? `: ${reasons}` : '.'}`;
    }
    if (result?.ambiguous === true) {
      return 'I found multiple matching markets. Please choose one from the options below.';
    }
    const error = typeof result?.error === 'string' ? result.error : last.error;
    return `I couldn't place the trade${error ? `: ${error}` : '.'}`;
  }

  if (last.name === 'search_markets') {
    const found = typeof result?.found === 'number' ? result.found : null;
    return found === null
      ? 'I searched the available markets. See the results below.'
      : `I found ${found} matching market${found === 1 ? '' : 's'}. See the results below.`;
  }

  if (last.name === 'search_hyperliquid_markets') {
    const found = typeof result?.found === 'number' ? result.found : null;
    return found === null
      ? 'I searched Hyperliquid markets. See the results below.'
      : `I found ${found} matching Hyperliquid market${found === 1 ? '' : 's'}. See the results below.`;
  }

  if (last.name === 'set_hyperliquid_leverage') {
    if (result?.success === true) {
      return 'The Hyperliquid leverage setting was updated successfully. See the details below.';
    }
    if (result?.policyDenied === true) {
      const reasons = Array.isArray(result.reasons) ? result.reasons.map(String).join('; ') : '';
      return `I couldn't update leverage because the policy engine denied it${reasons ? `: ${reasons}` : '.'}`;
    }
    const error = typeof result?.error === 'string' ? result.error : last.error;
    return `I couldn't update Hyperliquid leverage${error ? `: ${error}` : '.'}`;
  }

  if (last.name === 'get_portfolio') {
    return 'I checked your portfolio. See the current details below.';
  }

  return 'I completed the requested action. See the details below.';
}

export type UserMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Keep persisted browser history valid and bounded for model providers that
 * require alternating user/assistant turns. Empty bubbles are discarded,
 * adjacent same-role turns are merged, and only the most recent context is sent.
 */
export function normalizeChatHistory(userMessages: UserMessage[], maxMessages = 20): UserMessage[] {
  const merged: UserMessage[] = [];
  for (const message of userMessages) {
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content || (message.role !== 'user' && message.role !== 'assistant')) continue;

    const previous = merged[merged.length - 1];
    if (previous?.role === message.role) {
      previous.content = `${previous.content}\n\n${content}`;
    } else {
      merged.push({ role: message.role, content });
    }
  }

  const bounded = merged.slice(-maxMessages);
  while (bounded[0]?.role === 'assistant') bounded.shift();
  return bounded;
}

export function buildFalseTradeClaimResponse(text: string, toolCalls: ExecutedToolCall[]): string | null {
  const placedThisTurn = toolCalls.some(t => t.name === 'place_trade' && (t.result as { success?: boolean } | undefined)?.success === true);
  if (placedThisTurn || !CLAIMS_TRADE_DONE.test(text) || TRADE_NEGATED.test(text)) return null;

  const failedTradeCall = [...toolCalls].reverse().find(t => t.name === 'place_trade');
  if (failedTradeCall) {
    return buildToolFallbackResponse([failedTradeCall]) ?? 'No trade was placed. The trade tool did not return success.';
  }

  return 'No trade was placed. I did not get a successful trade submission for this turn, so I will not claim an order exists. Please confirm the exact market, outcome, and amount and I can submit it.';
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_markets',
      description: 'Search for prediction markets by topic or keyword. Returns up to 30 matching markets with current YES/NO prices.',
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
      name: 'search_hyperliquid_markets',
      description: 'Search Hyperliquid crypto markets by name/symbol. Use marketType="spot" for spot tokens and marketType="perp" for perpetual futures.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Token name or symbol, e.g. "HYPE"' },
          marketType: { type: 'string', enum: ['spot', 'perp', 'all'], description: 'Which Hyperliquid market set to search. Defaults to spot.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_portfolio',
      description: 'Get the current portfolio across both venues: budget remaining, Polymarket positions, Hyperliquid spot balances, perp margin/positions, and recent orders.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_hyperliquid_leverage',
      description: 'Set the leverage for a Hyperliquid perpetual futures coin. Only call after the user explicitly asks to adjust leverage or confirms the leverage, coin, and margin mode.',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Hyperliquid perp coin symbol, e.g. "BTC", "ETH", "HYPE"' },
          leverage: { type: 'number', description: 'Whole-number leverage, e.g. 1, 2, 5, 10.' },
          marginMode: { type: 'string', enum: ['cross', 'isolated'], description: 'Margin mode to set. Defaults to cross.' },
        },
        required: ['coin', 'leverage'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_trade',
      description: 'Place a trade on Polymarket (prediction markets) OR Hyperliquid (crypto spot/perps). Set venue accordingly. Only call after the user has explicitly confirmed the exact market/coin, side, market type, and amount.',
      parameters: {
        type: 'object',
        properties: {
          venue: { type: 'string', enum: ['polymarket', 'hyperliquid'], description: 'polymarket = prediction markets (YES/NO outcomes); hyperliquid = crypto spot/perps. Defaults to polymarket.' },
          // Polymarket fields
          marketQuery: { type: 'string', description: 'POLYMARKET: exact full market title from search results — copy it verbatim' },
          outcome: { type: 'string', enum: ['YES', 'NO'], description: 'POLYMARKET: which outcome token to trade' },
          limitPrice: { type: 'number', description: 'POLYMARKET: limit price 0.01–0.99; omit to use current market price' },
          // Hyperliquid fields
          coin: { type: 'string', description: 'HYPERLIQUID: token symbol to trade, e.g. "HYPE", "BTC", "ETH"' },
          marketType: { type: 'string', enum: ['spot', 'perp'], description: 'HYPERLIQUID: spot = token/USDC spot trade; perp = perpetual futures. Defaults to spot.' },
          reduceOnly: { type: 'boolean', description: 'HYPERLIQUID PERP only: true when closing/reducing an existing position without opening the opposite side.' },
          // Shared
          side: { type: 'string', enum: ['BUY', 'SELL'], description: 'BUY or SELL. For Hyperliquid perps, BUY opens/increases long or closes short; SELL opens/increases short or closes long.' },
          maxSpendUSDC: { type: 'number', description: 'Max USDC to spend/notional to trade. Required for BUY orders and for opening Hyperliquid perp longs/shorts.' },
          maxFraction: { type: 'number', description: 'Fraction of the current position to close/reduce (1.0 = all, 0.5 = half). For spot sells this sells token inventory; for perps this creates a reduce-only close order.' },
          rationale: { type: 'string', description: 'Brief reason for the trade' },
          confidence: { type: 'number', description: 'Confidence 0–1 (e.g. 0.8 = 80%)' },
        },
        required: ['side', 'rationale', 'confidence'],
      },
    },
  },
];

// How many markets search_markets returns to the model. Generous on purpose — the model sifts
// them for the best semantic match, and ~50 rows (title + short description) is well within context.
const MARKET_SEARCH_RESULT_LIMIT = 50;

// Shared spend accounting. Spot and Polymarket sells reduce exposure, but opening
// a perp short is still risk-increasing, so non-reduce-only perp fills count positive.
const NET_SPEND_EXPR = `
  CASE
    WHEN o.venue = 'hyperliquid-perp' THEN
      CASE WHEN json_extract(f.raw_json, '$.reduceOnly') = 1 THEN -(f.price * f.size) ELSE f.price * f.size END
    WHEN o.side = 'BUY' THEN f.price * f.size
    ELSE -(f.price * f.size)
  END
`;

function readNetSpendUsdc(db: ReturnType<typeof getDb>, agentWalletId: string, sinceMs?: number): number {
  const sinceClause = sinceMs === undefined ? '' : ' AND f.created_at >= ?';
  const params = sinceMs === undefined ? [agentWalletId] : [agentWalletId, sinceMs];
  return (db.prepare(`
    SELECT COALESCE(SUM(${NET_SPEND_EXPR}), 0) as total
    FROM fills f JOIN orders o ON o.id = f.order_id
    WHERE o.agent_wallet_id = ?${sinceClause}
  `).get(...params) as { total: number }).total;
}

function buildSystemPrompt(policy: StoredPolicy, accountState: AccountState, liveMode: boolean): string {
  const t = policy.policyJson.trading;
  const expiresAt = new Date(policy.policyJson.expiresAt).toLocaleDateString();
  const venues = policy.policyJson.allowedVenues ?? ['polymarket'];
  const hl = policy.policyJson.hyperliquid;
  const hlEnabled = venues.includes('hyperliquid') && !!hl;
  const hlMaxLeverage = hl?.maxLeverage ?? 1;
  return `You are a helpful trading assistant for an agent that trades on two venues: Polymarket (prediction markets) and Hyperliquid (crypto spot and perps).

You can:
- Search for markets/coins and explain what they mean
- Check the user's current portfolio and positions across both venues
- Place ${liveMode ? 'LIVE trades (real money)' : 'paper trades (simulated, no real money)'} when the user asks you to

Venues — pick the right one:
- POLYMARKET: prediction markets with YES/NO outcomes (elections, sports, events). Use search_markets, then place_trade with venue="polymarket", marketQuery, outcome (YES/NO).
- HYPERLIQUID SPOT: crypto tokens bought/sold with USDC (e.g. HYPE, PURR). Use search_hyperliquid_markets with marketType="spot", then place_trade with venue="hyperliquid", marketType="spot", coin, side, maxSpendUSDC for buys or maxFraction for sells.
- HYPERLIQUID PERPS: perpetual futures (e.g. BTC, ETH, HYPE perps). Use search_hyperliquid_markets with marketType="perp", then place_trade with venue="hyperliquid", marketType="perp", coin, side, maxSpendUSDC as notional for opening/increasing a position. BUY opens/increases a long; SELL opens/increases a short. To close/reduce, use maxFraction (1.0 = all, 0.5 = half); this submits a reduce-only order and does not flip the position. ${hlEnabled ? `Hyperliquid is mainnet/real-money and requires Live mode.${hl && hl.allowedCoins.length ? ` Allowed Hyperliquid coins: ${hl.allowedCoins.join(', ')}.` : ''}` : 'Hyperliquid is NOT enabled by this policy — tell the user Hyperliquid is not authorized; they must re-sign the policy enabling it.'}
- HYPERLIQUID LEVERAGE: only change perp leverage when the user explicitly asks or confirms. Use set_hyperliquid_leverage with coin, leverage, and marginMode. If the user asks for a leveraged perp trade, call set_hyperliquid_leverage first, then place_trade after the leverage tool succeeds.

Agent policy (signed by user, enforced deterministically):
- Budget remaining RIGHT NOW: $${accountState.budgetRemainingUSDC.toFixed(2)} of $${t.maxBudgetUSDC.toFixed(2)} total
- Spent so far TODAY: $${accountState.dailySpendUSDC.toFixed(2)} of $${t.maxDailySpendUSDC.toFixed(2)} daily cap
- Max order size: $${t.maxOrderSizeUSDC.toFixed(2)} USDC per trade
- Max Hyperliquid leverage: ${hlMaxLeverage}x
- Open orders: ${accountState.openOrderCount}
- Policy expires: ${expiresAt}

CRITICAL about budget: the figures above are the LIVE truth, recomputed from actual filled trades on every message. They change as orders fill, cancel, or get sold. NEVER refuse a trade based on a budget or "daily limit reached" number you saw EARLIER in this conversation — those are stale (e.g. open orders you later cancelled no longer count). Cancelled and unfilled orders do NOT consume budget. Use ONLY the numbers in this message, or call get_portfolio to refresh. If you are unsure whether budget allows a trade, just call place_trade — the policy engine checks limits authoritatively and will return policyDenied with the real reason if it actually exceeds a limit. Do not pre-emptively decline on your own.

Mode: ${liveMode ? 'LIVE trading — trades submit real orders to Polymarket with real money.' : 'Paper trading — trades are simulated, no real money.'}
Safety: Every trade you place is validated by a deterministic policy engine. You cannot bypass it.

How search works:
- search_markets returns candidates by keyword matching. YOU are responsible for semantic selection — read the titles and descriptions and pick the one that best fits what the user asked for.
- If the right market is clear from the results, confirm it with the user ("I found: [title]. Is this the one?").
- If no good match exists, tell the user directly.
- Never call search_markets more than once per user message.

Before calling place_trade you MUST have confirmed ALL of:
1. The exact market (show the user the title/coin and get confirmation)
2. For Polymarket, the outcome (YES or NO). For Hyperliquid, the market type and direction (spot buy/sell, perp long/short/close).
3. The amount — for BUY/spot or opening perps: ask "How much would you like to spend?" if not specified; for spot/perp close or reduce: use maxFraction (1.0 = all, 0.5 = half)

When calling place_trade: set marketQuery to the EXACT full market title from search results. Do NOT invent or guess a marketId — omit it entirely.
For Polymarket and Hyperliquid spot SELL trades: set maxFraction, never maxSpendUSDC. For Hyperliquid perp SELL, use maxSpendUSDC only when the user wants to open/increase a short; use maxFraction to close/reduce a long.

CRITICAL — how trades actually happen:
- A trade is placed ONLY by calling the place_trade tool. Writing a message is NOT placing a trade.
- The moment the user confirms the market, outcome, and amount, you MUST call place_trade in that SAME response. Do not reply "I've placed it" / "done" / "order submitted" as text without the tool call — that is a lie, because nothing happened.
- Only after place_trade returns success may you tell the user the trade was placed (quote the result).
- If place_trade returns success=false, say explicitly that no trade was placed and explain the returned error/reason.
- If you did not call place_trade, say explicitly that no trade has been placed yet.`;
}

async function toolSearchMarkets(args: { query: string }) {
  const db = getDb();
  const rawQuery = args.query.trim();

  // Split into meaningful keywords (length > 1, skip common stopwords)
  const STOPS = new Set(['in', 'on', 'at', 'to', 'of', 'or', 'an', 'is', 'be', 'do', 'it', 'vs', 'by', 'if', 'as']);
  const keywords = rawQuery.split(/\s+/).filter(w => w.length > 1 && !STOPS.has(w.toLowerCase()));

  if (keywords.length === 0) {
    // No useful keywords — return top active markets
    const top = db.prepare(`
      SELECT market_id, title, description, liquidity_usdc, category
      FROM markets
      WHERE status = 'active'
      ORDER BY liquidity_usdc DESC
      LIMIT ?
    `).all(MARKET_SEARCH_RESULT_LIMIT) as Array<{ market_id: string; title: string; description: string; liquidity_usdc: number; category: string }>;
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
    LIMIT ?
  `).all(...scoreParams, ...filterParams, MARKET_SEARCH_RESULT_LIMIT)) as Array<{ market_id: string; title: string; description: string; liquidity_usdc: number; category: string; kw_score: number }>;

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
  try { await new ClobTradingClientImpl().reconcileLiveFills(agentWalletId); }
  catch (err) { logger.warn({ agentWalletId, err }, 'portfolio fill reconcile failed'); }
  repairMatchedFillsForAgent(db, agentWalletId);

  const totalSpent = readNetSpendUsdc(db, agentWalletId);
  const dailySpend = readNetSpendUsdc(db, agentWalletId, todayMs);

  const positions = db.prepare(`
    SELECT COALESCE(m.title, o.market_id) as market_title,
      COALESCE(mt.outcome,'') as outcome,
      SUM(CASE WHEN o.side='BUY' THEN f.size ELSE -f.size END) as net_shares,
      COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE 0 END),0) as buy_cost
    FROM fills f JOIN orders o ON o.id=f.order_id
    LEFT JOIN markets m ON m.market_id=o.market_id
    LEFT JOIN market_tokens mt ON mt.token_id=o.token_id
    WHERE o.agent_wallet_id=? AND o.venue='polymarket' GROUP BY o.market_id, o.token_id HAVING net_shares>0.001
    ORDER BY buy_cost DESC LIMIT 10
  `).all(agentWalletId) as Array<{ market_title: string; outcome: string; net_shares: number; buy_cost: number }>;

  // Hyperliquid balances/positions (live, from the master account) when configured.
  let hyperliquid: {
    usdc: string;
    balances: { coin: string; total: string }[];
    perps: { accountValue: string; withdrawable: string; totalNtlPos: string; totalMarginUsed: string; positions: { coin: string; side: 'LONG' | 'SHORT'; size: string; value: string; entryPx: string; pnl: string; leverage: number; liquidationPx: string | null }[] } | null;
  } | null = null;
  if (hasHlCreds(agentWalletId)) {
    const hlClient = new HyperliquidClient();
    let spot: { usdc: number; balances: { coin: string; total: number }[] } | null = null;
    let perps: Awaited<ReturnType<HyperliquidClient['getPerpState']>> | null = null;
    try {
      const state = await hlClient.getSpotState(agentWalletId);
      spot = { usdc: state.usdc, balances: state.balances.filter(b => b.coin !== 'USDC') };
    } catch (err) {
      logger.warn({ agentWalletId, err }, 'portfolio: hyperliquid spot balance fetch failed');
    }
    try {
      perps = await hlClient.getPerpState(agentWalletId);
    } catch (err) {
      logger.warn({ agentWalletId, err }, 'portfolio: hyperliquid perp state fetch failed');
    }
    if (spot || perps) hyperliquid = {
      usdc: (spot?.usdc ?? 0).toFixed(2),
      balances: (spot?.balances ?? []).map(b => ({ coin: b.coin, total: String(b.total) })),
      perps: perps ? {
        accountValue: perps.accountValue.toFixed(2),
        withdrawable: perps.withdrawable.toFixed(2),
        totalNtlPos: perps.totalNtlPos.toFixed(2),
        totalMarginUsed: perps.totalMarginUsed.toFixed(2),
        positions: perps.positions.map(p => ({
          coin: p.coin,
          side: p.side,
          size: Math.abs(p.szi).toString(),
          value: p.positionValue.toFixed(2),
          entryPx: p.entryPx.toString(),
          pnl: p.unrealizedPnl.toFixed(2),
          leverage: p.leverage,
          liquidationPx: p.liquidationPx == null ? null : p.liquidationPx.toString(),
        })),
      } : null,
    };
  }

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
    hyperliquid,
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

  const tokenId = args.outcome === 'YES' ? resolvedMarket.yesTokenId : resolvedMarket.noTokenId;
  const db1 = getDb();
  const modeRow = db1.prepare('SELECT paper_mode FROM agent_wallets WHERE id = ?').get(agentWalletId) as { paper_mode: number } | undefined;
  const liveMode = modeRow?.paper_mode === 0;

  // Best market price for the side. Prefer the LIVE CLOB top-of-book (the cached gamma price is
  // often stale, which is why limit orders were resting unfilled). Fall back to cache on failure.
  const cachedPx = args.side === 'BUY' ? resolvedMarket.bestAsk : resolvedMarket.bestBid;
  let marketPx = cachedPx && cachedPx >= 0.01 ? cachedPx : null;
  if (liveMode && tokenId) {
    try {
      const live = await new ClobTradingClientImpl().getTopOfBookPrice(agentWalletId, tokenId, args.side);
      if (live && live >= 0.01) marketPx = live;
    } catch (err) {
      logger.warn({ agentWalletId, err }, 'live top-of-book fetch failed — using cached price');
    }
  }

  // Match Polymarket's default behavior: use the current executable quote exactly.
  // Do not add a crossing cushion or round using Gamma's cached 0.01 tick metadata;
  // markets can quote at finer increments (for example, an ask of 0.194).
  const limitPrice = selectTradeLimitPrice(args.limitPrice, marketPx);

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
  // Preserve the price selected above (explicit user limit or live top of book).
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

  const totalSpent = readNetSpendUsdc(db, agentWalletId);
  const dailySpend = readNetSpendUsdc(db, agentWalletId, todayMs);

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

  const spreadBps = resolvedMarket.bestBid != null && resolvedMarket.bestAsk != null
    ? Math.round((resolvedMarket.bestAsk - resolvedMarket.bestBid) / resolvedMarket.bestAsk * 10_000) : 50;

  const marketState: MarketState = {
    marketId: resolvedMarket.marketId,
    tokenId,
    spreadBps,
    bestBid: args.side === 'SELL' && marketPx != null ? marketPx : resolvedMarket.bestBid,
    bestAsk: args.side === 'BUY' && marketPx != null ? marketPx : resolvedMarket.bestAsk,
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

  const liveEnabled = liveMode;

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

  // Live trading path. Order size is bounded by the signed policy (already checked above).
  const orderValueUsdc = intent.maxSpendUSDC ?? (intent.size ? intent.size * intent.limitPrice : 0);

  const clobClient = new ClobTradingClientImpl();
  let liveTickSize: number;
  try {
    // This must happen before buildNormalizedOrder: Gamma stores 0.01 even for
    // markets whose live CLOB tick is 0.001, which previously changed 0.193 to 0.190.
    liveTickSize = await clobClient.getMarketTickSize(agentWalletId, tokenId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Tick-size fetch failed';
    return { success: false, error: `Could not verify the live market tick size: ${msg}` };
  }

  const buildResult = buildNormalizedOrder(intent, resolvedMarket, agentWalletId, tradeIntentId, liveTickSize);
  if (!buildResult.success || !buildResult.order) {
    return { success: false, error: `Order build failed: ${buildResult.errorMessage}` };
  }
  const order = buildResult.order;
  const actualOrderType = order.executionOrderType ?? order.orderType;
  if (args.limitPrice == null && Math.abs(order.price - intent.limitPrice) > 1e-9) {
    return {
      success: false,
      error: `Refusing to submit: live quote ${intent.limitPrice} changed to ${order.price} during order construction.`,
    };
  }

  // Persist the order row up front so it (and its eventual fills) are tracked. The live path
  // previously never inserted into `orders`, so live fills/positions were invisible to the portfolio.
  const orderId = uuidv4();
  const nowMs = Date.now();
  db.prepare(`
    INSERT INTO orders (id, trade_intent_id, agent_wallet_id, market_id, token_id, side, price, size, order_type, expiration, idempotency_key, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    orderId, tradeIntentId, agentWalletId,
    order.marketId, order.tokenId, order.side, order.price, order.size, actualOrderType,
    order.expirationTimestamp ?? null, order.idempotencyKey, nowMs, nowMs,
  );

  let signedOrder: unknown;
  try {
    signedOrder = await clobClient.createSignedOrder(agentWalletId, order);
  } catch (err) {
    db.prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), orderId);
    const msg = err instanceof Error ? err.message : 'Sign failed';
    return { success: false, error: `Failed to sign order: ${msg}` };
  }

  const postResult = await clobClient.postOrder(agentWalletId, signedOrder, actualOrderType);

  if (postResult.clobOrderId) {
    const localStatus = localStatusFromClobPost(postResult);
    db.prepare(`UPDATE orders SET clob_order_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(postResult.clobOrderId, localStatus, Date.now(), orderId);
    recordImmediateMatchedFill(db, orderId, order, postResult);
    // Record any immediate fill so the portfolio reflects the executed trade.
    if (localStatus !== 'filled') {
      try { await clobClient.reconcileLiveFills(agentWalletId); }
      catch (err) { logger.warn({ agentWalletId, err }, 'post-trade fill reconcile failed'); }
    }
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
    // Report the order that was actually persisted and submitted, not the pre-build intent.
    limitPrice: order.price,
    orderValue: order.amountUsdc ?? orderValueUsdc,
    status: postResult.clobStatus ?? null,
  };
}

async function toolSearchHyperliquid(args: { query: string; marketType?: 'spot' | 'perp' | 'all' }): Promise<unknown> {
  try {
    const marketType = args.marketType ?? 'spot';
    const client = new HyperliquidClient();
    const [spot, perps] = await Promise.all([
      marketType === 'perp' ? Promise.resolve([]) : client.searchSpotMarkets(args.query ?? ''),
      marketType === 'spot' ? Promise.resolve([]) : client.searchPerpMarkets(args.query ?? ''),
    ]);
    const markets = [
      ...spot.map(r => ({ title: `${r.coin}/USDC`, coin: r.coin, price: r.price, marketType: 'spot' as const })),
      ...perps.map(r => ({ title: `${r.coin} Perp`, coin: r.coin, price: r.price, marketType: 'perp' as const, maxLeverage: r.maxLeverage })),
    ];
    return {
      found: markets.length,
      venue: 'hyperliquid',
      marketType,
      markets,
    };
  } catch (err) {
    return { found: 0, markets: [], error: err instanceof Error ? err.message : 'Hyperliquid search failed' };
  }
}

async function toolSetHyperliquidLeverage(
  args: { coin?: string; leverage?: number; marginMode?: 'cross' | 'isolated' },
  policy: StoredPolicy,
  agentWalletId: string,
): Promise<unknown> {
  logger.info({ agentWalletId, args }, 'set_hyperliquid_leverage invoked');
  const coin = (args.coin ?? '').trim();
  if (!coin) return { success: false, error: 'No coin specified for the Hyperliquid leverage setting.' };

  const leverage = Number(args.leverage);
  if (!Number.isInteger(leverage) || leverage < 1) {
    return { success: false, error: 'Leverage must be a whole number greater than or equal to 1.' };
  }
  if (!hasHlCreds(agentWalletId)) {
    return { success: false, error: 'No Hyperliquid API wallet configured. Add it in Agent Setup → Hyperliquid.' };
  }

  const db = getDb();
  const liveMode = (db.prepare('SELECT paper_mode FROM agent_wallets WHERE id=?').get(agentWalletId) as { paper_mode: number } | undefined)?.paper_mode === 0;
  if (!liveMode) {
    return { success: false, error: 'Hyperliquid leverage changes affect mainnet settings. Switch the agent to Live mode to update leverage.' };
  }

  const usageState: UsageState = {
    llmRequestsLastHour: 0,
    llmSpendTodayUSDC: 0,
    policyActive: policy.status === 'active',
    policyExpired: policy.expiresAt.getTime() < Date.now(),
    sessionKeyRevoked: policy.status === 'revoked',
    intentNonceUsed: false,
  };

  const hlClient = new HyperliquidClient();
  const asset = await hlClient.getPerpAssetInfo(coin);
  if (!asset) return { success: false, error: `Unknown Hyperliquid perp coin: ${coin}` };

  const decision = runHyperliquidLeveragePolicy({
    policy: policy.policyJson,
    coin: asset.coin,
    leverage,
    exchangeMaxLeverage: asset.maxLeverage,
    usageState,
  });
  if (!decision.allowed) {
    logger.info({ agentWalletId, reasons: decision.reasons, coin: asset.coin, leverage }, 'set_hyperliquid_leverage: policy denied');
    return { success: false, policyDenied: true, reasons: decision.reasons, market: `${asset.coin}-PERP`, marketType: 'perp' };
  }

  const marginMode = args.marginMode === 'isolated' ? 'isolated' : 'cross';
  try {
    const result = await hlClient.updatePerpLeverage(agentWalletId, {
      coin: asset.coin,
      leverage,
      isCross: marginMode === 'cross',
    });
    writeAudit({
      userId: policy.userId,
      agentWalletId,
      policyId: policy.id,
      actorType: 'agent',
      actorId: 'chat',
      action: result.success ? 'hyperliquid.leverage.updated' : 'hyperliquid.leverage.failed',
      details: { venue: 'hyperliquid', marketType: 'perp', coin: result.coin, leverage, marginMode, source: 'chat', error: result.error },
    });
    if (!result.success) return { success: false, error: result.error ?? 'Hyperliquid leverage update failed', venue: 'hyperliquid', marketType: 'perp' };
    return { success: true, mode: 'live', venue: 'hyperliquid', marketType: 'perp', coin: result.coin, market: `${result.coin}-PERP`, leverage: result.leverage, marginMode, maxLeverage: result.maxLeverage };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Hyperliquid leverage update failed', venue: 'hyperliquid', marketType: 'perp' };
  }
}

async function toolPlaceHyperliquidTrade(
  args: { coin?: string; marketType?: 'spot' | 'perp'; side: 'BUY' | 'SELL'; maxSpendUSDC?: number; maxFraction?: number; reduceOnly?: boolean },
  policy: StoredPolicy,
  agentWalletId: string,
): Promise<unknown> {
  logger.info({ agentWalletId, args }, 'place_trade (hyperliquid) invoked');
  const coin = (args.coin ?? '').trim();
  const marketType = args.marketType === 'perp' ? 'perp' : 'spot';
  if (!coin) return { success: false, error: 'No coin specified for the Hyperliquid trade.' };
  if (marketType === 'spot' && args.side === 'BUY' && !args.maxSpendUSDC) {
    return { success: false, needsAmount: true, error: 'Amount not specified. Ask how much USDC to spend.' };
  }
  if (marketType === 'spot' && args.side === 'SELL' && !args.maxSpendUSDC && args.maxFraction === undefined) {
    return { success: false, needsAmount: true, error: 'Sell quantity not specified — use maxFraction (1.0 = sell all).' };
  }
  if (marketType === 'perp' && !args.maxSpendUSDC && args.maxFraction === undefined) {
    return { success: false, needsAmount: true, error: 'Perp amount not specified. Use maxSpendUSDC as notional for opening/increasing, or maxFraction for closing/reducing.' };
  }
  if (!hasHlCreds(agentWalletId)) {
    return { success: false, error: 'No Hyperliquid API wallet configured. Add it in Agent Setup → Hyperliquid.' };
  }

  const db = getDb();
  const today = new Date(); today.setHours(0, 0, 0, 0); const todayMs = today.getTime();
  const totalSpent = readNetSpendUsdc(db, agentWalletId);
  const dailySpend = readNetSpendUsdc(db, agentWalletId, todayMs);
  const openOrderCount = (db.prepare("SELECT COUNT(*) as c FROM orders WHERE agent_wallet_id=? AND status IN ('open','pending','partially_filled')").get(agentWalletId) as { c: number }).c;

  const accountState: AccountState = {
    budgetRemainingUSDC: policy.policyJson.trading.maxBudgetUSDC - totalSpent,
    dailySpendUSDC: dailySpend, openOrderCount, positionSizeByMarket: {},
  };
  const usageState: UsageState = {
    llmRequestsLastHour: 0, llmSpendTodayUSDC: 0,
    policyActive: policy.status === 'active',
    policyExpired: policy.expiresAt.getTime() < Date.now(),
    sessionKeyRevoked: policy.status === 'revoked',
    intentNonceUsed: false,
  };

  const hlClient = new HyperliquidClient();
  let orderValueUsdc = 0;
  let reduceOnly = args.reduceOnly === true;
  try {
    if (marketType === 'perp') {
      const preview = await hlClient.previewPerpOrder(agentWalletId, {
        coin,
        side: args.side,
        usdcAmount: args.maxSpendUSDC,
        fraction: args.maxFraction,
        reduceOnly: args.reduceOnly,
      });
      orderValueUsdc = preview.notionalUsdc;
      reduceOnly = preview.reduceOnly;
      if (!preview.reduceOnly && preview.availableMarginUsdc <= 0) {
        return { success: false, error: 'No Hyperliquid perp collateral is available. Deposit USDC to Hyperliquid before opening a perp position.', venue: 'hyperliquid', marketType };
      }
    } else {
      const preview = await hlClient.previewSpotOrder(agentWalletId, {
        coin,
        side: args.side,
        usdcAmount: args.maxSpendUSDC,
        fraction: args.maxFraction,
      });
      orderValueUsdc = preview.notionalUsdc;
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : `Could not size Hyperliquid ${marketType} order`,
      venue: 'hyperliquid',
      marketType,
    };
  }

  const decision = runHyperliquidPolicy({ policy: policy.policyJson, coin, side: args.side, orderValueUsdc, marketType, reduceOnly, accountState, usageState });
  if (!decision.allowed) {
    logger.info({ agentWalletId, reasons: decision.reasons }, 'place_trade (hyperliquid): policy denied');
    return { success: false, policyDenied: true, reasons: decision.reasons, market: `${coin} (Hyperliquid ${marketType})`, marketType };
  }

  // Hyperliquid trades are real mainnet orders — require Live mode.
  const liveMode = (db.prepare('SELECT paper_mode FROM agent_wallets WHERE id=?').get(agentWalletId) as { paper_mode: number } | undefined)?.paper_mode === 0;
  if (!liveMode) {
    return { success: false, error: 'Hyperliquid trades execute on mainnet with real funds. Switch the agent to Live mode to trade on Hyperliquid.' };
  }

  let result: Awaited<ReturnType<HyperliquidClient['placeSpotOrder']>> | Awaited<ReturnType<HyperliquidClient['placePerpOrder']>>;
  try {
    result = marketType === 'perp'
      ? await hlClient.placePerpOrder(agentWalletId, {
        coin, side: args.side, usdcAmount: args.maxSpendUSDC, fraction: args.maxFraction, reduceOnly: args.reduceOnly,
      })
      : await hlClient.placeSpotOrder(agentWalletId, {
        coin, side: args.side, usdcAmount: args.maxSpendUSDC, fraction: args.maxFraction,
      });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Hyperliquid order failed', venue: 'hyperliquid', marketType };
  }

  // Record into the shared intents/orders/fills tables, tagged by Hyperliquid market type.
  const tradeIntentId = uuidv4(); const orderId = uuidv4(); const now = Date.now();
  const dbVenue = marketType === 'perp' ? 'hyperliquid-perp' : 'hyperliquid';
  const marketId = marketType === 'perp' ? `${result.coin}-PERP` : result.pair;
  const tokenId = marketType === 'perp' ? `${result.coin}-PERP` : result.coin;
  const structuredIntent = { coin, side: args.side, marketType, usdcAmount: args.maxSpendUSDC, fraction: args.maxFraction, reduceOnly: marketType === 'perp' ? ('reduceOnly' in result ? result.reduceOnly : reduceOnly) : false };
  db.prepare("INSERT INTO trade_intents (id, user_id, agent_wallet_id, policy_id, session_key_address, raw_input, structured_intent_json, status, venue, created_at) VALUES (?,?,?,?,?,?,?,'executed',?,?)")
    .run(tradeIntentId, policy.userId, agentWalletId, policy.id, policy.sessionKeyAddress, `chat: ${args.side} ${coin} (HL ${marketType})`, JSON.stringify(structuredIntent), dbVenue, now);
  const status = result.success ? (result.filledSize > 0 ? 'filled' : 'open') : 'failed';
  db.prepare("INSERT INTO orders (id, trade_intent_id, agent_wallet_id, market_id, token_id, side, price, size, order_type, expiration, clob_order_id, idempotency_key, status, venue, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'IOC',NULL,?,?,?,?,?,?)")
    .run(orderId, tradeIntentId, agentWalletId, marketId, tokenId, args.side, result.price, result.size, result.oid != null ? String(result.oid) : null, `hl-${marketType}-${orderId}`, status, dbVenue, now, now);
  if (result.success && result.filledSize > 0) {
    db.prepare("INSERT INTO fills (id, order_id, clob_trade_id, price, size, side, fee, created_at, raw_json) VALUES (?,?,?,?,?,?,0,?,?)")
      .run(uuidv4(), orderId, `HL-${result.oid ?? orderId}`, result.avgPrice ?? result.price, result.filledSize, args.side, now, JSON.stringify({ ...result, marketType, reduceOnly: structuredIntent.reduceOnly }));
  }

  writeAudit({ userId: policy.userId, agentWalletId, policyId: policy.id, actorType: 'agent', actorId: 'chat', action: result.success ? 'order.submitted' : 'order.failed', details: { venue: 'hyperliquid', marketType, coin: result.coin, side: args.side, reduceOnly: structuredIntent.reduceOnly, oid: result.oid, filledSize: result.filledSize, mode: 'live', source: 'chat' } });

  if (!result.success) return { success: false, error: result.error ?? 'Hyperliquid order did not fill', venue: 'hyperliquid', marketType };
  return {
    success: true, mode: 'live', venue: 'hyperliquid', marketType,
    market: marketType === 'perp' ? `${result.coin}-PERP (Hyperliquid perp)` : `${result.coin}/USDC (Hyperliquid spot)`, side: args.side, coin: result.coin,
    fillPrice: result.avgPrice ?? result.price, fillSize: result.filledSize,
    price: result.price, size: result.size, oid: result.oid, resting: result.resting,
    reduceOnly: structuredIntent.reduceOnly,
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
    case 'search_hyperliquid_markets':
      return toolSearchHyperliquid(args as { query: string; marketType?: 'spot' | 'perp' | 'all' });
    case 'set_hyperliquid_leverage':
      return toolSetHyperliquidLeverage(args as { coin?: string; leverage?: number; marginMode?: 'cross' | 'isolated' }, policy, agentWalletId);
    case 'get_portfolio':
      return toolGetPortfolio(agentWalletId, policy);
    case 'place_trade':
      if ((args as { venue?: string }).venue === 'hyperliquid') {
        return toolPlaceHyperliquidTrade(
          args as { coin?: string; marketType?: 'spot' | 'perp'; side: 'BUY' | 'SELL'; maxSpendUSDC?: number; maxFraction?: number; reduceOnly?: boolean },
          policy,
          agentWalletId,
        );
      }
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
  const todayMs = today.getTime();
  repairMatchedFillsForAgent(db, agentWalletId);
  // Budget is computed live from actual fills — never from conversation history.
  // Only filled orders count; open/cancelled/failed orders do not.
  const totalSpent = readNetSpendUsdc(db, agentWalletId);
  const dailySpent = readNetSpendUsdc(db, agentWalletId, todayMs);
  const openOrderCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM orders WHERE agent_wallet_id=? AND status IN ('open','pending','partially_filled')"
  ).get(agentWalletId) as { cnt: number }).cnt;

  const accountState: AccountState = {
    budgetRemainingUSDC: policy.policyJson.trading.maxBudgetUSDC - totalSpent,
    dailySpendUSDC: dailySpent,
    openOrderCount,
    positionSizeByMarket: {},
  };

  const agentRow = db.prepare('SELECT paper_mode FROM agent_wallets WHERE id = ?').get(agentWalletId) as { paper_mode: number } | undefined;
  const liveMode = agentRow?.paper_mode === 0;

  const client = new OpenAI({ baseURL: OPENROUTER_BASE, apiKey });
  const systemPrompt = buildSystemPrompt(policy, accountState, liveMode);
  const normalizedHistory = normalizeChatHistory(userMessages);
  if (normalizedHistory.length === 0) {
    return { response: 'Please enter a message so I can help.', toolCalls: [] };
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...normalizedHistory,
  ];

  const allToolCalls: ExecutedToolCall[] = [];
  let emptyCompletionRetries = 0;

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
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (!text) {
        logger.warn({
          agentWalletId,
          round,
          finishReason: choice.finish_reason,
          toolsCalledThisTurn: allToolCalls.map(t => t.name),
        }, 'chat model returned an empty completion');

        // Never ask the model to continue after a tool has run: it could repeat a
        // side effect such as placing the same trade twice. Return a deterministic
        // summary of the completed tool call instead.
        const toolFallback = buildToolFallbackResponse(allToolCalls);
        if (toolFallback) return { response: toolFallback, toolCalls: allToolCalls };

        if (emptyCompletionRetries < 2) {
          emptyCompletionRetries += 1;
          // Rebuild a provider-valid transcript. Inserting a system message after
          // user/assistant turns is invalid for some Anthropic routes.
          const retryHistory = emptyCompletionRetries === 1
            ? normalizedHistory
            : normalizedHistory.slice(-4);
          messages.splice(0, messages.length,
            {
              role: 'system',
              content: `${systemPrompt}\n\nIMPORTANT: Return a clear, non-empty answer to the user's latest message.`,
            },
            ...retryHistory,
          );
          continue;
        }

        return {
          response: 'I did not receive a usable response from the language model. Please try again.',
          toolCalls: allToolCalls,
        };
      }
      // Backstop: if the model claims a trade was executed but there was no
      // successful place_trade result in this turn, do not pass that claim to
      // the UI. A retry can produce another false positive; deterministic
      // correction is safer than letting the model narrate a non-existent order.
      const falseTradeClaimResponse = buildFalseTradeClaimResponse(text, allToolCalls);
      if (falseTradeClaimResponse) {
        logger.warn({ agentWalletId, round }, 'model claimed a trade without a successful place_trade result');
        return { response: falseTradeClaimResponse, toolCalls: allToolCalls };
      }
      logger.info({ agentWalletId, round, toolsCalledThisTurn: allToolCalls.map(t => t.name) }, 'chat turn finished without (further) tool calls');
      return { response: text, toolCalls: allToolCalls };
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

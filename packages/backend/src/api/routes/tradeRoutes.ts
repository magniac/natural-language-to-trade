import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { parseTradeIntent, parseTradeIntentFromJSON } from '../../parser/tradeIntentParser';
import { resolveMarket, resolveMarketById } from '../../market/marketResolver';
import { runPolicyEngine, type AccountState, type UsageState, type MarketState } from '../../policy/policyEngine';
import { simulateTrade, createSimulatorState } from '../../simulator/paperTradingSimulator';
import { buildNormalizedOrder } from '../../clob/orderBuilder';
import { ClobTradingClientImpl } from '../../clob/clobTradingClient';
import { getDb } from '../../db/database';
import { writeAudit } from '../../db/auditRepository';
import { isLiveTradingEnabled } from '../middleware';
import { logger } from '../../utils/logger';
import { runAgentChat } from '../../agent/agentChat';
import type { StoredPolicy } from '../../types/policy';

const router = Router();

// In-memory simulator states (per agent wallet) — replace with DB persistence in prod
const simulatorStates: Map<string, ReturnType<typeof createSimulatorState>> = new Map();

function getSimState(agentWalletId: string, budgetUSDC: number) {
  if (!simulatorStates.has(agentWalletId)) {
    simulatorStates.set(agentWalletId, createSimulatorState(agentWalletId, budgetUSDC));
  }
  return simulatorStates.get(agentWalletId)!;
}

function buildAccountState(agentWalletId: string, policy: StoredPolicy): AccountState {
  const db = getDb();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const dailySpend = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side = 'BUY' THEN f.price * f.size ELSE -(f.price * f.size) END), 0) as total
    FROM fills f
    JOIN orders o ON o.id = f.order_id
    WHERE o.agent_wallet_id = ? AND f.created_at >= ?
  `).get(agentWalletId, todayMs) as { total: number }).total;

  const openOrderCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM orders WHERE agent_wallet_id = ? AND status IN ('open', 'pending', 'partially_filled')
  `).get(agentWalletId) as { cnt: number }).cnt;

  const totalSpent = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side = 'BUY' THEN f.price * f.size ELSE -(f.price * f.size) END), 0) as total
    FROM fills f JOIN orders o ON o.id = f.order_id
    WHERE o.agent_wallet_id = ?
  `).get(agentWalletId) as { total: number }).total;

  return {
    budgetRemainingUSDC: policy.policyJson.trading.maxBudgetUSDC - totalSpent,
    dailySpendUSDC: dailySpend,
    openOrderCount,
    positionSizeByMarket: {},
  };
}

function buildUsageState(policyId: string, agentWalletId: string, stored: StoredPolicy): UsageState {
  const db = getDb();
  const hourAgo = Date.now() - 3600_000;
  const todayMs = new Date().setHours(0, 0, 0, 0);

  const llmReqs = (db.prepare('SELECT COUNT(*) as cnt FROM llm_usage WHERE policy_id = ? AND created_at >= ?')
    .get(policyId, hourAgo) as { cnt: number }).cnt;

  const llmSpend = (db.prepare('SELECT COALESCE(SUM(actual_cost_usdc), 0) as total FROM llm_usage WHERE policy_id = ? AND created_at >= ?')
    .get(policyId, todayMs) as { total: number }).total;

  return {
    llmRequestsLastHour: llmReqs,
    llmSpendTodayUSDC: llmSpend,
    policyActive: stored.status === 'active',
    policyExpired: stored.expiresAt.getTime() < Date.now(),
    sessionKeyRevoked: stored.status === 'revoked',
    intentNonceUsed: false,
  };
}

// POST /api/agent/trade/intent
router.post('/intent', async (req, res) => {
  const policy = (req as unknown as { policy: StoredPolicy }).policy as StoredPolicy | undefined;
  if (!policy) return res.status(401).json({ error: 'Policy not loaded' });

  const { rawInput, structuredIntent, paperMode = true } = req.body as {
    rawInput?: string;
    structuredIntent?: unknown;
    paperMode?: boolean;
  };

  if (!rawInput && !structuredIntent) {
    return res.status(400).json({ error: 'Either rawInput or structuredIntent is required' });
  }

  if (!paperMode && isLiveTradingEnabled() === false) {
    return res.status(403).json({ error: 'Live trading is disabled. Use paperMode: true.' });
  }

  // Step 1: Parse intent
  let parseResult;
  if (structuredIntent) {
    parseResult = parseTradeIntentFromJSON(structuredIntent);
  } else {
    parseResult = await parseTradeIntent(rawInput!, policy.agentWalletId);
  }

  if (!parseResult.success || !parseResult.intent) {
    writeAudit({
      userId: policy.userId,
      agentWalletId: policy.agentWalletId,
      policyId: policy.id,
      actorType: 'agent',
      actorId: policy.sessionKeyAddress,
      action: 'intent.parse',
      details: { success: false, error: parseResult.errorMessage },
    });
    return res.status(422).json({ error: 'Failed to parse intent', reason: parseResult.errorMessage });
  }

  const intent = { ...parseResult.intent };
  const priceWasExplicit = parseResult.priceWasExplicit;
  const tradeIntentId = uuidv4();

  // Step 2: Resolve market
  let resolveResult;
  if (intent.marketId) {
    resolveResult = await resolveMarketById(intent.marketId);
  } else {
    resolveResult = await resolveMarket(intent.marketQuery);
  }

  if (resolveResult.refusalReason || resolveResult.candidates.length === 0) {
    writeAudit({
      userId: policy.userId,
      agentWalletId: policy.agentWalletId,
      policyId: policy.id,
      actorType: 'agent',
      actorId: policy.sessionKeyAddress,
      action: 'intent.resolve',
      details: { success: false, reason: resolveResult.refusalReason },
    });
    return res.status(422).json({ error: 'Market resolution failed', reason: resolveResult.refusalReason });
  }

  const resolvedMarket = resolveResult.candidates[0];

  // If user didn't specify a price, use the real market price (ask for BUY, bid for SELL)
  // so the policy engine sees a realistic limit price rather than the 0.50 placeholder.
  if (!priceWasExplicit) {
    const marketFillPrice = intent.side === 'BUY'
      ? resolvedMarket.bestAsk
      : resolvedMarket.bestBid;
    if (marketFillPrice != null) {
      intent.limitPrice = marketFillPrice;
      logger.info({ side: intent.side, marketFillPrice }, 'No price specified — using live market price');
    }
  }

  // If the intent uses maxFraction ("sell all my shares"), look up the actual position
  // from fills and set intent.size = netShares * fraction before the policy engine runs.
  if (intent.maxFraction !== undefined && !intent.size) {
    const db = getDb();
    const tokenId = intent.outcome === 'YES' ? resolvedMarket.yesTokenId : resolvedMarket.noTokenId;
    const posRow = db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN o.side = 'BUY' THEN f.size ELSE -f.size END
      ), 0) AS net_shares
      FROM fills f
      JOIN orders o ON o.id = f.order_id
      WHERE o.agent_wallet_id = ? AND o.market_id = ? AND o.token_id = ?
    `).get(policy.agentWalletId, resolvedMarket.marketId, tokenId) as { net_shares: number };

    const netShares = posRow.net_shares;
    if (netShares <= 0) {
      return res.status(422).json({
        error: 'No position to sell',
        reason: `You have no ${intent.outcome} shares in "${resolvedMarket.title}"`,
      });
    }
    intent.size = Math.round(netShares * intent.maxFraction * 100) / 100;
    logger.info({ netShares, maxFraction: intent.maxFraction, size: intent.size }, 'Resolved sell fraction to share count');
  }

  // Step 3: Build market state snapshot from Gamma API data stored at last ingest
  const dataAgeMs = Date.now() - resolvedMarket.dataUpdatedAt.getTime();
  const spreadBps = resolvedMarket.bestBid != null && resolvedMarket.bestAsk != null
    ? Math.round((resolvedMarket.bestAsk - resolvedMarket.bestBid) / resolvedMarket.bestAsk * 10_000)
    : 50;

  const marketState: MarketState = {
    marketId: resolvedMarket.marketId,
    tokenId: intent.outcome === 'YES' ? resolvedMarket.yesTokenId : resolvedMarket.noTokenId,
    spreadBps,
    bestBid: resolvedMarket.bestBid,
    bestAsk: resolvedMarket.bestAsk,
    liquidityUsdc: resolvedMarket.liquidityUsdc,
    dataAgeMs,
    isActive: resolvedMarket.status === 'active',
  };

  const accountState = buildAccountState(policy.agentWalletId, policy);
  const usageState = buildUsageState(policy.id, policy.agentWalletId, policy);

  // Step 4: Policy engine
  const decision = runPolicyEngine({
    intent,
    policy: policy.policyJson,
    resolvedMarket,
    accountState,
    usageState,
    marketState,
  });

  // Store decision
  const db = getDb();
  db.prepare(`
    INSERT INTO trade_intents (id, user_id, agent_wallet_id, policy_id, session_key_address, raw_input, structured_intent_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tradeIntentId, policy.userId, policy.agentWalletId, policy.id, policy.sessionKeyAddress,
    rawInput ?? '[structured]', JSON.stringify(intent), decision.allowed ? 'resolved' : 'denied', Date.now());

  db.prepare(`
    INSERT INTO policy_decisions (id, trade_intent_id, allowed, reasons_json, risk_summary_json, market_state_snapshot_json, account_state_snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), tradeIntentId, decision.allowed ? 1 : 0,
    JSON.stringify(decision.reasons), JSON.stringify(decision.riskSummary ?? {}),
    JSON.stringify(marketState), JSON.stringify(accountState), Date.now());

  writeAudit({
    userId: policy.userId,
    agentWalletId: policy.agentWalletId,
    policyId: policy.id,
    actorType: 'agent',
    actorId: policy.sessionKeyAddress,
    action: decision.allowed ? 'intent.allow' : 'intent.deny',
    details: { tradeIntentId, allowed: decision.allowed, reasons: decision.reasons },
  });

  if (!decision.allowed) {
    return res.status(403).json({ error: 'Trade denied by policy engine', reasons: decision.reasons, tradeIntentId });
  }

  // Step 5: Paper trade or live
  if (paperMode) {
    const simState = getSimState(policy.agentWalletId, policy.policyJson.trading.maxBudgetUSDC);
    // Use real bid/ask from Gamma data: BUY fills at ask, SELL fills at bid
    const marketPrice = intent.side === 'BUY'
      ? (resolvedMarket.bestAsk ?? intent.limitPrice)
      : (resolvedMarket.bestBid ?? intent.limitPrice);
    const simResult = simulateTrade(simState, {
      intent,
      resolvedMarket,
      marketPrice,
      agentWalletId: policy.agentWalletId,
      userId: policy.userId,
      policyId: policy.id,
      tradeIntentId,
    });

    // Merge state updates
    Object.assign(simState, simResult.newState);

    return res.json({
      mode: 'paper',
      tradeIntentId,
      orderId: simResult.orderId,
      fillPrice: simResult.fillPrice,
      fillSize: simResult.fillSize,
      partialFill: simResult.partialFill,
      riskSummary: decision.riskSummary,
    });
  }

  // Live trading path (behind ENABLE_LIVE_TRADING feature flag)
  // Step 6: Build order
  const buildResult = buildNormalizedOrder(intent, resolvedMarket, policy.agentWalletId, tradeIntentId);
  if (!buildResult.success || !buildResult.order) {
    return res.status(500).json({ error: 'Order build failed', reason: buildResult.errorMessage });
  }

  const order = buildResult.order;

  // Hard global cap: never submit a live order above MAX_GLOBAL_LIVE_ORDER_USDC
  const maxLive = parseFloat(process.env.MAX_GLOBAL_LIVE_ORDER_USDC ?? '1');
  const orderValueUsdc = order.price * order.size;
  if (orderValueUsdc > maxLive) {
    return res.status(403).json({
      error: `Order value $${orderValueUsdc.toFixed(2)} exceeds the live trading cap ($${maxLive}). Lower the order size.`,
    });
  }

  // Step 7: Sign and submit to Polymarket CLOB
  const clobClient = new ClobTradingClientImpl();
  let signedOrder: unknown;
  try {
    signedOrder = await clobClient.createSignedOrder(policy.agentWalletId, order);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sign failed';
    logger.error({ tradeIntentId, err }, 'CLOB order sign failed');
    return res.status(500).json({ error: 'Failed to sign order', reason: msg });
  }

  const postResult = await clobClient.postOrder(policy.agentWalletId, signedOrder, order.orderType);

  // Persist CLOB order ID to the orders row that the simulator wrote
  if (postResult.clobOrderId) {
    db.prepare(`UPDATE orders SET clob_order_id = ?, status = 'open', updated_at = ? WHERE trade_intent_id = ?`)
      .run(postResult.clobOrderId, Date.now(), tradeIntentId);
  }

  writeAudit({
    userId: policy.userId, agentWalletId: policy.agentWalletId, policyId: policy.id,
    actorType: 'agent', actorId: policy.sessionKeyAddress,
    action: postResult.success ? 'order.submitted' : 'order.failed',
    details: { tradeIntentId, clobOrderId: postResult.clobOrderId, error: postResult.errorMessage },
  });

  if (!postResult.success) {
    return res.status(502).json({ error: 'CLOB submission failed', reason: postResult.errorMessage, tradeIntentId });
  }

  return res.json({
    mode: 'live',
    tradeIntentId,
    clobOrderId: postResult.clobOrderId,
    price: order.price,
    size: order.size,
    riskSummary: decision.riskSummary,
  });
});

// POST /api/agent/trade/cancel-all  — cancel every open order (paper + live)
router.post('/cancel-all', async (req, res) => {
  const policy = (req as unknown as { policy: StoredPolicy }).policy;
  const db = getDb();

  // Mark all open paper orders cancelled in DB
  const affected = db.prepare(`
    UPDATE orders SET status = 'cancelled', updated_at = ?
    WHERE agent_wallet_id = ? AND status IN ('open', 'pending', 'partially_filled')
  `).run(Date.now(), policy.agentWalletId);

  // If live trading is active, also cancel on CLOB
  let clobCancelled = 0;
  if (isLiveTradingEnabled()) {
    try {
      const clobClient = new ClobTradingClientImpl();
      await clobClient.cancelAll(policy.agentWalletId);
      clobCancelled = affected.changes;
    } catch (err) {
      logger.error({ err }, 'CLOB cancel-all failed');
    }
  }

  writeAudit({
    userId: policy.userId, agentWalletId: policy.agentWalletId, policyId: policy.id,
    actorType: 'user', actorId: policy.sessionKeyAddress,
    action: 'order.cancel_all', details: { dbCancelled: affected.changes, clobCancelled },
  });

  return res.json({ cancelled: affected.changes, clobCancelled });
});

// POST /api/agent/trade/cancel/:orderId  — cancel a specific order
router.post('/cancel/:orderId', async (req, res) => {
  const policy = (req as unknown as { policy: StoredPolicy }).policy;
  const db = getDb();
  const { orderId } = req.params;

  const row = db.prepare('SELECT * FROM orders WHERE id = ? AND agent_wallet_id = ?')
    .get(orderId, policy.agentWalletId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Order not found' });

  db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), orderId);

  if (isLiveTradingEnabled() && row.clob_order_id) {
    try {
      const clobClient = new ClobTradingClientImpl();
      await clobClient.cancelOrder(policy.agentWalletId, row.clob_order_id as string);
    } catch (err) {
      logger.error({ orderId, err }, 'CLOB single cancel failed');
    }
  }

  writeAudit({
    userId: policy.userId, agentWalletId: policy.agentWalletId, policyId: policy.id,
    actorType: 'user', actorId: policy.sessionKeyAddress,
    action: 'order.cancel', details: { orderId, clobOrderId: row.clob_order_id },
  });

  return res.json({ cancelled: orderId });
});

// GET /api/agent/trade/portfolio
router.get('/portfolio', async (req, res) => {
  const policy = (req as unknown as { policy: StoredPolicy }).policy as StoredPolicy | undefined;
  if (!policy) return res.status(401).json({ error: 'Policy not loaded' });

  const db = getDb();
  const agentWalletId = policy.agentWalletId;

  // Refresh live fills from the CLOB so positions reflect executed trades (no-op for paper).
  if (process.env.ENABLE_LIVE_TRADING === 'true') {
    try { await new ClobTradingClientImpl().reconcileLiveFills(agentWalletId); }
    catch (err) { logger.warn({ agentWalletId, err }, 'portfolio fill reconcile failed'); }
  }

  const summary = db.prepare(`
    SELECT
      COUNT(DISTINCT o.id) as total_orders,
      COUNT(DISTINCT CASE WHEN f.id IS NOT NULL THEN o.id END) as filled_orders,
      COUNT(DISTINCT CASE WHEN o.status IN ('open', 'pending', 'partially_filled') THEN o.id END) as open_orders,
      COALESCE(SUM(CASE WHEN o.side = 'BUY' THEN f.price * f.size ELSE -(f.price * f.size) END), 0) as total_spent_usdc
    FROM orders o
    LEFT JOIN fills f ON f.order_id = o.id
    WHERE o.agent_wallet_id = ?
  `).get(agentWalletId) as { total_orders: number; filled_orders: number; open_orders: number; total_spent_usdc: number };

  const positions = (db.prepare(`
    SELECT
      o.market_id,
      o.token_id,
      COALESCE(m.title, o.market_id) as market_title,
      COALESCE(mt.outcome, '') as outcome,
      SUM(CASE WHEN o.side = 'BUY' THEN f.size ELSE -f.size END) as net_shares,
      COALESCE(SUM(CASE WHEN o.side = 'BUY' THEN f.price * f.size ELSE 0 END), 0) as total_buy_cost_usdc,
      COALESCE(SUM(CASE WHEN o.side = 'BUY' THEN f.size ELSE 0 END), 0) as total_buy_shares
    FROM fills f
    JOIN orders o ON o.id = f.order_id
    LEFT JOIN markets m ON m.market_id = o.market_id
    LEFT JOIN market_tokens mt ON mt.token_id = o.token_id
    WHERE o.agent_wallet_id = ?
    GROUP BY o.market_id, o.token_id
    HAVING net_shares > 0.0001
    ORDER BY total_buy_cost_usdc DESC
  `).all(agentWalletId) as Array<{
    market_id: string; token_id: string; market_title: string; outcome: string;
    net_shares: number; total_buy_cost_usdc: number; total_buy_shares: number;
  }>).map(p => ({
    market_id: p.market_id,
    token_id: p.token_id,
    market_title: p.market_title,
    outcome: p.outcome,
    side: 'BUY',
    total_shares: p.net_shares,
    avg_price: p.total_buy_shares > 0 ? p.total_buy_cost_usdc / p.total_buy_shares : 0,
    total_cost_usdc: p.total_buy_cost_usdc,
  }));

  const recentOrders = db.prepare(`
    SELECT
      o.id,
      o.market_id,
      o.side,
      o.price as limit_price,
      o.size as requested_size,
      o.status,
      o.created_at,
      COALESCE(m.title, o.market_id) as market_title,
      COALESCE(mt.outcome, '') as outcome,
      COALESCE(SUM(f.size), 0) as filled_size,
      COALESCE(SUM(f.price * f.size), 0) as fill_cost_usdc,
      CASE WHEN SUM(f.size) > 0 THEN SUM(f.price * f.size) / SUM(f.size) ELSE NULL END as fill_price
    FROM orders o
    LEFT JOIN markets m ON m.market_id = o.market_id
    LEFT JOIN market_tokens mt ON mt.token_id = o.token_id
    LEFT JOIN fills f ON f.order_id = o.id
    WHERE o.agent_wallet_id = ?
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 25
  `).all(agentWalletId);

  return res.json({
    agentWalletId,
    summary: {
      totalOrders: summary.total_orders,
      filledOrders: summary.filled_orders,
      openOrders: summary.open_orders,
      totalSpentUsdc: summary.total_spent_usdc,
      budgetUsdc: policy.policyJson.trading.maxBudgetUSDC,
      budgetRemainingUsdc: policy.policyJson.trading.maxBudgetUSDC - summary.total_spent_usdc,
    },
    positions,
    recentOrders,
  });
});

// POST /api/agent/trade/chat
router.post('/chat', async (req, res) => {
  const policy = (req as unknown as { policy: StoredPolicy }).policy as StoredPolicy | undefined;
  if (!policy) return res.status(401).json({ error: 'Policy not loaded' });

  const { messages } = req.body as { messages?: Array<{ role: 'user' | 'assistant'; content: string }> };
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const result = await runAgentChat(messages, policy, policy.agentWalletId);
    return res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Chat failed';
    logger.error({ err }, 'Agent chat error');
    return res.status(500).json({ error: msg });
  }
});

export default router;

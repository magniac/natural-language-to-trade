import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';
import { parseTradeIntentFromJSON } from '../parser/tradeIntentParser';
import { resolveMarketById } from '../market/marketResolver';
import { runPolicyEngine, type AccountState, type UsageState, type MarketState } from '../policy/policyEngine';
import { simulateTrade, createSimulatorState } from '../simulator/paperTradingSimulator';
import { getActivePolicyForAgent } from '../db/policyRepository';
import { writeAudit } from '../db/auditRepository';
import { resolveLlmApiKey } from '../utils/llmKeyStore';
import type { StoredPolicy } from '../types/policy';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const LOOP_MODEL = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.6';
const MARKETS_PER_SCAN = 10;
const DEFAULT_ORDER_SIZE_USDC = 0.50;

const activeIntervals = new Map<string, NodeJS.Timeout>();
const simulatorStates = new Map<string, ReturnType<typeof createSimulatorState>>();

export interface LoopStatus {
  agentWalletId: string;
  status: 'running' | 'stopped';
  intervalMs: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runsTotal: number;
  tradesPlaced: number;
  startedAt: number | null;
}

export interface LoopDecision {
  id: string;
  runId: string;
  marketId: string;
  marketTitle: string;
  decision: 'BUY_YES' | 'BUY_NO' | 'PASS';
  reasoning: string | null;
  suggestedPrice: number | null;
  orderId: string | null;
  policyOutcome: string | null;
  policyReasons: string[] | null;
  createdAt: number;
}

type LLMDecision = {
  marketId: string;
  decision: 'BUY_YES' | 'BUY_NO' | 'PASS';
  reasoning: string;
  suggestedPrice?: number;
};

type ScannedMarket = {
  market_id: string;
  title: string;
  best_bid: number | null;
  best_ask: number | null;
  description: string | null;
  liquidity_usdc: number;
};

function getLoopRow(agentWalletId: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM loop_state WHERE agent_wallet_id = ?')
    .get(agentWalletId) as Record<string, unknown> | undefined;
}

function ensureLoopRow(agentWalletId: string): void {
  getDb().prepare(`
    INSERT INTO loop_state (agent_wallet_id, status, interval_ms, runs_total, trades_placed)
    VALUES (?, 'stopped', 300000, 0, 0)
    ON CONFLICT(agent_wallet_id) DO NOTHING
  `).run(agentWalletId);
}

function setLoopFields(agentWalletId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const db = getDb();
  const setClauses = keys.map(k => `${k} = ?`).join(', ');
  const stmt = db.prepare(`UPDATE loop_state SET ${setClauses} WHERE agent_wallet_id = ?`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stmt.run as (...a: any[]) => void)(...Object.values(fields), agentWalletId);
}

function rowToStatus(agentWalletId: string, row?: Record<string, unknown>): LoopStatus {
  if (!row) return { agentWalletId, status: 'stopped', intervalMs: 300_000, lastRunAt: null, nextRunAt: null, runsTotal: 0, tradesPlaced: 0, startedAt: null };
  return {
    agentWalletId,
    status: row.status as 'running' | 'stopped',
    intervalMs: row.interval_ms as number,
    lastRunAt: (row.last_run_at as number | null) ?? null,
    nextRunAt: (row.next_run_at as number | null) ?? null,
    runsTotal: row.runs_total as number,
    tradesPlaced: row.trades_placed as number,
    startedAt: (row.started_at as number | null) ?? null,
  };
}

async function callLLM(markets: ScannedMarket[], agentWalletId: string): Promise<LLMDecision[]> {
  const apiKey = resolveLlmApiKey(agentWalletId);
  if (!apiKey) {
    logger.warn({ agentWalletId }, 'Autonomous loop: no LLM API key — all markets PASS');
    return markets.map(m => ({ marketId: m.market_id, decision: 'PASS' as const, reasoning: 'No OpenRouter API key configured' }));
  }

  const client = new OpenAI({ baseURL: OPENROUTER_BASE, apiKey });

  const marketList = markets.map((m, i) => {
    const bid = m.best_bid != null ? `$${m.best_bid.toFixed(3)}` : '?';
    const ask = m.best_ask != null ? `$${m.best_ask.toFixed(3)}` : '?';
    return `${i + 1}. [ID: ${m.market_id}]\n   Title: ${m.title}\n   YES bid/ask: ${bid} / ${ask} | Liquidity: $${m.liquidity_usdc.toFixed(0)}`;
  }).join('\n\n');

  const prompt = `You are an autonomous prediction market trading agent doing a periodic market scan.

For each market below, decide: BUY_YES, BUY_NO, or PASS.

Rules:
- Only trade when you have genuine conviction based on public knowledge (>70% confidence)
- PASS if uncertain, far in the future, or bid/ask unknown
- At most 2 non-PASS decisions per scan
- suggestedPrice must be between 0.05 and 0.95

Markets:
${marketList}

Respond ONLY with a JSON array:
[{"marketId":"...","decision":"BUY_YES"|"BUY_NO"|"PASS","reasoning":"...","suggestedPrice":0.xx}]`;

  const response = await client.chat.completions.create({
    model: LOOP_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 1000,
  });

  const raw = response.choices[0]?.message?.content ?? '[]';
  const jsonStr = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();

  try {
    const parsed = JSON.parse(jsonStr) as unknown[];
    return parsed.filter((d): d is LLMDecision =>
      typeof d === 'object' && d !== null && 'marketId' in d && 'decision' in d
    );
  } catch {
    logger.warn({ raw }, 'Autonomous loop: failed to parse LLM JSON');
    return markets.map(m => ({ marketId: m.market_id, decision: 'PASS' as const, reasoning: 'LLM parse error' }));
  }
}

function buildAccountState(agentWalletId: string, policy: StoredPolicy): AccountState {
  const db = getDb();
  const todayMs = new Date().setHours(0, 0, 0, 0);

  const dailySpend = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE -(f.price*f.size) END),0) as total
    FROM fills f JOIN orders o ON o.id=f.order_id
    WHERE o.agent_wallet_id=? AND f.created_at>=?
  `).get(agentWalletId, todayMs) as { total: number }).total;

  const totalSpent = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN f.price*f.size ELSE -(f.price*f.size) END),0) as total
    FROM fills f JOIN orders o ON o.id=f.order_id
    WHERE o.agent_wallet_id=?
  `).get(agentWalletId) as { total: number }).total;

  const openOrderCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM orders WHERE agent_wallet_id=? AND status IN ('open','pending','partially_filled')
  `).get(agentWalletId) as { cnt: number }).cnt;

  return {
    budgetRemainingUSDC: policy.policyJson.trading.maxBudgetUSDC - totalSpent,
    dailySpendUSDC: dailySpend,
    openOrderCount,
    positionSizeByMarket: {},
  };
}

function buildUsageState(agentWalletId: string, policy: StoredPolicy): UsageState {
  const db = getDb();
  const hourAgo = Date.now() - 3_600_000;
  const todayMs = new Date().setHours(0, 0, 0, 0);
  const llmReqs = (db.prepare('SELECT COUNT(*) as cnt FROM llm_usage WHERE policy_id=? AND created_at>=?').get(policy.id, hourAgo) as { cnt: number }).cnt;
  const llmSpend = (db.prepare('SELECT COALESCE(SUM(actual_cost_usdc),0) as total FROM llm_usage WHERE policy_id=? AND created_at>=?').get(policy.id, todayMs) as { total: number }).total;
  void agentWalletId;
  return {
    llmRequestsLastHour: llmReqs,
    llmSpendTodayUSDC: llmSpend,
    policyActive: policy.status === 'active',
    policyExpired: policy.expiresAt.getTime() < Date.now(),
    sessionKeyRevoked: policy.status === 'revoked',
    intentNonceUsed: false,
  };
}

async function runOnce(agentWalletId: string): Promise<void> {
  const db = getDb();
  const runId = uuidv4();
  const now = Date.now();

  logger.info({ agentWalletId, runId }, 'Autonomous loop: starting run');

  const policy = getActivePolicyForAgent(agentWalletId);
  if (!policy) {
    logger.warn({ agentWalletId }, 'Autonomous loop: no active policy — skipping');
    return;
  }
  if (policy.expiresAt.getTime() < now) {
    logger.warn({ agentWalletId }, 'Autonomous loop: policy expired — stopping');
    stopLoop(agentWalletId);
    return;
  }

  const markets = db.prepare(`
    SELECT market_id, title, best_bid, best_ask, description, COALESCE(liquidity_usdc,0) as liquidity_usdc
    FROM markets WHERE status='active'
    ORDER BY liquidity_usdc DESC LIMIT ?
  `).all(MARKETS_PER_SCAN) as ScannedMarket[];

  if (markets.length === 0) {
    logger.info({ agentWalletId }, 'Autonomous loop: no markets available');
    return;
  }

  let decisions: LLMDecision[];
  try {
    decisions = await callLLM(markets, agentWalletId);
  } catch (err) {
    logger.error({ agentWalletId, err }, 'Autonomous loop: LLM call failed');
    decisions = markets.map(m => ({ marketId: m.market_id, decision: 'PASS' as const, reasoning: 'LLM error' }));
  }

  let tradesPlaced = 0;

  for (const market of markets) {
    const d = decisions.find(x => x.marketId === market.market_id) ?? { marketId: market.market_id, decision: 'PASS' as const, reasoning: 'Not evaluated' };

    if (d.decision === 'PASS') {
      db.prepare(`
        INSERT INTO loop_decisions (id,agent_wallet_id,run_id,market_id,market_title,decision,reasoning,suggested_price,order_id,policy_outcome,policy_reasons,created_at)
        VALUES (?,?,?,?,?,'PASS',?,NULL,NULL,NULL,NULL,?)
      `).run(uuidv4(), agentWalletId, runId, market.market_id, market.title, d.reasoning, now);
      continue;
    }

    const outcome: 'YES' | 'NO' = d.decision === 'BUY_YES' ? 'YES' : 'NO';
    const rawPrice = d.suggestedPrice ?? (outcome === 'YES' ? market.best_ask : (market.best_bid != null ? 1 - market.best_bid : null)) ?? 0.5;
    const clampedPrice = Math.max(0.05, Math.min(0.95, rawPrice));
    const orderSize = Math.min(DEFAULT_ORDER_SIZE_USDC, policy.policyJson.trading.maxOrderSizeUSDC);

    let policyOutcome = 'ERROR';
    let policyReasons: string[] = [];
    let orderId: string | null = null;

    try {
      const parseResult = parseTradeIntentFromJSON({
        side: 'BUY',
        outcome,
        marketId: market.market_id,
        marketQuery: market.title,
        limitPrice: clampedPrice,
        maxSpendUSDC: orderSize,
        orderType: 'GTC',
      });

      if (!parseResult.success || !parseResult.intent) {
        policyOutcome = 'PARSE_ERROR';
        policyReasons = [parseResult.errorMessage ?? 'Parse failed'];
      } else {
        const intent = parseResult.intent;
        const resolveResult = await resolveMarketById(market.market_id);

        if (resolveResult.candidates.length === 0) {
          policyOutcome = 'RESOLVE_ERROR';
          policyReasons = [resolveResult.refusalReason ?? 'Market not found'];
        } else {
          const resolvedMarket = resolveResult.candidates[0];
          const accountState = buildAccountState(agentWalletId, policy);
          const usageState = buildUsageState(agentWalletId, policy);

          const spreadBps = resolvedMarket.bestBid != null && resolvedMarket.bestAsk != null
            ? Math.round((resolvedMarket.bestAsk - resolvedMarket.bestBid) / resolvedMarket.bestAsk * 10_000)
            : 50;
          const tokenId = outcome === 'YES' ? resolvedMarket.yesTokenId : resolvedMarket.noTokenId;
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
            policyOutcome = 'DENIED';
            policyReasons = policyDecision.reasons;
          } else {
            policyOutcome = 'ALLOWED';
            if (!simulatorStates.has(agentWalletId)) {
              simulatorStates.set(agentWalletId, createSimulatorState(agentWalletId, policy.policyJson.trading.maxBudgetUSDC));
            }
            const simState = simulatorStates.get(agentWalletId)!;
            const marketPrice = intent.side === 'BUY' ? (resolvedMarket.bestAsk ?? intent.limitPrice) : (resolvedMarket.bestBid ?? intent.limitPrice);
            const tradeIntentId = uuidv4();

            const simResult = simulateTrade(simState, {
              intent, resolvedMarket, marketPrice,
              agentWalletId, userId: policy.userId, policyId: policy.id, tradeIntentId,
            });
            Object.assign(simState, simResult.newState);
            orderId = simResult.orderId;
            tradesPlaced++;

            writeAudit({
              userId: policy.userId, agentWalletId, policyId: policy.id,
              actorType: 'agent', actorId: 'autonomous-loop',
              action: 'order.submitted',
              details: { runId, orderId, marketId: market.market_id, outcome, price: clampedPrice, source: 'loop' },
            });
          }
        }
      }
    } catch (err) {
      policyOutcome = 'ERROR';
      policyReasons = [err instanceof Error ? err.message : 'Unknown error'];
      logger.error({ agentWalletId, marketId: market.market_id, err }, 'Autonomous loop: trade execution error');
    }

    db.prepare(`
      INSERT INTO loop_decisions (id,agent_wallet_id,run_id,market_id,market_title,decision,reasoning,suggested_price,order_id,policy_outcome,policy_reasons,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(uuidv4(), agentWalletId, runId, market.market_id, market.title,
      d.decision, d.reasoning, d.suggestedPrice ?? null, orderId,
      policyOutcome, JSON.stringify(policyReasons), now);
  }

  const currentRow = getLoopRow(agentWalletId);
  const currentRuns = (currentRow?.runs_total as number | undefined) ?? 0;
  const currentTrades = (currentRow?.trades_placed as number | undefined) ?? 0;
  const intervalMs = (currentRow?.interval_ms as number | undefined) ?? 300_000;

  setLoopFields(agentWalletId, {
    last_run_at: now,
    next_run_at: now + intervalMs,
    runs_total: currentRuns + 1,
    trades_placed: currentTrades + tradesPlaced,
  });

  logger.info({ agentWalletId, runId, tradesPlaced, marketsScanned: markets.length }, 'Autonomous loop: run complete');
}

export function startLoop(agentWalletId: string, intervalMs = 300_000): void {
  if (activeIntervals.has(agentWalletId)) {
    clearInterval(activeIntervals.get(agentWalletId)!);
    activeIntervals.delete(agentWalletId);
  }

  const now = Date.now();
  ensureLoopRow(agentWalletId);
  setLoopFields(agentWalletId, {
    status: 'running',
    interval_ms: intervalMs,
    started_at: now,
    next_run_at: now + intervalMs,
    stopped_at: null,
  });

  runOnce(agentWalletId).catch(err =>
    logger.error({ agentWalletId, err }, 'Autonomous loop: initial run failed')
  );

  const timer = setInterval(() => {
    runOnce(agentWalletId).catch(err =>
      logger.error({ agentWalletId, err }, 'Autonomous loop: periodic run failed')
    );
  }, intervalMs);

  activeIntervals.set(agentWalletId, timer);
  logger.info({ agentWalletId, intervalMs }, 'Autonomous loop started');
}

export function stopLoop(agentWalletId: string): void {
  const timer = activeIntervals.get(agentWalletId);
  if (timer) {
    clearInterval(timer);
    activeIntervals.delete(agentWalletId);
  }
  ensureLoopRow(agentWalletId);
  setLoopFields(agentWalletId, {
    status: 'stopped',
    next_run_at: null,
    stopped_at: Date.now(),
  });
  logger.info({ agentWalletId }, 'Autonomous loop stopped');
}

export function getLoopStatusAndDecisions(agentWalletId: string): { status: LoopStatus; recentDecisions: LoopDecision[] } {
  const db = getDb();
  const row = getLoopRow(agentWalletId);
  const recentDecisions = (db.prepare(`
    SELECT * FROM loop_decisions WHERE agent_wallet_id=? ORDER BY created_at DESC LIMIT 30
  `).all(agentWalletId) as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string,
    runId: r.run_id as string,
    marketId: r.market_id as string,
    marketTitle: r.market_title as string,
    decision: r.decision as 'BUY_YES' | 'BUY_NO' | 'PASS',
    reasoning: (r.reasoning as string | null) ?? null,
    suggestedPrice: (r.suggested_price as number | null) ?? null,
    orderId: (r.order_id as string | null) ?? null,
    policyOutcome: (r.policy_outcome as string | null) ?? null,
    policyReasons: r.policy_reasons ? (JSON.parse(r.policy_reasons as string) as string[]) : null,
    createdAt: r.created_at as number,
  }));
  return { status: rowToStatus(agentWalletId, row), recentDecisions };
}

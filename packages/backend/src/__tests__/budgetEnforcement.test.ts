/**
 * Integration tests for budget and spend enforcement.
 *
 * These tests cover the critical path that was missing from the original suite:
 *   simulateTrade → writes fills to DB → buildAccountState reads DB → policy engine blocks.
 *
 * They use a real in-memory SQLite DB so there is no mocking of the persistence layer.
 */

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuidv4 } from 'uuid';
import { SCHEMA_SQL } from '../db/schema';
import { createSimulatorState, simulateTrade } from '../simulator/paperTradingSimulator';
import { runPolicyEngine } from '../policy/policyEngine';
import type { AgentPolicy } from '../types/policy';
import type { TradeIntent } from '../types/intent';
import type { MarketResolverCandidate } from '../types/market';
import type { AccountState, UsageState, MarketState } from '../policy/policyEngine';

let testDb: DatabaseSync;

jest.mock('../db/auditRepository', () => ({ writeAudit: jest.fn() }));
jest.mock('../db/database', () => ({ getDb: () => testDb }));

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL.replace('PRAGMA foreign_keys = ON;', 'PRAGMA foreign_keys = OFF;'));
  return db;
}

/** Mirror of buildAccountState in tradeRoutes — reads from real DB. */
function buildAccountState(agentWalletId: string, policy: AgentPolicy): AccountState {
  const db = testDb;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const dailySpend = (db.prepare(`
    SELECT COALESCE(SUM(f.price * f.size), 0) as total
    FROM fills f JOIN orders o ON o.id = f.order_id
    WHERE o.agent_wallet_id = ? AND f.created_at >= ?
  `).get(agentWalletId, todayMs) as { total: number }).total;

  const openOrderCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM orders WHERE agent_wallet_id = ? AND status IN ('open', 'pending', 'partially_filled')
  `).get(agentWalletId) as { cnt: number }).cnt;

  const totalSpent = (db.prepare(`
    SELECT COALESCE(SUM(f.price * f.size), 0) as total
    FROM fills f JOIN orders o ON o.id = f.order_id
    WHERE o.agent_wallet_id = ?
  `).get(agentWalletId) as { total: number }).total;

  return {
    budgetRemainingUSDC: policy.trading.maxBudgetUSDC - totalSpent,
    dailySpendUSDC: dailySpend,
    openOrderCount,
    positionSizeByMarket: {},
  };
}

const NOW_SEC = Math.floor(Date.now() / 1000);

const POLICY: AgentPolicy = {
  version: '1',
  userWallet: '0xUser',
  agentWallet: '0xAgent',
  sessionKey: '0xSession',
  createdAt: NOW_SEC - 60,
  expiresAt: NOW_SEC + 86400,
  revocationNonce: 'nonce-1',
  llm: {
    allowedModels: ['anthropic/claude-haiku-4-5-20251001'],
    maxRequestsPerHour: 20,
    maxTokensPerRequest: 4000,
    maxSpendPerDayUSDC: 5,
  },
  trading: {
    maxBudgetUSDC: 10,
    maxOrderSizeUSDC: 10,
    maxDailySpendUSDC: 10,
    maxOpenOrders: 5,
    allowedMarkets: [],
    allowedCategories: [],
    allowedSides: ['BUY', 'SELL'],
    allowedOrderTypes: ['GTD', 'GTC'],
    maxPrice: null,
    minLiquidityUSDC: 100,
    maxSpreadBps: 500,
    minExpirationSeconds: 60,
    maxExpirationSeconds: 3600,
  },
};

const MARKET: MarketResolverCandidate = {
  marketId: 'market-1',
  title: 'Will BTC hit $100k?',
  yesTokenId: 'yes-token',
  noTokenId: 'no-token',
  status: 'active',
  liquidityUsdc: 50_000,
  resolutionDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  confidence: 0.9,
  bestBid: 0.34,
  bestAsk: 0.36,
  dataUpdatedAt: new Date(),
};

const INTENT: TradeIntent = {
  action: 'trade',
  marketQuery: 'btc 100k',
  outcome: 'YES',
  side: 'BUY',
  maxSpendUSDC: 5,
  limitPrice: 0.35,
  orderType: 'GTD',
  expirationSeconds: 300,
  rationale: 'test',
  confidence: 0.9,
};

const MARKET_STATE: MarketState = {
  marketId: 'market-1',
  tokenId: 'yes-token',
  spreadBps: 50,
  bestBid: 0.34,
  bestAsk: 0.36,
  liquidityUsdc: 50_000,
  dataAgeMs: 10_000,
  isActive: true,
};

const BASE_USAGE: UsageState = {
  llmRequestsLastHour: 0,
  llmSpendTodayUSDC: 0,
  policyActive: true,
  policyExpired: false,
  sessionKeyRevoked: false,
  intentNonceUsed: false,
};

const AGENT_ID = 'agent-budget-test';

beforeEach(() => {
  testDb = makeDb();
});

afterEach(() => {
  testDb.close();
});

describe('Budget enforcement — DB-backed account state', () => {
  it('starts with full budget available', () => {
    const account = buildAccountState(AGENT_ID, POLICY);
    expect(account.budgetRemainingUSDC).toBe(10);
    expect(account.dailySpendUSDC).toBe(0);
  });

  it('reduces remaining budget after a fill', () => {
    const state = createSimulatorState(AGENT_ID, POLICY.trading.maxBudgetUSDC);
    simulateTrade(state, { intent: INTENT, resolvedMarket: MARKET, marketPrice: 0.35, agentWalletId: AGENT_ID, userId: 'u1', policyId: 'p1', tradeIntentId: uuidv4() });

    const account = buildAccountState(AGENT_ID, POLICY);
    expect(account.budgetRemainingUSDC).toBeLessThan(10);
    expect(account.dailySpendUSDC).toBeGreaterThan(0);
  });

  it('blocks a second trade when budget is exactly exhausted', () => {
    const state = createSimulatorState(AGENT_ID, POLICY.trading.maxBudgetUSDC);
    // Spend the full $10 budget in one trade
    const bigIntent = { ...INTENT, maxSpendUSDC: 10 };
    simulateTrade(state, { intent: bigIntent, resolvedMarket: MARKET, marketPrice: 0.35, agentWalletId: AGENT_ID, userId: 'u1', policyId: 'p1', tradeIntentId: uuidv4() });

    const account = buildAccountState(AGENT_ID, POLICY);
    // Budget should be at or near zero
    expect(account.budgetRemainingUSDC).toBeLessThanOrEqual(0.01);

    // Second trade should be denied
    const decision = runPolicyEngine({
      intent: { ...INTENT, maxSpendUSDC: 1 },
      policy: POLICY,
      resolvedMarket: MARKET,
      accountState: account,
      usageState: BASE_USAGE,
      marketState: MARKET_STATE,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some(r => r.includes('remaining budget'))).toBe(true);
  });

  it('blocks when cumulative spend across trades exhausts budget', () => {
    const state = createSimulatorState(AGENT_ID, POLICY.trading.maxBudgetUSDC);
    // Two $5 trades against a $10 budget
    for (let i = 0; i < 2; i++) {
      simulateTrade(state, { intent: INTENT, resolvedMarket: MARKET, marketPrice: 0.35, agentWalletId: AGENT_ID, userId: 'u1', policyId: 'p1', tradeIntentId: uuidv4() });
    }

    const account = buildAccountState(AGENT_ID, POLICY);
    expect(account.budgetRemainingUSDC).toBeLessThanOrEqual(0.01);

    const decision = runPolicyEngine({
      intent: { ...INTENT, maxSpendUSDC: 1 },
      policy: POLICY,
      resolvedMarket: MARKET,
      accountState: account,
      usageState: BASE_USAGE,
      marketState: MARKET_STATE,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some(r => r.includes('remaining budget'))).toBe(true);
  });

  it('enforces daily spend limit across trades', () => {
    const state = createSimulatorState(AGENT_ID, POLICY.trading.maxBudgetUSDC);
    // Spend $5 via simulator
    simulateTrade(state, { intent: INTENT, resolvedMarket: MARKET, marketPrice: 0.35, agentWalletId: AGENT_ID, userId: 'u1', policyId: 'p1', tradeIntentId: uuidv4() });

    const account = buildAccountState(AGENT_ID, POLICY);
    // Now try a second $6 trade — 5 + 6 > 10 daily limit
    const decision = runPolicyEngine({
      intent: { ...INTENT, maxSpendUSDC: 6 },
      policy: POLICY,
      resolvedMarket: MARKET,
      accountState: account,
      usageState: BASE_USAGE,
      marketState: MARKET_STATE,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some(r => r.includes('Daily spend'))).toBe(true);
  });

  it('open order count is tracked in DB and enforced', () => {
    const state = createSimulatorState(AGENT_ID, 1000);
    // Place 5 unfilled (limit below market) orders to hit the open order cap
    for (let i = 0; i < 5; i++) {
      simulateTrade(state, {
        intent: { ...INTENT, limitPrice: 0.01, maxSpendUSDC: 1 },
        resolvedMarket: MARKET,
        marketPrice: 0.35,
        agentWalletId: AGENT_ID,
        userId: 'u1',
        policyId: 'p1',
        tradeIntentId: uuidv4(),
      });
    }

    const account = buildAccountState(AGENT_ID, POLICY);
    expect(account.openOrderCount).toBe(5);

    const decision = runPolicyEngine({
      intent: { ...INTENT, maxSpendUSDC: 1 },
      policy: POLICY,
      resolvedMarket: MARKET,
      accountState: account,
      usageState: BASE_USAGE,
      marketState: MARKET_STATE,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some(r => r.includes('Too many open orders'))).toBe(true);
  });

  it('filled orders do not count toward open order limit', () => {
    const state = createSimulatorState(AGENT_ID, 1000);
    // Place 5 filled orders (limit at market price)
    for (let i = 0; i < 5; i++) {
      simulateTrade(state, {
        intent: { ...INTENT, limitPrice: 0.35, maxSpendUSDC: 1 },
        resolvedMarket: MARKET,
        marketPrice: 0.35,
        agentWalletId: AGENT_ID,
        userId: 'u1',
        policyId: 'p1',
        tradeIntentId: uuidv4(),
      });
    }

    const account = buildAccountState(AGENT_ID, POLICY);
    expect(account.openOrderCount).toBe(0);
  });

  it('unfilled orders do not consume budget', () => {
    const state = createSimulatorState(AGENT_ID, POLICY.trading.maxBudgetUSDC);
    // Place an unfilled order
    simulateTrade(state, {
      intent: { ...INTENT, limitPrice: 0.01 },
      resolvedMarket: MARKET,
      marketPrice: 0.35,
      agentWalletId: AGENT_ID,
      userId: 'u1',
      policyId: 'p1',
      tradeIntentId: uuidv4(),
    });

    const account = buildAccountState(AGENT_ID, POLICY);
    // Budget should still be full since order didn't fill
    expect(account.budgetRemainingUSDC).toBe(10);
    expect(account.dailySpendUSDC).toBe(0);
  });

  it('policy allows trade when budget is partially used', () => {
    const state = createSimulatorState(AGENT_ID, POLICY.trading.maxBudgetUSDC);
    // Spend $5 of $10 budget
    simulateTrade(state, { intent: INTENT, resolvedMarket: MARKET, marketPrice: 0.35, agentWalletId: AGENT_ID, userId: 'u1', policyId: 'p1', tradeIntentId: uuidv4() });

    const account = buildAccountState(AGENT_ID, POLICY);
    // $4 trade should still be allowed (5 spent + 4 = 9 < 10 daily, and budget ~5 remaining)
    const decision = runPolicyEngine({
      intent: { ...INTENT, maxSpendUSDC: 4 },
      policy: POLICY,
      resolvedMarket: MARKET,
      accountState: account,
      usageState: BASE_USAGE,
      marketState: MARKET_STATE,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('Limit price vs market price safety', () => {
  it('policy engine blocks buy with limit price far above best ask', () => {
    const account = buildAccountState(AGENT_ID, POLICY);
    const decision = runPolicyEngine({
      intent: { ...INTENT, limitPrice: 0.80 },
      policy: POLICY,
      resolvedMarket: MARKET,
      accountState: account,
      usageState: BASE_USAGE,
      marketState: MARKET_STATE,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some(r => r.includes('best ask'))).toBe(true);
  });

  it('policy engine allows buy with limit price at best ask', () => {
    const account = buildAccountState(AGENT_ID, POLICY);
    const decision = runPolicyEngine({
      intent: { ...INTENT, limitPrice: 0.36 },
      policy: POLICY,
      resolvedMarket: MARKET,
      accountState: account,
      usageState: BASE_USAGE,
      marketState: MARKET_STATE,
    });
    expect(decision.allowed).toBe(true);
  });
});

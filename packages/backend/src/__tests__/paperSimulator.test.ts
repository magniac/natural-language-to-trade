import { DatabaseSync } from 'node:sqlite';
import {
  createSimulatorState,
  simulateTrade,
  cancelSimulatedOrder,
  cancelAllSimulatedOrders,
  type SimulateTradeInput,
} from '../simulator/paperTradingSimulator';
import { SCHEMA_SQL } from '../db/schema';
import type { TradeIntent } from '../types/intent';
import type { MarketResolverCandidate } from '../types/market';

// Use a real in-memory SQLite DB so we can verify fills are written
let testDb: DatabaseSync;

jest.mock('../db/auditRepository', () => ({ writeAudit: jest.fn() }));
jest.mock('../db/database', () => ({
  getDb: () => testDb,
}));

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Foreign keys off for test isolation (no need to seed users/wallets/intents)
  db.exec(SCHEMA_SQL.replace('PRAGMA foreign_keys = ON;', 'PRAGMA foreign_keys = OFF;'));
  return db;
}

const MARKET: MarketResolverCandidate = {
  marketId: 'mkt-1',
  title: 'Test Market',
  yesTokenId: 'yes-token',
  noTokenId: 'no-token',
  status: 'active',
  liquidityUsdc: 10_000,
  resolutionDate: null,
  confidence: 0.9,
  bestBid: 0.38,
  bestAsk: 0.40,
  dataUpdatedAt: new Date(),
};

const INTENT: TradeIntent = {
  action: 'trade',
  marketQuery: 'test',
  outcome: 'YES',
  side: 'BUY',
  maxSpendUSDC: 10,
  limitPrice: 0.40,
  orderType: 'GTD',
  expirationSeconds: 300,
  rationale: 'test trade',
  confidence: 0.9,
};

const INPUT: SimulateTradeInput = {
  intent: INTENT,
  resolvedMarket: MARKET,
  marketPrice: 0.40,
  agentWalletId: 'agent-1',
  userId: 'user-1',
  policyId: 'policy-1',
  tradeIntentId: 'intent-1',
};

beforeEach(() => {
  testDb = makeDb();
});

afterEach(() => {
  testDb.close();
});

describe('PaperTradingSimulator — in-memory state', () => {
  it('creates initial state correctly', () => {
    const state = createSimulatorState('agent-1', 100);
    expect(state.budgetUSDC).toBe(100);
    expect(state.usedUSDC).toBe(0);
    expect(state.tradeCount).toBe(0);
    expect(Object.keys(state.openOrders)).toHaveLength(0);
  });

  it('fills a buy order when limit price >= market price', () => {
    const state = createSimulatorState('agent-1', 100);
    const result = simulateTrade(state, INPUT);
    expect(result.success).toBe(true);
    expect(result.fillPrice).not.toBeNull();
    expect(result.fillSize).toBeGreaterThan(0);
  });

  it('does not fill when limit price is below market price', () => {
    const state = createSimulatorState('agent-1', 100);
    const result = simulateTrade(state, {
      ...INPUT,
      intent: { ...INTENT, limitPrice: 0.30 },
      marketPrice: 0.40,
    });
    expect(result.success).toBe(true);
    expect(result.fillPrice).toBeNull();
  });

  it('handles partial fill when order size is large relative to liquidity', () => {
    const lowLiquidityMarket: MarketResolverCandidate = { ...MARKET, liquidityUsdc: 50 };
    const state = createSimulatorState('agent-1', 1000);
    const result = simulateTrade(state, {
      ...INPUT,
      resolvedMarket: lowLiquidityMarket,
      intent: { ...INTENT, maxSpendUSDC: 100 },
    });
    expect(result.success).toBe(true);
    if (result.fillPrice !== null) {
      expect(result.partialFill).toBe(true);
    }
  });

  it('can cancel a specific open order', () => {
    const state = createSimulatorState('agent-1', 100);
    const result = simulateTrade(state, {
      ...INPUT,
      intent: { ...INTENT, limitPrice: 0.10 },
      marketPrice: 0.50,
    });
    Object.assign(state, result.newState);

    const openOrderIds = Object.keys(state.openOrders);
    if (openOrderIds.length > 0) {
      const cancelResult = cancelSimulatedOrder(state, openOrderIds[0]);
      expect(cancelResult.success).toBe(true);
      expect(cancelResult.newState.openOrders![openOrderIds[0]]).toBeUndefined();
    }
  });

  it('can cancel all open orders', () => {
    const state = createSimulatorState('agent-1', 100);
    for (let i = 0; i < 2; i++) {
      const result = simulateTrade(state, {
        ...INPUT,
        tradeIntentId: `intent-unfilled-${i}`,
        intent: { ...INTENT, limitPrice: 0.10 },
        marketPrice: 0.50,
      });
      Object.assign(state, result.newState);
    }
    const newState = cancelAllSimulatedOrders(state);
    expect(Object.keys(newState.openOrders ?? {})).toHaveLength(0);
  });

  it('handles NO outcome trade correctly', () => {
    const state = createSimulatorState('agent-1', 100);
    const result = simulateTrade(state, {
      ...INPUT,
      intent: { ...INTENT, outcome: 'NO' },
    });
    expect(result.success).toBe(true);
  });

  it('returns error for zero computed size', () => {
    const state = createSimulatorState('agent-1', 100);
    const badIntent = { ...INTENT, maxSpendUSDC: undefined, size: undefined };
    const result = simulateTrade(state, { ...INPUT, intent: badIntent as TradeIntent });
    expect(result.success).toBe(false);
    expect(result.errorMessage).not.toBeNull();
  });

  it('sell fills when limit price <= market price', () => {
    const state = createSimulatorState('agent-1', 100);
    const result = simulateTrade(state, {
      ...INPUT,
      intent: { ...INTENT, side: 'SELL', limitPrice: 0.35 },
      marketPrice: 0.40,
    });
    expect(result.success).toBe(true);
    expect(result.fillPrice).not.toBeNull();
  });

  it('sell does not fill when limit price > market price', () => {
    const state = createSimulatorState('agent-1', 100);
    const result = simulateTrade(state, {
      ...INPUT,
      intent: { ...INTENT, side: 'SELL', limitPrice: 0.50 },
      marketPrice: 0.40,
    });
    expect(result.success).toBe(true);
    expect(result.fillPrice).toBeNull();
  });
});

describe('PaperTradingSimulator — DB persistence', () => {
  it('writes an order row to the database on every trade', () => {
    const state = createSimulatorState('agent-1', 100);
    simulateTrade(state, INPUT);

    const orders = testDb.prepare('SELECT * FROM orders WHERE agent_wallet_id = ?').all('agent-1') as { id: string; status: string }[];
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('filled');
  });

  it('writes a fill row to the database when trade fills', () => {
    const state = createSimulatorState('agent-1', 100);
    simulateTrade(state, INPUT);

    const fills = testDb.prepare('SELECT * FROM fills').all() as { price: number; size: number }[];
    expect(fills).toHaveLength(1);
    expect(fills[0].price).toBeCloseTo(0.40, 3);
    expect(fills[0].size).toBeGreaterThan(0);
  });

  it('does NOT write a fill row when the order does not fill', () => {
    const state = createSimulatorState('agent-1', 100);
    simulateTrade(state, {
      ...INPUT,
      intent: { ...INTENT, limitPrice: 0.10 },
      marketPrice: 0.50,
    });

    const orders = testDb.prepare('SELECT * FROM orders').all() as { status: string }[];
    const fills = testDb.prepare('SELECT * FROM fills').all();
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('open');
    expect(fills).toHaveLength(0);
  });

  it('fill price * fill size matches the recorded spend', () => {
    const state = createSimulatorState('agent-1', 100);
    const result = simulateTrade(state, INPUT);

    const fills = testDb.prepare('SELECT price, size FROM fills').all() as { price: number; size: number }[];
    expect(fills).toHaveLength(1);
    expect(fills[0].price * fills[0].size).toBeCloseTo(result.fillPrice! * result.fillSize!, 6);
  });

  it('accumulates multiple fills across sequential trades', () => {
    const state = createSimulatorState('agent-1', 100);

    simulateTrade(state, { ...INPUT, tradeIntentId: 'intent-a' });
    simulateTrade(state, { ...INPUT, tradeIntentId: 'intent-b' });

    const fills = testDb.prepare('SELECT * FROM fills').all();
    const orders = testDb.prepare('SELECT * FROM orders').all();
    expect(orders).toHaveLength(2);
    expect(fills).toHaveLength(2);
  });

  it('totalSpent computed from DB matches sum of fill costs', () => {
    const state = createSimulatorState('agent-1', 100);

    simulateTrade(state, { ...INPUT, tradeIntentId: 'intent-a' });
    simulateTrade(state, { ...INPUT, tradeIntentId: 'intent-b', intent: { ...INTENT, maxSpendUSDC: 5 } });

    const { total } = testDb.prepare(`
      SELECT COALESCE(SUM(f.price * f.size), 0) as total
      FROM fills f JOIN orders o ON o.id = f.order_id
      WHERE o.agent_wallet_id = 'agent-1'
    `).get() as { total: number };

    expect(total).toBeGreaterThan(0);
    // Should be approximately 10 + 5 = 15 USDC
    expect(total).toBeCloseTo(15, 0);
  });
});

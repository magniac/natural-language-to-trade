import { buildNormalizedOrder } from '../clob/orderBuilder';
import * as marketRepo from '../market/marketRepository';
import type { TradeIntent } from '../types/intent';
import type { MarketResolverCandidate } from '../types/market';

jest.mock('../market/marketRepository');
const mockGetTokenByTokenId = marketRepo.getTokenByTokenId as jest.Mock;

const MARKET: MarketResolverCandidate = {
  marketId: 'mkt-1',
  title: 'Test',
  yesTokenId: 'yes-token',
  noTokenId: 'no-token',
  status: 'active',
  liquidityUsdc: 5000,
  resolutionDate: null,
  confidence: 0.9,
  bestBid: 0.39,
  bestAsk: 0.41,
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
  rationale: 'test',
  confidence: 0.9,
};

beforeEach(() => {
  mockGetTokenByTokenId.mockReturnValue({ marketId: 'mkt-1', outcome: 'YES', tickSize: 0.01 });
});

describe('OrderBuilder', () => {
  it('builds a valid GTD BUY order', () => {
    const result = buildNormalizedOrder(INTENT, MARKET, 'agent-1', 'intent-1');
    expect(result.success).toBe(true);
    expect(result.order!.tokenId).toBe('yes-token');
    expect(result.order!.side).toBe('BUY');
    expect(result.order!.size).toBeGreaterThan(0);
    expect(result.order!.expirationTimestamp).not.toBeNull();
    expect(result.order!.idempotencyKey).toContain('intent-1');
  });

  it('uses noTokenId for NO outcome', () => {
    const result = buildNormalizedOrder(
      { ...INTENT, outcome: 'NO' },
      MARKET,
      'agent-1',
      'intent-1',
    );
    expect(result.success).toBe(true);
    expect(result.order!.tokenId).toBe('no-token');
  });

  it('calculates size from maxSpendUSDC and limitPrice', () => {
    const result = buildNormalizedOrder(INTENT, MARKET, 'agent-1', 'intent-1');
    expect(result.order!.size).toBeCloseTo(10 / 0.40, 1);
  });

  it('uses an authoritative live tick instead of rounding with stale cached metadata', () => {
    const result = buildNormalizedOrder(
      { ...INTENT, limitPrice: 0.194, maxSpendUSDC: 1 },
      MARKET,
      'agent-1',
      'intent-1',
      0.001,
    );

    expect(result.success).toBe(true);
    expect(result.order!.price).toBe(0.194);
    expect(result.order!.amountUsdc).toBe(1);
    expect(result.order!.executionOrderType).toBe('FOK');
    expect(result.order!.size).toBe(5.154639);
  });

  it('uses direct size when provided', () => {
    const intent = { ...INTENT, maxSpendUSDC: undefined, size: 50 };
    const result = buildNormalizedOrder(intent as TradeIntent, MARKET, 'agent-1', 'intent-1');
    expect(result.success).toBe(true);
    expect(result.order!.size).toBe(50);
  });

  it('rejects when token not found in database', () => {
    mockGetTokenByTokenId.mockReturnValue(null);
    const result = buildNormalizedOrder(INTENT, MARKET, 'agent-1', 'intent-1');
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('not found in database');
  });

  it('rejects when market has no YES token', () => {
    const market = { ...MARKET, yesTokenId: '' };
    const result = buildNormalizedOrder(INTENT, market, 'agent-1', 'intent-1');
    expect(result.success).toBe(false);
  });

  it('does not set expiration for GTC orders', () => {
    const result = buildNormalizedOrder(
      { ...INTENT, orderType: 'GTC', expirationSeconds: undefined },
      MARKET,
      'agent-1',
      'intent-1',
    );
    expect(result.success).toBe(true);
    expect(result.order!.expirationTimestamp).toBeNull();
  });

  it('produces a deterministic idempotency key', () => {
    const r1 = buildNormalizedOrder(INTENT, MARKET, 'agent-1', 'intent-1');
    const r2 = buildNormalizedOrder(INTENT, MARKET, 'agent-1', 'intent-1');
    expect(r1.order!.idempotencyKey).toBe(r2.order!.idempotencyKey);
  });
});

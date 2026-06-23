import { runPolicyEngine, checkLLMPolicy } from '../policy/policyEngine';
import type { PolicyEngineInput, AccountState, UsageState, MarketState } from '../policy/policyEngine';
import type { AgentPolicy } from '../types/policy';
import type { TradeIntent } from '../types/intent';
import type { MarketResolverCandidate } from '../types/market';

const NOW_SEC = Math.floor(Date.now() / 1000);

const BASE_POLICY: AgentPolicy = {
  version: '1',
  userWallet: '0xUser',
  agentWallet: '0xAgent',
  sessionKey: '0xSession',
  createdAt: NOW_SEC - 3600,
  expiresAt: NOW_SEC + 86400,
  revocationNonce: 'nonce-1',
  llm: {
    allowedModels: ['anthropic/claude-haiku-4-5-20251001'],
    maxRequestsPerHour: 20,
    maxTokensPerRequest: 4000,
    maxSpendPerDayUSDC: 5,
  },
  trading: {
    maxBudgetUSDC: 100,
    maxOrderSizeUSDC: 20,
    maxDailySpendUSDC: 50,
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

const BASE_INTENT: TradeIntent = {
  action: 'trade',
  marketQuery: 'Will BTC hit 100k?',
  outcome: 'YES',
  side: 'BUY',
  maxSpendUSDC: 10,
  limitPrice: 0.35,
  orderType: 'GTD',
  expirationSeconds: 300,
  rationale: 'Good trade',
  confidence: 0.85,
};

const BASE_MARKET: MarketResolverCandidate = {
  marketId: 'market-1',
  title: 'Will BTC hit $100k?',
  yesTokenId: 'token-yes-1',
  noTokenId: 'token-no-1',
  status: 'active',
  liquidityUsdc: 5000,
  resolutionDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  confidence: 0.92,
  bestBid: 0.34,
  bestAsk: 0.36,
  dataUpdatedAt: new Date(),
};

const BASE_ACCOUNT: AccountState = {
  budgetRemainingUSDC: 90,
  dailySpendUSDC: 5,
  openOrderCount: 1,
  positionSizeByMarket: {},
};

const BASE_USAGE: UsageState = {
  llmRequestsLastHour: 2,
  llmSpendTodayUSDC: 0.5,
  policyActive: true,
  policyExpired: false,
  sessionKeyRevoked: false,
  intentNonceUsed: false,
};

const BASE_MARKET_STATE: MarketState = {
  marketId: 'market-1',
  tokenId: 'token-yes-1',
  spreadBps: 50,
  bestBid: 0.34,
  bestAsk: 0.36,
  liquidityUsdc: 5000,
  dataAgeMs: 30_000,
  isActive: true,
};

function makeInput(overrides: Partial<PolicyEngineInput> = {}): PolicyEngineInput {
  return {
    intent: BASE_INTENT,
    policy: BASE_POLICY,
    resolvedMarket: BASE_MARKET,
    accountState: BASE_ACCOUNT,
    usageState: BASE_USAGE,
    marketState: BASE_MARKET_STATE,
    ...overrides,
  };
}

describe('PolicyEngine — allowed cases', () => {
  it('allows a valid GTD buy', () => {
    const result = runPolicyEngine(makeInput());
    expect(result.allowed).toBe(true);
    expect(result.reasons).toHaveLength(0);
    expect(result.normalizedIntent).not.toBeNull();
    expect(result.riskSummary).not.toBeNull();
  });

  it('produces a risk summary with correct values', () => {
    const result = runPolicyEngine(makeInput());
    expect(result.riskSummary!.orderValueUsdc).toBe(10);
    expect(result.riskSummary!.liquidityUsdc).toBe(5000);
  });
});

describe('PolicyEngine — denied cases', () => {
  it('denies when policy is inactive', () => {
    const result = runPolicyEngine(makeInput({ usageState: { ...BASE_USAGE, policyActive: false } }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('not active'))).toBe(true);
  });

  it('denies when policy is expired', () => {
    const result = runPolicyEngine(makeInput({ usageState: { ...BASE_USAGE, policyExpired: true } }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.toLowerCase().includes('expir'))).toBe(true);
  });

  it('denies replayed nonce', () => {
    const result = runPolicyEngine(makeInput({ usageState: { ...BASE_USAGE, intentNonceUsed: true } }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('replay'))).toBe(true);
  });

  it('denies order exceeding max order size', () => {
    const result = runPolicyEngine(makeInput({
      intent: { ...BASE_INTENT, maxSpendUSDC: 25 },  // > maxOrderSizeUSDC 20
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('max order size'))).toBe(true);
  });

  it('denies when daily spend limit would be exceeded', () => {
    const result = runPolicyEngine(makeInput({
      accountState: { ...BASE_ACCOUNT, dailySpendUSDC: 45 },  // 45 + 10 = 55 > 50
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('Daily spend'))).toBe(true);
  });

  it('denies when budget is insufficient', () => {
    const result = runPolicyEngine(makeInput({
      accountState: { ...BASE_ACCOUNT, budgetRemainingUSDC: 5 },  // < 10
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('remaining budget'))).toBe(true);
  });

  it('denies when too many open orders', () => {
    const result = runPolicyEngine(makeInput({
      accountState: { ...BASE_ACCOUNT, openOrderCount: 5 },  // = max 5
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('Too many open orders'))).toBe(true);
  });

  it('denies disallowed order type (FOK)', () => {
    const result = runPolicyEngine(makeInput({
      intent: { ...BASE_INTENT, orderType: 'FOK' },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('"FOK"'))).toBe(true);
  });

  it('denies disallowed side', () => {
    const policy = { ...BASE_POLICY, trading: { ...BASE_POLICY.trading, allowedSides: ['BUY' as const] } };
    const result = runPolicyEngine(makeInput({
      policy,
      intent: { ...BASE_INTENT, side: 'SELL' },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('"SELL"'))).toBe(true);
  });

  it('denies invalid price (out of [0.01, 0.99])', () => {
    const result = runPolicyEngine(makeInput({
      intent: { ...BASE_INTENT, limitPrice: 0.001 },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('valid range'))).toBe(true);
  });

  it('denies stale market data', () => {
    const result = runPolicyEngine(makeInput({
      marketState: { ...BASE_MARKET_STATE, dataAgeMs: 10 * 60 * 1000 },  // 10 min > 5 min threshold
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('stale'))).toBe(true);
  });

  it('denies inactive market', () => {
    const result = runPolicyEngine(makeInput({
      marketState: { ...BASE_MARKET_STATE, isActive: false },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('not active'))).toBe(true);
  });

  it('denies wide spread', () => {
    const result = runPolicyEngine(makeInput({
      marketState: { ...BASE_MARKET_STATE, spreadBps: 1000 },  // > max 500
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('Spread too wide'))).toBe(true);
  });

  it('denies insufficient liquidity', () => {
    const result = runPolicyEngine(makeInput({
      resolvedMarket: { ...BASE_MARKET, liquidityUsdc: 50 },  // < min 100
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('Insufficient liquidity'))).toBe(true);
  });

  it('denies GTD order without expirationSeconds', () => {
    const { expirationSeconds: _, ...noExpiry } = BASE_INTENT;
    const result = runPolicyEngine(makeInput({ intent: noExpiry as TradeIntent }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('expirationSeconds'))).toBe(true);
  });

  it('denies market resolving within 1 hour', () => {
    const result = runPolicyEngine(makeInput({
      resolvedMarket: { ...BASE_MARKET, resolutionDate: new Date(Date.now() + 30 * 60 * 1000) },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('resolves within'))).toBe(true);
  });

  it('denies when LLM hourly limit exceeded', () => {
    const result = runPolicyEngine(makeInput({
      usageState: { ...BASE_USAGE, llmRequestsLastHour: 20 },  // = max 20
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('LLM request limit'))).toBe(true);
  });

  it('denies market not in allowedMarkets list when list is non-empty', () => {
    const policy = { ...BASE_POLICY, trading: { ...BASE_POLICY.trading, allowedMarkets: ['other-market'] } };
    const result = runPolicyEngine(makeInput({ policy }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('not in the allowed markets list'))).toBe(true);
  });

  it('denies expired policy by timestamp', () => {
    const policy = { ...BASE_POLICY, expiresAt: NOW_SEC - 100 };
    const result = runPolicyEngine(makeInput({ policy }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('expiry timestamp'))).toBe(true);
  });

  it('denies session key revoked', () => {
    const result = runPolicyEngine(makeInput({ usageState: { ...BASE_USAGE, sessionKeyRevoked: true } }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('revoked'))).toBe(true);
  });
});

describe('PolicyEngine — LLM policy checks', () => {
  it('allows a valid LLM request', () => {
    const result = checkLLMPolicy(BASE_POLICY, BASE_USAGE, 'anthropic/claude-haiku-4-5-20251001', 1000);
    expect(result.allowed).toBe(true);
  });

  it('denies disallowed model', () => {
    const result = checkLLMPolicy(BASE_POLICY, BASE_USAGE, 'openai/gpt-4o', 1000);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('not in the allowed models list'))).toBe(true);
  });

  it('denies when token estimate exceeds max', () => {
    const result = checkLLMPolicy(BASE_POLICY, BASE_USAGE, 'anthropic/claude-haiku-4-5-20251001', 5000);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('Estimated tokens'))).toBe(true);
  });
});

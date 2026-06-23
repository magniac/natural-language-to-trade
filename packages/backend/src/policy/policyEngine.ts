import type { TradeIntent } from '../types/intent';
import type { AgentPolicy } from '../types/policy';
import type { MarketResolverCandidate } from '../types/market';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface AccountState {
  budgetRemainingUSDC: number;
  dailySpendUSDC: number;
  openOrderCount: number;
  positionSizeByMarket: Record<string, number>;
}

export interface UsageState {
  llmRequestsLastHour: number;
  llmSpendTodayUSDC: number;
  policyActive: boolean;
  policyExpired: boolean;
  sessionKeyRevoked: boolean;
  intentNonceUsed: boolean;
}

export interface MarketState {
  marketId: string;
  tokenId: string;
  spreadBps: number;
  bestBid: number | null;
  bestAsk: number | null;
  liquidityUsdc: number;
  dataAgeMs: number;
  isActive: boolean;
}

export interface PolicyEngineInput {
  intent: TradeIntent;
  policy: AgentPolicy;
  resolvedMarket: MarketResolverCandidate;
  accountState: AccountState;
  usageState: UsageState;
  marketState: MarketState;
}

// ─── Output types ─────────────────────────────────────────────────────────────

export interface RiskSummary {
  orderValueUsdc: number;
  budgetUtilizationPct: number;
  dailySpendUtilizationPct: number;
  spreadBps: number;
  liquidityUsdc: number;
  marketDataAgeMs: number;
}

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  normalizedIntent: TradeIntent | null;
  riskSummary: RiskSummary | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MARKET_DATA_AGE_MS = 5 * 60 * 1000;   // 5 minutes — tied to market refresh interval

// ─── Engine ───────────────────────────────────────────────────────────────────

/**
 * Pure, deterministic policy engine.
 * NO network calls, NO LLM calls.
 * Returns explicit allow/deny with reasons.
 * Deny by default.
 */
export function runPolicyEngine(input: PolicyEngineInput): PolicyDecision {
  const reasons: string[] = [];
  const { intent, policy, resolvedMarket, accountState, usageState, marketState } = input;
  const trading = policy.trading;

  // ── Policy-level checks ──
  if (!usageState.policyActive) reasons.push('Policy is not active');
  if (usageState.policyExpired) reasons.push('Policy has expired');
  if (usageState.sessionKeyRevoked) reasons.push('Session key has been revoked');
  if (usageState.intentNonceUsed) reasons.push('Duplicate intent ID — potential replay attack');

  const nowSec = Math.floor(Date.now() / 1000);
  if (policy.expiresAt <= nowSec) reasons.push('Policy expiry timestamp has passed');

  // ── Market identity checks ──
  if (!resolvedMarket.marketId) reasons.push('No market ID resolved');
  if (!resolvedMarket.yesTokenId || !resolvedMarket.noTokenId)
    reasons.push('Market token IDs missing — do not trade with incomplete market data');

  if (trading.allowedMarkets.length > 0 && !trading.allowedMarkets.includes(resolvedMarket.marketId))
    reasons.push(`Market ${resolvedMarket.marketId} is not in the allowed markets list`);

  // ── Market state checks ──
  if (!marketState.isActive) reasons.push('Market is not active');

  if (marketState.dataAgeMs > MAX_MARKET_DATA_AGE_MS)
    reasons.push(`Market data is stale (${Math.round(marketState.dataAgeMs / 1000)}s old, max ${MAX_MARKET_DATA_AGE_MS / 1000}s)`);

  if (trading.minLiquidityUSDC !== null && resolvedMarket.liquidityUsdc < trading.minLiquidityUSDC)
    reasons.push(`Insufficient liquidity: $${resolvedMarket.liquidityUsdc} < minimum $${trading.minLiquidityUSDC}`);

  if (trading.maxSpreadBps !== null && marketState.spreadBps > trading.maxSpreadBps)
    reasons.push(`Spread too wide: ${marketState.spreadBps}bps > max ${trading.maxSpreadBps}bps`);

  // Check near-resolution
  if (resolvedMarket.resolutionDate && trading.nearResolutionHours !== null) {
    const msToResolution = resolvedMarket.resolutionDate.getTime() - Date.now();
    if (msToResolution < trading.nearResolutionHours * 60 * 60 * 1000)
      reasons.push(`Market resolves within ${trading.nearResolutionHours} hour(s) — trading blocked near resolution`);
  }

  // ── Side/outcome/type checks ──
  if (!trading.allowedSides.includes(intent.side))
    reasons.push(`Side "${intent.side}" is not in the allowed sides list`);

  if (!trading.allowedOrderTypes.includes(intent.orderType))
    reasons.push(`Order type "${intent.orderType}" is not in the allowed order types list`);

  // ── Order size checks ──
  const orderValueUsdc = intent.maxSpendUSDC ?? (intent.size ? intent.size * intent.limitPrice : 0);
  if (orderValueUsdc <= 0)
    reasons.push('Order value could not be determined (no maxSpendUSDC or size)');

  if (orderValueUsdc > trading.maxOrderSizeUSDC)
    reasons.push(`Order size $${orderValueUsdc} exceeds max order size $${trading.maxOrderSizeUSDC}`);

  // ── Budget checks (BUY only — sells return USDC, never spend it) ──
  if (intent.side === 'BUY') {
    if (orderValueUsdc > accountState.budgetRemainingUSDC)
      reasons.push(`Order $${orderValueUsdc} exceeds remaining budget $${accountState.budgetRemainingUSDC}`);

    if (accountState.dailySpendUSDC + orderValueUsdc > trading.maxDailySpendUSDC)
      reasons.push(`Daily spend limit exceeded: $${accountState.dailySpendUSDC} + $${orderValueUsdc} > $${trading.maxDailySpendUSDC}`);
  }

  // ── Open orders check ──
  if (accountState.openOrderCount >= trading.maxOpenOrders)
    reasons.push(`Too many open orders: ${accountState.openOrderCount} >= max ${trading.maxOpenOrders}`);

  // ── Price checks ──
  if (intent.limitPrice < 0.01 || intent.limitPrice > 0.99)
    reasons.push(`Limit price ${intent.limitPrice} is outside valid range [0.01, 0.99]`);

  if (trading.maxPrice !== null && intent.limitPrice > trading.maxPrice)
    reasons.push(`Limit price ${intent.limitPrice} exceeds policy max price ${trading.maxPrice}`);

  // Price must be below best ask for buys, above best bid for sells
  if (intent.side === 'BUY' && marketState.bestAsk !== null && intent.limitPrice > marketState.bestAsk * 1.05)
    reasons.push(`Buy limit price ${intent.limitPrice} is significantly above best ask ${marketState.bestAsk}`);

  if (intent.side === 'SELL' && marketState.bestBid !== null && intent.limitPrice < marketState.bestBid * 0.95)
    reasons.push(`Sell limit price ${intent.limitPrice} is significantly below best bid ${marketState.bestBid}`);

  // ── Expiration checks ──
  if (intent.orderType === 'GTD') {
    if (!intent.expirationSeconds)
      reasons.push('GTD order requires expirationSeconds');
    else {
      if (trading.minExpirationSeconds !== null && intent.expirationSeconds < trading.minExpirationSeconds)
        reasons.push(`Expiration ${intent.expirationSeconds}s is less than min ${trading.minExpirationSeconds}s`);
      if (trading.maxExpirationSeconds !== null && intent.expirationSeconds > trading.maxExpirationSeconds)
        reasons.push(`Expiration ${intent.expirationSeconds}s exceeds max ${trading.maxExpirationSeconds}s`);
    }
  }

  // ── LLM usage checks ──
  if (usageState.llmRequestsLastHour >= policy.llm.maxRequestsPerHour)
    reasons.push(`LLM request limit exceeded: ${usageState.llmRequestsLastHour}/${policy.llm.maxRequestsPerHour} per hour`);

  if (usageState.llmSpendTodayUSDC >= policy.llm.maxSpendPerDayUSDC)
    reasons.push(`LLM daily spend exceeded: $${usageState.llmSpendTodayUSDC}/$${policy.llm.maxSpendPerDayUSDC}`);

  const allowed = reasons.length === 0;

  const riskSummary: RiskSummary = {
    orderValueUsdc,
    budgetUtilizationPct: trading.maxBudgetUSDC > 0
      ? (orderValueUsdc / trading.maxBudgetUSDC) * 100 : 0,
    dailySpendUtilizationPct: trading.maxDailySpendUSDC > 0
      ? ((accountState.dailySpendUSDC + orderValueUsdc) / trading.maxDailySpendUSDC) * 100 : 0,
    spreadBps: marketState.spreadBps,
    liquidityUsdc: resolvedMarket.liquidityUsdc,
    marketDataAgeMs: marketState.dataAgeMs,
  };

  return {
    allowed,
    reasons,
    normalizedIntent: allowed ? intent : null,
    riskSummary: allowed ? riskSummary : null,
  };
}

export function checkLLMPolicy(
  policy: AgentPolicy,
  usageState: UsageState,
  requestedModel: string,
  estimatedTokens: number
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!usageState.policyActive) reasons.push('Policy is not active');
  if (usageState.policyExpired) reasons.push('Policy has expired');
  if (usageState.sessionKeyRevoked) reasons.push('Session key has been revoked');

  if (!policy.llm.allowedModels.includes(requestedModel))
    reasons.push(`Model "${requestedModel}" is not in the allowed models list`);

  if (estimatedTokens > policy.llm.maxTokensPerRequest)
    reasons.push(`Estimated tokens ${estimatedTokens} exceeds max ${policy.llm.maxTokensPerRequest} per request`);

  if (usageState.llmRequestsLastHour >= policy.llm.maxRequestsPerHour)
    reasons.push(`LLM hourly request limit reached: ${usageState.llmRequestsLastHour}/${policy.llm.maxRequestsPerHour}`);

  if (usageState.llmSpendTodayUSDC >= policy.llm.maxSpendPerDayUSDC)
    reasons.push(`LLM daily spend limit reached: $${usageState.llmSpendTodayUSDC}/$${policy.llm.maxSpendPerDayUSDC}`);

  return { allowed: reasons.length === 0, reasons };
}

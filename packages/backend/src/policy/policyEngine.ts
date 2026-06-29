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

  // ── Venue gate (default to Polymarket-only for policies signed before multi-venue) ──
  if (!(policy.allowedVenues ?? ['polymarket']).includes('polymarket'))
    reasons.push('Polymarket trading is not allowed by this policy');

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

// ─── Hyperliquid policy (deterministic; shares global budget/daily caps) ──────

export interface HyperliquidPolicyInput {
  policy: AgentPolicy;
  coin: string;
  side: 'BUY' | 'SELL';
  orderValueUsdc: number;
  marketType?: 'spot' | 'perp';
  reduceOnly?: boolean;
  accountState: AccountState;   // budget/daily/openOrders are shared across venues
  usageState: UsageState;
}

export function runHyperliquidPolicy(input: HyperliquidPolicyInput): { allowed: boolean; reasons: string[] } {
  const { policy, coin, side, orderValueUsdc, accountState, usageState } = input;
  const marketType = input.marketType ?? 'spot';
  const reduceOnly = input.reduceOnly === true;
  const reasons: string[] = [];
  const trading = policy.trading;
  const hl = policy.hyperliquid;

  // ── Policy-level ──
  if (!usageState.policyActive) reasons.push('Policy is not active');
  if (usageState.policyExpired) reasons.push('Policy has expired');
  if (usageState.sessionKeyRevoked) reasons.push('Session key has been revoked');
  if (policy.expiresAt <= Math.floor(Date.now() / 1000)) reasons.push('Policy expiry timestamp has passed');

  // ── Venue gate ──
  if (!(policy.allowedVenues ?? ['polymarket']).includes('hyperliquid'))
    reasons.push('Hyperliquid trading is not allowed by this policy');
  if (!hl) reasons.push('No Hyperliquid limits configured — re-sign the policy to enable Hyperliquid');

  // ── Side + coin allow-lists ──
  if (!trading.allowedSides.includes(side))
    reasons.push(`Side "${side}" is not in the allowed sides list`);
  if (hl && hl.allowedCoins.length > 0 && !hl.allowedCoins.map(c => c.toUpperCase()).includes(coin.toUpperCase()))
    reasons.push(`Coin ${coin} is not in the allowed Hyperliquid coins list`);

  // ── Order size (HL-specific + shared global cap) ──
  if (orderValueUsdc <= 0) reasons.push('Order value could not be determined');
  if (hl && orderValueUsdc > hl.maxOrderSizeUSDC)
    reasons.push(`Order size $${orderValueUsdc.toFixed(2)} exceeds Hyperliquid max order size $${hl.maxOrderSizeUSDC}`);
  if (orderValueUsdc > trading.maxOrderSizeUSDC)
    reasons.push(`Order size $${orderValueUsdc.toFixed(2)} exceeds max order size $${trading.maxOrderSizeUSDC}`);

  // ── Budget / daily (shared across venues) ──
  // Spot sells reduce inventory. Perp BUY/SELL both add exposure unless reduce-only.
  const consumesBudget = marketType === 'perp' ? !reduceOnly : side === 'BUY';
  if (consumesBudget) {
    if (orderValueUsdc > accountState.budgetRemainingUSDC)
      reasons.push(`Order $${orderValueUsdc.toFixed(2)} exceeds remaining budget $${accountState.budgetRemainingUSDC.toFixed(2)}`);
    if (accountState.dailySpendUSDC + orderValueUsdc > trading.maxDailySpendUSDC)
      reasons.push(`Daily spend limit exceeded: $${accountState.dailySpendUSDC.toFixed(2)} + $${orderValueUsdc.toFixed(2)} > $${trading.maxDailySpendUSDC}`);
  }

  // ── Open orders (shared) ──
  if (accountState.openOrderCount >= trading.maxOpenOrders)
    reasons.push(`Too many open orders: ${accountState.openOrderCount} >= max ${trading.maxOpenOrders}`);

  return { allowed: reasons.length === 0, reasons };
}

export interface HyperliquidLeveragePolicyInput {
  policy: AgentPolicy;
  coin: string;
  leverage: number;
  exchangeMaxLeverage: number;
  usageState: UsageState;
}

export function runHyperliquidLeveragePolicy(input: HyperliquidLeveragePolicyInput): { allowed: boolean; reasons: string[] } {
  const { policy, coin, leverage, exchangeMaxLeverage, usageState } = input;
  const reasons: string[] = [];
  const hl = policy.hyperliquid;

  if (!usageState.policyActive) reasons.push('Policy is not active');
  if (usageState.policyExpired) reasons.push('Policy has expired');
  if (usageState.sessionKeyRevoked) reasons.push('Session key has been revoked');
  if (policy.expiresAt <= Math.floor(Date.now() / 1000)) reasons.push('Policy expiry timestamp has passed');

  if (!(policy.allowedVenues ?? ['polymarket']).includes('hyperliquid'))
    reasons.push('Hyperliquid trading is not allowed by this policy');
  if (!hl) reasons.push('No Hyperliquid limits configured — re-sign the policy to enable Hyperliquid');

  if (hl && hl.allowedCoins.length > 0 && !hl.allowedCoins.map(c => c.toUpperCase()).includes(coin.toUpperCase()))
    reasons.push(`Coin ${coin} is not in the allowed Hyperliquid coins list`);

  if (!Number.isInteger(leverage) || leverage < 1)
    reasons.push('Leverage must be a whole number greater than or equal to 1');
  if (leverage > exchangeMaxLeverage)
    reasons.push(`Leverage ${leverage}x exceeds Hyperliquid max leverage ${exchangeMaxLeverage}x for ${coin}`);

  const policyMaxLeverage = hl?.maxLeverage ?? 1;
  if (leverage > policyMaxLeverage)
    reasons.push(`Leverage ${leverage}x exceeds policy max leverage ${policyMaxLeverage}x`);

  return { allowed: reasons.length === 0, reasons };
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

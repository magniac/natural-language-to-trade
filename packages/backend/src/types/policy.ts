export interface LLMPolicy {
  allowedModels: string[];
  maxRequestsPerHour: number;
  maxTokensPerRequest: number;
  maxSpendPerDayUSDC: number;
}

export interface TradingPolicy {
  maxBudgetUSDC: number;
  maxOrderSizeUSDC: number;
  maxDailySpendUSDC: number;
  maxOpenOrders: number;
  allowedMarkets: string[];           // empty = all
  allowedCategories: string[];        // empty = all
  allowedSides: ('BUY' | 'SELL')[];
  allowedOrderTypes: ('GTD' | 'GTC' | 'FOK' | 'FAK')[];
  maxPrice: number | null;
  minLiquidityUSDC: number | null;
  maxSpreadBps: number | null;
  nearResolutionHours: number | null; // null = no block; hours before resolution to stop trading
  minExpirationSeconds: number | null;
  maxExpirationSeconds: number | null;
}

export type Venue = 'polymarket' | 'hyperliquid';

export interface HyperliquidPolicy {
  maxOrderSizeUSDC: number;
  allowedCoins: string[];   // empty = any spot/perp coin
  maxSlippageBps: number;
  maxLeverage?: number;     // optional for policies signed before leverage controls
}

export interface AgentPolicy {
  version: '1';
  userWallet: string;
  agentWallet: string;
  sessionKey: string;
  createdAt: number;
  expiresAt: number;
  revocationNonce: string;
  llm: LLMPolicy;
  trading: TradingPolicy;
  // Optional so policies signed before multi-venue support remain valid. When absent,
  // only Polymarket is allowed (Hyperliquid requires a re-signed policy that opts in).
  allowedVenues?: Venue[];
  hyperliquid?: HyperliquidPolicy;
}

export type PolicyStatus = 'active' | 'expired' | 'revoked' | 'superseded';

export interface StoredPolicy {
  id: string;
  userId: string;
  agentWalletId: string;
  sessionKeyAddress: string;
  policyJson: AgentPolicy;
  policyHash: string;
  userSignature: string;
  status: PolicyStatus;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

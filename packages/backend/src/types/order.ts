export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'GTD' | 'GTC' | 'FOK' | 'FAK';
export type OrderStatus =
  | 'pending'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'unknown';

export interface NormalizedOrder {
  tradeIntentId: string;
  agentWalletId: string;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  price: number;
  /** Dollar amount for BUY-by-USDC marketable orders. Keeps $1.00 from being
   * rounded down to $0.9991 by the limit-order share-size precision rules. */
  amountUsdc?: number;
  size: number;
  /** Actual CLOB order type used when it differs from the policy-visible intent
   * order type. Dollar buys execute as FOK market orders to avoid resting. */
  executionOrderType?: OrderType;
  orderType: OrderType;
  expirationTimestamp: number | null;
  idempotencyKey: string;
}

export interface SignedOrder {
  normalizedOrder: NormalizedOrder;
  signedPayload: unknown;
  signerAddress: string;
  signedAt: Date;
}

export interface StoredOrder {
  id: string;
  tradeIntentId: string;
  agentWalletId: string;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  orderType: OrderType;
  expiration: number | null;
  signedOrderHash: string | null;
  clobOrderId: string | null;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Fill {
  id: string;
  orderId: string;
  clobTradeId: string;
  price: number;
  size: number;
  side: OrderSide;
  fee: number;
  createdAt: Date;
  rawJson: Record<string, unknown>;
}

export interface PostOrderResult {
  success: boolean;
  clobOrderId: string | null;
  errorMessage: string | null;
  clobStatus?: string | null;
  makingAmount?: string | null;
  takingAmount?: string | null;
  tradeIds?: string[];
  raw?: unknown;
}

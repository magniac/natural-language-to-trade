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
  size: number;
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
}

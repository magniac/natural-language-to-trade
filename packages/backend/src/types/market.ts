export type MarketStatus = 'active' | 'closed' | 'resolved' | 'paused' | 'unknown';
export type TokenOutcome = 'YES' | 'NO';

export interface MarketToken {
  tokenId: string;
  outcome: TokenOutcome;
  tickSize: number;
  negRisk: boolean;
}

export interface Market {
  marketId: string;
  eventId: string;
  title: string;
  description: string;
  status: MarketStatus;
  category: string;
  resolutionDate: Date | null;
  liquidityUsdc: number;
  volume24hUsdc: number;
  tags: string[];
  tokens: MarketToken[];
  metadata: Record<string, unknown>;
  updatedAt: Date;
}

export interface OrderbookEntry {
  price: number;
  size: number;
}

export interface Orderbook {
  marketId: string;
  tokenId: string;
  bids: OrderbookEntry[];
  asks: OrderbookEntry[];
  spreadBps: number;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  fetchedAt: Date;
}

export interface MarketResolverCandidate {
  marketId: string;
  title: string;
  yesTokenId: string;
  noTokenId: string;
  status: MarketStatus;
  liquidityUsdc: number;
  resolutionDate: Date | null;
  confidence: number;
  bestBid: number | null;
  bestAsk: number | null;
  dataUpdatedAt: Date;
}

export interface MarketResolverResult {
  query: string;
  candidates: MarketResolverCandidate[];
  ambiguous: boolean;
  refusalReason: string | null;
}

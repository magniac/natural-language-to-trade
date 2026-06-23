import type { TradeIntent } from '../types/intent';
import type { MarketResolverCandidate } from '../types/market';
import type { NormalizedOrder } from '../types/order';
import { getTokenByTokenId } from '../market/marketRepository';

export interface BuildOrderResult {
  success: boolean;
  order: NormalizedOrder | null;
  errorMessage: string | null;
}

function roundToTickSize(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

export function buildNormalizedOrder(
  intent: TradeIntent,
  resolvedMarket: MarketResolverCandidate,
  agentWalletId: string,
  tradeIntentId: string,
): BuildOrderResult {
  // Determine token ID from outcome — use only verified token IDs
  const tokenId = intent.outcome === 'YES'
    ? resolvedMarket.yesTokenId
    : resolvedMarket.noTokenId;

  if (!tokenId) {
    return { success: false, order: null, errorMessage: `No ${intent.outcome} token ID for market ${resolvedMarket.marketId}` };
  }

  // Verify this token exists in our database
  const tokenInfo = getTokenByTokenId(tokenId);
  if (!tokenInfo) {
    return {
      success: false,
      order: null,
      errorMessage: `Token ${tokenId} not found in database. Only tokens from verified market data may be traded.`,
    };
  }

  // Apply tick size precision
  const tickSize = tokenInfo.tickSize;
  const roundedPrice = roundToTickSize(intent.limitPrice, tickSize);

  if (Math.abs(roundedPrice - intent.limitPrice) > tickSize * 2) {
    return {
      success: false,
      order: null,
      errorMessage: `Price ${intent.limitPrice} is not compatible with tick size ${tickSize}`,
    };
  }

  // Calculate size from maxSpendUSDC or direct size
  let size: number;
  if (intent.size !== undefined) {
    size = intent.size;
  } else if (intent.maxSpendUSDC !== undefined) {
    size = intent.maxSpendUSDC / roundedPrice;
  } else {
    return { success: false, order: null, errorMessage: 'Cannot determine order size' };
  }

  // Round to 2 decimal places minimum
  size = Math.floor(size * 100) / 100;
  if (size <= 0) {
    return { success: false, order: null, errorMessage: 'Computed order size is zero or negative' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expirationTimestamp = intent.orderType === 'GTD' && intent.expirationSeconds
    ? nowSec + intent.expirationSeconds
    : null;

  const idempotencyKey = `${tradeIntentId}-${intent.outcome}-${intent.side}`;

  return {
    success: true,
    order: {
      tradeIntentId,
      agentWalletId,
      marketId: resolvedMarket.marketId,
      tokenId,
      side: intent.side,
      price: roundedPrice,
      size,
      orderType: intent.orderType,
      expirationTimestamp,
      idempotencyKey,
    },
    errorMessage: null,
  };
}

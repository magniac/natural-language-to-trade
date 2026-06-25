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

function floorToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

export function buildNormalizedOrder(
  intent: TradeIntent,
  resolvedMarket: MarketResolverCandidate,
  agentWalletId: string,
  tradeIntentId: string,
  tickSizeOverride?: number,
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
  // Live callers pass the current CLOB tick size. The repository value comes
  // from Gamma ingestion and may be stale or hardcoded to 0.01.
  const tickSize = tickSizeOverride ?? tokenInfo.tickSize;
  const roundedPrice = roundToTickSize(intent.limitPrice, tickSize);

  if (Math.abs(roundedPrice - intent.limitPrice) > tickSize * 2) {
    return {
      success: false,
      order: null,
      errorMessage: `Price ${intent.limitPrice} is not compatible with tick size ${tickSize}`,
    };
  }

  // Calculate size from maxSpendUSDC or direct size.
  // For live BUY-by-dollar orders, keep the original USDC amount too. Polymarket
  // market orders take BUY `amount` in dollars; plain limit orders take share
  // `size` and the SDK floors that size to 2 decimals. At prices like 0.194,
  // flooring `$1 / 0.194` to 5.15 shares signs a $0.9991 maker amount, which
  // CLOB rejects because marketable buys must be at least $1.
  let size: number;
  const amountUsdc = intent.side === 'BUY' ? intent.maxSpendUSDC : undefined;
  const executionOrderType = amountUsdc !== undefined ? 'FOK' as const : undefined;
  if (intent.size !== undefined) {
    size = intent.size;
  } else if (intent.maxSpendUSDC !== undefined) {
    size = intent.maxSpendUSDC / roundedPrice;
  } else {
    return { success: false, order: null, errorMessage: 'Cannot determine order size' };
  }

  // Limit orders are rounded exactly as the SDK will round them. BUY-by-dollar
  // marketable orders keep a high-precision estimated share size for display/DB;
  // the signed order's actual maker amount comes from amountUsdc.
  size = amountUsdc !== undefined ? floorToDecimals(size, 6) : floorToDecimals(size, 2);
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
      amountUsdc,
      size,
      executionOrderType,
      orderType: intent.orderType,
      expirationTimestamp,
      idempotencyKey,
    },
    errorMessage: null,
  };
}

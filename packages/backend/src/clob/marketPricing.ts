/**
 * Choose the limit sent with an order.
 *
 * A user-supplied limit is always honored. Without one, use the executable
 * top-of-book price exactly: best ask for a buy, best bid for a sell. The CLOB
 * quote already conforms to the market's current tick size, so rounding it
 * with cached market metadata can turn a taker order into a resting order.
 */
export function selectTradeLimitPrice(
  explicitPrice: number | undefined,
  topOfBookPrice: number | null,
  fallbackPrice = 0.5,
): number {
  const selected = explicitPrice ?? topOfBookPrice ?? fallbackPrice;
  return Number(Math.max(0.01, Math.min(0.99, selected)).toFixed(4));
}

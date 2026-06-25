import { selectTradeLimitPrice } from '../clob/marketPricing';
import { getExecutableTopOfBookPrice, interpretPostOrderResponse } from '../clob/clobTradingClient';

describe('selectTradeLimitPrice', () => {
  it('uses the exact executable quote by default', () => {
    expect(selectTradeLimitPrice(undefined, 0.194)).toBe(0.194);
  });

  it('does not add a crossing cushion to a buy quote', () => {
    expect(selectTradeLimitPrice(undefined, 0.19)).toBe(0.19);
  });

  it('honors an explicit user limit instead of the market quote', () => {
    expect(selectTradeLimitPrice(0.18, 0.194)).toBe(0.18);
  });

  it('falls back safely when no quote is available', () => {
    expect(selectTradeLimitPrice(undefined, null)).toBe(0.5);
  });
});

describe('getExecutableTopOfBookPrice', () => {
  const franceLikeBook = {
    bids: [
      { price: '0.191', size: '1000' },
      { price: '0.193', size: '97387.67' },
      { price: '0.001', size: '431638' },
    ],
    asks: [
      { price: '0.999', size: '19403875.33' },
      { price: '0.195', size: '162933.67' },
      { price: '0.194', size: '99687.68' },
    ],
    tick_size: '0.001',
  };

  it('uses the lowest ask for a buy order, not the bid returned by the price endpoint', () => {
    expect(getExecutableTopOfBookPrice(franceLikeBook, 'BUY')).toBe(0.194);
  });

  it('uses the highest bid for a sell order', () => {
    expect(getExecutableTopOfBookPrice(franceLikeBook, 'SELL')).toBe(0.193);
  });
});

describe('interpretPostOrderResponse', () => {
  it('treats CLOB error bodies as failed submissions even when the SDK does not throw', () => {
    expect(interpretPostOrderResponse({
      error: 'invalid amount for a marketable BUY order ($0.9991), min size: $1',
      status: 400,
    })).toMatchObject({
      success: false,
      clobOrderId: null,
      errorMessage: 'invalid amount for a marketable BUY order ($0.9991), min size: $1',
      clobStatus: '400',
    });
  });

  it('requires an orderID before reporting success', () => {
    expect(interpretPostOrderResponse({ success: true, status: 'matched' })).toMatchObject({
      success: false,
      clobOrderId: null,
      errorMessage: 'CLOB submission returned no orderID',
      clobStatus: 'matched',
    });
  });

  it('returns success when CLOB returns an orderID', () => {
    expect(interpretPostOrderResponse({ success: true, orderID: '0xabc', status: 'matched' })).toMatchObject({
      success: true,
      clobOrderId: '0xabc',
      errorMessage: null,
      clobStatus: 'matched',
    });
  });
});

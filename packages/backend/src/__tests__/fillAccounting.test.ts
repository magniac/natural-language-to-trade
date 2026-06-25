import { matchedFillFromAmounts, parseClobDecimalAmount } from '../clob/fillAccounting';

describe('live fill accounting', () => {
  it('treats CLOB matched amounts as decimal strings, not fixed-6 integers', () => {
    expect(parseClobDecimalAmount('5.154638')).toBe(5.154638);
    expect(parseClobDecimalAmount('0.999999')).toBe(0.999999);
  });

  it('computes BUY fill size and spend from matched post-order amounts', () => {
    const fill = matchedFillFromAmounts('BUY', '0.999999', '5.154638');

    expect(fill).toEqual({
      price: 0.999999 / 5.154638,
      size: 5.154638,
    });
    expect(fill!.price * fill!.size).toBeCloseTo(0.999999, 9);
  });

  it('computes SELL fill size and proceeds from matched post-order amounts', () => {
    const fill = matchedFillFromAmounts('SELL', '5.154638', '0.999999');

    expect(fill).toEqual({
      price: 0.999999 / 5.154638,
      size: 5.154638,
    });
  });
});

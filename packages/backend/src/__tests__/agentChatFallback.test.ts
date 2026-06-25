import { buildFalseTradeClaimResponse, buildToolFallbackResponse, normalizeChatHistory, type ExecutedToolCall } from '../agent/agentChat';

describe('buildToolFallbackResponse', () => {
  it('confirms a successful trade when the model returns empty content afterward', () => {
    const calls: ExecutedToolCall[] = [{
      name: 'place_trade',
      args: {},
      result: { success: true, mode: 'live', limitPrice: 0.194 },
    }];

    expect(buildToolFallbackResponse(calls)).toBe(
      'The trade was submitted successfully. See the order details below.',
    );
  });

  it('surfaces a trade failure instead of returning an empty bubble', () => {
    const calls: ExecutedToolCall[] = [{
      name: 'place_trade',
      args: {},
      result: { success: false, error: 'No matching market' },
    }];

    expect(buildToolFallbackResponse(calls)).toBe(
      "I couldn't place the trade: No matching market",
    );
  });

  it('returns null when no tool was called so the model can be retried safely', () => {
    expect(buildToolFallbackResponse([])).toBeNull();
  });
});

describe('normalizeChatHistory', () => {
  it('drops empty turns and merges consecutive roles into a valid transcript', () => {
    expect(normalizeChatHistory([
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Buy $1 on France' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'YES on the World Cup' },
    ])).toEqual([
      { role: 'user', content: 'Buy $1 on France\n\nYES on the World Cup' },
    ]);
  });

  it('caps old persisted history and starts on a user turn', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));

    const normalized = normalizeChatHistory(history, 5);
    expect(normalized).toHaveLength(4);
    expect(normalized[0].role).toBe('user');
    expect(normalized[3].content).toBe('message 11');
  });
});

describe('buildFalseTradeClaimResponse', () => {
  it('blocks a submitted-order claim when no trade tool succeeded', () => {
    expect(buildFalseTradeClaimResponse('Done — I placed the trade.', [])).toContain('No trade was placed');
  });

  it('surfaces the failed trade tool result instead of the model claim', () => {
    const response = buildFalseTradeClaimResponse('The order has been submitted.', [{
      name: 'place_trade',
      args: {},
      result: { success: false, error: 'CLOB submission failed: insufficient balance' },
    }]);

    expect(response).toBe("I couldn't place the trade: CLOB submission failed: insufficient balance");
  });

  it('allows success claims when place_trade actually succeeded', () => {
    const response = buildFalseTradeClaimResponse('The order has been submitted.', [{
      name: 'place_trade',
      args: {},
      result: { success: true },
    }]);

    expect(response).toBeNull();
  });
});

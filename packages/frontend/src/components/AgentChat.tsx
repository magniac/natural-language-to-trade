import React from 'react';
import Button from './Button';
import { loadSession, getSessionStatus, buildSignedHeaders, SESSION_SAVED_EVENT } from '../lib/sessionSigner';
import type { AgentSession } from '../lib/sessionSigner';

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  toolCalls?: ToolCall[];
  loading?: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  search_markets: 'Searched markets',
  search_hyperliquid_markets: 'Searched Hyperliquid',
  get_portfolio: 'Checked portfolio',
  place_trade: 'Placed trade',
};

const TOOL_ICONS: Record<string, string> = {
  search_markets: '🔍',
  search_hyperliquid_markets: '🪙',
  get_portfolio: '📊',
  place_trade: '💱',
};

function ToolCallCard({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = React.useState(tc.name === 'place_trade');
  const label = TOOL_LABELS[tc.name] ?? tc.name;
  const icon = TOOL_ICONS[tc.name] ?? '⚙';

  const result = tc.result as Record<string, unknown> | undefined;
  const isTradeSuccess = tc.name === 'place_trade' && result?.success === true;
  const isTradeDenied = tc.name === 'place_trade' && result?.policyDenied === true;
  const tradeIsLive = isTradeSuccess && result?.mode === 'live';

  return (
    <div style={{
      background: '#0f1117', border: '1px solid #2d3748', borderRadius: 8,
      marginTop: 8, overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '8px 12px', background: 'none', border: 'none',
          color: '#a0aec0', fontSize: 12, textAlign: 'left', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <span>{icon}</span>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {isTradeSuccess && <span style={{ color: '#4ade80', fontSize: 11 }}>{tradeIsLive ? '✓ live' : '✓ paper'}</span>}
        {isTradeDenied && <span style={{ color: '#f87171', fontSize: 11 }}>✗ denied</span>}
        {tc.error && <span style={{ color: '#f87171', fontSize: 11 }}>error</span>}
        <span style={{ marginLeft: 'auto', fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 12px 12px', borderTop: '1px solid #2d3748' }}>
          {tc.name === 'search_markets' && (() => {
            const r = tc.result as { found?: number; markets?: Array<{ title: string; yesAsk: number | null; noBid: number | null; liquidity: number }> } | undefined;
            if (!r?.markets?.length) return <p style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>No markets found.</p>;
            return (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {r.markets.map((m, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: '#e2e8f0', flex: 1, marginRight: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.title}>{m.title}</span>
                    <span style={{ color: '#4ade80', whiteSpace: 'nowrap' }}>
                      YES {m.yesAsk != null ? `$${m.yesAsk.toFixed(2)}` : '?'}
                    </span>
                    <span style={{ color: '#4b5563', marginLeft: 8, whiteSpace: 'nowrap', fontSize: 11 }}>
                      ${m.liquidity.toLocaleString()} liq
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}

          {tc.name === 'search_hyperliquid_markets' && (() => {
            const r = tc.result as { markets?: Array<{ title: string; coin: string; price: number | null }> } | undefined;
            if (!r?.markets?.length) return <p style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>No Hyperliquid coins found.</p>;
            return (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {r.markets.map((m, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: '#e2e8f0' }}>{m.coin}</span>
                    <span style={{ color: '#4ade80', whiteSpace: 'nowrap' }}>{m.price != null ? `$${m.price}` : '?'}</span>
                  </div>
                ))}
              </div>
            );
          })()}

          {tc.name === 'get_portfolio' && (() => {
            const r = tc.result as { budgetRemainingUSDC?: string; dailySpendUSDC?: string; openPositions?: Array<{ market: string; outcome: string; shares: string }>; hyperliquid?: { usdc: string; balances: Array<{ coin: string; total: string }> } | null } | undefined;
            return (
              <div style={{ marginTop: 8, fontSize: 12, color: '#a0aec0' }}>
                <p>Budget remaining: <strong style={{ color: '#e2e8f0' }}>${r?.budgetRemainingUSDC}</strong></p>
                <p>Today's spend: <strong style={{ color: '#e2e8f0' }}>${r?.dailySpendUSDC}</strong></p>
                {r?.openPositions && r.openPositions.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <p style={{ color: '#6b7280', marginBottom: 4 }}>Polymarket positions:</p>
                    {r.openPositions.map((p, i) => (
                      <p key={i}>{p.outcome} {p.shares} shares — <span style={{ color: '#6b7280' }}>{p.market}</span></p>
                    ))}
                  </div>
                )}
                {r?.hyperliquid && (
                  <div style={{ marginTop: 6 }}>
                    <p style={{ color: '#6b7280', marginBottom: 4 }}>Hyperliquid spot: <strong style={{ color: '#e2e8f0' }}>${r.hyperliquid.usdc} USDC</strong></p>
                    {r.hyperliquid.balances.map((b, i) => (
                      <p key={i}>{b.total} {b.coin}</p>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {tc.name === 'place_trade' && (() => {
            const r = tc.result as { success?: boolean; mode?: 'paper' | 'live'; venue?: string; status?: string | null; policyDenied?: boolean; ambiguous?: boolean; market?: string; side?: string; outcome?: string; coin?: string; price?: number; size?: number; fillPrice?: number; fillSize?: number; limitPrice?: number; orderValue?: number; clobOrderId?: string; oid?: number; resting?: boolean; reasons?: string[]; error?: string; candidates?: Array<{ id: string; title: string }> } | undefined;
            if (r?.success && r.venue === 'hyperliquid') {
              const filled = (r.fillSize ?? 0) > 0;
              return (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  <p style={{ color: '#4ade80', marginBottom: 4 }}>{filled ? 'Hyperliquid order filled' : 'Hyperliquid order submitted'}</p>
                  <p style={{ color: '#a0aec0' }}>{r.side} {filled ? r.fillSize : r.size} {r.coin} @ ${(r.fillPrice ?? r.price)?.toFixed(4)}</p>
                  <p style={{ color: '#6b7280' }}>{r.market}</p>
                  {r.oid != null && <p style={{ color: '#4b5563', fontFamily: 'monospace', fontSize: 11 }}>oid {r.oid}</p>}
                </div>
              );
            }
            if (r?.success) {
              const isLive = r.mode === 'live';
              const liveFilled = isLive && r.status?.toLowerCase() === 'matched';
              return (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  <p style={{ color: '#4ade80', marginBottom: 4 }}>
                    {isLive ? (liveFilled ? 'Live trade filled' : 'Live trade submitted') : 'Trade executed (paper)'}
                  </p>
                  {isLive ? (
                    <p style={{ color: '#a0aec0' }}>{r.side} {r.outcome} @ ${r.limitPrice?.toFixed(3)} · ${r.orderValue?.toFixed(2)} {liveFilled ? 'filled' : 'order'}</p>
                  ) : (
                    <p style={{ color: '#a0aec0' }}>{r.side} {r.outcome} @ ${r.fillPrice?.toFixed(3)} × {r.fillSize?.toFixed(2)} shares</p>
                  )}
                  <p style={{ color: '#6b7280' }}>{r.market}</p>
                  {isLive && r.clobOrderId && <p style={{ color: '#4b5563', fontFamily: 'monospace', fontSize: 11 }}>order {r.clobOrderId.slice(0, 14)}…</p>}
                </div>
              );
            }
            if (r?.policyDenied) return (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                <p style={{ color: '#f87171', marginBottom: 4 }}>Policy engine denied the trade</p>
                {r.reasons?.map((reason, i) => <p key={i} style={{ color: '#6b7280' }}>• {reason}</p>)}
              </div>
            );
            if (r?.ambiguous) return (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                <p style={{ color: '#f59e0b', marginBottom: 4 }}>Multiple markets found — asking user to clarify</p>
                {r.candidates?.map((c, i) => <p key={i} style={{ color: '#6b7280' }}>• {c.title}</p>)}
              </div>
            );
            return (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                <p style={{ color: '#f87171' }}>{r?.error ?? tc.error ?? 'Trade failed'}</p>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  const hasContent = msg.content.trim().length > 0;
  const hasToolCalls = Boolean(msg.toolCalls?.length);
  if (!msg.loading && !hasContent && !hasToolCalls) return null;

  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 16 }}>
      <div style={{ maxWidth: '78%' }}>
        {!isUser && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{
              width: 20, height: 20, borderRadius: '50%',
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, color: '#fff', fontWeight: 700, flexShrink: 0,
            }}>A</div>
            <span style={{ fontSize: 11, color: '#6b7280' }}>Agent</span>
          </div>
        )}
        {(msg.loading || hasContent) && (
          <div style={{
            padding: '10px 14px', borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            background: isUser ? '#6366f1' : '#1a1d27',
            border: isUser ? 'none' : '1px solid #2d3748',
            color: '#e2e8f0', fontSize: 14, lineHeight: 1.6,
            whiteSpace: msg.loading ? 'normal' : 'pre-wrap',
          }}>
            {msg.loading ? (
              <span style={{ color: '#6b7280' }}>Thinking…</span>
            ) : msg.content}
          </div>
        )}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {msg.toolCalls.map((tc, i) => <ToolCallCard key={i} tc={tc} />)}
          </div>
        )}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  'What markets are available about AI?',
  'Show me my portfolio',
  'Search for Bitcoin price markets',
  'What\'s the current YES price for the US election?',
];

const WELCOME_MSG: ChatMessage = {
  id: 'welcome',
  role: 'agent',
  content: 'Hi! I can search markets, check your portfolio, and place paper trades. What would you like to do?',
};

function chatStorageKey(agentWalletId: string) {
  return `agent_chat_${agentWalletId}`;
}

function loadPersistedMessages(agentWalletId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(chatStorageKey(agentWalletId));
    if (!raw) return [WELCOME_MSG];
    const parsed = JSON.parse(raw) as ChatMessage[];
    const usable = parsed.filter(m =>
      m.role === 'user' || m.content?.trim().length > 0 || Boolean(m.toolCalls?.length)
    );
    return usable.length ? usable : [WELCOME_MSG];
  } catch {
    return [WELCOME_MSG];
  }
}

function saveMessages(agentWalletId: string, msgs: ChatMessage[]) {
  try {
    // Don't persist loading placeholders
    const toSave = msgs.filter(m =>
      !m.loading && (m.role === 'user' || m.content.trim().length > 0 || Boolean(m.toolCalls?.length))
    );
    localStorage.setItem(chatStorageKey(agentWalletId), JSON.stringify(toSave));
  } catch { /* quota exceeded — ignore */ }
}

export default function AgentChat() {
  const [session, setSession] = React.useState<AgentSession | null>(() => loadSession());
  const [messages, setMessages] = React.useState<ChatMessage[]>(() => {
    const s = loadSession();
    return s ? loadPersistedMessages(s.agentWalletId) : [WELCOME_MSG];
  });
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const refresh = () => {
      const newSession = loadSession();
      setSession(prev => {
        // If the agent changed, reload that agent's history
        if (newSession?.agentWalletId !== prev?.agentWalletId) {
          setMessages(newSession ? loadPersistedMessages(newSession.agentWalletId) : [WELCOME_MSG]);
        }
        return newSession;
      });
    };
    window.addEventListener(SESSION_SAVED_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(SESSION_SAVED_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  // Persist messages to localStorage whenever they change
  React.useEffect(() => {
    if (session) saveMessages(session.agentWalletId, messages);
  }, [messages, session]);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function clearChat() {
    if (!session || loading) return;
    localStorage.removeItem(chatStorageKey(session.agentWalletId));
    setMessages([WELCOME_MSG]);
    setInput('');
  }

  async function sendMessage(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading || !session) return;

    setInput('');
    const userMsg: ChatMessage = { id: uuidv4(), role: 'user', content };
    const loadingMsg: ChatMessage = { id: uuidv4(), role: 'agent', content: '', loading: true };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setLoading(true);

    // Build conversation history (exclude welcome and loading messages)
    const history = [...messages, userMsg]
      .filter(m => !m.loading && m.id !== 'welcome' && m.content.trim().length > 0)
      .map(m => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.content }));

    try {
      const path = '/api/agent/trade/chat';
      const body = JSON.stringify({ messages: history });
      const headers = await buildSignedHeaders(session, 'POST', path, body);
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      const data = await res.json() as { response?: string; toolCalls?: ToolCall[]; error?: string };
      const responseText = res.ok
        ? (data.response?.trim() || 'The agent returned an empty response. Please try again.')
        : (data.error?.trim() || 'Something went wrong.');

      const completedTrade = data.toolCalls?.some(tc => {
        const result = tc.result as { success?: boolean } | undefined;
        return tc.name === 'place_trade' && result?.success === true;
      });
      if (completedTrade) {
        window.dispatchEvent(new Event('polymarket:trade-completed'));
      }

      setMessages(prev => prev.map(m =>
        m.loading ? { ...m, loading: false, content: responseText, toolCalls: data.toolCalls } : m
      ));
    } catch {
      setMessages(prev => prev.map(m =>
        m.loading ? { ...m, loading: false, content: 'Network error — please try again.' } : m
      ));
    } finally {
      setLoading(false);
    }
  }

  if (!session) {
    const status = getSessionStatus();
    const expired = status.state === 'expired';
    return (
      <div style={{ background: '#1a1d27', border: '1px solid #2d3748', borderRadius: 12, padding: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Agent Chat</h3>
        {expired ? (
          <>
            <p style={{ fontSize: 13, color: '#fbbf24', marginBottom: 6 }}>
              Your trading policy has expired{status.expiresAt ? ` (on ${new Date(status.expiresAt * 1000).toLocaleString()})` : ''}.
            </p>
            <p style={{ fontSize: 13, color: '#6b7280' }}>
              Go to <strong style={{ color: '#a0aec0' }}>Agent Setup</strong> and re-sign the policy to start a fresh session. Your wallet, funding, and approvals are all still intact — you only need to sign again.
            </p>
          </>
        ) : (
          <p style={{ fontSize: 13, color: '#6b7280' }}>Complete Agent Setup first to start chatting.</p>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 200px)', minHeight: 500 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: 10, borderBottom: '1px solid #2d3748',
      }}>
        <span style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 700 }}>Agent Chat</span>
        <button
          type="button"
          onClick={clearChat}
          disabled={loading || messages.length <= 1}
          style={{
            padding: '5px 10px', borderRadius: 6, border: '1px solid #374151',
            background: 'transparent', color: loading || messages.length <= 1 ? '#4b5563' : '#9ca3af',
            cursor: loading || messages.length <= 1 ? 'not-allowed' : 'pointer', fontSize: 12,
          }}
        >
          Clear chat
        </button>
      </div>
      {/* Message list */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '20px 0',
        display: 'flex', flexDirection: 'column',
      }}>
        {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
        <div ref={bottomRef} />
      </div>

      {/* Suggestions (only shown when just the welcome message) */}
      {messages.length === 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {SUGGESTIONS.map(s => (
            <button
              key={s}
              onClick={() => sendMessage(s)}
              style={{
                fontSize: 12, padding: '6px 12px', borderRadius: 999,
                background: '#1a1d27', border: '1px solid #2d3748',
                color: '#a0aec0', cursor: 'pointer',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ display: 'flex', gap: 10, paddingTop: 12, borderTop: '1px solid #2d3748' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder='Ask anything — "Search for AI markets", "Buy $1 of YES on Bitcoin", "Show my portfolio"…'
          disabled={loading}
          style={{
            flex: 1, padding: '10px 14px', borderRadius: 8,
            background: '#0f1117', border: '1px solid #2d3748',
            color: '#e2e8f0', fontSize: 14, outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <Button onClick={() => sendMessage()} loading={loading} disabled={!input.trim() || loading}>
          Send
        </Button>
      </div>
    </div>
  );
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

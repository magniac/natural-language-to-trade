import React from 'react';
import Card from './Card';
import Button from './Button';
import { loadSession, buildSignedHeaders, SESSION_SAVED_EVENT } from '../lib/sessionSigner';
import type { AgentSession } from '../lib/sessionSigner';

interface TradeResult {
  mode: string;
  tradeIntentId: string;
  orderId?: string;
  fillPrice?: number;
  fillSize?: number;
  partialFill?: boolean;
  riskSummary?: {
    orderValueUsdc: number;
    budgetUtilizationPct: number;
    dailySpendUtilizationPct: number;
    spreadBps: number;
  };
  error?: string;
  reasons?: string[];
  reason?: string;
}

export default function TradeInput() {
  const [input, setInput] = React.useState('');
  const [result, setResult] = React.useState<TradeResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [authError, setAuthError] = React.useState(false);
  const [session, setSession] = React.useState<AgentSession | null>(() => loadSession());

  // Re-read session whenever: policy is signed (custom event), or window regains focus
  React.useEffect(() => {
    const refresh = () => setSession(loadSession());
    window.addEventListener(SESSION_SAVED_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(SESSION_SAVED_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  async function submitTrade() {
    if (!input.trim()) return;

    if (!session) {
      setError('No active session found. Go to Agent Setup, create a wallet, and sign a policy first.');
      return;
    }

    setLoading(true); setError(null); setResult(null); setAuthError(false);

    try {
      const path = '/api/agent/trade/intent';
      const body = JSON.stringify({ rawInput: input, paperMode: true });

      // Sign the request with the session key
      const signedHeaders = await buildSignedHeaders(session, 'POST', path, body);

      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders },
        body,
      });

      const data = await res.json() as TradeResult;

      if (res.status === 401) {
        setAuthError(true);
        setError(data.error ?? 'Session authentication failed');
      } else if (res.status === 422) {
        setError(data.error + (data.reason ? `: ${data.reason}` : ''));
      } else if (!res.ok) {
        setResult(data);
      } else {
        setResult(data);
        window.dispatchEvent(new CustomEvent('polymarket:trade-completed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  const examplePrompts = [
    'Buy $5 of YES for USA winning the 2026 World Cup',
    'Buy $3 of YES on Bitcoin reaching $100k by December 2026',
    'Sell all my USA World Cup YES shares',
    'Sell half my Bitcoin YES position',
  ];

  return (
    <Card>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: '#e2e8f0' }}>
        Natural Language Trade Intent
      </h3>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
        Describe your trade in plain English. The system parses it, resolves the market,
        runs the policy engine, and simulates in paper mode.
      </p>

      {!session && (
        <div style={{
          background: '#92400e22', border: '1px solid #92400e66', borderRadius: 8,
          padding: '10px 14px', marginBottom: 16,
        }}>
          <p style={{ fontSize: 13, color: '#fbbf24' }}>
            No active session — complete Agent Setup first to sign a policy.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {examplePrompts.map(p => (
          <button
            key={p}
            onClick={() => setInput(p)}
            style={{
              fontSize: 12, padding: '4px 12px', borderRadius: 999,
              background: '#1a1d27', border: '1px solid #2d3748',
              color: '#a0aec0', cursor: 'pointer',
            }}
          >
            {p.length > 50 ? p.slice(0, 50) + '…' : p}
          </button>
        ))}
      </div>

      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        rows={3}
        placeholder='e.g. "Buy $5 of YES for USA winning the World Cup" or "Sell all my Bitcoin YES shares"'
        style={{
          width: '100%', padding: '12px 14px', borderRadius: 8,
          background: '#0f1117', border: '1px solid #2d3748',
          color: '#e2e8f0', fontSize: 14, resize: 'vertical',
          outline: 'none', fontFamily: 'inherit', marginBottom: 12,
          boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <Button onClick={submitTrade} loading={loading} disabled={!session}>
          Submit Intent (Paper Mode)
        </Button>
        {session && (
          <span style={{ fontSize: 12, color: '#4ade80' }}>
            Session active · policy {session.policyId.slice(0, 8)}…
          </span>
        )}
      </div>

      {authError && (
        <div style={{
          background: '#7f1d1d22', border: '1px solid #7f1d1d66',
          borderRadius: 8, padding: '12px 16px', marginBottom: 12,
        }}>
          <p style={{ color: '#ef4444', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Session authentication failed
          </p>
          <p style={{ color: '#fca5a5', fontSize: 12 }}>{error}</p>
          <p style={{ color: '#6b7280', fontSize: 12, marginTop: 6 }}>
            Try re-signing a policy in Agent Setup to refresh your session key.
          </p>
        </div>
      )}

      {!authError && error && !result && (
        <div style={{
          background: '#7f1d1d22', border: '1px solid #7f1d1d66',
          borderRadius: 8, padding: '12px 16px',
        }}>
          <p style={{ color: '#ef4444', fontSize: 13 }}>{error}</p>
        </div>
      )}

      {result && (
        <div style={{
          background: '#0f1117', border: '1px solid #2d3748',
          borderRadius: 8, padding: '16px',
        }}>
          {result.error ? (
            <div>
              <p style={{ color: '#ef4444', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                Trade Denied by Policy Engine
              </p>
              {result.reasons && result.reasons.length > 0 && (
                <ul style={{ paddingLeft: 16, margin: 0 }}>
                  {result.reasons.map((r, i) => (
                    <li key={i} style={{ color: '#fca5a5', fontSize: 13, marginBottom: 4 }}>{r}</li>
                  ))}
                </ul>
              )}
              {result.reason && (
                <p style={{ color: '#fca5a5', fontSize: 13 }}>{result.reason}</p>
              )}
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
                <p style={{ color: '#22c55e', fontWeight: 600, fontSize: 14 }}>
                  Paper Trade Submitted
                </p>
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 999,
                  background: '#3b82f622', color: '#3b82f6', border: '1px solid #3b82f644',
                }}>
                  PAPER MODE
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {[
                  ['Order ID', result.orderId ? result.orderId.slice(0, 16) + '…' : '—'],
                  ['Fill Price', result.fillPrice != null ? `$${result.fillPrice.toFixed(3)}` : 'Pending'],
                  ['Fill Size', result.fillSize != null ? result.fillSize.toFixed(2) + ' shares' : 'Pending'],
                  ['Partial Fill', result.partialFill ? 'Yes' : 'No'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p style={{ fontSize: 11, color: '#6b7280' }}>{label}</p>
                    <p style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 600 }}>{value}</p>
                  </div>
                ))}
              </div>

              {result.riskSummary && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #2d3748' }}>
                  <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Risk Summary</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                    {[
                      ['Order Value', `$${result.riskSummary.orderValueUsdc}`],
                      ['Budget Used', `${result.riskSummary.budgetUtilizationPct.toFixed(1)}%`],
                      ['Daily Used', `${result.riskSummary.dailySpendUtilizationPct.toFixed(1)}%`],
                      ['Spread', `${result.riskSummary.spreadBps}bps`],
                    ].map(([l, v]) => (
                      <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <span style={{ color: '#6b7280' }}>{l}</span>
                        <span style={{ color: '#a0aec0' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

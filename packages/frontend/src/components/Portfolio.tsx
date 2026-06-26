import React from 'react';
import Card from './Card';
import { loadSession, buildSignedHeaders, SESSION_SAVED_EVENT } from '../lib/sessionSigner';
import type { AgentSession } from '../lib/sessionSigner';

interface Position {
  market_id: string;
  market_title: string;
  token_id: string;
  outcome: string;
  side: string;
  total_shares: number;
  avg_price: number;
  total_cost_usdc: number;
}

interface Order {
  id: string;
  market_title: string;
  outcome: string;
  side: string;
  limit_price: number;
  requested_size: number;
  filled_size: number;
  fill_price: number | null;
  fill_cost_usdc: number;
  status: string;
  created_at: number;
}

interface PortfolioData {
  summary: {
    totalOrders: number;
    filledOrders: number;
    openOrders: number;
    totalSpentUsdc: number;
    budgetUsdc: number;
    budgetRemainingUsdc: number;
    walletBalanceUsdc: number | null;
  };
  positions: Position[];
  recentOrders: Order[];
  hyperliquid: { usdc: number; balances: { coin: string; total: number }[] } | null;
}

const STATUS_COLOR: Record<string, string> = {
  filled: '#22c55e',
  partially_filled: '#f59e0b',
  open: '#3b82f6',
  cancelled: '#6b7280',
  pending: '#a78bfa',
};

function fmt(n: number, decimals = 3) {
  return n.toFixed(decimals);
}

function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export default function Portfolio({ hideTitle = false }: { hideTitle?: boolean }) {
  const [session, setSession] = React.useState<AgentSession | null>(() => loadSession());
  const [data, setData] = React.useState<PortfolioData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelMsg, setCancelMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    const refresh = () => setSession(loadSession());
    window.addEventListener(SESSION_SAVED_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(SESSION_SAVED_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  React.useEffect(() => {
    if (session) fetchPortfolio(session);
    else setData(null);
  }, [session]);

  // Refresh after a trade is submitted
  React.useEffect(() => {
    const onTrade = () => { if (session) fetchPortfolio(session); };
    window.addEventListener('polymarket:trade-completed', onTrade);
    return () => window.removeEventListener('polymarket:trade-completed', onTrade);
  }, [session]);

  async function fetchPortfolio(s: AgentSession) {
    setLoading(true); setError(null);
    try {
      const path = '/api/agent/trade/portfolio';
      const headers = await buildSignedHeaders(s, 'GET', path, '');
      const res = await fetch(path, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as PortfolioData);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load portfolio');
    } finally {
      setLoading(false);
    }
  }

  if (!session) {
    return (
      <Card>
        {!hideTitle && <h3 style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Portfolio</h3>}
        <p style={{ fontSize: 13, color: '#6b7280' }}>Complete Agent Setup to view your portfolio.</p>
      </Card>
    );
  }

  if (loading && !data) {
    return (
      <Card>
        {!hideTitle && <h3 style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Portfolio</h3>}
        <p style={{ fontSize: 13, color: '#6b7280' }}>Loading…</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        {!hideTitle && <h3 style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Portfolio</h3>}
        <p style={{ fontSize: 13, color: '#ef4444' }}>{error}</p>
      </Card>
    );
  }

  async function cancelAll() {
    if (!session) return;
    setCancelling(true); setCancelMsg(null);
    try {
      const path = '/api/agent/trade/cancel-all';
      const headers = await buildSignedHeaders(session, 'POST', path, '');
      const res = await fetch(path, { method: 'POST', headers });
      const body = await res.json() as { cancelled?: number };
      setCancelMsg(`Cancelled ${body.cancelled ?? 0} open order(s).`);
      fetchPortfolio(session);
    } catch {
      setCancelMsg('Cancel-all failed.');
    } finally {
      setCancelling(false);
    }
  }

  if (!data) return null;

  const { summary, positions, recentOrders, hyperliquid } = data;
  const budgetPct = summary.budgetUsdc > 0
    ? Math.min(100, (summary.totalSpentUsdc / summary.budgetUsdc) * 100)
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        {[
          ...(summary.walletBalanceUsdc !== null
            ? [{ label: 'Wallet Balance', value: `$${fmt(summary.walletBalanceUsdc, 2)}`, sub: 'pUSD on-chain' }]
            : []),
          { label: 'Total Spent', value: `$${fmt(summary.totalSpentUsdc, 2)}`, sub: `of $${fmt(summary.budgetUsdc, 0)} budget` },
          { label: 'Budget Left', value: `$${fmt(Math.max(0, summary.budgetRemainingUsdc), 2)}`, sub: `${(100 - budgetPct).toFixed(0)}% remaining` },
          { label: 'Filled Orders', value: String(summary.filledOrders), sub: `${summary.totalOrders} total` },
          { label: 'Open Orders', value: String(summary.openOrders), sub: 'awaiting fill' },
        ].map(({ label, value, sub }) => (
          <div key={label} style={{
            background: '#1a1d27', border: '1px solid #2d3748',
            borderRadius: 10, padding: '14px 16px',
          }}>
            <p style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</p>
            <p style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0', marginBottom: 2 }}>{value}</p>
            <p style={{ fontSize: 11, color: '#4b5563' }}>{sub}</p>
          </div>
        ))}
      </div>

      {/* Budget bar */}
      <div style={{ background: '#1a1d27', border: '1px solid #2d3748', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>Budget utilization</span>
          <span style={{ fontSize: 12, color: '#e2e8f0' }}>{budgetPct.toFixed(1)}%</span>
        </div>
        <div style={{ height: 6, background: '#2d3748', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${budgetPct}%`,
            background: budgetPct > 90 ? '#ef4444' : budgetPct > 70 ? '#f59e0b' : '#22c55e',
            transition: 'width 0.3s ease',
          }} />
        </div>
      </div>

      {/* Positions */}
      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 14 }}>
          Holdings
        </h3>
        {positions.length === 0 ? (
          <p style={{ fontSize: 13, color: '#4b5563' }}>No filled positions yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Market', 'Outcome', 'Side', 'Shares', 'Avg Price', 'Cost'].map(h => (
                  <th key={h} style={{ textAlign: 'left', color: '#6b7280', fontWeight: 500, paddingBottom: 8, borderBottom: '1px solid #2d3748', paddingRight: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #1a1d27' }}>
                  <td style={{ paddingTop: 10, paddingBottom: 10, paddingRight: 12, color: '#e2e8f0', maxWidth: 260 }}>
                    <span title={p.market_title} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.market_title}
                    </span>
                  </td>
                  <td style={{ paddingRight: 12 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                      background: p.outcome === 'YES' ? '#14532d44' : '#7f1d1d44',
                      color: p.outcome === 'YES' ? '#4ade80' : '#f87171',
                    }}>{p.outcome}</span>
                  </td>
                  <td style={{ paddingRight: 12, color: p.side === 'BUY' ? '#34d399' : '#f87171' }}>{p.side}</td>
                  <td style={{ paddingRight: 12, color: '#e2e8f0' }}>{fmt(p.total_shares, 2)}</td>
                  <td style={{ paddingRight: 12, color: '#e2e8f0' }}>${fmt(p.avg_price, 3)}</td>
                  <td style={{ color: '#a0aec0' }}>${fmt(p.total_cost_usdc, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Hyperliquid spot balances */}
      {hyperliquid && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>Hyperliquid (spot)</h3>
            <span style={{ fontSize: 13, color: hyperliquid.usdc > 0 ? '#4ade80' : '#6b7280' }}>${hyperliquid.usdc.toFixed(2)} USDC</span>
          </div>
          {hyperliquid.balances.length === 0 ? (
            <p style={{ fontSize: 12, color: '#6b7280' }}>No token holdings yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {hyperliquid.balances.map((b, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: '#e2e8f0' }}>{b.coin}</span>
                  <span style={{ color: '#a0aec0' }}>{b.total}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Recent orders */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>Recent Orders</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {summary.openOrders > 0 && (
              <button
                onClick={cancelAll}
                disabled={cancelling}
                style={{
                  fontSize: 11, padding: '4px 10px', borderRadius: 6,
                  background: cancelling ? '#7f1d1d44' : '#7f1d1d88',
                  border: '1px solid #7f1d1d', color: '#f87171',
                  cursor: 'pointer',
                }}
              >
                {cancelling ? 'Cancelling…' : `Cancel All (${summary.openOrders})`}
              </button>
            )}
            <button
              onClick={() => fetchPortfolio(session)}
              disabled={loading}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 6,
                background: '#2d3748', border: 'none', color: '#a0aec0',
                cursor: 'pointer',
              }}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {cancelMsg && (
          <p style={{ fontSize: 12, color: '#4ade80', marginBottom: 10 }}>{cancelMsg}</p>
        )}
        {recentOrders.length === 0 ? (
          <p style={{ fontSize: 13, color: '#4b5563' }}>No orders yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {['Market', 'Side', 'Limit', 'Filled', 'Cost', 'Status', 'When'].map(h => (
                  <th key={h} style={{ textAlign: 'left', color: '#6b7280', fontWeight: 500, paddingBottom: 8, borderBottom: '1px solid #2d3748', paddingRight: 10 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentOrders.map((o, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #1a1d2744' }}>
                  <td style={{ paddingTop: 9, paddingBottom: 9, paddingRight: 10, color: '#e2e8f0', maxWidth: 200 }}>
                    <span title={o.market_title} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.market_title}
                    </span>
                    {o.outcome && (
                      <span style={{ fontSize: 10, color: o.outcome === 'YES' ? '#4ade80' : '#f87171' }}>{o.outcome}</span>
                    )}
                  </td>
                  <td style={{ paddingRight: 10, color: o.side === 'BUY' ? '#34d399' : '#f87171', fontWeight: 600 }}>{o.side}</td>
                  <td style={{ paddingRight: 10, color: '#a0aec0' }}>${fmt(o.limit_price, 3)}</td>
                  <td style={{ paddingRight: 10, color: '#e2e8f0' }}>
                    {o.filled_size > 0 ? `${fmt(o.filled_size, 2)} @ $${o.fill_price ? fmt(o.fill_price, 3) : '—'}` : '—'}
                  </td>
                  <td style={{ paddingRight: 10, color: '#a0aec0' }}>
                    {o.fill_cost_usdc > 0 ? `$${fmt(o.fill_cost_usdc, 2)}` : '—'}
                  </td>
                  <td style={{ paddingRight: 10 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                      background: `${STATUS_COLOR[o.status] ?? '#6b7280'}22`,
                      color: STATUS_COLOR[o.status] ?? '#6b7280',
                    }}>
                      {o.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td style={{ color: '#4b5563', whiteSpace: 'nowrap' }}>{timeAgo(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

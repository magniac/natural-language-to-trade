import React from 'react';
import { api, type MarketSearchResult } from '../lib/api';
import Card from './Card';
import Button from './Button';

export default function MarketSearch() {
  const [query, setQuery] = React.useState('');
  const [result, setResult] = React.useState<MarketSearchResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function search() {
    if (!query.trim()) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await api.searchMarkets(query);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: '#e2e8f0' }}>
        Market Search
      </h3>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="e.g. Will Bitcoin hit $100k this year?"
          style={{
            flex: 1, padding: '10px 14px', borderRadius: 8, fontSize: 14,
            background: '#0f1117', border: '1px solid #2d3748', color: '#e2e8f0',
            outline: 'none',
          }}
        />
        <Button onClick={search} loading={loading}>Search</Button>
      </div>

      {error && <p style={{ color: '#ef4444', fontSize: 13 }}>{error}</p>}

      {result && (
        <div>
          {result.refusalReason && (
            <div style={{
              background: '#7c3aed22', border: '1px solid #7c3aed44',
              borderRadius: 8, padding: '12px 16px', marginBottom: 12,
            }}>
              <p style={{ color: '#a78bfa', fontSize: 13 }}>
                <strong>Resolver notice:</strong> {result.refusalReason}
              </p>
              {result.ambiguous && (
                <p style={{ color: '#f59e0b', fontSize: 12, marginTop: 4 }}>
                  Multiple similar markets found — please refine your query.
                </p>
              )}
            </div>
          )}

          {result.candidates.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {result.candidates.map(c => (
                <div key={c.marketId} style={{
                  background: '#0f1117', borderRadius: 8, padding: '14px 16px',
                  border: '1px solid #2d3748',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', flex: 1 }}>{c.title}</p>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 8px',
                      background: c.confidence > 0.8 ? '#22c55e22' : '#f59e0b22',
                      color: c.confidence > 0.8 ? '#22c55e' : '#f59e0b',
                      border: `1px solid ${c.confidence > 0.8 ? '#22c55e44' : '#f59e0b44'}`,
                      borderRadius: 999, marginLeft: 8, whiteSpace: 'nowrap',
                    }}>
                      {(c.confidence * 100).toFixed(0)}% match
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#6b7280' }}>
                    <span>Liquidity: ${c.liquidityUsdc.toLocaleString()}</span>
                    <span>Status: {c.status}</span>
                    <span style={{ fontFamily: 'monospace' }}>ID: {c.marketId.slice(0, 12)}…</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {result.candidates.length === 0 && !result.refusalReason && (
            <p style={{ color: '#6b7280', fontSize: 13 }}>No markets found.</p>
          )}
        </div>
      )}
    </Card>
  );
}

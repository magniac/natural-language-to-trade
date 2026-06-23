import React from 'react';
import Card from './Card';
import Button from './Button';
import { loadSession } from '../lib/sessionSigner';
import type { AgentSession } from '../lib/sessionSigner';

interface LoopStatus {
  agentWalletId: string;
  status: 'running' | 'stopped';
  intervalMs: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runsTotal: number;
  tradesPlaced: number;
  startedAt: number | null;
}

interface LoopDecision {
  id: string;
  runId: string;
  marketId: string;
  marketTitle: string;
  decision: 'BUY_YES' | 'BUY_NO' | 'PASS';
  reasoning: string | null;
  suggestedPrice: number | null;
  orderId: string | null;
  policyOutcome: string | null;
  policyReasons: string[] | null;
  createdAt: number;
}

interface LoopData {
  status: LoopStatus;
  recentDecisions: LoopDecision[];
}

const INTERVAL_OPTIONS = [
  { label: '1 min (demo)', ms: 60_000 },
  { label: '5 min', ms: 300_000 },
  { label: '15 min', ms: 900_000 },
  { label: '30 min', ms: 1_800_000 },
];

const DECISION_COLOR: Record<string, string> = {
  BUY_YES: '#22c55e',
  BUY_NO:  '#f59e0b',
  PASS:    '#4b5563',
};

const OUTCOME_COLOR: Record<string, string> = {
  ALLOWED:       '#22c55e',
  DENIED:        '#f87171',
  ERROR:         '#f87171',
  PARSE_ERROR:   '#f59e0b',
  RESOLVE_ERROR: '#f59e0b',
};

function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function timeUntil(ms: number) {
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  return `${Math.floor(diff / 60_000)}m`;
}

export default function AutonomousLoop() {
  const [session] = React.useState<AgentSession | null>(() => loadSession());
  const [data, setData] = React.useState<LoopData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [actionLoading, setActionLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedInterval, setSelectedInterval] = React.useState(60_000);

  const agentId = session?.agentWalletId;

  async function fetchStatus() {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/loop/status`);
      if (res.ok) setData(await res.json() as LoopData);
    } catch { /* silent */ }
  }

  React.useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    fetchStatus().finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Auto-refresh every 15s when running
  React.useEffect(() => {
    if (!agentId || data?.status.status !== 'running') return;
    const t = setInterval(fetchStatus, 15_000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, data?.status.status]);

  async function startLoop() {
    if (!agentId) return;
    setActionLoading(true); setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/loop/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMs: selectedInterval }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? 'Failed to start loop');
      } else {
        await fetchStatus();
      }
    } catch { setError('Network error'); }
    finally { setActionLoading(false); }
  }

  async function stopLoop() {
    if (!agentId) return;
    setActionLoading(true); setError(null);
    try {
      await fetch(`/api/agents/${agentId}/loop/stop`, { method: 'POST' });
      await fetchStatus();
    } catch { setError('Network error'); }
    finally { setActionLoading(false); }
  }

  if (!session) {
    return (
      <Card>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Autonomous Loop (M10)</h3>
        <p style={{ fontSize: 13, color: '#6b7280' }}>Complete Agent Setup first.</p>
      </Card>
    );
  }

  const loopStatus = data?.status;
  const isRunning = loopStatus?.status === 'running';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header card */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>Autonomous Loop (M10)</h3>
            <p style={{ fontSize: 13, color: '#6b7280' }}>
              Periodically scans markets, evaluates them with Claude Haiku, and places paper trades that pass the policy engine.
            </p>
          </div>
          <span style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 999, fontWeight: 700,
            background: isRunning ? '#14532d33' : '#1f2937',
            color: isRunning ? '#4ade80' : '#6b7280',
            border: `1px solid ${isRunning ? '#14532d66' : '#374151'}`,
            whiteSpace: 'nowrap',
          }}>
            {loading ? '…' : isRunning ? '● Running' : '○ Stopped'}
          </span>
        </div>

        {/* Stats row */}
        {loopStatus && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {[
              { label: 'Runs', value: String(loopStatus.runsTotal) },
              { label: 'Trades placed', value: String(loopStatus.tradesPlaced) },
              { label: 'Last run', value: loopStatus.lastRunAt ? timeAgo(loopStatus.lastRunAt) : '—' },
              { label: 'Next run', value: isRunning && loopStatus.nextRunAt ? timeUntil(loopStatus.nextRunAt) : '—' },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: '#0f1117', border: '1px solid #2d3748', borderRadius: 8, padding: '10px 12px' }}>
                <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 3 }}>{label}</p>
                <p style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Controls */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {!isRunning && (
            <select
              value={selectedInterval}
              onChange={e => setSelectedInterval(Number(e.target.value))}
              style={{
                padding: '6px 10px', borderRadius: 6, fontSize: 13,
                background: '#1a1d27', border: '1px solid #2d3748',
                color: '#a0aec0', cursor: 'pointer',
              }}
            >
              {INTERVAL_OPTIONS.map(o => (
                <option key={o.ms} value={o.ms}>{o.label}</option>
              ))}
            </select>
          )}
          {isRunning ? (
            <Button variant="warning" size="sm" onClick={stopLoop} loading={actionLoading}>
              Stop Loop
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={startLoop} loading={actionLoading}>
              Start Loop
            </Button>
          )}
          <button
            onClick={() => { fetchStatus(); }}
            style={{
              fontSize: 11, padding: '5px 10px', borderRadius: 6,
              background: '#2d3748', border: 'none', color: '#a0aec0', cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>

        {error && <p style={{ fontSize: 12, color: '#f87171', marginTop: 10 }}>{error}</p>}
      </Card>

      {/* Recent decisions */}
      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 14 }}>Recent Decisions</h3>
        {!data || data.recentDecisions.length === 0 ? (
          <p style={{ fontSize: 13, color: '#4b5563' }}>
            {isRunning ? 'First scan in progress…' : 'No decisions yet. Start the loop to begin scanning.'}
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {['When', 'Market', 'Decision', 'Price', 'Policy', 'Reasoning'].map(h => (
                  <th key={h} style={{
                    textAlign: 'left', color: '#6b7280', fontWeight: 500,
                    paddingBottom: 8, borderBottom: '1px solid #2d3748', paddingRight: 10,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recentDecisions.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid #1a1d2744' }}>
                  <td style={{ paddingTop: 9, paddingBottom: 9, paddingRight: 10, color: '#4b5563', whiteSpace: 'nowrap' }}>
                    {timeAgo(d.createdAt)}
                  </td>
                  <td style={{ paddingRight: 10, color: '#e2e8f0', maxWidth: 200 }}>
                    <span title={d.marketTitle} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.marketTitle}
                    </span>
                  </td>
                  <td style={{ paddingRight: 10 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                      background: `${DECISION_COLOR[d.decision] ?? '#6b7280'}22`,
                      color: DECISION_COLOR[d.decision] ?? '#6b7280',
                    }}>
                      {d.decision}
                    </span>
                  </td>
                  <td style={{ paddingRight: 10, color: '#a0aec0' }}>
                    {d.suggestedPrice != null ? `$${d.suggestedPrice.toFixed(3)}` : '—'}
                  </td>
                  <td style={{ paddingRight: 10 }}>
                    {d.policyOutcome ? (
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                        background: `${OUTCOME_COLOR[d.policyOutcome] ?? '#6b7280'}22`,
                        color: OUTCOME_COLOR[d.policyOutcome] ?? '#6b7280',
                      }}>
                        {d.policyOutcome}
                      </span>
                    ) : '—'}
                    {d.policyReasons && d.policyReasons.length > 0 && (
                      <p style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                        {d.policyReasons[0]}
                      </p>
                    )}
                  </td>
                  <td style={{ color: '#6b7280', maxWidth: 240 }}>
                    <span title={d.reasoning ?? ''} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.reasoning ?? '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

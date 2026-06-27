import React from 'react';
import { api, type HealthResponse, type MarketIngestionStatus } from '../lib/api';
import StatusBadge from './StatusBadge';

function formatAge(timestampMs: number | null | undefined): string | null {
  if (!timestampMs) return null;
  const ageMs = Math.max(0, Date.now() - timestampMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ageMs < minute) return 'just now';
  if (ageMs < hour) {
    const mins = Math.floor(ageMs / minute);
    return `${mins} min${mins === 1 ? '' : 's'} ago`;
  }
  if (ageMs < day) {
    const hours = Math.floor(ageMs / hour);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(ageMs / day);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatDuration(durationMs: number | null | undefined): string {
  if (!durationMs) return '0s';
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function getMarketRefreshLabel(status?: MarketIngestionStatus): string | null {
  if (!status) return null;
  if (status.inProgress) {
    const age = formatAge(status.currentRunStartedAt);
    return age ? `refreshing, started ${age}` : 'refreshing now';
  }
  const lastResultAge = formatAge(status.lastCompletedAt ?? status.lastFailedAt);
  if (status.lastResult && lastResultAge) {
    switch (status.lastResult.status) {
      case 'success':
        return `refresh succeeded ${lastResultAge}`;
      case 'partial':
        return `refresh partial ${lastResultAge}`;
      case 'stalled':
        return `refresh stuck ${lastResultAge}`;
      case 'failed':
        return `refresh failed ${lastResultAge}`;
      case 'skipped':
        return `refresh skipped ${lastResultAge}`;
    }
  }
  const lastRefreshed = formatAge(status.lastCompletedAt);
  if (lastRefreshed) return `refreshed ${lastRefreshed}`;
  const lastFailed = formatAge(status.lastFailedAt);
  if (lastFailed) return `refresh failed ${lastFailed}`;
  return null;
}

function getMarketRefreshTitle(status?: MarketIngestionStatus): string {
  if (!status) return 'Market refresh status is not available yet.';

  const parts = [
    'Active Polymarket markets in the local database.',
    'This health check only reads local status; it does not trigger Gamma ingestion.',
  ];

  if (status.inProgress) {
    parts.push(`A refresh is currently running${status.currentRunStartedAt ? `, started ${new Date(status.currentRunStartedAt).toLocaleString()}` : ''}.`);
  }
  if (status.lastCompletedAt) {
    parts.push(`Last completed: ${new Date(status.lastCompletedAt).toLocaleString()}.`);
  }
  if (status.lastResult) {
    parts.push(`Last result: ${status.lastResult.status}. ${status.lastResult.message}`);
    parts.push(`Totals: fetched ${status.lastResult.fetched.toLocaleString()}, upserted ${status.lastResult.upserted.toLocaleString()}, errors ${status.lastResult.errors.toLocaleString()}, duration ${formatDuration(status.lastResult.durationMs)}.`);
    for (const crawl of status.lastResult.crawls ?? []) {
      parts.push(`${crawl.label}: ${crawl.status}; pages ${crawl.pages.toLocaleString()}, fetched ${crawl.fetched.toLocaleString()}, upserted ${crawl.upserted.toLocaleString()}, errors ${crawl.errors.toLocaleString()}. ${crawl.message}`);
    }
  }
  if (status.lastSkippedAt) {
    parts.push(`Last skipped overlap: ${new Date(status.lastSkippedAt).toLocaleString()}.`);
  }
  if (status.lastError) {
    parts.push(`Last error: ${status.lastError}.`);
  }

  return parts.join(' ');
}

export default function SystemStatus() {
  const [health, setHealth] = React.useState<HealthResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    const poll = () => {
      api.health()
        .then(h => { if (active) { setHealth(h); setError(null); } })
        .catch(() => { if (active) setError('Backend offline'); });
    };
    poll();
    // Poll so the count updates live as market ingestion fills the local catalogue.
    const id = setInterval(poll, 10_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const marketRefreshLabel = getMarketRefreshLabel(health?.marketIngestion);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      {error ? (
        <StatusBadge status="offline" />
      ) : health ? (
        <>
          <StatusBadge status={health.status} />
          <span style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
            {health.liveTradingEnabled ? 'Live trading' : 'Paper mode'}
          </span>
          {health.marketCount !== undefined && (
            <span
              style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}
              title={getMarketRefreshTitle(health.marketIngestion)}
            >
              · {health.marketCount.toLocaleString()} markets
              {marketRefreshLabel ? ` · ${marketRefreshLabel}` : ''}
            </span>
          )}
        </>
      ) : (
        <span style={{ fontSize: 12, color: '#4b5563' }}>Connecting…</span>
      )}
    </div>
  );
}

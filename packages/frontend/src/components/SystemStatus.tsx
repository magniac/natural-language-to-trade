import React from 'react';
import { api } from '../lib/api';
import Card from './Card';
import StatusBadge from './StatusBadge';

interface HealthStatus {
  status: string;
  liveTradingEnabled: boolean;
}

export default function SystemStatus() {
  const [health, setHealth] = React.useState<HealthStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api.health()
      .then(setHealth)
      .catch(() => setError('Backend offline'));
  }, []);

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
        </>
      ) : (
        <span style={{ fontSize: 12, color: '#4b5563' }}>Connecting…</span>
      )}
    </div>
  );
}

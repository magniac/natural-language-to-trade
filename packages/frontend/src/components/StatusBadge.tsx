import React from 'react';

interface Props {
  status: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  paused: '#f59e0b',
  revoked: '#ef4444',
  disabled: '#6b7280',
  archived: '#6b7280',
  paper: '#3b82f6',
  live: '#ef4444',
  open: '#22c55e',
  filled: '#8b5cf6',
  cancelled: '#6b7280',
};

export default function StatusBadge({ status }: Props) {
  const color = STATUS_COLORS[status.toLowerCase()] ?? '#6b7280';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
      padding: '3px 10px', borderRadius: 999,
      background: `${color}22`, color, border: `1px solid ${color}44`,
      textTransform: 'uppercase',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {status}
    </span>
  );
}

import React from 'react';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'danger' | 'ghost' | 'warning';
  size?: 'sm' | 'md';
  loading?: boolean;
}

const VARIANTS = {
  primary: { bg: '#6366f1', hover: '#4f46e5', color: '#fff', border: 'transparent' },
  danger: { bg: '#ef4444', hover: '#dc2626', color: '#fff', border: 'transparent' },
  warning: { bg: '#f59e0b', hover: '#d97706', color: '#000', border: 'transparent' },
  ghost: { bg: 'transparent', hover: '#2d3748', color: '#a0aec0', border: '#2d3748' },
};

export default function Button({ variant = 'primary', size = 'md', loading, children, disabled, style, ...props }: Props) {
  const v = VARIANTS[variant];
  const pad = size === 'sm' ? '6px 14px' : '10px 20px';
  const fs = size === 'sm' ? 13 : 14;

  return (
    <button
      disabled={disabled || loading}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: pad, fontSize: fs, fontWeight: 600,
        borderRadius: 8, border: `1px solid ${v.border}`,
        background: v.bg, color: v.color,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.6 : 1,
        transition: 'background 0.15s',
        ...style,
      }}
      {...props}
    >
      {loading ? '...' : children}
    </button>
  );
}

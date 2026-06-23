import React from 'react';

interface Props {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export default function Card({ children, style }: Props) {
  return (
    <div style={{
      background: '#1a1d27',
      border: '1px solid #2d3748',
      borderRadius: 12,
      padding: '24px 28px',
      ...style,
    }}>
      {children}
    </div>
  );
}

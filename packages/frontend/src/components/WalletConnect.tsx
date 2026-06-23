import React from 'react';
import Button from './Button';
import { connectWallet, type WalletState } from '../lib/wallet';

interface Props {
  wallet: WalletState;
  onConnect: (state: WalletState) => void;
}

export default function WalletConnect({ wallet, onConnect }: Props) {
  const [error, setError] = React.useState<string | null>(null);

  async function handleConnect() {
    setError(null);
    onConnect({ status: 'connecting' });
    try {
      const { address, provider } = await connectWallet();
      onConnect({ status: 'connected', address, provider });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      onConnect({ status: 'disconnected' });
    }
  }

  if (wallet.status === 'connected') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
        <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#a0aec0' }}>
          {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
        </span>
      </div>
    );
  }

  return (
    <div>
      <Button
        onClick={handleConnect}
        loading={wallet.status === 'connecting'}
      >
        Connect Wallet
      </Button>
      {error && <p style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{error}</p>}
    </div>
  );
}

import React from 'react';
import WalletConnect from './components/WalletConnect';
import AgentSetup from './components/AgentSetup';
import Portfolio from './components/Portfolio';
import SystemStatus from './components/SystemStatus';
import AgentChat from './components/AgentChat';
import type { WalletState } from './lib/wallet';
import './App.css';

const NAV_ITEMS = ['Agent Setup', 'Chat'] as const;
type NavTab = typeof NAV_ITEMS[number];

export default function App() {
  const [wallet, setWallet] = React.useState<WalletState>({ status: 'disconnected' });
  const [tab, setTab] = React.useState<NavTab>('Agent Setup');
  const [liveEnabled, setLiveEnabled] = React.useState(false);

  React.useEffect(() => {
    fetch('/api/health').then(r => r.json()).then((d: { liveTradingEnabled?: boolean }) => {
      setLiveEnabled(d.liveTradingEnabled === true);
    }).catch(() => {});
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117' }}>
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 16, color: '#fff',
          }}>P</div>
          <span className="app-title">Polymarket Agent</span>
          <SystemStatus />
        </div>

        <nav style={{ display: 'flex', gap: 4 }}>
          {NAV_ITEMS.map(item => (
            <button
              key={item}
              onClick={() => setTab(item)}
              style={{
                padding: '7px 16px', borderRadius: 6, fontSize: 13, fontWeight: 500,
                background: tab === item ? '#2d3748' : 'transparent',
                border: 'none', color: tab === item ? '#e2e8f0' : '#6b7280',
                cursor: 'pointer',
              }}
            >
              {item}
            </button>
          ))}
        </nav>

        <WalletConnect wallet={wallet} onConnect={setWallet} />
      </header>

      <main className={tab === 'Chat' ? 'app-main app-main--chat' : 'app-main'}>
        {tab === 'Agent Setup' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
                Autonomous Agent
              </h1>
              <p style={{ color: '#6b7280', fontSize: 14 }}>
                Create an agent with a bounded budget and signed policy. Your main wallet signs the policy
                but never touches the backend trading logic.
              </p>
            </div>

            <div style={{
              background: '#b4530911', border: '1px solid #f59e0b44',
              borderRadius: 12, padding: '16px 20px',
            }}>
              <h4 style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', marginBottom: 4 }}>
                Before you start — one-time prerequisites
              </h4>
              <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                You set these up yourself, outside this app. The platform never creates wallets or Polymarket accounts for you.
              </p>
              <ol style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  <>Install <strong style={{ color: '#e2e8f0' }}>MetaMask</strong> with <strong style={{ color: '#e2e8f0' }}>two accounts</strong>: your <em>main</em> wallet (signs the policy, holds your funds) and a separate <em>agent</em> wallet the bot will trade from.</>,
                  <>On <a href="https://polymarket.com" target="_blank" rel="noreferrer" style={{ color: '#a78bfa' }}>polymarket.com</a>, connect the <strong style={{ color: '#e2e8f0' }}>agent</strong> wallet and finish its onboarding so it gets a Polymarket account.</>,
                  <>In Polymarket settings, create a <strong style={{ color: '#e2e8f0' }}>Relayer API key</strong> for the agent account (you'll paste the key and its address here). This lets the agent move funds and trade gas-free.</>,
                  <>Hold some <strong style={{ color: '#e2e8f0' }}>pUSD on Polygon</strong> in your main wallet to fund the agent, plus a little POL for gas.</>,
                  <>Get an <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" style={{ color: '#a78bfa' }}>OpenRouter API key</a> — it powers the agent's natural-language understanding.</>,
                ].map((item, i) => (
                  <li key={i} style={{ fontSize: 13, color: '#a0aec0', lineHeight: 1.5 }}>{item}</li>
                ))}
              </ol>
            </div>

            <div style={{
              background: '#7c3aed11', border: '1px solid #7c3aed33',
              borderRadius: 12, padding: '16px 20px',
            }}>
              <h4 style={{ fontSize: 13, fontWeight: 700, color: '#a78bfa', marginBottom: 4 }}>
                Setup steps (in this order)
              </h4>
              <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                Connect your <strong style={{ color: '#e2e8f0' }}>main</strong> wallet (top right) first, then work top-to-bottom through the card below.
              </p>
              <ol style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  'Create the agent, then import the agent wallet’s private key (the second MetaMask account you connected to Polymarket).',
                  'Add your Relayer API key + address, then click Provision to register the agent’s Polymarket deposit wallet.',
                  'Add your OpenRouter API key.',
                  'Set your trading limits (budget, max order, daily cap) and sign the policy with your main wallet — an EIP-712 signature, no on-chain transaction or gas.',
                  'Fund the deposit wallet with pUSD, click Authorize Trading (approves buying and selling), then derive CLOB credentials.',
                  'Choose Paper or Live mode, then open the Chat tab to trade. You can pause, revoke, or withdraw at any time.',
                ].map((step, i) => (
                  <li key={i} style={{ fontSize: 13, color: '#a0aec0', lineHeight: 1.5 }}>{step}</li>
                ))}
              </ol>
              <p style={{ fontSize: 12, color: '#6b7280', marginTop: 10, lineHeight: 1.5 }}>
                Your main wallet only ever signs the policy — its private key never reaches the backend. The agent trades within the limits you set, enforced by a deterministic policy engine.
              </p>
            </div>

            <AgentSetup wallet={wallet} />
          </div>
        )}

        {tab === 'Chat' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Agent Chat</h1>
              <p style={{ color: '#6b7280', fontSize: 14 }}>
                Talk to the agent in natural language. It can search markets, explain prices, check your portfolio, and place {liveEnabled ? 'live' : 'paper'} trades — all through the policy engine.
              </p>
            </div>

            <div className="chat-workspace">
              <section className="chat-workspace__chat" aria-label="Agent chat">
                <AgentChat />
              </section>

              <aside className="chat-workspace__portfolio" aria-label="Portfolio">
                <h2 style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>Portfolio</h2>
                <Portfolio hideTitle />
              </aside>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

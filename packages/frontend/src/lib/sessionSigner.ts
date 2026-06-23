import { ethers } from 'ethers';

const SESSION_STORAGE_KEY = 'polymarket_agent_session';
const AGENT_WALLET_KEY = 'polymarket_agent_wallet';

export interface AgentSession {
  sessionPrivateKey: string;
  sessionAddress: string;
  policyId: string;
  agentWalletId: string;
  agentAddress: string;
  expiresAt: number; // Unix seconds
}

export interface PersistedAgentWallet {
  agentWalletId: string;
  address: string;
  proxyWalletAddress?: string;
  step: 'configuring' | 'done';
  policyId?: string;
  // Budget & limits
  budget?: string;
  maxOrder?: string;
  dailyLimit?: string;
  maxOpenOrders?: string;
  expiryDays?: string;
  // Market safety filters
  minLiquidityUSDC?: string;      // '' = no limit
  maxSpreadBps?: string;          // '' = no limit
  nearResolutionHours?: string;   // '' = no block
  maxPrice?: string;              // '' = no limit
  // Allowed sides
  allowBuy?: boolean;
  allowSell?: boolean;
}

export function saveAgentWallet(info: PersistedAgentWallet): void {
  localStorage.setItem(AGENT_WALLET_KEY, JSON.stringify(info));
}

export function loadAgentWallet(): PersistedAgentWallet | null {
  try {
    const raw = localStorage.getItem(AGENT_WALLET_KEY);
    return raw ? JSON.parse(raw) as PersistedAgentWallet : null;
  } catch {
    return null;
  }
}

export function clearAgentWallet(): void {
  localStorage.removeItem(AGENT_WALLET_KEY);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(SESSION_SAVED_EVENT, { detail: null }));
}

export const SESSION_SAVED_EVENT = 'polymarket:session-saved';

export function saveSession(session: AgentSession): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  window.dispatchEvent(new CustomEvent(SESSION_SAVED_EVENT, { detail: session }));
}

export function loadSession(): AgentSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as AgentSession;
    if (session.expiresAt < Math.floor(Date.now() / 1000)) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function buildSignedHeaders(
  session: AgentSession,
  method: string,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();

  // Mirror backend: bodyHash = '0x' + sha256(JSON.stringify(req.body))
  // Express re-stringifies parsed body, which matches JSON.stringify(body object)
  const bodyHash = '0x' + await sha256Hex(body);

  const canonical = JSON.stringify({
    policyId: session.policyId,
    sessionKey: session.sessionAddress,
    method: method.toUpperCase(),
    path,
    bodyHash,
    timestamp,
    nonce,
  });

  const wallet = new ethers.Wallet(session.sessionPrivateKey);
  const signature = await wallet.signMessage(canonical);

  return {
    'X-Policy-Id': session.policyId,
    'X-Session-Key': session.sessionAddress,
    'X-Timestamp': String(timestamp),
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

const BASE = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json() as T;
}

export interface MarketSearchResult {
  query: string;
  candidates: {
    marketId: string;
    title: string;
    yesTokenId: string;
    noTokenId: string;
    status: string;
    liquidityUsdc: number;
    confidence: number;
  }[];
  ambiguous: boolean;
  refusalReason: string | null;
}

export interface Market {
  marketId: string;
  title: string;
  description: string;
  status: string;
  category: string;
  liquidityUsdc: number;
  tokens: { tokenId: string; outcome: string; tickSize: number }[];
}

export const api = {
  health: () => request<{ status: string; liveTradingEnabled: boolean }>('/health'),

  searchMarkets: (query: string) =>
    request<MarketSearchResult>(`/market/search?q=${encodeURIComponent(query)}`),

  listMarkets: (limit = 20) =>
    request<{ markets: Market[] }>(`/market/search?limit=${limit}`),

  createAgent: (userId: string) =>
    request<{ agentWalletId: string; address: string }>('/agents', {
      method: 'POST',
      body: JSON.stringify({ userId, walletAddress: userId }),
    }),

  getAgent: (agentId: string) =>
    request<{ id: string; address: string; status: string }>(`/agents/${agentId}`),

  pauseAgent: (agentId: string) =>
    request<{ status: string }>(`/agents/${agentId}/pause`, { method: 'POST' }),

  resumeAgent: (agentId: string) =>
    request<{ status: string }>(`/agents/${agentId}/resume`, { method: 'POST' }),

  revokeAgent: (agentId: string) =>
    request<{ revoked: boolean }>(`/agents/${agentId}/revoke`, { method: 'POST' }),

  getPolicy: (agentId: string) =>
    request<{ id: string; status: string; expiresAt: number; policyJson: Record<string, unknown> }>(`/agents/${agentId}/policy`),

  verifyPolicySignature: (agentId: string, policy: unknown, userSignature: string) =>
    request<{ valid: boolean; reason: string | null }>(`/agents/${agentId}/policy/signature/verify`, {
      method: 'POST',
      body: JSON.stringify({ policy, userSignature }),
    }),

  getAuditLog: (agentId: string) =>
    request<{ entries: { id: string; action: string; actorType: string; details: Record<string, unknown>; createdAt: string }[] }>(
      `/agents/${agentId}/audit-log`
    ),
};

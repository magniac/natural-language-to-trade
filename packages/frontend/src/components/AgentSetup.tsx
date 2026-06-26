import React from 'react';
import { ethers } from 'ethers';
import { api } from '../lib/api';
import { signPolicyEIP712 } from '../lib/wallet';
import { saveSession, saveAgentWallet, loadAgentWallet, loadSession, getSessionStatus, clearAgentWallet, clearSession, type PersistedAgentWallet } from '../lib/sessionSigner';
import Card from './Card';
import Button from './Button';
import StatusBadge from './StatusBadge';
import type { WalletState } from '../lib/wallet';

interface Props {
  wallet: WalletState;
}

interface AgentInfo {
  agentWalletId: string;
  address: string;
  proxyWalletAddress?: string;
  policyId?: string;
  status: string;
}

export default function AgentSetup({ wallet }: Props) {
  // Restore persisted state on mount so tab switches don't reset the flow
  const persisted = loadAgentWallet();

  const [agent, setAgent] = React.useState<AgentInfo | null>(
    persisted ? { agentWalletId: persisted.agentWalletId, address: persisted.address, proxyWalletAddress: persisted.proxyWalletAddress, status: 'active', policyId: persisted.policyId } : null
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [step, setStep] = React.useState<'idle' | 'creating' | 'configuring' | 'signing' | 'done'>(
    persisted?.step ?? 'idle'
  );

  // Policy configuration state — restore from localStorage so tab switches don't reset values
  const [budget, setBudget] = React.useState(persisted?.budget ?? '50');
  const [maxOrder, setMaxOrder] = React.useState(persisted?.maxOrder ?? '10');
  const [dailyLimit, setDailyLimit] = React.useState(persisted?.dailyLimit ?? '25');
  const [maxOpenOrders, setMaxOpenOrders] = React.useState(persisted?.maxOpenOrders ?? '5');
  const [expiryDays, setExpiryDays] = React.useState(persisted?.expiryDays ?? '7');
  // Market safety filters (empty string = no limit/disabled)
  const [minLiquidityUSDC, setMinLiquidityUSDC] = React.useState(persisted?.minLiquidityUSDC ?? '100');
  const [maxSpreadBps, setMaxSpreadBps] = React.useState(persisted?.maxSpreadBps ?? '500');
  const [nearResolutionHours, setNearResolutionHours] = React.useState(persisted?.nearResolutionHours ?? '1');
  const [maxPrice, setMaxPrice] = React.useState(persisted?.maxPrice ?? '');
  // Allowed operations
  const [allowBuy, setAllowBuy] = React.useState(persisted?.allowBuy ?? true);
  const [allowSell, setAllowSell] = React.useState(persisted?.allowSell ?? true);
  // Hyperliquid venue (spot)
  const [allowHyperliquid, setAllowHyperliquid] = React.useState(persisted?.allowHyperliquid ?? false);
  const [hlAllowedCoins, setHlAllowedCoins] = React.useState(persisted?.hlAllowedCoins ?? '');
  const [hlMaxOrder, setHlMaxOrder] = React.useState(persisted?.hlMaxOrder ?? '1');
  const [hlSlippageBps, setHlSlippageBps] = React.useState(persisted?.hlSlippageBps ?? '100');
  const [signedPolicyId, setSignedPolicyId] = React.useState<string | null>(persisted?.policyId ?? null);
  const [clobStatus, setClobStatus] = React.useState<'unknown' | 'none' | 'active' | 'deriving' | 'error'>('unknown');
  const [clobDerivedAt, setClobDerivedAt] = React.useState<string | null>(null);
  const [llmKeyStatus, setLlmKeyStatus] = React.useState<'unknown' | 'none' | 'active'>('unknown');
  const [llmKeyInput, setLlmKeyInput] = React.useState('');
  const [llmKeySaving, setLlmKeySaving] = React.useState(false);
  const [llmKeyError, setLlmKeyError] = React.useState<string | null>(null);
  const [relayerKeyStatus, setRelayerKeyStatus] = React.useState<'unknown' | 'none' | 'active'>('unknown');
  const [relayerKeyInput, setRelayerKeyInput] = React.useState('');
  const [relayerAddrInput, setRelayerAddrInput] = React.useState('');
  const [relayerKeySaving, setRelayerKeySaving] = React.useState(false);
  const [relayerKeyError, setRelayerKeyError] = React.useState<string | null>(null);
  // Hyperliquid API wallet + deposit
  const [hlKeyStatus, setHlKeyStatus] = React.useState<'unknown' | 'none' | 'active'>('unknown');
  const [hlAddrInput, setHlAddrInput] = React.useState('');
  const [hlKeyInput, setHlKeyInput] = React.useState('');
  const [hlKeySaving, setHlKeySaving] = React.useState(false);
  const [hlKeyError, setHlKeyError] = React.useState<string | null>(null);
  const [hlBalance, setHlBalance] = React.useState<{ usdc: number; balances: { coin: string; total: number }[] } | null>(null);
  const [hlDepositAmount, setHlDepositAmount] = React.useState('10');
  const [hlDepositError, setHlDepositError] = React.useState<string | null>(null);
  const [hlDepositing, setHlDepositing] = React.useState(false);
  const [paperMode, setPaperMode] = React.useState(true);
  const [serverLiveEnabled, setServerLiveEnabled] = React.useState(false);
  const [modeSaving, setModeSaving] = React.useState(false);
  const [wantsLive, setWantsLive] = React.useState(false);

  // On-chain funding state
  type FundStatus = { usdcBalance: number; allowanceExchange: number; allowanceNegRisk: number; ctfApproved: boolean } | null;
  const [fundStatus, setFundStatus] = React.useState<FundStatus>(null);
  const [fundLoading, setFundLoading] = React.useState(false);
  const [fundError, setFundError] = React.useState<string | null>(null);
  const [approving, setApproving] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);

  // Private key import / export state
  const [importKeyInput, setImportKeyInput] = React.useState('');
  const [importKeyLoading, setImportKeyLoading] = React.useState(false);
  const [importKeyError, setImportKeyError] = React.useState<string | null>(null);
  const [provisionLoading, setProvisionLoading] = React.useState(false);
  const [provisionError, setProvisionError] = React.useState<string | null>(null);
  const [myWalletPusd, setMyWalletPusd] = React.useState<number | null>(null);

  const activePolicyId = signedPolicyId ?? agent?.policyId ?? null;
  const isEditingExistingPolicy = Boolean(activePolicyId) && step === 'configuring';

  function persistCurrentAgentWallet(
    nextStep: PersistedAgentWallet['step'],
    overrides: Partial<PersistedAgentWallet> = {},
  ) {
    if (!agent) return;
    saveAgentWallet({
      agentWalletId: agent.agentWalletId,
      address: agent.address,
      proxyWalletAddress: agent.proxyWalletAddress,
      step: nextStep,
      policyId: activePolicyId ?? undefined,
      budget,
      maxOrder,
      dailyLimit,
      maxOpenOrders,
      expiryDays,
      minLiquidityUSDC,
      maxSpreadBps,
      nearResolutionHours,
      maxPrice,
      allowBuy,
      allowSell,
      allowHyperliquid,
      hlAllowedCoins,
      hlMaxOrder,
      hlSlippageBps,
      ...overrides,
    });
  }

  function beginPolicyEdit() {
    if (!agent) return;
    setError(null);
    setStep('configuring');
    persistCurrentAgentWallet('configuring');
  }

  function cancelPolicyEdit() {
    if (!agent) return;
    setError(null);
    setStep('done');
    persistCurrentAgentWallet('done');
  }

  React.useEffect(() => {
    if (!agent?.agentWalletId) return;
    let cancelled = false;

    api.getAgent(agent.agentWalletId)
      .then(serverAgent => {
        if (cancelled) return;
        const serverProxyWallet = 'proxy_wallet_address' in serverAgent
          ? serverAgent.proxy_wallet_address ?? undefined
          : agent.proxyWalletAddress;
        const normalizedAgent = {
          ...agent,
          address: serverAgent.address,
          status: serverAgent.status,
          proxyWalletAddress: serverProxyWallet,
        };
        setAgent(normalizedAgent);

        const persistedAgent = loadAgentWallet();
        if (persistedAgent?.agentWalletId === agent.agentWalletId) {
          saveAgentWallet({
            ...persistedAgent,
            address: serverAgent.address,
            proxyWalletAddress: serverProxyWallet,
          });
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [agent?.agentWalletId]);

  // Load LLM key status when agent is known
  React.useEffect(() => {
    if (!agent?.agentWalletId || step !== 'done') return;
    fetch(`/api/agents/${agent.agentWalletId}/llm-key/status`)
      .then(r => r.json())
      .then((d: { hasKey: boolean }) => setLlmKeyStatus(d.hasKey ? 'active' : 'none'))
      .catch(() => setLlmKeyStatus('unknown'));
    fetch(`/api/agents/${agent.agentWalletId}/relayer-key/status`)
      .then(r => r.json())
      .then((d: { hasKey: boolean }) => setRelayerKeyStatus(d.hasKey ? 'active' : 'none'))
      .catch(() => setRelayerKeyStatus('unknown'));
    fetch(`/api/agents/${agent.agentWalletId}/hyperliquid-key/status`)
      .then(r => r.json())
      .then((d: { hasKey: boolean }) => { setHlKeyStatus(d.hasKey ? 'active' : 'none'); if (d.hasKey) void refreshHlBalance(); })
      .catch(() => setHlKeyStatus('unknown'));
  }, [agent?.agentWalletId, step]);

  // The agent that matters for mode/trades is the one in the active session,
  // which may differ from the one shown in Agent Setup if the user has multiple agents.
  const activeSessionAgentId = loadSession()?.agentWalletId ?? agent?.agentWalletId;

  // Load serverLiveEnabled as soon as we have any agent (needed in configuring step too)
  React.useEffect(() => {
    if (!agent?.agentWalletId) return;
    fetch(`/api/agents/${agent.agentWalletId}/mode`)
      .then(r => r.json())
      .then((d: { serverLiveEnabled: boolean }) => setServerLiveEnabled(d.serverLiveEnabled))
      .catch(() => {});
  }, [agent?.agentWalletId]);

  // Load the current paper/live state for the active session agent (done step only)
  React.useEffect(() => {
    if (!activeSessionAgentId || step !== 'done') return;
    fetch(`/api/agents/${activeSessionAgentId}/mode`)
      .then(r => r.json())
      .then((d: { paperMode: boolean; serverLiveEnabled: boolean }) => {
        setPaperMode(d.paperMode);
        setServerLiveEnabled(d.serverLiveEnabled);
      })
      .catch(() => {});
  }, [activeSessionAgentId, step]);

  async function setMode(live: boolean) {
    if (!activeSessionAgentId) return;
    setModeSaving(true);
    try {
      const res = await fetch(`/api/agents/${activeSessionAgentId}/mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paperMode: !live }),
      });
      if (res.ok) setPaperMode(!live);
    } finally {
      setModeSaving(false);
    }
  }

  // Load on-chain funding status when agent is known
  async function refreshFundStatus() {
    if (!agent?.agentWalletId) return;
    setFundLoading(true); setFundError(null);
    try {
      const r = await fetch(`/api/agents/${agent.agentWalletId}/usdc-balance`);
      if (!r.ok) throw new Error((await r.json() as { error: string }).error);
      const data = await r.json() as NonNullable<FundStatus> & { proxyWalletAddress?: string | null };
      setFundStatus({ usdcBalance: data.usdcBalance, allowanceExchange: data.allowanceExchange, allowanceNegRisk: data.allowanceNegRisk, ctfApproved: data.ctfApproved });
      // The backend (DB) is the source of truth for the provisioned deposit wallet — sync it so
      // switching tabs / reloading doesn't lose the provision step.
      const proxy = data?.proxyWalletAddress ?? undefined;
      if (proxy && proxy !== agent.proxyWalletAddress) {
        setAgent(prev => prev ? { ...prev, proxyWalletAddress: proxy } : prev);
        persistProxyAddress(proxy);
      }
    } catch (err) {
      setFundError(err instanceof Error ? err.message : 'RPC error');
    } finally {
      setFundLoading(false);
    }
  }

  function persistProxyAddress(proxy?: string) {
    const cur = loadAgentWallet();
    if (cur) saveAgentWallet({ ...cur, proxyWalletAddress: proxy });
  }

  React.useEffect(() => {
    if (!agent?.agentWalletId || step !== 'done') return;
    void refreshFundStatus();
  }, [agent?.agentWalletId, step]);

  // Polymarket migrated from USDC.e to pUSD in April 2026.
  // pUSD is Polymarket's collateral token (ERC-20 on Polygon). Transfer it from any wallet that holds it.
  const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

  async function sendUsdcToAgent() {
    if (!agent || wallet.status !== 'connected') return;
    if (!agent.proxyWalletAddress) {
      setFundError('Provision the Polymarket deposit wallet before funding.');
      return;
    }
    const fundTarget = agent.proxyWalletAddress;
    setFundError(null);
    try {
      await wallet.provider.send('wallet_switchEthereumChain', [{ chainId: '0x89' }]);
      const signer = await wallet.provider.getSigner();
      const pUSD = new ethers.Contract(
        PUSD_ADDRESS,
        ['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
        signer,
      );
      const userBalance = await pUSD.balanceOf(await signer.getAddress()) as bigint;
      const amount = ethers.parseUnits(budget, 6);
      if (userBalance < amount) {
        const have = parseFloat(ethers.formatUnits(userBalance, 6)).toFixed(2);
        throw new Error(`Your wallet only has $${have} pUSD. Make sure your MetaMask wallet has pUSD on Polygon.`);
      }
      const tx = await (pUSD.transfer(fundTarget, amount) as Promise<ethers.TransactionResponse>);
      await tx.wait();
      void refreshFundStatus();
    } catch (err) {
      setFundError(err instanceof Error ? err.message : 'Transfer failed');
      throw err;
    }
  }

  async function approveUsdc() {
    if (!agent) return;
    setApproving(true); setFundError(null);
    try {
      const r = await fetch(`/api/agents/${agent.agentWalletId}/approve-usdc`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json() as { error: string }).error);
      void refreshFundStatus();
    } catch (err) {
      setFundError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setApproving(false);
    }
  }

  async function withdrawFromAgent() {
    if (!agent || wallet.status !== 'connected') return;
    setWithdrawing(true); setFundError(null);
    try {
      const to = await wallet.provider.getSigner().then(s => s.getAddress());
      const r = await fetch(`/api/agents/${agent.agentWalletId}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      });
      const result = await r.json() as { error?: string };
      if (!r.ok) throw new Error(result.error ?? 'Withdraw failed');
      void refreshFundStatus();
    } catch (err) {
      setFundError(err instanceof Error ? err.message : 'Withdraw failed');
    } finally {
      setWithdrawing(false);
    }
  }

  // Fetch connected MetaMask wallet's pUSD balance for display
  const connectedWalletAddress = wallet.status === 'connected' ? wallet.address : null;
  React.useEffect(() => {
    if (!connectedWalletAddress || step !== 'done') return;
    const provider = (wallet as { provider?: ethers.BrowserProvider }).provider;
    if (!provider) return;
    const pUSD = new ethers.Contract(
      PUSD_ADDRESS,
      ['function balanceOf(address) view returns (uint256)'],
      provider,
    );
    (pUSD.balanceOf(connectedWalletAddress) as Promise<bigint>)
      .then(b => setMyWalletPusd(parseFloat(ethers.formatUnits(b, 6))))
      .catch(() => null);
  }, [connectedWalletAddress, step]);

  async function importAgentKey() {
    if (!agent || !importKeyInput.trim()) return;
    setImportKeyLoading(true); setImportKeyError(null);
    try {
      const r = await fetch(`/api/agents/${agent.agentWalletId}/import-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: importKeyInput.trim() }),
      });
      const data = await r.json() as { success?: boolean; address?: string; error?: string };
      if (!r.ok || !data.success) throw new Error(data.error ?? 'Import failed');
      const importedAddress = data.address;
      if (!importedAddress) throw new Error('Import succeeded but no address was returned');
      // Changing the EOA invalidates the previously provisioned proxy wallet.
      setAgent(prev => prev ? { ...prev, address: importedAddress, proxyWalletAddress: undefined } : prev);
      saveAgentWallet({
        agentWalletId: agent.agentWalletId,
        address: importedAddress,
        proxyWalletAddress: undefined,
        step: step === 'done' ? 'done' : 'configuring',
        policyId: activePolicyId ?? undefined,
        budget,
        maxOrder,
        dailyLimit,
        maxOpenOrders,
        expiryDays,
        minLiquidityUSDC,
        maxSpreadBps,
        nearResolutionHours,
        maxPrice,
        allowBuy,
        allowSell,
        allowHyperliquid,
        hlAllowedCoins,
        hlMaxOrder,
        hlSlippageBps,
      });
      setImportKeyInput('');
      setClobStatus('none');
      void refreshFundStatus();
    } catch (err) {
      setImportKeyError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportKeyLoading(false);
    }
  }

  async function provisionWallet() {
    if (!agent) return;
    setProvisionLoading(true); setProvisionError(null);
    try {
      const r = await fetch(`/api/agents/${agent.agentWalletId}/provision-wallet`, { method: 'POST' });
      const data = await r.json() as { success?: boolean; proxyWalletAddress?: string; created?: boolean; error?: string };
      if (!r.ok || !data.success) throw new Error(data.error ?? 'Provisioning failed');
      setAgent(prev => prev ? { ...prev, proxyWalletAddress: data.proxyWalletAddress } : prev);
      persistProxyAddress(data.proxyWalletAddress);
      void refreshFundStatus();
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : 'Provisioning failed');
    } finally {
      setProvisionLoading(false);
    }
  }

  // Load CLOB credential status when agent is known
  React.useEffect(() => {
    if (!agent?.agentWalletId || step !== 'done') return;
    fetch(`/api/agents/${agent.agentWalletId}/clob/status`)
      .then(r => r.json())
      .then((d: { hasCreds: boolean; derivedAt?: string }) => {
        setClobStatus(d.hasCreds ? 'active' : 'none');
        if (d.derivedAt) setClobDerivedAt(d.derivedAt);
      })
      .catch(() => setClobStatus('unknown'));
  }, [agent?.agentWalletId, step]);

  if (wallet.status !== 'connected') {
    return (
      <Card>
        <p style={{ color: '#6b7280', fontSize: 14 }}>Connect your wallet to create an autonomous trading agent.</p>
      </Card>
    );
  }

  const userId = wallet.address; // wallet address is the natural user identity

  async function createAgent() {
    setLoading(true); setError(null);
    try {
      const result = await api.createAgent(userId);
      const newAgent = { agentWalletId: result.agentWalletId, address: result.address, status: 'active' };
      setAgent(newAgent);
      setStep('configuring');
      saveAgentWallet({ agentWalletId: result.agentWalletId, address: result.address, proxyWalletAddress: undefined, step: 'configuring', budget, maxOrder, dailyLimit, maxOpenOrders, expiryDays, minLiquidityUSDC, maxSpreadBps, nearResolutionHours, maxPrice, allowBuy, allowSell, allowHyperliquid, hlAllowedCoins, hlMaxOrder, hlSlippageBps });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setLoading(false);
    }
  }

  async function signAndSubmitPolicy() {
    if (!agent || wallet.status !== 'connected') return;
    setLoading(true); setError(null);

    try {
      const sessionWallet = ethers.Wallet.createRandom();
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresSec = nowSec + parseInt(expiryDays) * 86400;

      const policy = {
        version: '1' as const,
        userWallet: wallet.address,
        agentWallet: agent.address,
        sessionKey: sessionWallet.address,
        createdAt: nowSec,
        expiresAt: expiresSec,
        revocationNonce: `revoke-${Date.now()}`,
        llm: {
          allowedModels: [
            'anthropic/claude-sonnet-4.6',
            'anthropic/claude-sonnet-4.5',
            'anthropic/claude-haiku-4-5',
            'anthropic/claude-3-haiku',
          ],
          maxRequestsPerHour: 20,
          maxTokensPerRequest: 4000,
          maxSpendPerDayUSDC: 2,
        },
        trading: {
          maxBudgetUSDC: parseFloat(budget),
          maxOrderSizeUSDC: parseFloat(maxOrder),
          maxDailySpendUSDC: parseFloat(dailyLimit),
          maxOpenOrders: parseInt(maxOpenOrders) || 5,
          allowedMarkets: [],
          allowedCategories: [],
          allowedSides: [
            ...(allowBuy ? ['BUY' as const] : []),
            ...(allowSell ? ['SELL' as const] : []),
          ],
          allowedOrderTypes: ['GTD', 'GTC', 'FOK', 'FAK'],
          maxPrice: maxPrice !== '' ? parseFloat(maxPrice) : null,
          minLiquidityUSDC: minLiquidityUSDC !== '' ? parseFloat(minLiquidityUSDC) : null,
          maxSpreadBps: maxSpreadBps !== '' ? parseInt(maxSpreadBps) : null,
          nearResolutionHours: nearResolutionHours !== '' ? parseFloat(nearResolutionHours) : null,
          minExpirationSeconds: 60,
          maxExpirationSeconds: 3600,
        },
        allowedVenues: [
          'polymarket' as const,
          ...(allowHyperliquid ? ['hyperliquid' as const] : []),
        ],
        hyperliquid: {
          maxOrderSizeUSDC: parseFloat(hlMaxOrder) || 1,
          allowedCoins: hlAllowedCoins.split(',').map(c => c.trim().toUpperCase()).filter(Boolean),
          maxSlippageBps: parseInt(hlSlippageBps) || 100,
        },
      };

      // Compute policy hash client-side (same logic as backend)
      const policyStr = JSON.stringify(policy, (_key, value) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
        }
        return value;
      });
      const msgBuffer = new TextEncoder().encode(policyStr);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const policyHash = '0x' + Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      const sig = await signPolicyEIP712(wallet.provider, {
        version: policy.version,
        userWallet: policy.userWallet,
        agentWallet: policy.agentWallet,
        sessionKey: policy.sessionKey,
        createdAt: policy.createdAt,
        expiresAt: policy.expiresAt,
        revocationNonce: policy.revocationNonce,
        policyHash,
      });

      const result = await fetch(`/api/agents/${agent.agentWalletId}/policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          sessionKeyAddress: sessionWallet.address,
          policy,
          userSignature: sig,
        }),
      });

      if (!result.ok) {
        const errBody = await result.json().catch(() => ({})) as { error?: string; reason?: string };
        const msg = [errBody.error, errBody.reason].filter(Boolean).join(': ');
        throw new Error(msg || `Policy submission failed (HTTP ${result.status})`);
      }

      const data = await result.json() as { policyId: string };
      setSignedPolicyId(data.policyId);
      setAgent(a => a ? { ...a, policyId: data.policyId } : a);

      // Persist session key so the Trade tab can sign requests
      saveSession({
        sessionPrivateKey: sessionWallet.privateKey,
        sessionAddress: sessionWallet.address,
        policyId: data.policyId,
        agentWalletId: agent.agentWalletId,
        agentAddress: agent.address,
        expiresAt: expiresSec,
      });

      // Persist agent wallet state so tab switches don't reset the UI
      saveAgentWallet({ agentWalletId: agent.agentWalletId, address: agent.address, proxyWalletAddress: agent.proxyWalletAddress, step: 'done', policyId: data.policyId, budget, maxOrder, dailyLimit, maxOpenOrders, expiryDays, minLiquidityUSDC, maxSpreadBps, nearResolutionHours, maxPrice, allowBuy, allowSell, allowHyperliquid, hlAllowedCoins, hlMaxOrder, hlSlippageBps });

      setStep('done');

      // If user chose live trading, set mode in DB then auto-trigger funding flow
      if (wantsLive && serverLiveEnabled) {
        await fetch(`/api/agents/${agent.agentWalletId}/mode`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paperMode: false }),
        });
        setPaperMode(false);
        // MetaMask prompts once to send pUSD to the Polymarket proxy wallet.
        try { await sendUsdcToAgent(); } catch { /* error shown in fund card */ return; }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign policy');
    } finally {
      setLoading(false);
    }
  }

  async function deriveCredentials() {
    if (!agent) return;
    setClobStatus('deriving');
    try {
      const res = await fetch(`/api/agents/${agent.agentWalletId}/clob/derive`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { reason?: string };
        setClobStatus('error');
        setError(body.reason ?? 'Credential derivation failed');
        return;
      }
      const statusRes = await fetch(`/api/agents/${agent.agentWalletId}/clob/status`);
      const statusData = await statusRes.json() as { hasCreds: boolean; derivedAt?: string };
      setClobStatus(statusData.hasCreds ? 'active' : 'error');
      if (statusData.derivedAt) setClobDerivedAt(statusData.derivedAt);
    } catch {
      setClobStatus('error');
      setError('Network error during credential derivation');
    }
  }

  async function saveLlmKey() {
    if (!agent || !llmKeyInput.trim()) return;
    setLlmKeySaving(true); setLlmKeyError(null);
    try {
      const res = await fetch(`/api/agents/${agent.agentWalletId}/llm-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: llmKeyInput.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setLlmKeyError(body.error ?? 'Failed to save key');
      } else {
        setLlmKeyStatus('active');
        setLlmKeyInput('');
      }
    } catch {
      setLlmKeyError('Network error');
    } finally {
      setLlmKeySaving(false);
    }
  }

  async function removeLlmKey() {
    if (!agent) return;
    await fetch(`/api/agents/${agent.agentWalletId}/llm-key`, { method: 'DELETE' });
    setLlmKeyStatus('none');
    setLlmKeyInput('');
  }

  async function saveRelayerKey() {
    if (!agent || !relayerKeyInput.trim() || !relayerAddrInput.trim()) return;
    setRelayerKeySaving(true); setRelayerKeyError(null);
    try {
      const res = await fetch(`/api/agents/${agent.agentWalletId}/relayer-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: relayerKeyInput.trim(), apiKeyAddress: relayerAddrInput.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setRelayerKeyError(body.error ?? 'Failed to save relayer key');
      } else {
        setRelayerKeyStatus('active');
        setRelayerKeyInput('');
        setRelayerAddrInput('');
      }
    } catch {
      setRelayerKeyError('Network error');
    } finally {
      setRelayerKeySaving(false);
    }
  }

  async function removeRelayerKey() {
    if (!agent) return;
    await fetch(`/api/agents/${agent.agentWalletId}/relayer-key`, { method: 'DELETE' });
    setRelayerKeyStatus('none');
    setRelayerKeyInput('');
    setRelayerAddrInput('');
  }

  // ── Hyperliquid: API wallet + deposit ──
  // Hyperliquid Bridge2 on Arbitrum. Send native USDC (Circle's, NOT USDC.e); minimum $5.
  const HL_BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
  const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
  const ARBITRUM_CHAIN = '0xa4b1';

  async function refreshHlBalance() {
    if (!agent) return;
    try {
      const r = await fetch(`/api/agents/${agent.agentWalletId}/hyperliquid-balance`);
      if (r.ok) setHlBalance(await r.json() as { usdc: number; balances: { coin: string; total: number }[] });
    } catch { /* ignore */ }
  }

  async function saveHlKey() {
    if (!agent || !hlKeyInput.trim() || !hlAddrInput.trim()) return;
    setHlKeySaving(true); setHlKeyError(null);
    try {
      let derived: string;
      try { derived = new ethers.Wallet(hlKeyInput.trim()).address; } catch { throw new Error('Invalid private key'); }
      if (derived.toLowerCase() !== hlAddrInput.trim().toLowerCase()) {
        throw new Error(`Key does not match address — it belongs to ${derived}`);
      }
      const r = await fetch(`/api/agents/${agent.agentWalletId}/hyperliquid-key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiWalletAddress: hlAddrInput.trim(), privateKey: hlKeyInput.trim() }),
      });
      const data = await r.json() as { status?: string; error?: string };
      if (!r.ok || data.status !== 'stored') throw new Error(data.error ?? 'Failed to save');
      setHlKeyStatus('active'); setHlKeyInput(''); setHlAddrInput('');
      void refreshHlBalance();
    } catch (err) {
      setHlKeyError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setHlKeySaving(false);
    }
  }

  async function removeHlKey() {
    if (!agent) return;
    await fetch(`/api/agents/${agent.agentWalletId}/hyperliquid-key`, { method: 'DELETE' });
    setHlKeyStatus('none'); setHlKeyInput(''); setHlAddrInput(''); setHlBalance(null);
  }

  async function depositToHyperliquid() {
    if (!agent || wallet.status !== 'connected') return;
    setHlDepositError(null); setHlDepositing(true);
    try {
      const amt = parseFloat(hlDepositAmount);
      if (!(amt >= 5)) throw new Error('Hyperliquid requires a minimum deposit of 5 USDC.');
      await wallet.provider.send('wallet_switchEthereumChain', [{ chainId: ARBITRUM_CHAIN }]);
      const signer = await wallet.provider.getSigner();
      const usdc = new ethers.Contract(
        ARB_USDC,
        ['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
        signer,
      );
      const bal = await usdc.balanceOf(await signer.getAddress()) as bigint;
      const amount = ethers.parseUnits(hlDepositAmount, 6);
      if (bal < amount) {
        const have = parseFloat(ethers.formatUnits(bal, 6)).toFixed(2);
        throw new Error(`Your wallet has only $${have} native USDC on Arbitrum. Bridge in native USDC (not USDC.e) first.`);
      }
      // Funds credit your Hyperliquid master account (this connected wallet) in under a minute.
      const tx = await (usdc.transfer(HL_BRIDGE, amount) as Promise<ethers.TransactionResponse>);
      await tx.wait();
      setTimeout(() => void refreshHlBalance(), 8000);
    } catch (err) {
      setHlDepositError(err instanceof Error ? err.message : 'Deposit failed');
    } finally {
      setHlDepositing(false);
    }
  }

  async function pauseAgent() {
    if (!agent) return;
    await api.pauseAgent(agent.agentWalletId);
    setAgent(a => a ? { ...a, status: 'paused' } : a);
  }

  async function resumeAgent() {
    if (!agent) return;
    await api.resumeAgent(agent.agentWalletId);
    setAgent(a => a ? { ...a, status: 'active' } : a);
  }

  async function revokePolicy() {
    if (!agent) return;
    setLoading(true);
    try {
      await api.revokeAgent(agent.agentWalletId);
    } catch {
      // Backend may error but we still clear local state
    } finally {
      setLoading(false);
    }
    clearSession();
    clearAgentWallet();
    setAgent(null);
    setStep('idle');
    setSignedPolicyId(null);
  }

  return (
    <Card>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: '#e2e8f0' }}>
        Autonomous Agent Setup
      </h3>

      {!agent && step === 'idle' && (
        <div>
          <p style={{ color: '#a0aec0', fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
            Create a dedicated agent wallet. The agent will trade within strict limits you control.
            Your main wallet key is never exposed to the backend.
          </p>
          <Button onClick={createAgent} loading={loading}>Create Agent Wallet</Button>
        </div>
      )}

      {agent && step === 'configuring' && (
        <div>
          <div style={{ marginBottom: 20, padding: '14px 16px', background: '#0f1117', borderRadius: 8, border: '1px solid #2d3748', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Agent Wallet</p>
            <div>
              <p style={{ fontSize: 11, color: '#4b5563', marginBottom: 4 }}>Agent wallet private key</p>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="password"
                  value={importKeyInput}
                  onChange={e => setImportKeyInput(e.target.value)}
                  placeholder="0x…"
                  style={{ flex: 1, background: '#1a1d27', border: '1px solid #2d3748', borderRadius: 4, color: '#e2e8f0', padding: '5px 8px', fontSize: 12, fontFamily: 'monospace' }}
                />
                <Button size="sm" variant="ghost" onClick={importAgentKey} loading={importKeyLoading} disabled={!importKeyInput.trim()}>
                  Save
                </Button>
              </div>
              <p style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>The Polymarket deposit wallet is provisioned automatically after you add your relayer key (next step).</p>
            </div>
            {importKeyError && <p style={{ fontSize: 11, color: '#f87171', margin: 0 }}>{importKeyError}</p>}
            {agent.address && (
              <p style={{ fontSize: 11, color: '#4b5563', margin: 0 }}>Address: <code style={{ color: '#6b7280' }}>{agent.address}</code></p>
            )}
          </div>

          <h4 style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 16 }}>
            {isEditingExistingPolicy ? 'Edit Trading Policy' : 'Configure Trading Policy'}
          </h4>

          {isEditingExistingPolicy && (
            <div style={{
              background: '#1e3a5f33', border: '1px solid #1e3a5f',
              borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            }}>
              <p style={{ fontSize: 13, color: '#93c5fd', lineHeight: 1.6 }}>
                Adjust the limits below, then re-sign to replace the current active policy.
                The existing policy remains active until the new signature is accepted.
              </p>
            </div>
          )}

          {/* Section: Budget & Limits */}
          <p style={{ fontSize: 11, color: '#4b5563', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Budget & Limits</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
            {([
              { label: 'Max Budget (USDC)', value: budget, set: setBudget, key: 'budget', hint: 'Total exposure cap' },
              { label: 'Max Order Size (USDC)', value: maxOrder, set: setMaxOrder, key: 'maxOrder', hint: 'Per-order limit' },
              { label: 'Max Daily Spend (USDC)', value: dailyLimit, set: setDailyLimit, key: 'dailyLimit', hint: 'Daily spending cap' },
              { label: 'Max Open Orders', value: maxOpenOrders, set: setMaxOpenOrders, key: 'maxOpenOrders', hint: 'Concurrent positions' },
              { label: 'Policy Duration (days)', value: expiryDays, set: setExpiryDays, key: 'expiryDays', hint: 'Auto-expiry' },
            ] as const).map(({ label, value, set, key: fieldKey, hint }) => (
              <div key={label}>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 6 }}>{label}</label>
                <input
                  type="number"
                  value={value}
                  onChange={e => {
                    (set as (v: string) => void)(e.target.value);
                    if (agent) saveAgentWallet({ agentWalletId: agent.agentWalletId, address: agent.address, proxyWalletAddress: agent.proxyWalletAddress, step: 'configuring', budget, maxOrder, dailyLimit, maxOpenOrders, expiryDays, minLiquidityUSDC, maxSpreadBps, nearResolutionHours, maxPrice, allowBuy, allowSell, [fieldKey]: e.target.value });
                  }}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: '#0f1117', border: '1px solid #2d3748', color: '#e2e8f0', fontSize: 14, outline: 'none' }}
                />
                <p style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>{hint}</p>
              </div>
            ))}
          </div>

          {/* Section: Market Safety Filters */}
          <p style={{ fontSize: 11, color: '#4b5563', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Market Safety Filters</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
            {([
              { label: 'Min Liquidity (USDC)', value: minLiquidityUSDC, set: setMinLiquidityUSDC, key: 'minLiquidityUSDC', hint: 'Leave blank to disable', placeholder: 'e.g. 100' },
              { label: 'Max Spread (bps)', value: maxSpreadBps, set: setMaxSpreadBps, key: 'maxSpreadBps', hint: 'Leave blank to disable', placeholder: 'e.g. 500' },
              { label: 'Near-Resolution Block (hours)', value: nearResolutionHours, set: setNearResolutionHours, key: 'nearResolutionHours', hint: 'Block trading X hrs before resolution. Leave blank to disable', placeholder: 'e.g. 1' },
              { label: 'Max Price (0–1)', value: maxPrice, set: setMaxPrice, key: 'maxPrice', hint: 'Max limit price per share. Leave blank to disable', placeholder: 'e.g. 0.95' },
            ] as const).map(({ label, value, set, key: fieldKey, hint, placeholder }) => (
              <div key={label}>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 6 }}>{label}</label>
                <input
                  type="number"
                  value={value}
                  placeholder={placeholder}
                  onChange={e => {
                    (set as (v: string) => void)(e.target.value);
                    if (agent) saveAgentWallet({ agentWalletId: agent.agentWalletId, address: agent.address, proxyWalletAddress: agent.proxyWalletAddress, step: 'configuring', budget, maxOrder, dailyLimit, maxOpenOrders, expiryDays, minLiquidityUSDC, maxSpreadBps, nearResolutionHours, maxPrice, allowBuy, allowSell, [fieldKey]: e.target.value });
                  }}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: '#0f1117', border: '1px solid #2d3748', color: '#e2e8f0', fontSize: 14, outline: 'none' }}
                />
                <p style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>{hint}</p>
              </div>
            ))}
          </div>

          {/* Section: Allowed Operations */}
          <p style={{ fontSize: 11, color: '#4b5563', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Allowed Operations</p>
          <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
            {([
              { label: 'Allow BUY orders', value: allowBuy, set: setAllowBuy, key: 'allowBuy' },
              { label: 'Allow SELL orders', value: allowSell, set: setAllowSell, key: 'allowSell' },
            ] as const).map(({ label, value, set, key: fieldKey }) => (
              <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#a0aec0' }}>
                <input
                  type="checkbox"
                  checked={value}
                  onChange={e => {
                    (set as (v: boolean) => void)(e.target.checked);
                    if (agent) saveAgentWallet({ agentWalletId: agent.agentWalletId, address: agent.address, proxyWalletAddress: agent.proxyWalletAddress, step: 'configuring', budget, maxOrder, dailyLimit, maxOpenOrders, expiryDays, minLiquidityUSDC, maxSpreadBps, nearResolutionHours, maxPrice, allowBuy, allowSell, [fieldKey]: e.target.checked });
                  }}
                  style={{ accentColor: '#6366f1', width: 16, height: 16 }}
                />
                {label}
              </label>
            ))}
          </div>

          {/* Section: Trading Venues */}
          <p style={{ fontSize: 11, color: '#4b5563', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Trading Venues</p>
          <div style={{ marginBottom: 20, padding: '12px 14px', background: '#0f1117', borderRadius: 8, border: '1px solid #2d3748' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#a0aec0' }}>
              <input type="checkbox" checked style={{ accentColor: '#6366f1', width: 16, height: 16 }} disabled readOnly />
              Polymarket (prediction markets) — always enabled
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#a0aec0', marginTop: 10 }}>
              <input
                type="checkbox"
                checked={allowHyperliquid}
                onChange={e => {
                  setAllowHyperliquid(e.target.checked);
                  if (agent) saveAgentWallet({ agentWalletId: agent.agentWalletId, address: agent.address, step: 'configuring', allowHyperliquid: e.target.checked, hlAllowedCoins, hlMaxOrder, hlSlippageBps });
                }}
                style={{ accentColor: '#6366f1', width: 16, height: 16 }}
              />
              Hyperliquid (crypto spot, mainnet — real funds)
            </label>
            {allowHyperliquid && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                {([
                  { label: 'HL Max Order (USDC)', value: hlMaxOrder, set: setHlMaxOrder, key: 'hlMaxOrder', placeholder: 'e.g. 1', hint: 'Per HL spot order' },
                  { label: 'HL Max Slippage (bps)', value: hlSlippageBps, set: setHlSlippageBps, key: 'hlSlippageBps', placeholder: 'e.g. 100', hint: '100 = 1%' },
                ] as const).map(({ label, value, set, key: fieldKey, placeholder, hint }) => (
                  <div key={label}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 6 }}>{label}</label>
                    <input
                      type="number"
                      value={value}
                      placeholder={placeholder}
                      onChange={e => {
                        (set as (v: string) => void)(e.target.value);
                        if (agent) saveAgentWallet({ agentWalletId: agent.agentWalletId, address: agent.address, step: 'configuring', [fieldKey]: e.target.value });
                      }}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: '#1a1d27', border: '1px solid #2d3748', color: '#e2e8f0', fontSize: 14, outline: 'none' }}
                    />
                    <p style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>{hint}</p>
                  </div>
                ))}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 6 }}>Allowed Coins (comma-separated; blank = any)</label>
                  <input
                    type="text"
                    value={hlAllowedCoins}
                    placeholder="e.g. HYPE, PURR, BTC"
                    onChange={e => {
                      setHlAllowedCoins(e.target.value);
                      if (agent) saveAgentWallet({ agentWalletId: agent.agentWalletId, address: agent.address, step: 'configuring', hlAllowedCoins: e.target.value });
                    }}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: '#1a1d27', border: '1px solid #2d3748', color: '#e2e8f0', fontSize: 14, outline: 'none' }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Section: Trading Mode */}
          <p style={{ fontSize: 11, color: '#4b5563', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Trading Mode</p>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            {[
              { id: 'paper', label: 'Paper', desc: 'Simulated — no real money', live: false },
              { id: 'live',  label: 'Live',  desc: `Real orders on Polymarket${!serverLiveEnabled ? ' (disabled on server)' : ''}`, live: true },
            ].map(({ id, label, desc, live }) => (
              <label
                key={id}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', gap: 10, cursor: live && !serverLiveEnabled ? 'not-allowed' : 'pointer',
                  padding: '10px 14px', borderRadius: 8,
                  border: `1px solid ${wantsLive === live ? (live ? '#22c55e66' : '#6366f166') : '#2d3748'}`,
                  background: wantsLive === live ? (live ? '#14532d22' : '#1e1b4b22') : '#0f1117',
                  opacity: live && !serverLiveEnabled ? 0.45 : 1,
                }}
              >
                <input
                  type="radio"
                  name="tradingMode"
                  checked={wantsLive === live}
                  disabled={live && !serverLiveEnabled}
                  onChange={() => setWantsLive(live)}
                  style={{ accentColor: live ? '#22c55e' : '#6366f1' }}
                />
                <div>
                  <div style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>{label}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{desc}</div>
                </div>
              </label>
            ))}
          </div>

          {wantsLive && serverLiveEnabled && (
            <div style={{ background: '#92400e22', border: '1px solid #92400e66', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
              <p style={{ fontSize: 12, color: '#fbbf24', lineHeight: 1.5 }}>
                After signing, MetaMask will prompt you to send <strong>${budget} pUSD</strong> to the Polymarket wallet. No POL funding is required.
              </p>
            </div>
          )}

          <div style={{
            background: '#1e3a5f33', border: '1px solid #1e3a5f',
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
          }}>
            <p style={{ fontSize: 13, color: '#93c5fd', lineHeight: 1.6 }}>
              You will sign this policy with your wallet (EIP-712). The backend verifies this signature
              before executing any trade. Policy enforces hard limits — the agent cannot exceed them.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button onClick={signAndSubmitPolicy} loading={loading}>
              {isEditingExistingPolicy ? 'Review & Re-sign Policy' : 'Review & Sign Policy'}
            </Button>
            {isEditingExistingPolicy && (
              <Button variant="ghost" onClick={cancelPolicyEdit} disabled={loading}>
                Cancel
              </Button>
            )}
          </div>
          {error && <p style={{ color: '#ef4444', fontSize: 13, marginTop: 10 }}>{error}</p>}
        </div>
      )}

      {agent && step === 'done' && (
        <div>
          {getSessionStatus().state === 'expired' ? (
            <div style={{
              background: '#7c2d1233', border: '1px solid #f59e0b66',
              borderRadius: 8, padding: '14px 16px', marginBottom: 20,
            }}>
              <p style={{ color: '#fbbf24', fontSize: 14, fontWeight: 600 }}>Your trading policy has expired.</p>
              <p style={{ color: '#fcd34d', fontSize: 12, marginTop: 6 }}>
                Trading is paused until you re-sign. Your wallet, funding, and approvals are intact — click
                {' '}<strong>Re-sign Policy</strong> below to start a fresh session.
              </p>
            </div>
          ) : (
            <div style={{
              background: '#14532d33', border: '1px solid #14532d66',
              borderRadius: 8, padding: '14px 16px', marginBottom: 20,
            }}>
              <p style={{ color: '#86efac', fontSize: 14, fontWeight: 600 }}>Agent configured and ready.</p>
              <p style={{ color: '#4ade80', fontSize: 12, marginTop: 6 }}>
                Session key saved — switch to the <strong>Chat</strong> tab to trade.
              </p>
            </div>
          )}

          <div style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#6b7280' }}>Agent status</span>
              <StatusBadge status={agent.status} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#6b7280' }}>Policy ID</span>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#a78bfa' }}>
                {activePolicyId?.slice(0, 16)}…
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#6b7280' }}>Max budget</span>
              <span style={{ color: '#e2e8f0' }}>${budget} USDC</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#6b7280' }}>Max order size</span>
              <span style={{ color: '#e2e8f0' }}>${maxOrder} USDC</span>
            </div>
          </div>

          {/* Trading mode toggle */}
          <div style={{
            background: '#0f1117', border: '1px solid #2d3748',
            borderRadius: 8, padding: '14px 16px', marginBottom: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <p style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600, marginBottom: 2 }}>Trading Mode</p>
                <p style={{ fontSize: 12, color: '#6b7280' }}>
                  {paperMode
                    ? 'Paper mode — trades are simulated, no real money.'
                    : 'Live mode — trades submit real orders to Polymarket.'}
                </p>
                {!serverLiveEnabled && (
                  <p style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>
                    Live trading is disabled on this server (ENABLE_LIVE_TRADING=false).
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <span style={{ fontSize: 12, color: paperMode ? '#93c5fd' : '#4b5563' }}>Paper</span>
                <button
                  onClick={() => setMode(paperMode)}
                  disabled={modeSaving || (!paperMode === false && !serverLiveEnabled)}
                  title={!serverLiveEnabled && paperMode ? 'Live trading disabled on server' : undefined}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none', cursor: modeSaving ? 'wait' : 'pointer',
                    background: !paperMode ? '#22c55e' : '#2d3748',
                    position: 'relative', transition: 'background 0.2s',
                    opacity: modeSaving ? 0.6 : 1,
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 3, width: 18, height: 18, borderRadius: '50%', background: '#fff',
                    transition: 'left 0.2s', left: !paperMode ? 23 : 3,
                  }} />
                </button>
                <span style={{ fontSize: 12, color: !paperMode ? '#22c55e' : '#4b5563' }}>Live</span>
              </div>
            </div>
          </div>

          {/* Fund Agent Wallet */}
          <div style={{
            background: '#0f1117', border: '1px solid #2d3748',
            borderRadius: 8, padding: '14px 16px', marginBottom: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>Fund Agent Wallet</span>
              {fundLoading && <span style={{ fontSize: 11, color: '#6b7280' }}>Loading…</span>}
              {!fundLoading && fundStatus !== null && (
                <span style={{ fontSize: 11, color: fundStatus.usdcBalance > 0 ? '#4ade80' : '#f87171' }}>
                  {fundStatus.usdcBalance.toFixed(2)} pUSD
                </span>
              )}
            </div>

            {/* Deposit wallet address with copy */}
            {agent.proxyWalletAddress ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <code style={{ fontSize: 11, color: '#a78bfa', background: '#1a1d27', padding: '4px 8px', borderRadius: 4, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent.proxyWalletAddress}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(agent.proxyWalletAddress!)}
                  style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', cursor: 'pointer', flexShrink: 0 }}
                >
                  Copy
                </button>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: '#f59e0b', marginBottom: 12 }}>
                Provision the Polymarket deposit wallet below before funding — funds must go to the registered deposit wallet, not the EOA.
              </p>
            )}

            {fundStatus !== null && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Balances */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                  {[
                    { label: 'pUSD balance', value: `$${fundStatus.usdcBalance.toFixed(2)}`, ok: fundStatus.usdcBalance > 0 },
                    { label: 'Exchange allowance', value: fundStatus.allowanceExchange > 1e9 ? '✓ max' : `$${fundStatus.allowanceExchange.toFixed(2)}`, ok: fundStatus.allowanceExchange > 0 },
                    { label: 'NegRisk allowance', value: fundStatus.allowanceNegRisk > 1e9 ? '✓ max' : `$${fundStatus.allowanceNegRisk.toFixed(2)}`, ok: fundStatus.allowanceNegRisk > 0 },
                  ].map(({ label, value, ok }) => (
                    <div key={label} style={{ background: '#1a1d27', borderRadius: 6, padding: '6px 10px' }}>
                      <div style={{ fontSize: 10, color: '#4b5563', marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 12, color: ok ? '#4ade80' : '#f87171', fontWeight: 600 }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Step 1: Send pUSD */}
                <div>
                  <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                    Step 1 — agent pUSD: {fundStatus.usdcBalance === 0 ? 'none yet' : `$${fundStatus.usdcBalance.toFixed(2)}`}
                    {myWalletPusd !== null && (
                      <span style={{ color: '#4b5563' }}> · your MetaMask: ${myWalletPusd.toFixed(2)}</span>
                    )}
                  </p>
                  <Button size="sm" variant="ghost" onClick={sendUsdcToAgent} disabled={!agent.proxyWalletAddress}>
                    Send {budget} pUSD via MetaMask
                  </Button>
                </div>

                {/* Step 2: Set allowances */}
                {fundStatus.usdcBalance > 0 && (fundStatus.allowanceExchange === 0 || fundStatus.allowanceNegRisk === 0 || !fundStatus.ctfApproved) && (
                  <div>
                    <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                      Step 2 — Authorize the agent wallet to trade on Polymarket (pUSD for buying, positions for selling):
                    </p>
                    <Button size="sm" variant="ghost" onClick={approveUsdc} loading={approving}>
                      Authorize Trading
                    </Button>
                  </div>
                )}

                {/* All done */}
                {fundStatus.usdcBalance > 0 && fundStatus.allowanceExchange > 0 && fundStatus.allowanceNegRisk > 0 && fundStatus.ctfApproved && (
                  <p style={{ fontSize: 12, color: '#4ade80' }}>
                    Agent wallet funded and authorized (buy + sell).
                  </p>
                )}

                {/* Withdraw */}
                {fundStatus.usdcBalance > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                      Withdraw all pUSD from the Polymarket wallet to your connected wallet:
                    </p>
                    <Button size="sm" variant="ghost" onClick={withdrawFromAgent} loading={withdrawing}>
                      Withdraw Agent Funds
                    </Button>
                  </div>
                )}

                <button
                  onClick={refreshFundStatus}
                  style={{ fontSize: 11, color: '#4b5563', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
                >
                  Refresh balances
                </button>
              </div>
            )}

            {fundError && <p style={{ fontSize: 12, color: '#f87171', marginTop: 8 }}>{fundError}</p>}
          </div>

          {/* Agent Wallet */}
          <div style={{ background: '#0f1117', border: '1px solid #2d3748', borderRadius: 8, padding: '14px 16px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Agent Wallet</p>
            <div>
              <p style={{ fontSize: 11, color: '#4b5563', marginBottom: 4 }}>Agent wallet private key</p>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="password"
                  value={importKeyInput}
                  onChange={e => setImportKeyInput(e.target.value)}
                  placeholder="0x…"
                  style={{ flex: 1, background: '#1a1d27', border: '1px solid #2d3748', borderRadius: 4, color: '#e2e8f0', padding: '5px 8px', fontSize: 12, fontFamily: 'monospace' }}
                />
                <Button size="sm" variant="ghost" onClick={importAgentKey} loading={importKeyLoading} disabled={!importKeyInput.trim()}>
                  Save
                </Button>
              </div>
            </div>
            {importKeyError && <p style={{ fontSize: 11, color: '#f87171', margin: 0 }}>{importKeyError}</p>}
            {agent.address && (
              <p style={{ fontSize: 11, color: '#4b5563', margin: 0 }}>Address: <code style={{ color: '#6b7280' }}>{agent.address}</code></p>
            )}
          </div>

          {/* Polymarket Deposit Wallet (provisioned via relayer) */}
          <div style={{ background: '#0f1117', border: '1px solid #2d3748', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>Polymarket Deposit Wallet</span>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600,
                background: agent.proxyWalletAddress ? '#14532d33' : '#7f1d1d22',
                color: agent.proxyWalletAddress ? '#4ade80' : '#f87171',
                border: `1px solid ${agent.proxyWalletAddress ? '#14532d66' : '#7f1d1d44'}`,
              }}>
                {agent.proxyWalletAddress ? 'Provisioned' : 'Not provisioned'}
              </span>
            </div>
            {agent.proxyWalletAddress ? (
              <p style={{ fontSize: 11, color: '#4b5563', margin: 0 }}>
                Registered with your relayer key. Deposit address: <code style={{ color: '#6b7280' }}>{agent.proxyWalletAddress}</code>
              </p>
            ) : (
              <>
                <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10, lineHeight: 1.5 }}>
                  Creates and registers the agent's Polymarket deposit wallet through the relayer (gasless). This is what funds are sent to and what autonomous withdrawals draw from. Requires the relayer API key below.
                </p>
                <Button size="sm" variant="ghost" onClick={provisionWallet} loading={provisionLoading} disabled={relayerKeyStatus !== 'active'}>
                  Provision deposit wallet
                </Button>
                {relayerKeyStatus !== 'active' && <p style={{ fontSize: 11, color: '#4b5563', marginTop: 6 }}>Add your relayer API key first.</p>}
                {provisionError && <p style={{ fontSize: 11, color: '#f87171', marginTop: 6 }}>{provisionError}</p>}
              </>
            )}
          </div>

          {/* OpenRouter API Key */}
          <div style={{
            background: '#0f1117', border: '1px solid #2d3748',
            borderRadius: 8, padding: '14px 16px', marginBottom: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>OpenRouter API Key</span>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600,
                background: llmKeyStatus === 'active' ? '#14532d33' : '#7f1d1d22',
                color: llmKeyStatus === 'active' ? '#4ade80' : '#f87171',
                border: `1px solid ${llmKeyStatus === 'active' ? '#14532d66' : '#7f1d1d44'}`,
              }}>
                {llmKeyStatus === 'active' ? 'Configured' : llmKeyStatus === 'none' ? 'Not set' : '…'}
              </span>
            </div>
            {llmKeyStatus === 'active' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <p style={{ fontSize: 12, color: '#4b5563', flex: 1 }}>
                  Key stored securely. Powers trade intent parsing, agent chat, and the autonomous loop.
                </p>
                <button
                  onClick={removeLlmKey}
                  style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: '#7f1d1d44', border: '1px solid #7f1d1d', color: '#f87171', cursor: 'pointer' }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10, lineHeight: 1.5 }}>
                  Your <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" style={{ color: '#a78bfa' }}>OpenRouter API key</a> (sk-or-…) is stored encrypted on the server. Required for natural language trade parsing, agent chat, and the autonomous loop.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    value={llmKeyInput}
                    onChange={e => setLlmKeyInput(e.target.value)}
                    placeholder="sk-or-v1-..."
                    style={{
                      flex: 1, padding: '7px 10px', borderRadius: 6, fontSize: 13,
                      background: '#1a1d27', border: '1px solid #2d3748',
                      color: '#e2e8f0', outline: 'none', fontFamily: 'monospace',
                    }}
                  />
                  <Button size="sm" variant="ghost" onClick={saveLlmKey} loading={llmKeySaving} disabled={llmKeyInput.trim().length < 10}>
                    Save
                  </Button>
                </div>
                {llmKeyError && <p style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>{llmKeyError}</p>}
              </>
            )}
          </div>

          {/* Relayer API Key (for withdrawals) */}
          <div style={{
            background: '#0f1117', border: '1px solid #2d3748',
            borderRadius: 8, padding: '14px 16px', marginBottom: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>Relayer API Key</span>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600,
                background: relayerKeyStatus === 'active' ? '#14532d33' : '#7f1d1d22',
                color: relayerKeyStatus === 'active' ? '#4ade80' : '#f87171',
                border: `1px solid ${relayerKeyStatus === 'active' ? '#14532d66' : '#7f1d1d44'}`,
              }}>
                {relayerKeyStatus === 'active' ? 'Configured' : relayerKeyStatus === 'none' ? 'Not set' : '…'}
              </span>
            </div>
            {relayerKeyStatus === 'active' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <p style={{ fontSize: 12, color: '#4b5563', flex: 1 }}>
                  Relayer key stored securely. Used to withdraw pUSD from the Polymarket proxy wallet back to your wallet.
                </p>
                <button
                  onClick={removeRelayerKey}
                  style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: '#7f1d1d44', border: '1px solid #7f1d1d', color: '#f87171', cursor: 'pointer' }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10, lineHeight: 1.5 }}>
                  Your Polymarket relayer API key and its address are stored encrypted on the server. Required to withdraw funds from the proxy wallet (the relayer pays gas and executes the transfer on the proxy's behalf).
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input
                    type="text"
                    value={relayerAddrInput}
                    onChange={e => setRelayerAddrInput(e.target.value)}
                    placeholder="API key address (0x…)"
                    style={{
                      padding: '7px 10px', borderRadius: 6, fontSize: 13,
                      background: '#1a1d27', border: '1px solid #2d3748',
                      color: '#e2e8f0', outline: 'none', fontFamily: 'monospace',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="password"
                      value={relayerKeyInput}
                      onChange={e => setRelayerKeyInput(e.target.value)}
                      placeholder="API key"
                      style={{
                        flex: 1, padding: '7px 10px', borderRadius: 6, fontSize: 13,
                        background: '#1a1d27', border: '1px solid #2d3748',
                        color: '#e2e8f0', outline: 'none', fontFamily: 'monospace',
                      }}
                    />
                    <Button size="sm" variant="ghost" onClick={saveRelayerKey} loading={relayerKeySaving} disabled={!relayerKeyInput.trim() || !relayerAddrInput.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
                {relayerKeyError && <p style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>{relayerKeyError}</p>}
              </>
            )}
          </div>

          {/* Hyperliquid API Wallet (signer) */}
          <div style={{ background: '#0f1117', border: '1px solid #2d3748', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>Hyperliquid API Wallet</span>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600,
                background: hlKeyStatus === 'active' ? '#14532d33' : '#7f1d1d22',
                color: hlKeyStatus === 'active' ? '#4ade80' : '#f87171',
                border: `1px solid ${hlKeyStatus === 'active' ? '#14532d66' : '#7f1d1d44'}`,
              }}>{hlKeyStatus === 'active' ? 'Configured' : hlKeyStatus === 'none' ? 'Not set' : '…'}</span>
            </div>
            {hlKeyStatus === 'active' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <p style={{ fontSize: 12, color: '#4b5563', flex: 1 }}>
                  API wallet stored. It signs spot orders for your connected wallet (the master account that holds funds). It cannot withdraw.
                </p>
                <button onClick={removeHlKey} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: '#7f1d1d44', border: '1px solid #7f1d1d', color: '#f87171', cursor: 'pointer' }}>Remove</button>
              </div>
            ) : (
              <>
                <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10, lineHeight: 1.5 }}>
                  Paste the <strong style={{ color: '#a0aec0' }}>API wallet</strong> address + secret key you generated on Hyperliquid (More → API). It signs orders on behalf of your connected main wallet (the fund holder). Stored encrypted; cannot withdraw.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input type="text" value={hlAddrInput} onChange={e => setHlAddrInput(e.target.value)} placeholder="API wallet address (0x…)"
                    style={{ padding: '7px 10px', borderRadius: 6, fontSize: 13, background: '#1a1d27', border: '1px solid #2d3748', color: '#e2e8f0', outline: 'none', fontFamily: 'monospace' }} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="password" value={hlKeyInput} onChange={e => setHlKeyInput(e.target.value)} placeholder="API wallet secret key (0x…)"
                      style={{ flex: 1, padding: '7px 10px', borderRadius: 6, fontSize: 13, background: '#1a1d27', border: '1px solid #2d3748', color: '#e2e8f0', outline: 'none', fontFamily: 'monospace' }} />
                    <Button size="sm" variant="ghost" onClick={saveHlKey} loading={hlKeySaving} disabled={!hlKeyInput.trim() || !hlAddrInput.trim()}>Save</Button>
                  </div>
                </div>
                {hlKeyError && <p style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>{hlKeyError}</p>}
              </>
            )}
          </div>

          {/* Hyperliquid Deposit */}
          {hlKeyStatus === 'active' && (
            <div style={{ background: '#0f1117', border: '1px solid #2d3748', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 13, color: '#6b7280' }}>Hyperliquid Balance</span>
                <span style={{ fontSize: 12, color: hlBalance && hlBalance.usdc > 0 ? '#4ade80' : '#6b7280' }}>
                  {hlBalance ? `$${hlBalance.usdc.toFixed(2)} USDC` : '—'}
                </span>
              </div>
              {hlBalance && hlBalance.balances.length > 0 && (
                <p style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                  Holdings: {hlBalance.balances.map(b => `${b.total} ${b.coin}`).join(', ')}
                </p>
              )}
              <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, lineHeight: 1.5 }}>
                Deposit <strong style={{ color: '#a0aec0' }}>native USDC on Arbitrum</strong> (not USDC.e) to Hyperliquid. Min <strong style={{ color: '#a0aec0' }}>5 USDC</strong> — less is lost. Credits your account in &lt;1 min.
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="number" value={hlDepositAmount} onChange={e => setHlDepositAmount(e.target.value)} min={5}
                  style={{ width: 90, padding: '7px 10px', borderRadius: 6, fontSize: 13, background: '#1a1d27', border: '1px solid #2d3748', color: '#e2e8f0', outline: 'none' }} />
                <Button size="sm" variant="ghost" onClick={depositToHyperliquid} loading={hlDepositing} disabled={wallet.status !== 'connected'}>
                  Deposit USDC via MetaMask
                </Button>
                <button onClick={refreshHlBalance} style={{ fontSize: 11, color: '#4b5563', background: 'none', border: 'none', cursor: 'pointer' }}>Refresh</button>
              </div>
              {hlDepositError && <p style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>{hlDepositError}</p>}
            </div>
          )}

          {/* M7: CLOB Credential derivation */}
          <div style={{
            background: '#0f1117', border: '1px solid #2d3748',
            borderRadius: 8, padding: '14px 16px', marginBottom: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>CLOB API Credentials (M7)</span>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600,
                background: clobStatus === 'active' ? '#14532d33' : clobStatus === 'deriving' ? '#1e3a5f33' : '#7f1d1d22',
                color: clobStatus === 'active' ? '#4ade80' : clobStatus === 'deriving' ? '#93c5fd' : '#f87171',
                border: `1px solid ${clobStatus === 'active' ? '#14532d66' : clobStatus === 'deriving' ? '#1e3a5f' : '#7f1d1d44'}`,
              }}>
                {clobStatus === 'active' ? 'Active' : clobStatus === 'deriving' ? 'Deriving…' : clobStatus === 'none' ? 'Not derived' : clobStatus === 'error' ? 'Error' : '…'}
              </span>
            </div>
            {clobStatus === 'active' && clobDerivedAt && (
              <p style={{ fontSize: 11, color: '#4b5563', marginBottom: 8 }}>
                Derived {new Date(clobDerivedAt).toLocaleString()}
              </p>
            )}
            {clobStatus !== 'active' && (
              <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10, lineHeight: 1.5 }}>
                Derives Polymarket API credentials from the agent wallet by signing an authentication challenge.
                Required for live order submission (M8). Paper trading works without this.
              </p>
            )}
            {(clobStatus === 'none' || clobStatus === 'error' || clobStatus === 'unknown') && (
              <Button size="sm" variant="ghost" onClick={deriveCredentials} loading={false}>
                Derive CLOB Credentials
              </Button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {agent.status === 'active'
              ? <Button variant="warning" size="sm" onClick={pauseAgent}>Pause Agent</Button>
              : <Button variant="primary" size="sm" onClick={resumeAgent}>Resume Agent</Button>
            }
            <Button variant={getSessionStatus().state === 'expired' ? 'primary' : 'ghost'} size="sm" onClick={signAndSubmitPolicy} loading={loading}>
              Re-sign Policy
            </Button>
            <Button variant="ghost" size="sm" onClick={beginPolicyEdit}>
              Edit Policy
            </Button>
            <Button variant="danger" size="sm" onClick={revokePolicy} loading={loading}>
              Revoke Policy
            </Button>
          </div>
        </div>
      )}

      {error && step !== 'done' && step !== 'configuring' && (
        <p style={{ color: '#ef4444', fontSize: 13, marginTop: 10 }}>{error}</p>
      )}
    </Card>
  );
}

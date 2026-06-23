import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import { getDb } from '../../db/database';
import { DevSigner } from '../../agent/devSigner';
import { getSigner } from '../../agent/signerFactory';
import { createPolicy, getPolicyById, getActivePolicyForAgent, revokePolicy } from '../../db/policyRepository';
import { verifyPolicySignature, hashPolicy } from '../../auth/policyVerifier';
import { writeAudit, getAuditLog } from '../../db/auditRepository';
import { ClobTradingClientImpl } from '../../clob/clobTradingClient';
import { getContractConfig } from '@polymarket/clob-client-v2';
import { startLoop, stopLoop, getLoopStatusAndDecisions } from '../../agent/autonomousLoop';
import { storeLlmApiKey, hasLlmApiKey, deleteLlmApiKey } from '../../utils/llmKeyStore';
import { storeRelayerCreds, hasRelayerCreds, deleteRelayerCreds, resolveRelayerCreds } from '../../utils/relayerKeyStore';
import { logger } from '../../utils/logger';
import { z } from 'zod';
import type { AgentPolicy } from '../../types/policy';
import { withdrawPusdFromProxy, provisionDepositWallet, authorizeDepositWalletForTrading } from '../../clob/proxyWalletClient';

const POLYGON_CHAIN_ID = 137;
const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
function getPolygonProvider() {
  const rpcUrl = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com';
  return new ethers.JsonRpcProvider(rpcUrl);
}

const router = Router();

// Accept wallet address (0x...) or UUID as userId
const CreateAgentSchema = z.object({
  userId: z.string().min(1),
  walletAddress: z.string().optional(),
});

function upsertUser(userId: string, walletAddress?: string): void {
  const db = getDb();
  const now = Date.now();
  const addr = walletAddress ?? userId;
  db.prepare(`
    INSERT INTO users (id, wallet_address, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, 'active')
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(userId, addr, now, now);
}

router.post('/', async (req, res) => {
  const parsed = CreateAgentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'userId is required' });

  const { userId, walletAddress } = parsed.data;

  // Auto-create user record if it doesn't exist
  upsertUser(userId, walletAddress);

  const signer = getSigner();
  if (!(signer instanceof DevSigner)) {
    return res.status(501).json({ error: 'Agent creation not yet implemented for non-dev signers' });
  }

  const { agentWalletId, address } = signer.createAgentWallet(userId);

  writeAudit({ userId, agentWalletId, actorType: 'user', actorId: userId, action: 'agent.create', details: { address } });
  return res.status(201).json({ agentWalletId, address });
});

router.get('/:agentId', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_wallets WHERE id = ?').get(req.params.agentId);
  if (!row) return res.status(404).json({ error: 'Agent not found' });
  return res.json(row);
});

router.post('/:agentId/pause', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE agent_wallets SET status = 'paused', updated_at = ? WHERE id = ?")
    .run(Date.now(), req.params.agentId);
  writeAudit({ agentWalletId: req.params.agentId, actorType: 'user', actorId: 'user', action: 'agent.pause' });
  return res.json({ status: 'paused' });
});

router.post('/:agentId/resume', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE agent_wallets SET status = 'active', updated_at = ? WHERE id = ?")
    .run(Date.now(), req.params.agentId);
  writeAudit({ agentWalletId: req.params.agentId, actorType: 'user', actorId: 'user', action: 'agent.resume' });
  return res.json({ status: 'active' });
});

router.post('/:agentId/revoke', async (req, res) => {
  const policy = getActivePolicyForAgent(req.params.agentId);
  if (policy) revokePolicy(policy.id);
  writeAudit({ agentWalletId: req.params.agentId, actorType: 'user', actorId: 'user', action: 'agent.revoke' });
  return res.json({ revoked: true });
});

// Policy CRUD
const PolicyCreateSchema = z.object({
  userId: z.string(),
  sessionKeyAddress: z.string().startsWith('0x'),
  policy: z.object({}).passthrough(),
  userSignature: z.string().startsWith('0x'),
});

router.post('/:agentId/policy', async (req, res) => {
  const parsed = PolicyCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { userId, sessionKeyAddress, policy, userSignature } = parsed.data;
  const agentPolicy = policy as unknown as AgentPolicy;

  // Verify signature before storing
  const sigCheck = verifyPolicySignature(agentPolicy, userSignature);
  if (!sigCheck.valid) {
    return res.status(400).json({ error: 'Invalid policy signature', reason: sigCheck.reason });
  }

  const stored = createPolicy({
    userId,
    agentWalletId: req.params.agentId,
    sessionKeyAddress,
    policy: agentPolicy,
    userSignature,
  });

  writeAudit({ userId, agentWalletId: req.params.agentId, policyId: stored.id, actorType: 'user', actorId: userId, action: 'policy.create' });
  return res.status(201).json({ policyId: stored.id, policyHash: stored.policyHash });
});

router.get('/:agentId/policy', (req, res) => {
  const policy = getActivePolicyForAgent(req.params.agentId);
  if (!policy) return res.status(404).json({ error: 'No active policy found' });
  return res.json(policy);
});

router.post('/:agentId/policy/signature/verify', async (req, res) => {
  const { policy, userSignature } = req.body as { policy: AgentPolicy; userSignature: string };
  if (!policy || !userSignature) return res.status(400).json({ error: 'policy and userSignature required' });

  const result = verifyPolicySignature(policy, userSignature);
  writeAudit({ agentWalletId: req.params.agentId, actorType: 'user', actorId: 'user', action: 'policy.verify', details: { valid: result.valid, reason: result.reason } });
  return res.json(result);
});

// ─── CLOB Credential Management (M7) ───────────────────────────────────────

// POST /:agentId/clob/derive  — sign into Polymarket CLOB and store API creds
router.post('/:agentId/clob/derive', async (req, res) => {
  const { agentId } = req.params;
  const db = getDb();
  const wallet = db.prepare('SELECT id FROM agent_wallets WHERE id = ?').get(agentId) as { id: string } | undefined;
  if (!wallet) return res.status(404).json({ error: 'Agent wallet not found' });

  try {
    const client = new ClobTradingClientImpl();
    await client.deriveCredentials(agentId);
    writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'clob.derive', details: { status: 'success' } });
    return res.json({ status: 'derived', message: 'CLOB API credentials derived and stored.' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ agentId, err }, 'CLOB credential derivation failed');
    writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'clob.derive', details: { status: 'error', error: msg } });
    return res.status(502).json({ error: 'CLOB credential derivation failed', reason: msg });
  }
});

// GET /:agentId/clob/status  — check whether CLOB creds exist
router.get('/:agentId/clob/status', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT status, created_at FROM clob_credentials
    WHERE agent_wallet_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(req.params.agentId) as { status: string; created_at: number } | undefined;

  if (!row) return res.json({ hasCreds: false });
  return res.json({ hasCreds: true, status: row.status, derivedAt: new Date(row.created_at).toISOString() });
});

// ─── LLM API key (user-supplied OpenRouter key) ──────────────────────────────

router.post('/:agentId/llm-key', (req, res) => {
  const { agentId } = req.params;
  const { apiKey } = req.body as { apiKey?: string };
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
    return res.status(400).json({ error: 'API key too short or missing.' });
  }
  const db = getDb();
  if (!db.prepare('SELECT id FROM agent_wallets WHERE id = ?').get(agentId)) {
    return res.status(404).json({ error: 'Agent wallet not found' });
  }
  storeLlmApiKey(agentId, apiKey);
  writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'agent.create', details: { sub: 'llm-key-stored' } });
  return res.json({ status: 'stored' });
});

router.get('/:agentId/llm-key/status', (req, res) => {
  return res.json({ hasKey: hasLlmApiKey(req.params.agentId) });
});

router.delete('/:agentId/llm-key', (req, res) => {
  deleteLlmApiKey(req.params.agentId);
  return res.json({ status: 'deleted' });
});

// ─── Relayer API key (user-supplied Polymarket relayer creds, for withdrawals) ─

router.post('/:agentId/relayer-key', (req, res) => {
  const { agentId } = req.params;
  const { apiKey, apiKeyAddress } = req.body as { apiKey?: string; apiKeyAddress?: string };
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
    return res.status(400).json({ error: 'apiKey too short or missing.' });
  }
  if (!apiKeyAddress || !ethers.isAddress(apiKeyAddress)) {
    return res.status(400).json({ error: 'Valid apiKeyAddress required.' });
  }
  const db = getDb();
  if (!db.prepare('SELECT id FROM agent_wallets WHERE id = ?').get(agentId)) {
    return res.status(404).json({ error: 'Agent wallet not found' });
  }
  storeRelayerCreds(agentId, { apiKey: apiKey.trim(), apiKeyAddress: apiKeyAddress.trim() });
  writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'agent.create', details: { sub: 'relayer-key-stored' } });
  return res.json({ status: 'stored' });
});

router.get('/:agentId/relayer-key/status', (req, res) => {
  return res.json({ hasKey: hasRelayerCreds(req.params.agentId) });
});

router.delete('/:agentId/relayer-key', (req, res) => {
  deleteRelayerCreds(req.params.agentId);
  return res.json({ status: 'deleted' });
});

// ─── Trading mode (paper / live) ─────────────────────────────────────────────

router.get('/:agentId/mode', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT paper_mode FROM agent_wallets WHERE id = ?').get(req.params.agentId) as { paper_mode: number } | undefined;
  if (!row) return res.status(404).json({ error: 'Agent not found' });
  const serverLiveEnabled = process.env.ENABLE_LIVE_TRADING === 'true';
  return res.json({ paperMode: row.paper_mode === 1, serverLiveEnabled });
});

router.patch('/:agentId/mode', (req, res) => {
  const { paperMode } = req.body as { paperMode: boolean };
  if (typeof paperMode !== 'boolean') return res.status(400).json({ error: 'paperMode (boolean) required' });
  if (!paperMode && process.env.ENABLE_LIVE_TRADING !== 'true') {
    return res.status(403).json({ error: 'Live trading is not enabled on this server (ENABLE_LIVE_TRADING=false)' });
  }
  const db = getDb();
  db.prepare('UPDATE agent_wallets SET paper_mode = ?, updated_at = ? WHERE id = ?')
    .run(paperMode ? 1 : 0, Date.now(), req.params.agentId);
  writeAudit({ actorType: 'admin', actorId: req.params.agentId, action: 'agent.mode_changed', details: { paperMode } });
  return res.json({ paperMode });
});

// ─── On-chain USDC balance / allowance ──────────────────────────────────────

router.get('/:agentId/usdc-balance', async (req, res) => {
  const { agentId } = req.params;
  const db = getDb();
  const agentRow = db.prepare('SELECT address, proxy_wallet_address FROM agent_wallets WHERE id = ?').get(agentId) as { address: string; proxy_wallet_address: string | null } | undefined;
  if (!agentRow) return res.status(404).json({ error: 'Agent not found' });

  try {
    const provider = getPolygonProvider();
    const { collateral, exchangeV2, negRiskExchangeV2, negRiskAdapter, conditionalTokens } = getContractConfig(POLYGON_CHAIN_ID) as Record<string, string>;
    const pUSD = new ethers.Contract(collateral, USDC_ABI, provider);
    const ctf = new ethers.Contract(conditionalTokens, ['function isApprovedForAll(address owner, address operator) view returns (bool)'], provider);

    const proxyAddress = agentRow.proxy_wallet_address;

    // pUSD balance: use proxy wallet if configured (that's where trading funds live),
    // otherwise fall back to EOA address
    const balanceAddress = proxyAddress ?? agentRow.address;
    const proxyPusdBalance = await pUSD.balanceOf(balanceAddress) as bigint;

    // Real allowances from the deposit wallet to the CLOB contracts. The exchange checks the
    // maker's (deposit wallet's) ERC-20 allowance for BUY, and ERC-1155 operator approval for SELL.
    // Neg-risk needs BOTH the neg-risk exchange and the neg-risk adapter, so report the min.
    let allowanceExchange = 0;
    let allowanceNegRisk = 0;
    let ctfApproved = false;
    if (proxyAddress) {
      const [allowExch, allowNeg, allowAdapter, ctfExch, ctfNeg, ctfAdapter] = await Promise.all([
        pUSD.allowance(proxyAddress, exchangeV2) as Promise<bigint>,
        pUSD.allowance(proxyAddress, negRiskExchangeV2) as Promise<bigint>,
        pUSD.allowance(proxyAddress, negRiskAdapter) as Promise<bigint>,
        ctf.isApprovedForAll(proxyAddress, exchangeV2) as Promise<boolean>,
        ctf.isApprovedForAll(proxyAddress, negRiskExchangeV2) as Promise<boolean>,
        ctf.isApprovedForAll(proxyAddress, negRiskAdapter) as Promise<boolean>,
      ]);
      allowanceExchange = parseFloat(ethers.formatUnits(allowExch, 6));
      allowanceNegRisk = parseFloat(ethers.formatUnits(allowNeg < allowAdapter ? allowNeg : allowAdapter, 6));
      ctfApproved = ctfExch && ctfNeg && ctfAdapter;
    }

    return res.json({
      address: agentRow.address,
      proxyWalletAddress: proxyAddress,
      usdcBalance: parseFloat(ethers.formatUnits(proxyPusdBalance, 6)),
      allowanceExchange,
      allowanceNegRisk,
      ctfApproved,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'RPC error';
    logger.warn({ agentId, err }, 'usdc-balance check failed');
    return res.status(502).json({ error: msg });
  }
});

// POST /:agentId/approve-usdc — the deposit wallet approves pUSD to the Polymarket exchanges,
// executed via the relayer (gasless). The exchange checks the maker (deposit wallet) allowance.
router.post('/:agentId/approve-usdc', async (req, res) => {
  const { agentId } = req.params;
  if (process.env.SIGNER_MODE !== 'dev') {
    return res.status(501).json({ error: 'approve-usdc only supported in dev signer mode' });
  }
  const db = getDb();
  const agentRow = db.prepare('SELECT proxy_wallet_address FROM agent_wallets WHERE id = ?').get(agentId) as { proxy_wallet_address: string | null } | undefined;
  if (!agentRow) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  if (!agentRow.proxy_wallet_address) {
    return res.status(409).json({ error: 'Provision the Polymarket deposit wallet before approving.' });
  }

  const relayerCreds = resolveRelayerCreds(agentId);
  if (!relayerCreds) {
    return res.status(409).json({ error: 'Add your relayer API key first, then approve.' });
  }

  const signer = getSigner();
  if (!(signer instanceof DevSigner)) {
    return res.status(501).json({ error: 'Dev signer required' });
  }

  try {
    const { exchangeV2, negRiskExchangeV2, negRiskAdapter, collateral, conditionalTokens } = getContractConfig(POLYGON_CHAIN_ID) as Record<string, string>;
    // Authorize all operators for both collateral (BUY) and outcome tokens (SELL). Neg-risk
    // markets route through the NegRiskAdapter, so it needs approval alongside the two exchanges.
    const { transactionHash } = await authorizeDepositWalletForTrading({
      privateKey: signer.exportKey(agentId),
      relayerCreds,
      collateral,
      conditionalTokens,
      operators: [exchangeV2, negRiskExchangeV2, negRiskAdapter],
    });

    writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'agent.create', details: { sub: 'usdc-approved', txHashes: [transactionHash] } });
    logger.info({ agentId, transactionHash }, 'Approved pUSD for exchanges via deposit wallet');
    return res.json({ success: true, txHashes: [transactionHash] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ agentId, err }, 'approve-usdc failed');
    return res.status(502).json({ error: msg });
  }
});

// ─── Provision Polymarket deposit wallet via the relayer ─────────────────────
// Derives the canonical deposit wallet for the agent EOA and registers it with the
// relayer API key (WALLET-CREATE). Required so the relayer will later relay withdrawals.

router.post('/:agentId/provision-wallet', async (req, res) => {
  const { agentId } = req.params;
  if (process.env.SIGNER_MODE !== 'dev') return res.status(501).json({ error: 'Only supported in dev signer mode' });

  const db = getDb();
  const agentRow = db.prepare('SELECT address FROM agent_wallets WHERE id = ?').get(agentId) as { address: string } | undefined;
  if (!agentRow) {
    return res.status(404).json({ error: 'Agent wallet not found' });
  }

  const relayerCreds = resolveRelayerCreds(agentId);
  if (!relayerCreds) {
    return res.status(409).json({ error: 'Add your relayer API key first, then provision the wallet.' });
  }
  // The relayer API key is bound to its signer address — it must be the agent's own EOA.
  if (relayerCreds.apiKeyAddress.toLowerCase() !== agentRow.address.toLowerCase()) {
    return res.status(409).json({ error: `Relayer API key address (${relayerCreds.apiKeyAddress}) must match the agent wallet address (${agentRow.address}).` });
  }

  const signer = getSigner();
  if (!(signer instanceof DevSigner)) return res.status(501).json({ error: 'Dev signer required' });

  try {
    const result = await provisionDepositWallet(signer.exportKey(agentId), relayerCreds);
    db.prepare('UPDATE agent_wallets SET proxy_wallet_address = ?, updated_at = ? WHERE id = ?')
      .run(result.depositWalletAddress, Date.now(), agentId);
    writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'agent.provision_wallet', details: { depositWalletAddress: result.depositWalletAddress, created: result.created, txHash: result.transactionHash } });
    logger.info({ agentId, ...result }, 'Provisioned deposit wallet via relayer');
    return res.json({ success: true, proxyWalletAddress: result.depositWalletAddress, created: result.created, txHash: result.transactionHash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ agentId, err }, 'provision-wallet failed');
    return res.status(502).json({ error: msg });
  }
});

// ─── Withdraw from agent wallet ──────────────────────────────────────────────

router.post('/:agentId/withdraw', async (req, res) => {
  const { agentId } = req.params;
  const { to, amountPusd } = req.body as { to?: string; amountPusd?: string };
  if (!to || !ethers.isAddress(to)) return res.status(400).json({ error: 'Valid `to` address required' });

  if (process.env.SIGNER_MODE !== 'dev') return res.status(501).json({ error: 'Only supported in dev signer mode' });
  const db = getDb();
  const agentRow = db.prepare(`
    SELECT aw.address, aw.proxy_wallet_address, u.wallet_address AS owner_wallet_address
    FROM agent_wallets aw
    JOIN users u ON u.id = aw.user_id
    WHERE aw.id = ?
  `).get(agentId) as {
    address: string;
    proxy_wallet_address: string | null;
    owner_wallet_address: string;
  } | undefined;
  if (!agentRow) return res.status(404).json({ error: 'Agent not found' });
  if (!agentRow.proxy_wallet_address) {
    return res.status(409).json({ error: 'No Polymarket proxy wallet is configured for this agent' });
  }
  if (to.toLowerCase() !== agentRow.owner_wallet_address.toLowerCase()) {
    return res.status(403).json({ error: 'Withdrawal destination must be the agent owner wallet currently connected' });
  }

  const signer = getSigner();
  if (!(signer instanceof DevSigner)) return res.status(501).json({ error: 'Dev signer required' });

  try {
    const provider = getPolygonProvider();
    const { collateral } = getContractConfig(POLYGON_CHAIN_ID) as Record<string, string>;
    const pUSD = new ethers.Contract(collateral, USDC_ABI, provider);

    const balance = await pUSD.balanceOf(agentRow.proxy_wallet_address) as bigint;
    const amount = amountPusd ? ethers.parseUnits(amountPusd, 6) : balance;
    if (amount <= 0n) {
      return res.status(400).json({ error: 'Polymarket proxy wallet has no pUSD to withdraw' });
    }
    if (amount > balance) {
      return res.status(400).json({ error: 'Requested withdrawal exceeds the proxy wallet pUSD balance' });
    }

    const relayerCreds = resolveRelayerCreds(agentId);
    if (!relayerCreds) {
      return res.status(409).json({ error: 'No relayer API key configured. Add it in Agent Setup before withdrawing.' });
    }

    const withdrawal = await withdrawPusdFromProxy({
      privateKey: signer.exportKey(agentId),
      proxyWalletAddress: agentRow.proxy_wallet_address,
      recipient: to,
      tokenAddress: collateral,
      amount,
      relayerCreds,
    });

    const txHashes = [withdrawal.transactionHash];
    logger.info({
      agentId,
      proxyWalletAddress: agentRow.proxy_wallet_address,
      to,
      amount: amount.toString(),
      hash: withdrawal.transactionHash,
      walletType: withdrawal.walletType,
    }, 'Withdrew pUSD from Polymarket wallet');

    writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: to, action: 'agent.withdraw', details: { from: agentRow.proxy_wallet_address, to, walletType: withdrawal.walletType, amountPusd: ethers.formatUnits(amount, 6), txHashes } });
    return res.json({ success: true, from: agentRow.proxy_wallet_address, to, walletType: withdrawal.walletType, amountPusd: ethers.formatUnits(amount, 6), txHashes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ agentId, err }, 'withdraw failed');
    return res.status(502).json({ error: msg });
  }
});

// ─── Import / export private key (dev signer mode only) ──────────────────────

router.post('/:agentId/import-key', async (req, res) => {
  const { agentId } = req.params;
  const { privateKey } = req.body as { privateKey?: string };
  if (!privateKey || typeof privateKey !== 'string') {
    return res.status(400).json({ error: 'privateKey required' });
  }
  if (process.env.SIGNER_MODE !== 'dev') {
    return res.status(501).json({ error: 'Only supported in dev signer mode' });
  }
  const db = getDb();
  if (!db.prepare('SELECT id FROM agent_wallets WHERE id = ?').get(agentId)) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const signer = getSigner();
  if (!(signer instanceof DevSigner)) {
    return res.status(501).json({ error: 'Dev signer required' });
  }
  try {
    // Importing a new EOA clears any previously provisioned deposit wallet — it must be re-provisioned for the new key.
    const address = signer.importKey(agentId, privateKey, undefined);
    // Invalidate old CLOB credentials — they belong to the old address
    db.prepare("UPDATE clob_credentials SET status = 'rotated', rotated_at = ? WHERE agent_wallet_id = ? AND status = 'active'")
      .run(Date.now(), agentId);
    writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'agent.key_import', details: { address } });
    return res.json({ success: true, address });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Import failed' });
  }
});

router.get('/:agentId/export-key', (req, res) => {
  const { agentId } = req.params;
  if (process.env.SIGNER_MODE !== 'dev') {
    return res.status(501).json({ error: 'Only supported in dev signer mode' });
  }
  const signer = getSigner();
  if (!(signer instanceof DevSigner)) {
    return res.status(501).json({ error: 'Dev signer required' });
  }
  try {
    const privateKey = signer.exportKey(agentId);
    writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'agent.key_export', details: {} });
    return res.json({ privateKey });
  } catch {
    return res.status(404).json({ error: 'Key not found' });
  }
});

// ─── Autonomous loop (M10) ───────────────────────────────────────────────────

router.post('/:agentId/loop/start', (req, res) => {
  const { agentId } = req.params;
  const db = getDb();
  if (!db.prepare('SELECT id FROM agent_wallets WHERE id=?').get(agentId)) {
    return res.status(404).json({ error: 'Agent wallet not found' });
  }
  const intervalMs = Math.max(60_000, parseInt(String(req.body.intervalMs ?? 300_000), 10));
  startLoop(agentId, intervalMs);
  writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'loop.start', details: { intervalMs } });
  return res.json({ status: 'running', intervalMs });
});

router.post('/:agentId/loop/stop', (req, res) => {
  const { agentId } = req.params;
  stopLoop(agentId);
  writeAudit({ agentWalletId: agentId, actorType: 'user', actorId: 'user', action: 'loop.stop' });
  return res.json({ status: 'stopped' });
});

router.get('/:agentId/loop/status', (req, res) => {
  return res.json(getLoopStatusAndDecisions(req.params.agentId));
});

// ─── Audit log ───────────────────────────────────────────────────────────────

// Audit log
router.get('/:agentId/audit-log', (req, res) => {
  const db = getDb();
  const agentRow = db.prepare('SELECT user_id FROM agent_wallets WHERE id = ?').get(req.params.agentId) as { user_id: string } | undefined;
  if (!agentRow) return res.status(404).json({ error: 'Agent not found' });
  const log = getAuditLog(agentRow.user_id, { limit: 100 });
  return res.json({ entries: log });
});

export default router;

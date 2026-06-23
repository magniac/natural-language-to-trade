import { ethers } from 'ethers';
import { verifyPolicySignature, hashPolicy, buildEIP712Message } from '../auth/policyVerifier';
import type { AgentPolicy } from '../types/policy';

const NOW_SEC = Math.floor(Date.now() / 1000);

const wallet = ethers.Wallet.createRandom() as ethers.HDNodeWallet;

const BASE_POLICY: AgentPolicy = {
  version: '1',
  userWallet: wallet.address,
  agentWallet: ethers.Wallet.createRandom().address,
  sessionKey: ethers.Wallet.createRandom().address,
  createdAt: NOW_SEC,
  expiresAt: NOW_SEC + 86400,
  revocationNonce: 'test-nonce',
  llm: {
    allowedModels: ['anthropic/claude-haiku-4-5-20251001'],
    maxRequestsPerHour: 10,
    maxTokensPerRequest: 2000,
    maxSpendPerDayUSDC: 2,
  },
  trading: {
    maxBudgetUSDC: 50,
    maxOrderSizeUSDC: 10,
    maxDailySpendUSDC: 25,
    maxOpenOrders: 3,
    allowedMarkets: [],
    allowedCategories: [],
    allowedSides: ['BUY'],
    allowedOrderTypes: ['GTD'],
    maxPrice: null,
    minLiquidityUSDC: null,
    maxSpreadBps: null,
    minExpirationSeconds: null,
    maxExpirationSeconds: null,
  },
};

async function signPolicy(policy: AgentPolicy, signerWallet: ethers.HDNodeWallet = wallet): Promise<string> {
  const policyHash = hashPolicy(policy);
  const eip712 = buildEIP712Message(policy);
  return signerWallet.signTypedData(
    eip712.domain,
    eip712.types,
    { ...eip712.message, policyHash },
  );
}

describe('PolicyVerifier', () => {
  it('verifies a valid policy signature', async () => {
    const sig = await signPolicy(BASE_POLICY);
    const result = verifyPolicySignature(BASE_POLICY, sig);
    expect(result.valid).toBe(true);
    expect(result.recoveredAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(result.reason).toBeNull();
  });

  it('rejects signature from wrong wallet', async () => {
    const wrongWallet = ethers.Wallet.createRandom() as ethers.HDNodeWallet;
    const sig = await signPolicy(BASE_POLICY, wrongWallet);
    const result = verifyPolicySignature(BASE_POLICY, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not match');
  });

  it('rejects expired policy', async () => {
    const expiredPolicy = { ...BASE_POLICY, expiresAt: NOW_SEC - 100 };
    const sig = await signPolicy(expiredPolicy);
    const result = verifyPolicySignature(expiredPolicy, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('rejects tampered policy (hash changes when content changes)', async () => {
    const sig = await signPolicy(BASE_POLICY);
    const tampered = { ...BASE_POLICY, trading: { ...BASE_POLICY.trading, maxBudgetUSDC: 999 } };
    const result = verifyPolicySignature(tampered, sig);
    // The EIP-712 message includes policyHash, so tampering changes the recovered address
    expect(result.valid).toBe(false);
  });

  it('produces consistent policy hash', () => {
    const hash1 = hashPolicy(BASE_POLICY);
    const hash2 = hashPolicy(BASE_POLICY);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('produces different hash for different policies', () => {
    const hash1 = hashPolicy(BASE_POLICY);
    const hash2 = hashPolicy({ ...BASE_POLICY, trading: { ...BASE_POLICY.trading, maxBudgetUSDC: 999 } });
    expect(hash1).not.toBe(hash2);
  });

  it('rejects malformed signature', () => {
    const result = verifyPolicySignature(BASE_POLICY, '0xinvalid');
    expect(result.valid).toBe(false);
  });
});

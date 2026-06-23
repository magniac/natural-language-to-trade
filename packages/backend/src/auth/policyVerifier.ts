import { ethers } from 'ethers';
import { sha256Hex } from '../utils/crypto';
import type { AgentPolicy, StoredPolicy } from '../types/policy';
import { logger } from '../utils/logger';

// EIP-712 typed data for policy signing
const POLICY_DOMAIN = {
  name: 'PolymarketAgentPolicy',
  version: '1',
};

const POLICY_TYPE = {
  AgentPolicy: [
    { name: 'version', type: 'string' },
    { name: 'userWallet', type: 'address' },
    { name: 'agentWallet', type: 'address' },
    { name: 'sessionKey', type: 'address' },
    { name: 'createdAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'revocationNonce', type: 'string' },
    { name: 'policyHash', type: 'bytes32' },
  ],
};

export function hashPolicy(policy: AgentPolicy): string {
  // Deep stable serialization: use a replacer function that sorts keys recursively
  return '0x' + sha256Hex(JSON.stringify(policy, (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  }));
}

export function buildEIP712Message(policy: AgentPolicy) {
  const policyHash = hashPolicy(policy);
  return {
    domain: POLICY_DOMAIN,
    types: POLICY_TYPE,
    message: {
      version: policy.version,
      userWallet: policy.userWallet,
      agentWallet: policy.agentWallet,
      sessionKey: policy.sessionKey,
      createdAt: policy.createdAt,
      expiresAt: policy.expiresAt,
      revocationNonce: policy.revocationNonce,
      policyHash: policyHash as `0x${string}`,
    },
  };
}

export function verifyPolicySignature(policy: AgentPolicy, signature: string): {
  valid: boolean;
  recoveredAddress: string | null;
  reason: string | null;
} {
  try {
    const policyHash = hashPolicy(policy);
    const eip712 = buildEIP712Message(policy);

    const recoveredAddress = ethers.verifyTypedData(
      eip712.domain,
      eip712.types,
      { ...eip712.message, policyHash },
      signature,
    );

    const normalizedRecovered = recoveredAddress.toLowerCase();
    const normalizedExpected = policy.userWallet.toLowerCase();

    if (normalizedRecovered !== normalizedExpected) {
      logger.warn({ recovered: normalizedRecovered, expected: normalizedExpected }, 'Policy signature mismatch');
      return {
        valid: false,
        recoveredAddress: normalizedRecovered,
        reason: `Signature signer ${normalizedRecovered} does not match policy userWallet ${normalizedExpected}`,
      };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (policy.expiresAt <= nowSec) {
      return { valid: false, recoveredAddress: normalizedRecovered, reason: 'Policy has expired' };
    }

    return { valid: true, recoveredAddress: normalizedRecovered, reason: null };
  } catch (err) {
    logger.error({ err }, 'Policy signature verification threw');
    return { valid: false, recoveredAddress: null, reason: 'Signature verification failed' };
  }
}

export function verifyStoredPolicy(stored: StoredPolicy): {
  valid: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  if (stored.status !== 'active') reasons.push(`Policy status is ${stored.status}`);

  const expiresAtSec = Math.floor(stored.expiresAt.getTime() / 1000);
  if (expiresAtSec <= nowSec) reasons.push('Policy has expired');

  const computedHash = hashPolicy(stored.policyJson);
  if (computedHash !== stored.policyHash) reasons.push('Policy hash mismatch — policy data may have been tampered');

  const sigCheck = verifyPolicySignature(stored.policyJson, stored.userSignature);
  if (!sigCheck.valid) reasons.push(sigCheck.reason ?? 'Invalid signature');

  return { valid: reasons.length === 0, reasons };
}

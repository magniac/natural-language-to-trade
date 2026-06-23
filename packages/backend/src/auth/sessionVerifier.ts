import { ethers } from 'ethers';
import crypto from 'crypto';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';
import { writeAudit } from '../db/auditRepository';
import type { StoredPolicy } from '../types/policy';
import { verifyStoredPolicy } from './policyVerifier';

export interface SessionRequestHeaders {
  policyId: string;
  sessionKey: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface SessionVerificationResult {
  valid: boolean;
  policyId: string | null;
  policy: StoredPolicy | null;
  reasons: string[];
}

const MAX_TIMESTAMP_DRIFT_SEC = 60;

function buildCanonicalMessage(params: {
  policyId: string;
  sessionKey: string;
  method: string;
  path: string;
  bodyHash: string;
  timestamp: number;
  nonce: string;
}): string {
  return JSON.stringify({
    policyId: params.policyId,
    sessionKey: params.sessionKey,
    method: params.method,
    path: params.path,
    bodyHash: params.bodyHash,
    timestamp: params.timestamp,
    nonce: params.nonce,
  });
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

export async function verifySessionRequest(
  headers: SessionRequestHeaders,
  method: string,
  path: string,
  rawBody: string,
  allowedScopes: string[]
): Promise<SessionVerificationResult> {
  const reasons: string[] = [];

  // 1. Check timestamp freshness
  const nowSec = Math.floor(Date.now() / 1000);
  const drift = Math.abs(nowSec - headers.timestamp);
  if (drift > MAX_TIMESTAMP_DRIFT_SEC) {
    reasons.push(`Timestamp drift too large: ${drift}s (max ${MAX_TIMESTAMP_DRIFT_SEC}s)`);
    return { valid: false, policyId: null, policy: null, reasons };
  }

  // 2. Load policy
  const db = getDb();
  const policyRow = db.prepare('SELECT * FROM agent_policies WHERE id = ?').get(headers.policyId) as Record<string, unknown> | undefined;

  if (!policyRow) {
    reasons.push(`Policy ${headers.policyId} not found`);
    writeAudit({
      actorType: 'agent',
      actorId: headers.sessionKey,
      action: 'session.reject',
      details: { policyId: headers.policyId, reason: 'policy_not_found' },
    });
    return { valid: false, policyId: headers.policyId, policy: null, reasons };
  }

  const stored: StoredPolicy = {
    id: policyRow.id as string,
    userId: policyRow.user_id as string,
    agentWalletId: policyRow.agent_wallet_id as string,
    sessionKeyAddress: policyRow.session_key_address as string,
    policyJson: JSON.parse(policyRow.policy_json as string),
    policyHash: policyRow.policy_hash as string,
    userSignature: policyRow.user_signature as string,
    status: policyRow.status as StoredPolicy['status'],
    createdAt: new Date(policyRow.created_at as number),
    expiresAt: new Date(policyRow.expires_at as number),
    revokedAt: policyRow.revoked_at ? new Date(policyRow.revoked_at as number) : null,
  };

  // 3. Verify policy integrity
  const policyCheck = verifyStoredPolicy(stored);
  if (!policyCheck.valid) {
    reasons.push(...policyCheck.reasons);
  }

  // 4. Confirm session key matches policy
  if (stored.sessionKeyAddress.toLowerCase() !== headers.sessionKey.toLowerCase()) {
    reasons.push(`Session key ${headers.sessionKey} does not match policy session key ${stored.sessionKeyAddress}`);
  }

  // 5. Check nonce not previously used
  const nonceRow = db.prepare('SELECT id FROM session_nonces WHERE policy_id = ? AND nonce = ?')
    .get(headers.policyId, headers.nonce);

  if (nonceRow) {
    reasons.push(`Nonce ${headers.nonce} has already been used — replay attack rejected`);
    writeAudit({
      userId: stored.userId,
      agentWalletId: stored.agentWalletId,
      policyId: headers.policyId,
      actorType: 'agent',
      actorId: headers.sessionKey,
      action: 'nonce.replay_rejected',
      details: { nonce: headers.nonce },
    });
  }

  if (reasons.length > 0) {
    return { valid: false, policyId: headers.policyId, policy: stored, reasons };
  }

  // 6. Verify request signature
  const bodyHash = '0x' + sha256Hex(rawBody);
  const canonical = buildCanonicalMessage({
    policyId: headers.policyId,
    sessionKey: headers.sessionKey,
    method: method.toUpperCase(),
    path,
    bodyHash,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
  });

  let recoveredSigner: string;
  try {
    recoveredSigner = ethers.verifyMessage(canonical, headers.signature);
  } catch {
    reasons.push('Failed to recover signer from signature');
    return { valid: false, policyId: headers.policyId, policy: stored, reasons };
  }

  if (recoveredSigner.toLowerCase() !== headers.sessionKey.toLowerCase()) {
    reasons.push(`Recovered signer ${recoveredSigner} does not match session key ${headers.sessionKey}`);
    return { valid: false, policyId: headers.policyId, policy: stored, reasons };
  }

  // 7. Mark nonce used
  db.prepare(`
    INSERT INTO session_nonces (id, policy_id, session_key_address, nonce, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    headers.policyId,
    headers.sessionKey,
    headers.nonce,
    headers.timestamp,
    Date.now(),
  );

  writeAudit({
    userId: stored.userId,
    agentWalletId: stored.agentWalletId,
    policyId: headers.policyId,
    actorType: 'agent',
    actorId: headers.sessionKey,
    action: 'session.verify',
    details: { method, path, nonce: headers.nonce },
  });

  logger.debug({ policyId: headers.policyId, method, path }, 'Session verified');
  return { valid: true, policyId: headers.policyId, policy: stored, reasons: [] };
}

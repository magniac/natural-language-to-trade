import { v4 as uuidv4 } from 'uuid';
import { getDb } from './database';
import { hashPolicy } from '../auth/policyVerifier';
import type { AgentPolicy, StoredPolicy } from '../types/policy';

export function createPolicy(params: {
  userId: string;
  agentWalletId: string;
  sessionKeyAddress: string;
  policy: AgentPolicy;
  userSignature: string;
}): StoredPolicy {
  const db = getDb();
  const id = uuidv4();
  const policyHash = hashPolicy(params.policy);
  const now = Date.now();
  const expiresAt = params.policy.expiresAt * 1000;

  db.prepare(`
    INSERT INTO agent_policies (id, user_id, agent_wallet_id, session_key_address, policy_json, policy_hash, user_signature, status, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
  `).run(id, params.userId, params.agentWalletId, params.sessionKeyAddress,
    JSON.stringify(params.policy), policyHash, params.userSignature, now, expiresAt);

  // Supersede previous active policies for this agent
  db.prepare(`
    UPDATE agent_policies SET status = 'superseded'
    WHERE agent_wallet_id = ? AND id != ? AND status = 'active'
  `).run(params.agentWalletId, id);

  return getPolicyById(id)!;
}

export function getPolicyById(policyId: string): StoredPolicy | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_policies WHERE id = ?').get(policyId) as Record<string, unknown> | undefined;
  return row ? rowToPolicy(row) : null;
}

export function getActivePolicyForAgent(agentWalletId: string): StoredPolicy | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_policies WHERE agent_wallet_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(agentWalletId) as Record<string, unknown> | undefined;
  return row ? rowToPolicy(row) : null;
}

export function revokePolicy(policyId: string): void {
  const db = getDb();
  db.prepare("UPDATE agent_policies SET status = 'revoked', revoked_at = ? WHERE id = ?")
    .run(Date.now(), policyId);
}

function rowToPolicy(row: Record<string, unknown>): StoredPolicy {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    agentWalletId: row.agent_wallet_id as string,
    sessionKeyAddress: row.session_key_address as string,
    policyJson: JSON.parse(row.policy_json as string),
    policyHash: row.policy_hash as string,
    userSignature: row.user_signature as string,
    status: row.status as StoredPolicy['status'],
    createdAt: new Date(row.created_at as number),
    expiresAt: new Date(row.expires_at as number),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as number) : null,
  };
}

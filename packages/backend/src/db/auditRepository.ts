import { v4 as uuidv4 } from 'uuid';
import { getDb } from './database';
import type { AuditLogEntry, AuditActorType, AuditAction } from '../types/audit';
import { logger } from '../utils/logger';

export interface WriteAuditParams {
  userId?: string;
  agentWalletId?: string;
  policyId?: string;
  actorType: AuditActorType;
  actorId: string;
  action: AuditAction;
  details?: Record<string, unknown>;
}

export function writeAudit(params: WriteAuditParams): string {
  const db = getDb();
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`
    INSERT INTO audit_logs (id, user_id, agent_wallet_id, policy_id, actor_type, actor_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.userId ?? null,
    params.agentWalletId ?? null,
    params.policyId ?? null,
    params.actorType,
    params.actorId,
    params.action,
    JSON.stringify(params.details ?? {}),
    now,
  );
  logger.debug({ auditId: id, action: params.action, actorId: params.actorId }, 'Audit logged');
  return id;
}

export function getAuditLog(
  userId: string,
  options: { limit?: number; offset?: number; action?: AuditAction } = {}
): AuditLogEntry[] {
  const db = getDb();
  const { limit = 100, offset = 0, action } = options;
  const rows = action
    ? db.prepare('SELECT * FROM audit_logs WHERE user_id = ? AND action = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(userId, action, limit, offset)
    : db.prepare('SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(userId, limit, offset);

  return (rows as Record<string, unknown>[]).map(rowToEntry);
}

function rowToEntry(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: row.id as string,
    userId: (row.user_id as string | null),
    agentWalletId: (row.agent_wallet_id as string | null),
    policyId: (row.policy_id as string | null),
    actorType: row.actor_type as AuditActorType,
    actorId: row.actor_id as string,
    action: row.action as AuditAction,
    details: JSON.parse(row.details_json as string),
    createdAt: new Date(row.created_at as number),
  };
}

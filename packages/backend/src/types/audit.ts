export type AuditActorType = 'user' | 'agent' | 'system' | 'admin';

export type AuditAction =
  | 'agent.create'
  | 'agent.pause'
  | 'agent.resume'
  | 'agent.revoke'
  | 'agent.cancel_all'
  | 'agent.withdraw'
  | 'agent.mode_changed'
  | 'agent.key_import'
  | 'agent.key_export'
  | 'agent.provision_wallet'
  | 'policy.create'
  | 'policy.verify'
  | 'policy.revoke'
  | 'session.request'
  | 'session.verify'
  | 'session.reject'
  | 'nonce.use'
  | 'nonce.replay_rejected'
  | 'intent.receive'
  | 'intent.parse'
  | 'intent.resolve'
  | 'intent.deny'
  | 'intent.allow'
  | 'clob.derive'
  | 'order.pending_signature'
  | 'order.build'
  | 'order.sign'
  | 'order.submit'
  | 'order.submitted'
  | 'order.failed'
  | 'order.cancel'
  | 'order.cancel_all'
  | 'order.fill'
  | 'order.reconcile'
  | 'llm.call'
  | 'llm.deny'
  | 'kill_switch.enable'
  | 'kill_switch.disable'
  | 'compliance.block'
  | 'compliance.allow'
  | 'simulator.trade'
  | 'loop.start'
  | 'loop.stop'
  | 'loop.run';

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  agentWalletId: string | null;
  policyId: string | null;
  actorType: AuditActorType;
  actorId: string;
  action: AuditAction;
  details: Record<string, unknown>;
  createdAt: Date;
}

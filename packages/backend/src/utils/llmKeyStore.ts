import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { encrypt, decrypt } from './crypto';

export function storeLlmApiKey(agentWalletId: string, apiKey: string): void {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM user_api_keys WHERE agent_wallet_id = ? AND provider = 'openrouter'"
  ).get(agentWalletId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE user_api_keys SET encrypted_key = ?, updated_at = ? WHERE id = ?"
    ).run(encrypt(apiKey), Date.now(), existing.id);
  } else {
    db.prepare(
      "INSERT INTO user_api_keys (id, agent_wallet_id, provider, encrypted_key, created_at, updated_at) VALUES (?, ?, 'openrouter', ?, ?, ?)"
    ).run(uuidv4(), agentWalletId, encrypt(apiKey), Date.now(), Date.now());
  }
}

export function getLlmApiKey(agentWalletId: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT encrypted_key FROM user_api_keys WHERE agent_wallet_id = ? AND provider = 'openrouter'"
  ).get(agentWalletId) as { encrypted_key: string } | undefined;
  if (!row) return null;
  return decrypt(row.encrypted_key);
}

export function deleteLlmApiKey(agentWalletId: string): void {
  getDb().prepare(
    "DELETE FROM user_api_keys WHERE agent_wallet_id = ? AND provider = 'openrouter'"
  ).run(agentWalletId);
}

export function hasLlmApiKey(agentWalletId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM user_api_keys WHERE agent_wallet_id = ? AND provider = 'openrouter'"
  ).get(agentWalletId);
  return !!row;
}

/** Resolve the API key: stored key first, fall back to env var. */
export function resolveLlmApiKey(agentWalletId?: string): string | undefined {
  if (agentWalletId) {
    const stored = getLlmApiKey(agentWalletId);
    if (stored) return stored;
  }
  return process.env.OPENROUTER_API_KEY || undefined;
}

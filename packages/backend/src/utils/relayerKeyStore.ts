import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { encrypt, decrypt } from './crypto';

const PROVIDER = 'relayer';

export interface RelayerApiCreds {
  apiKey: string;
  apiKeyAddress: string;
}

export function storeRelayerCreds(agentWalletId: string, creds: RelayerApiCreds): void {
  const db = getDb();
  const blob = encrypt(JSON.stringify(creds));
  const existing = db.prepare(
    "SELECT id FROM user_api_keys WHERE agent_wallet_id = ? AND provider = ?"
  ).get(agentWalletId, PROVIDER) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE user_api_keys SET encrypted_key = ?, updated_at = ? WHERE id = ?"
    ).run(blob, Date.now(), existing.id);
  } else {
    db.prepare(
      "INSERT INTO user_api_keys (id, agent_wallet_id, provider, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(uuidv4(), agentWalletId, PROVIDER, blob, Date.now(), Date.now());
  }
}

export function getRelayerCreds(agentWalletId: string): RelayerApiCreds | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT encrypted_key FROM user_api_keys WHERE agent_wallet_id = ? AND provider = ?"
  ).get(agentWalletId, PROVIDER) as { encrypted_key: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.encrypted_key)) as RelayerApiCreds;
  } catch {
    return null;
  }
}

export function deleteRelayerCreds(agentWalletId: string): void {
  getDb().prepare(
    "DELETE FROM user_api_keys WHERE agent_wallet_id = ? AND provider = ?"
  ).run(agentWalletId, PROVIDER);
}

export function hasRelayerCreds(agentWalletId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM user_api_keys WHERE agent_wallet_id = ? AND provider = ?"
  ).get(agentWalletId, PROVIDER);
  return !!row;
}

/** Resolve relayer creds: per-agent stored creds first, fall back to env vars. */
export function resolveRelayerCreds(agentWalletId?: string): RelayerApiCreds | null {
  if (agentWalletId) {
    const stored = getRelayerCreds(agentWalletId);
    if (stored?.apiKey && stored?.apiKeyAddress) return stored;
  }
  const apiKey = process.env.RELAYER_API_KEY;
  const apiKeyAddress = process.env.RELAYER_API_KEY_ADDRESS;
  if (apiKey && apiKeyAddress) return { apiKey, apiKeyAddress };
  return null;
}

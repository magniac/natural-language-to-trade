import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { encrypt, decrypt } from './crypto';

const PROVIDER = 'hyperliquid';

export interface HyperliquidCreds {
  /** The Hyperliquid API wallet (agent) address — the signer. */
  apiWalletAddress: string;
  /** The API wallet's private key. Signs orders; cannot withdraw funds. */
  privateKey: string;
}

export function storeHlCreds(agentWalletId: string, creds: HyperliquidCreds): void {
  const db = getDb();
  const blob = encrypt(JSON.stringify(creds));
  const existing = db.prepare(
    "SELECT id FROM user_api_keys WHERE agent_wallet_id = ? AND provider = ?"
  ).get(agentWalletId, PROVIDER) as { id: string } | undefined;

  if (existing) {
    db.prepare("UPDATE user_api_keys SET encrypted_key = ?, updated_at = ? WHERE id = ?")
      .run(blob, Date.now(), existing.id);
  } else {
    db.prepare(
      "INSERT INTO user_api_keys (id, agent_wallet_id, provider, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(uuidv4(), agentWalletId, PROVIDER, blob, Date.now(), Date.now());
  }
}

export function getHlCreds(agentWalletId: string): HyperliquidCreds | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT encrypted_key FROM user_api_keys WHERE agent_wallet_id = ? AND provider = ?"
  ).get(agentWalletId, PROVIDER) as { encrypted_key: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.encrypted_key)) as HyperliquidCreds;
  } catch {
    return null;
  }
}

export function hasHlCreds(agentWalletId: string): boolean {
  const db = getDb();
  return !!db.prepare(
    "SELECT id FROM user_api_keys WHERE agent_wallet_id = ? AND provider = ?"
  ).get(agentWalletId, PROVIDER);
}

export function deleteHlCreds(agentWalletId: string): void {
  getDb().prepare(
    "DELETE FROM user_api_keys WHERE agent_wallet_id = ? AND provider = ?"
  ).run(agentWalletId, PROVIDER);
}

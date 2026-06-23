import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { encrypt, decrypt } from '../utils/crypto';
import type { AgentSigner } from '../types/agent';
import { logger } from '../utils/logger';

/**
 * DEV SIGNER — local encrypted key store.
 * FOR TEST/DEVELOPMENT ONLY.
 * Never use in production.
 * Production must use KMS/HSM via the same AgentSigner interface.
 */
export class DevSigner implements AgentSigner {
  async getAddress(agentWalletId: string): Promise<string> {
    const wallet = this.loadWallet(agentWalletId);
    return wallet.address;
  }

  async signMessage(agentWalletId: string, message: Uint8Array | string): Promise<string> {
    const wallet = this.loadWallet(agentWalletId);
    logger.debug({ agentWalletId, purpose: 'signMessage' }, 'Agent signing message');
    return wallet.signMessage(message);
  }

  async signTypedData(agentWalletId: string, typedData: unknown): Promise<string> {
    const wallet = this.loadWallet(agentWalletId);
    const td = typedData as { domain: unknown; types: Record<string, unknown>; message: unknown };
    logger.debug({ agentWalletId, purpose: 'signTypedData' }, 'Agent signing typed data');
    return wallet.signTypedData(td.domain as ethers.TypedDataDomain, td.types as Record<string, ethers.TypedDataField[]>, td.message as Record<string, unknown>);
  }

  createAgentWallet(userId: string): { agentWalletId: string; address: string } {
    const wallet = ethers.Wallet.createRandom();
    const agentWalletId = uuidv4();

    const db = getDb();
    db.prepare(`
      INSERT INTO agent_wallets (id, user_id, address, signer_provider, kms_key_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'dev', NULL, 'active', ?, ?)
    `).run(agentWalletId, userId, wallet.address, Date.now(), Date.now());

    // Store encrypted private key in a separate secure table (dev only)
    db.prepare(`
      INSERT INTO dev_signer_keys (agent_wallet_id, encrypted_private_key, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_wallet_id) DO NOTHING
    `).run(agentWalletId, encrypt(wallet.privateKey), Date.now());

    logger.info({ agentWalletId, address: wallet.address }, 'Dev agent wallet created');
    return { agentWalletId, address: wallet.address };
  }

  /** Returns a wallet connected to the given provider — for sending on-chain txs (dev only). */
  createProviderWallet(agentWalletId: string, provider: ethers.JsonRpcProvider): ethers.Wallet {
    return this.loadWallet(agentWalletId).connect(provider);
  }

  /** Replaces the stored key (and optionally proxy wallet address) with user-supplied values. Returns the EOA address. */
  importKey(agentWalletId: string, privateKey: string, proxyWalletAddress?: string): string {
    let wallet: ethers.Wallet;
    try {
      wallet = new ethers.Wallet(privateKey);
    } catch {
      throw new Error('Invalid private key');
    }
    const db = getDb();
    db.prepare('UPDATE agent_wallets SET address = ?, proxy_wallet_address = ?, updated_at = ? WHERE id = ?')
      .run(wallet.address, proxyWalletAddress ?? null, Date.now(), agentWalletId);
    db.prepare(`
      INSERT INTO dev_signer_keys (agent_wallet_id, encrypted_private_key, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_wallet_id) DO UPDATE SET encrypted_private_key = excluded.encrypted_private_key
    `).run(agentWalletId, encrypt(privateKey), Date.now());
    logger.info({ agentWalletId, address: wallet.address, proxyWalletAddress }, 'Agent wallet key imported');
    return wallet.address;
  }

  /** Returns the raw private key — for exporting to MetaMask so the user can register it with Polymarket (dev only). */
  exportKey(agentWalletId: string): string {
    return this.loadWallet(agentWalletId).privateKey;
  }

  private loadWallet(agentWalletId: string): ethers.Wallet {
    const db = getDb();
    const row = db.prepare('SELECT encrypted_private_key FROM dev_signer_keys WHERE agent_wallet_id = ?')
      .get(agentWalletId) as { encrypted_private_key: string } | undefined;

    if (!row) throw new Error(`Dev signer: no key found for agent wallet ${agentWalletId}`);

    const privateKey = decrypt(row.encrypted_private_key);
    return new ethers.Wallet(privateKey);
  }
}

// Create the dev_signer_keys table if it doesn't exist (init-time side effect, dev only)
export function ensureDevSignerTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_signer_keys (
      agent_wallet_id TEXT PRIMARY KEY REFERENCES agent_wallets(id),
      encrypted_private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

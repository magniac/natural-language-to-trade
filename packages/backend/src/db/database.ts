// Uses Node.js built-in sqlite (available since Node 22.5)
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { SCHEMA_SQL } from './schema';
import { logger } from '../utils/logger';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH ?? './data/polymarket_agent.db';
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  // Migrations — safe to run repeatedly; errors on existing columns are swallowed
  try { db.exec(`ALTER TABLE agent_wallets ADD COLUMN paper_mode INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_wallets ADD COLUMN proxy_wallet_address TEXT`); } catch { /* already exists */ }
  // Venue tag so Polymarket and Hyperliquid trades share the orders/trade_intents tables.
  try { db.exec(`ALTER TABLE orders ADD COLUMN venue TEXT NOT NULL DEFAULT 'polymarket'`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE trade_intents ADD COLUMN venue TEXT NOT NULL DEFAULT 'polymarket'`); } catch { /* already exists */ }

  // Drop UNIQUE constraint on agent_wallets.address — imported EOA keys can be reused across agent rows.
  // SQLite requires a full table recreation to remove a constraint.
  const walletSchema = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_wallets'").get() as { sql: string } | undefined)?.sql ?? '';
  if (walletSchema.includes('UNIQUE')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`CREATE TABLE agent_wallets_tmp (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      address TEXT NOT NULL,
      proxy_wallet_address TEXT,
      signer_provider TEXT NOT NULL DEFAULT 'dev',
      kms_key_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      paper_mode INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(`INSERT INTO agent_wallets_tmp (id, user_id, address, proxy_wallet_address, signer_provider, kms_key_id, status, paper_mode, created_at, updated_at)
      SELECT id, user_id, address, proxy_wallet_address, signer_provider, kms_key_id, status, COALESCE(paper_mode, 1), created_at, updated_at FROM agent_wallets`);
    db.exec('DROP TABLE agent_wallets');
    db.exec('ALTER TABLE agent_wallets_tmp RENAME TO agent_wallets');
    db.exec('PRAGMA foreign_keys = ON');
    logger.info('Migrated agent_wallets: removed UNIQUE constraint on address');
  }

  logger.info({ dbPath }, 'Database initialized');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

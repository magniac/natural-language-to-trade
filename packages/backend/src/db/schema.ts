export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS agent_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  address TEXT NOT NULL UNIQUE,
  signer_provider TEXT NOT NULL DEFAULT 'dev',
  kms_key_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_policies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_wallet_id TEXT NOT NULL REFERENCES agent_wallets(id),
  session_key_address TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  user_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS session_nonces (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES agent_policies(id),
  session_key_address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(policy_id, nonce)
);

CREATE TABLE IF NOT EXISTS clob_credentials (
  id TEXT PRIMARY KEY,
  agent_wallet_id TEXT NOT NULL REFERENCES agent_wallets(id),
  encrypted_api_key TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  encrypted_passphrase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);

CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL UNIQUE,
  event_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  category TEXT,
  resolution_date INTEGER,
  liquidity_usdc REAL NOT NULL DEFAULT 0,
  volume_24h_usdc REAL NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_tokens (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES markets(market_id),
  outcome TEXT NOT NULL,
  token_id TEXT NOT NULL UNIQUE,
  tick_size REAL NOT NULL DEFAULT 0.01,
  neg_risk INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_wallet_id TEXT NOT NULL REFERENCES agent_wallets(id),
  policy_id TEXT NOT NULL REFERENCES agent_policies(id),
  session_key_address TEXT NOT NULL,
  raw_input TEXT NOT NULL,
  structured_intent_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  venue TEXT NOT NULL DEFAULT 'polymarket',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY,
  trade_intent_id TEXT NOT NULL REFERENCES trade_intents(id),
  allowed INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  risk_summary_json TEXT NOT NULL,
  market_state_snapshot_json TEXT NOT NULL DEFAULT '{}',
  account_state_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  trade_intent_id TEXT NOT NULL REFERENCES trade_intents(id),
  agent_wallet_id TEXT NOT NULL REFERENCES agent_wallets(id),
  market_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  order_type TEXT NOT NULL,
  expiration INTEGER,
  signed_order_hash TEXT,
  clob_order_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  venue TEXT NOT NULL DEFAULT 'polymarket',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  clob_trade_id TEXT NOT NULL UNIQUE,
  price REAL NOT NULL,
  size REAL NOT NULL,
  side TEXT NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_wallet_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  session_key_address TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usdc REAL NOT NULL DEFAULT 0,
  actual_cost_usdc REAL,
  request_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  agent_wallet_id TEXT,
  policy_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kill_switches (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  target_id TEXT,
  reason TEXT,
  enabled_by TEXT NOT NULL,
  enabled_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id TEXT PRIMARY KEY,
  agent_wallet_id TEXT NOT NULL REFERENCES agent_wallets(id),
  provider TEXT NOT NULL DEFAULT 'openrouter',
  encrypted_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_api_keys_agent_provider ON user_api_keys(agent_wallet_id, provider);

CREATE TABLE IF NOT EXISTS loop_state (
  agent_wallet_id TEXT PRIMARY KEY REFERENCES agent_wallets(id),
  status TEXT NOT NULL DEFAULT 'stopped',
  interval_ms INTEGER NOT NULL DEFAULT 300000,
  last_run_at INTEGER,
  next_run_at INTEGER,
  runs_total INTEGER NOT NULL DEFAULT 0,
  trades_placed INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  stopped_at INTEGER
);

CREATE TABLE IF NOT EXISTS loop_decisions (
  id TEXT PRIMARY KEY,
  agent_wallet_id TEXT NOT NULL REFERENCES agent_wallets(id),
  run_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_title TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasoning TEXT,
  suggested_price REAL,
  order_id TEXT,
  policy_outcome TEXT,
  policy_reasons TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loop_decisions_agent ON loop_decisions(agent_wallet_id, created_at);

-- Option 2: user's registered Polymarket proxy wallet as collateral source
CREATE TABLE IF NOT EXISTS user_polymarket_config (
  agent_wallet_id TEXT PRIMARY KEY REFERENCES agent_wallets(id),
  proxy_wallet_address TEXT NOT NULL,
  eoa_address TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  encrypted_passphrase TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_live_orders (
  id TEXT PRIMARY KEY,
  agent_wallet_id TEXT NOT NULL REFERENCES agent_wallets(id),
  typed_data_json TEXT NOT NULL,
  order_struct_json TEXT NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'GTC',
  status TEXT NOT NULL DEFAULT 'awaiting_signature',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_orders_agent ON pending_live_orders(agent_wallet_id, status);

CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
CREATE INDEX IF NOT EXISTS idx_market_tokens_market ON market_tokens(market_id);
CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_wallet_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_intent ON orders(trade_intent_id);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_nonces_policy ON session_nonces(policy_id, nonce);
CREATE INDEX IF NOT EXISTS idx_llm_usage_policy ON llm_usage(policy_id, created_at);
CREATE INDEX IF NOT EXISTS idx_policies_agent ON agent_policies(agent_wallet_id, status);
`;

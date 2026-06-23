# Orbit Natural-Language Trading Demo

A local full-stack demo for turning natural-language instructions into policy-constrained Polymarket orders. It combines a React interface, an Express API, a deterministic policy engine, paper trading, and an optional live-trading path through Polymarket's CLOB and relayer.

> **Development demo only.** The current signer stores agent private keys encrypted in a local SQLite database. The production KMS signer is not implemented. Do not deploy this application or use meaningful funds without replacing the development signer and completing a security review.

## What it does

- Searches and refreshes active Polymarket markets.
- Parses natural-language trade requests with an OpenRouter model.
- Verifies a user-signed EIP-712 policy before accepting agent requests.
- Enforces budget, order-size, daily-spend, liquidity, spread, price, expiry, and request limits deterministically.
- Simulates orders in paper mode, which is the default.
- Optionally signs and posts live CLOB orders behind server and per-agent feature flags.
- Displays holdings, recent orders, and budget use.
- Supports pausing, policy revocation, cancelling orders, and relayed pUSD withdrawals.

## Requirements

- Node.js 20 or newer
- npm
- A browser wallet such as MetaMask
- An [OpenRouter API key](https://openrouter.ai/keys), supplied globally or through Agent Setup

Live trading additionally requires:

- A separate agent wallet onboarded at [Polymarket](https://polymarket.com)
- A Polymarket relayer API key for that agent wallet
- pUSD on Polygon in the connected funding wallet
- A small amount of POL in the funding wallet for the initial pUSD transfer

Make sure your location and intended use comply with Polymarket's terms and applicable law. The backend geoblock is enabled by default.

## Quick start

Install dependencies from the repository root:

```bash
npm install
```

Create the backend environment file:

```bash
cp packages/backend/.env.example packages/backend/.env
```

Generate a local encryption key and paste it into `packages/backend/.env` as `ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

For natural-language parsing, set `OPENROUTER_API_KEY` in the environment file or add a key later in Agent Setup. Keep live trading disabled while getting started:

```dotenv
ENABLE_LIVE_TRADING=false
SIGNER_MODE=dev
```

Start the backend and frontend in separate terminals:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Open [http://localhost:3000](http://localhost:3000). The frontend proxies `/api` requests to the backend at `http://localhost:3001`.

## Using the demo

### Paper trading

1. Connect the wallet that will own and sign the agent policy.
2. Create an agent in Agent Setup.
3. Add an OpenRouter API key if one is not configured on the backend.
4. Choose policy limits and sign the EIP-712 policy.
5. Leave the agent in Paper mode.
6. Open Chat and ask the agent to search markets, inspect the portfolio, or place a paper trade.

Paper mode uses simulated fills and does not move funds.

### Live trading

Live mode is deliberately opt-in. First set these backend values and restart the server:

```dotenv
ENABLE_LIVE_TRADING=true
MAX_GLOBAL_LIVE_ORDER_USDC=1
```

Then complete Agent Setup in order:

1. Connect the main wallet that will sign the policy and fund the deposit wallet.
2. Create an agent, then import the private key of a separate wallet already onboarded with Polymarket.
3. Add that agent wallet's Polymarket relayer API key and matching API-key address.
4. Provision its canonical Polymarket deposit wallet through the relayer.
5. Add an OpenRouter API key.
6. Configure and sign the bounded trading policy.
7. Send pUSD from the connected main wallet to the provisioned deposit wallet.
8. Authorize trading; the relayer batches the required pUSD and outcome-token approvals.
9. Derive CLOB credentials and switch the agent to Live mode.

The server-wide `MAX_GLOBAL_LIVE_ORDER_USDC` remains a hard ceiling in addition to the signed policy's limits.

## Wallets and gas

The demo uses three wallet roles:

| Wallet | Purpose | Needs POL? |
| --- | --- | --- |
| Main browser wallet | Signs the policy and sends the initial pUSD funding transfer | **Yes, a small amount**, because the pUSD transfer is an ordinary Polygon transaction |
| Agent EOA | Signs CLOB and relayer requests; its development key is held by the backend | No |
| Polymarket deposit wallet | Holds pUSD and positions and acts as the CLOB funder/maker | No |

Policy signing is off-chain. Deposit-wallet provisioning, exchange approvals, and withdrawals are submitted through Polymarket's relayer, which pays gas. CLOB orders are signed and posted to the API. The only direct on-chain transaction initiated by the frontend is the initial pUSD transfer from the connected main wallet, so that wallet must have enough POL for its gas fee.

## Configuration

The complete starting configuration is in [`packages/backend/.env.example`](packages/backend/.env.example). Important values include:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Backend HTTP port |
| `DATABASE_PATH` | `./data/polymarket_agent.db` | SQLite database location, relative to the backend process |
| `ENCRYPTION_KEY` | none | Required 32-byte hex key for encrypted local secrets |
| `OPENROUTER_API_KEY` | none | Optional global LLM key; Agent Setup can store one per agent |
| `OPENROUTER_MODEL` | application default | Overrides the OpenRouter model |
| `SIGNER_MODE` | `dev` | Local development signer; `kms` is currently a stub |
| `ENABLE_LIVE_TRADING` | `false` | Server-wide live-trading gate |
| `MAX_GLOBAL_LIVE_ORDER_USDC` | `1` | Hard maximum value of any live order |
| `POLYGON_RPC_URL` | public Polygon RPC | RPC used for balances and relayed wallet operations |
| `RELAYER_API_KEY` / `RELAYER_API_KEY_ADDRESS` | none | Optional server-wide relayer credentials; per-agent credentials can be stored in the UI |
| `POLY_BUILDER_*` | none | Alternative builder authorization for the relayer |
| `ADMIN_API_KEY` | none | Required by internal admin endpoints |
| `GEOBLOCK_ENABLED` | `true` | Enables country-code enforcement on live trading |
| `BLOCKED_COUNTRY_CODES` | `US,GB` | Comma-separated blocked country codes |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS origins |

Never commit a populated `.env` file, wallet private key, relayer credential, CLOB credential, or OpenRouter key.

## How requests are authorized

The main wallet signs an EIP-712 policy containing the owner, agent, session key, expiry, revocation nonce, and trading/LLM limits. The browser stores the generated session key locally and signs each protected API request with a nonce and timestamp. The backend then:

1. Verifies the request signature and rejects replayed nonces.
2. Loads and re-verifies the stored owner-signed policy.
3. Parses the requested trade into structured intent.
4. Resolves current market data.
5. Runs the deterministic policy engine.
6. Simulates the trade or, when both live gates are enabled, signs and submits a CLOB order.

The language model does not decide whether a trade is allowed; it proposes an intent that must pass the policy engine.

## Repository layout

```text
packages/
  backend/
    src/agent/       Chat tools and signer abstraction
    src/api/         Express routes and request middleware
    src/auth/        Policy and session verification
    src/clob/        Polymarket CLOB and relayer integration
    src/market/      Gamma ingestion and market resolution
    src/policy/      Deterministic policy engine
    src/simulator/   Paper-trading execution
  frontend/
    src/components/  Setup, chat, portfolio, and status UI
    src/lib/         Wallet, API, and session-signing helpers
```

## Commands

Run these from the repository root:

```bash
npm run dev:backend   # Express API with automatic TypeScript restart
npm run dev:frontend  # Vite development server
npm run typecheck     # Type-check all workspaces
npm test              # Run backend tests
npm run build         # Build backend and frontend
```

## Safety notes and current limitations

- Live trading is disabled by default and requires both the server flag and Live mode on the agent.
- `SIGNER_MODE=dev` is intentionally rejected when `NODE_ENV=production`.
- The development signer can import and decrypt agent private keys. It is unsuitable for a hosted service.
- `SIGNER_MODE=kms` is not implemented yet.
- SQLite is intended for a local demo, not distributed deployment.
- Review the policy defaults, geoblocking, custody model, relayer permissions, and Polymarket integration before testing with live funds.

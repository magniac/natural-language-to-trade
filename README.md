# Orbit Natural-Language Trading Demo

A local full-stack demo for turning natural-language instructions into policy-constrained Polymarket and Hyperliquid trades. It combines a React interface, an Express API, a deterministic policy engine, paper trading, and optional live-trading paths through Polymarket's CLOB/relayer and Hyperliquid spot/perps.

> **Development demo only.** The current signer stores agent private keys encrypted in a local SQLite database. The production KMS signer is not implemented. Do not deploy this application or use meaningful funds without replacing the development signer and completing a security review.

## What it does

- Searches and refreshes active Polymarket markets.
- Parses natural-language trade requests with an OpenRouter model.
- Verifies a user-signed EIP-712 policy before accepting agent requests.
- Enforces venue, budget, order-size, daily-spend, liquidity, spread, price, expiry, coin, slippage, and request limits deterministically.
- Simulates orders in paper mode, which is the default.
- Optionally signs and posts live Polymarket CLOB orders and Hyperliquid spot/perp orders behind policy and per-agent mode controls.
- Displays holdings, recent orders, and budget use.
- Supports pausing, policy editing/re-signing, policy revocation, cancelling orders, and relayed pUSD withdrawals.

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

Hyperliquid live trading additionally requires:

- A Hyperliquid account funded from the connected main wallet
- A Hyperliquid API wallet address and secret key created in Hyperliquid
- Native USDC on Arbitrum for deposits to Hyperliquid

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

For natural-language parsing, set `OPENROUTER_API_KEY` in the environment file or add a key later in Agent Setup. Keep the default development signer while getting started:

```dotenv
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
4. Choose policy limits, enabled venues, and sign the EIP-712 policy.
5. Leave the agent in Paper mode.
6. Open Chat and ask the agent to search markets, inspect the portfolio, or place a paper trade.

Paper mode uses simulated fills and does not move funds.

### Editing a policy

Policies can be changed without revoking the agent. In Agent Setup, click **Edit Policy**, adjust the limits or Hyperliquid venue settings, then review and re-sign. The current policy stays active until the new signed policy is accepted by the backend. Once accepted, the new policy becomes active and the previous active policy is marked superseded.

Use **Re-sign Policy** when you only want to refresh the session key or extend the policy duration without changing the visible limits. Use **Revoke Policy** when you want to disable the agent and clear the local session.

### Polymarket live trading

Live mode is deliberately opt-in per agent. Complete Agent Setup in order:

1. Connect the main wallet that will sign the policy and fund the deposit wallet.
2. Create an agent, then import the private key of a separate wallet already onboarded with Polymarket.
3. Add that agent wallet's Polymarket relayer API key and matching API-key address.
4. Provision its canonical Polymarket deposit wallet through the relayer.
5. Add an OpenRouter API key.
6. Configure and sign the bounded trading policy.
7. Send pUSD from the connected main wallet to the provisioned deposit wallet.
8. Authorize trading; the relayer batches the required pUSD and outcome-token approvals.
9. Derive CLOB credentials and switch the agent to Live mode.

The signed policy's Polymarket order-size and budget limits remain hard ceilings for live CLOB orders.

### Hyperliquid live trading

Hyperliquid spot and perp trades use the same chat interface and the same signed policy model. To enable them:

1. In the policy editor, enable **Hyperliquid** under Trading Venues.
2. Set a Hyperliquid max order size, max leverage, max slippage, and optional comma-separated allowed coins. The max order size applies to spot order value and perp notional; max leverage caps chat-initiated leverage changes.
3. Re-sign the policy so Hyperliquid is included in `allowedVenues`.
4. Add the Hyperliquid API wallet address and secret key in Agent Setup. The app verifies that the secret key derives to the supplied API wallet address before storing it.
5. Deposit native USDC on Arbitrum to Hyperliquid from the connected main wallet.
6. To trade perps on non-unified Hyperliquid accounts, use **Fund Perps** in Agent Setup to move USDC from the Hyperliquid spot balance into the Hyperliquid perp account. If Hyperliquid reports unified account or portfolio margin mode, spot and perp collateral are already shared and no transfer is needed.
7. Switch the agent to Live mode when ready.

For spot, the chat agent buys and sells spot inventory against Hyperliquid USDC. For perps, the chat agent can update leverage within the signed policy ceiling, open longs with `BUY`, open shorts with `SELL`, and close/reduce positions with reduce-only `maxFraction` orders. Perp orders require available Hyperliquid collateral; Agent Setup shows whether the account uses separate spot/perp balances or unified collateral.

The Hyperliquid API wallet signs spot orders, perp orders, and perp leverage updates on behalf of the connected master account. It is not the funding wallet and cannot withdraw funds.

## Wallets and gas

The demo uses three wallet roles:

| Wallet | Purpose | Needs POL? |
| --- | --- | --- |
| Main browser wallet | Signs the policy and sends the initial pUSD funding transfer | **Yes, a small amount**, because the pUSD transfer is an ordinary Polygon transaction |
| Agent EOA | Signs CLOB and relayer requests; its development key is held by the backend | No |
| Polymarket deposit wallet | Holds pUSD and positions and acts as the CLOB funder/maker | No |
| Hyperliquid API wallet | Signs Hyperliquid spot/perp orders and perp leverage updates for the connected master account | No |

Policy signing is off-chain. Deposit-wallet provisioning, exchange approvals, and withdrawals are submitted through Polymarket's relayer, which pays gas. CLOB orders and Hyperliquid spot/perp orders are signed and posted to their APIs. The direct on-chain transactions initiated by the frontend are the initial pUSD transfer on Polygon and optional native USDC deposits to Hyperliquid on Arbitrum, so the connected wallet needs gas on the relevant chain.

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
| `POLYGON_RPC_URL` | public Polygon RPC | RPC used for balances and relayed wallet operations |
| `RELAYER_API_KEY` / `RELAYER_API_KEY_ADDRESS` | none | Optional server-wide relayer credentials; per-agent credentials can be stored in the UI |
| `POLY_BUILDER_*` | none | Alternative builder authorization for the relayer |
| `ADMIN_API_KEY` | none | Required by internal admin endpoints |
| `GEOBLOCK_ENABLED` | `true` | Enables country-code enforcement on live trading |
| `BLOCKED_COUNTRY_CODES` | `US,GB` | Comma-separated blocked country codes |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS origins |

Never commit a populated `.env` file, wallet private key, relayer credential, CLOB credential, Hyperliquid API wallet key, or OpenRouter key.

## How requests are authorized

The main wallet signs an EIP-712 policy containing the owner, agent, session key, expiry, revocation nonce, enabled venues, and trading/LLM limits. The browser stores the generated session key locally and signs each protected API request with a nonce and timestamp. The backend then:

1. Verifies the request signature and rejects replayed nonces.
2. Loads and re-verifies the stored owner-signed policy.
3. Parses the requested trade into structured intent.
4. Resolves current market data.
5. Runs the deterministic policy engine.
6. Simulates the trade or, when live mode and the signed policy allow it, signs and submits a Polymarket CLOB order or Hyperliquid spot/perp order.

The language model does not decide whether a trade is allowed; it proposes an intent that must pass the policy engine.

## Repository layout

```text
packages/
  backend/
    src/agent/       Chat tools and signer abstraction
    src/api/         Express routes and request middleware
    src/auth/        Policy and session verification
    src/clob/        Polymarket CLOB, relayer, and Hyperliquid integration
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

- Live trading requires Live mode on the agent and must pass the signed policy limits.
- `SIGNER_MODE=dev` is intentionally rejected when `NODE_ENV=production`.
- The development signer can import and decrypt agent private keys. It is unsuitable for a hosted service.
- Hyperliquid API wallet keys are stored encrypted in the local SQLite database for this demo.
- `SIGNER_MODE=kms` is not implemented yet.
- SQLite is intended for a local demo, not distributed deployment.
- Review the policy defaults, geoblocking, custody model, relayer permissions, Hyperliquid API wallet permissions, and exchange integrations before testing with live funds.

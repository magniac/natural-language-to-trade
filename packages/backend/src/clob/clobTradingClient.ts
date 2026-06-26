import { ClobClient, Side, SignatureTypeV2, Chain, getContractConfig } from '@polymarket/clob-client-v2';
import { ethers } from 'ethers';
import { getDb } from '../db/database';
import { getSigner } from '../agent/signerFactory';
import { encrypt, decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';
import type { NormalizedOrder, PostOrderResult, StoredOrder } from '../types/order';
import type { CLOBCredentials } from '../types/agent';
import { v4 as uuidv4 } from 'uuid';

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST ?? 'https://clob.polymarket.com';

type BookLevel = { price: string | number; size?: string | number };
type OrderBookLike = {
  bids?: BookLevel[];
  asks?: BookLevel[];
  tick_size?: string | number;
};

export interface Balances {
  usdc: number;
  positions: Record<string, number>;
}

export interface ClobTradingClientInterface {
  deriveCredentials(agentWalletId: string): Promise<void>;
  getOpenOrders(agentWalletId: string): Promise<StoredOrder[]>;
  getTopOfBookPrice(agentWalletId: string, tokenId: string, side: 'BUY' | 'SELL'): Promise<number | null>;
  getMarketTickSize(agentWalletId: string, tokenId: string): Promise<number>;
  getBalances(agentWalletId: string): Promise<Balances>;
  createSignedOrder(agentWalletId: string, order: NormalizedOrder): Promise<unknown>;
  postOrder(agentWalletId: string, signedOrder: unknown, orderType: string): Promise<PostOrderResult>;
  reconcileLiveFills(agentWalletId: string): Promise<void>;
  cancelOrder(agentWalletId: string, orderId: string): Promise<void>;
  cancelAll(agentWalletId: string): Promise<void>;
}

function getEncryptedCreds(agentWalletId: string): CLOBCredentials | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM clob_credentials WHERE agent_wallet_id = ? AND status = 'active'")
    .get(agentWalletId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    agentWalletId: row.agent_wallet_id as string,
    encryptedApiKey: row.encrypted_api_key as string,
    encryptedSecret: row.encrypted_secret as string,
    encryptedPassphrase: row.encrypted_passphrase as string,
    status: row.status as CLOBCredentials['status'],
    createdAt: new Date(row.created_at as number),
    rotatedAt: row.rotated_at ? new Date(row.rotated_at as number) : null,
  };
}

function validBookPrice(level: BookLevel): number | null {
  const price = parseFloat(String(level.price));
  const size = parseFloat(String(level.size ?? '1'));
  return Number.isFinite(price) && Number.isFinite(size) && price > 0 && price < 1 && size > 0
    ? price
    : null;
}

/**
 * Return the executable top of book for a taker order:
 * - BUY crosses the lowest ask
 * - SELL crosses the highest bid
 *
 * Polymarket's `/price?side=BUY` currently returns the bid for the token, not
 * the ask a buyer must pay. Reading the order book keeps us aligned with the
 * visible UI price and prevents default buy orders from resting one tick low.
 */
export function getExecutableTopOfBookPrice(book: OrderBookLike, side: 'BUY' | 'SELL'): number | null {
  const levels = side === 'BUY' ? book.asks : book.bids;
  const prices = (levels ?? []).map(validBookPrice).filter((p): p is number => p !== null);
  if (prices.length === 0) return null;
  return side === 'BUY' ? Math.min(...prices) : Math.max(...prices);
}

export function interpretPostOrderResponse(result: unknown): PostOrderResult {
  const body = result as {
    success?: boolean;
    orderID?: string;
    error?: string;
    errorMsg?: string;
    status?: string | number;
    makingAmount?: string;
    takingAmount?: string;
    tradeIDs?: string[];
    tradeIds?: string[];
  } | null;
  const errorMessage = typeof body?.error === 'string' && body.error
    ? body.error
    : typeof body?.errorMsg === 'string' && body.errorMsg
      ? body.errorMsg
      : null;
  const numericStatus = typeof body?.status === 'number' ? body.status : null;
  const clobOrderId = body?.orderID ?? null;

  if (body?.success === false || errorMessage || (numericStatus !== null && numericStatus >= 400)) {
    return {
      success: false,
      clobOrderId: null,
      errorMessage: errorMessage ?? `CLOB rejected order with status ${numericStatus}`,
      clobStatus: typeof body?.status === 'string' ? body.status : numericStatus !== null ? String(numericStatus) : null,
      raw: result,
    };
  }

  if (!clobOrderId) {
    return {
      success: false,
      clobOrderId: null,
      errorMessage: 'CLOB submission returned no orderID',
      clobStatus: typeof body?.status === 'string' ? body.status : numericStatus !== null ? String(numericStatus) : null,
      raw: result,
    };
  }

  return {
    success: true,
    clobOrderId,
    errorMessage: null,
    clobStatus: typeof body?.status === 'string' ? body.status : null,
    makingAmount: body?.makingAmount ?? null,
    takingAmount: body?.takingAmount ?? null,
    tradeIds: body?.tradeIDs ?? body?.tradeIds ?? [],
    raw: result,
  };
}

async function buildClobClient(agentWalletId: string): Promise<ClobClient> {
  const creds = getEncryptedCreds(agentWalletId);
  if (!creds) throw new Error(`No CLOB credentials found for agent wallet ${agentWalletId}. Run deriveCredentials first.`);

  const signer = getSigner();
  const eoaAddress = await signer.getAddress(agentWalletId);

  const signTyped = (domain: unknown, types: unknown, value: unknown) =>
    signer.signTypedData(agentWalletId, { domain, types, message: value });
  const ethSigner = {
    getAddress: async () => eoaAddress,
    signMessage: (msg: string | Uint8Array) => signer.signMessage(agentWalletId, msg),
    signTypedData: signTyped,
    _signTypedData: signTyped,
    provider: null,
  };

  const apiKey = decrypt(creds.encryptedApiKey);
  const secret = decrypt(creds.encryptedSecret);
  const passphrase = decrypt(creds.encryptedPassphrase);

  // The agent's funder is a relayer-provisioned Polymarket deposit wallet. Deposit wallets are
  // smart contracts that validate orders via EIP-1271 (ERC-7739 nested signatures), so orders must
  // use POLY_1271 — the CLOB rejects POLY_PROXY for a deposit-wallet maker ("use the deposit wallet flow").
  // With POLY_1271 the SDK sets both maker and signer to the funder and the EOA key produces the nested sig.
  const db = getDb();
  const agentRow = db.prepare('SELECT proxy_wallet_address FROM agent_wallets WHERE id = ?').get(agentWalletId) as { proxy_wallet_address: string | null } | undefined;
  const proxyWalletAddress = agentRow?.proxy_wallet_address ?? null;

  const signatureType = proxyWalletAddress ? SignatureTypeV2.POLY_1271 : SignatureTypeV2.EOA;
  const funderAddress = proxyWalletAddress ?? eoaAddress;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: ethSigner as any, creds: { key: apiKey, secret, passphrase }, signatureType, funderAddress });
}

export class ClobTradingClientImpl implements ClobTradingClientInterface {
  async deriveCredentials(agentWalletId: string): Promise<void> {
    const signer = getSigner();
    const address = await signer.getAddress(agentWalletId);

    const signTyped = (domain: unknown, types: unknown, value: unknown) =>
      signer.signTypedData(agentWalletId, { domain, types, message: value });

    const ethSigner = {
      getAddress: async () => address,
      signMessage: (msg: string | Uint8Array) => signer.signMessage(agentWalletId, msg),
      signTypedData: signTyped,
      _signTypedData: signTyped, // ethers v5 name used by @polymarket/clob-client
      provider: null,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tempClient = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: ethSigner as any, signatureType: SignatureTypeV2.EOA, funderAddress: address });

    const apiCreds = await tempClient.createOrDeriveApiKey();

    const db = getDb();
    const existingId = (db.prepare("SELECT id FROM clob_credentials WHERE agent_wallet_id = ? AND status = 'active'").get(agentWalletId) as { id: string } | undefined)?.id;

    if (existingId) {
      db.prepare("UPDATE clob_credentials SET status = 'rotated', rotated_at = ? WHERE id = ?")
        .run(Date.now(), existingId);
    }

    db.prepare(`
      INSERT INTO clob_credentials (id, agent_wallet_id, encrypted_api_key, encrypted_secret, encrypted_passphrase, status, created_at, rotated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)
    `).run(
      uuidv4(),
      agentWalletId,
      encrypt(apiCreds.key),
      encrypt(apiCreds.secret),
      encrypt(apiCreds.passphrase),
      Date.now(),
    );

    logger.info({ agentWalletId, address }, 'CLOB credentials derived and stored');
  }

  async getOpenOrders(agentWalletId: string): Promise<StoredOrder[]> {
    const client = await buildClobClient(agentWalletId);
    const orders = await client.getOpenOrders();
    logger.debug({ agentWalletId, count: orders.length }, 'Fetched open orders from CLOB');
    // Return our internal format — caller reconciles with DB
    return [];
  }

  /** Live executable top-of-book price for a side: best ASK for BUY, best BID for SELL. Null if unavailable. */
  async getTopOfBookPrice(agentWalletId: string, tokenId: string, side: 'BUY' | 'SELL'): Promise<number | null> {
    const client = await buildClobClient(agentWalletId);
    try {
      const book = await client.getOrderBook(tokenId) as OrderBookLike | null;
      if (book?.tick_size) {
        const tickSize = parseFloat(String(book.tick_size));
        if (Number.isFinite(tickSize) && tickSize > 0) {
          getDb().prepare('UPDATE market_tokens SET tick_size = ?, updated_at = ? WHERE token_id = ?')
            .run(tickSize, Date.now(), tokenId);
        }
      }
      if (book) {
        const price = getExecutableTopOfBookPrice(book, side);
        if (price != null) return price;
      }
    } catch (err) {
      logger.warn({ agentWalletId, tokenId, side, err }, 'CLOB order-book fetch failed — falling back to price endpoint');
    }

    // Fallback only. `/price` is maker-side by token side: BUY returns bid and
    // SELL returns ask, so invert it to get the executable taker quote.
    const priceSide = side === 'BUY' ? Side.SELL : Side.BUY;
    const resp = await client.getPrice(tokenId, priceSide) as { price?: string } | string | null;
    const raw = typeof resp === 'string' ? resp : resp?.price;
    const px = parseFloat(String(raw ?? ''));
    return Number.isFinite(px) && px > 0 ? px : null;
  }

  /** Fetch and cache the CLOB's authoritative tick size before an order is built. */
  async getMarketTickSize(agentWalletId: string, tokenId: string): Promise<number> {
    const client = await buildClobClient(agentWalletId);
    const rawTickSize = await client.getTickSize(tokenId);
    const tickSize = parseFloat(String(rawTickSize));
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      throw new Error(`Invalid tick size returned for token ${tokenId}: ${rawTickSize}`);
    }
    getDb().prepare('UPDATE market_tokens SET tick_size = ?, updated_at = ? WHERE token_id = ?')
      .run(tickSize, Date.now(), tokenId);
    return tickSize;
  }

  async getBalances(agentWalletId: string): Promise<Balances> {
    const client = await buildClobClient(agentWalletId);
    const balance = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' } as never);
    return { usdc: parseFloat(String(balance || 0)), positions: {} };
  }

  async createSignedOrder(agentWalletId: string, order: NormalizedOrder): Promise<unknown> {
    // Order size is bounded by the signed policy (maxOrderSizeUSDC), enforced in the policy engine.
    const client = await buildClobClient(agentWalletId);
    const side: Side = order.side === 'BUY' ? Side.BUY : Side.SELL;

    const db = getDb();
    const tokenRow = db.prepare('SELECT tick_size, neg_risk FROM market_tokens WHERE token_id = ?').get(order.tokenId) as { tick_size: number; neg_risk: number } | undefined;
    const negRisk = (tokenRow?.neg_risk ?? 0) === 1;
    let tickSize = String(tokenRow?.tick_size ?? 0.01) as '0.1' | '0.01' | '0.001' | '0.0001';
    try {
      // Gamma ingestion does not expose minimum_tick_size and historically stored
      // 0.01 for every market. Ask the CLOB at signing time so finer quotes such as
      // 0.194 remain valid instead of being rounded down to 0.19.
      tickSize = await client.getTickSize(order.tokenId);
      db.prepare('UPDATE market_tokens SET tick_size = ?, updated_at = ? WHERE token_id = ?')
        .run(parseFloat(tickSize), Date.now(), order.tokenId);
    } catch (err) {
      logger.warn({ agentWalletId, tokenId: order.tokenId, err }, 'Live tick-size fetch failed — using cached tick size');
    }

    const signedOrder = order.side === 'BUY' && order.amountUsdc !== undefined
      ? await client.createMarketOrder({
        tokenID: order.tokenId,
        amount: order.amountUsdc,
        price: order.price,
        side,
        orderType: order.executionOrderType ?? 'FOK',
      } as never, { tickSize, negRisk })
      : await client.createOrder({
        tokenID: order.tokenId,
        price: order.price,
        side,
        size: order.size,
      }, { tickSize, negRisk });

    logger.info({
      agentWalletId,
      tokenId: order.tokenId,
      side: order.side,
      amountUsdc: order.amountUsdc,
      orderType: order.executionOrderType ?? order.orderType,
      signedOrder,
    }, 'Signed CLOB order created');
    return signedOrder;
  }

  async postOrder(agentWalletId: string, signedOrder: unknown, orderType: string): Promise<PostOrderResult> {
    const client = await buildClobClient(agentWalletId);
    try {
      const result = await client.postOrder(signedOrder as never, orderType as never);
      const interpreted = interpretPostOrderResponse(result);
      if (!interpreted.success) {
        logger.error({ agentWalletId, result }, 'CLOB order post rejected');
        return interpreted;
      }

      logger.info({ agentWalletId, result }, 'CLOB order posted');
      return interpreted;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown CLOB error';
      logger.error({ agentWalletId, err }, 'CLOB order post failed');
      return { success: false, clobOrderId: null, errorMessage: msg };
    }
  }

  /**
   * Pull fill status for this agent's open live orders from the CLOB and record fills locally,
   * so the portfolio (which reads the `fills` table) reflects executed live trades. Idempotent:
   * one synthetic fill row per CLOB order, keyed by clob_order_id, updated as more size matches.
   */
  async reconcileLiveFills(agentWalletId: string): Promise<void> {
    const db = getDb();
    // Only live orders carry a clob_order_id; paper orders are excluded, so this is a no-op for them.
    const openOrders = db.prepare(
      "SELECT id, clob_order_id, side, price, size FROM orders WHERE agent_wallet_id = ? AND clob_order_id IS NOT NULL AND status IN ('open','pending','partially_filled')"
    ).all(agentWalletId) as Array<{ id: string; clob_order_id: string; side: string; price: number; size: number }>;
    if (openOrders.length === 0) return;

    const client = await buildClobClient(agentWalletId);
    for (const o of openOrders) {
      try {
        const remote = await client.getOrder(o.clob_order_id) as { size_matched?: string | number; original_size?: string | number; price?: string | number; status?: string } | null;
        if (!remote) continue;
        const matched = parseFloat(String(remote.size_matched ?? 0));
        const fillPrice = parseFloat(String(remote.price ?? o.price)) || o.price;
        if (matched > 0) {
          db.prepare(`
            INSERT INTO fills (id, order_id, clob_trade_id, price, size, side, fee, created_at, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(clob_trade_id) DO UPDATE SET size = excluded.size, price = excluded.price, raw_json = excluded.raw_json
          `).run(uuidv4(), o.id, o.clob_order_id, fillPrice, matched, o.side, Date.now(), JSON.stringify(remote));
        }
        const filledFully = matched >= o.size - 1e-9;
        const newStatus = filledFully ? 'filled' : matched > 0 ? 'partially_filled' : 'open';
        db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, Date.now(), o.id);
      } catch (err) {
        logger.warn({ agentWalletId, clobOrderId: o.clob_order_id, err }, 'Fill reconcile failed for order');
      }
    }
  }

  async cancelOrder(agentWalletId: string, orderId: string): Promise<void> {
    const client = await buildClobClient(agentWalletId);
    await client.cancelOrder({ orderID: orderId });
    logger.info({ agentWalletId, orderId }, 'CLOB order cancelled');
  }

  async cancelAll(agentWalletId: string): Promise<void> {
    const client = await buildClobClient(agentWalletId);
    await client.cancelAll();
    logger.info({ agentWalletId }, 'All CLOB orders cancelled');
  }
}

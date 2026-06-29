import { HttpTransport, InfoClient, ExchangeClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { getDb } from '../db/database';
import { getHlCreds } from '../utils/hyperliquidKeyStore';
import { logger } from '../utils/logger';

// Mainnet transport (default). Reads share one InfoClient; writes build a per-agent ExchangeClient
// from the stored API-wallet key (the signer). The master account (the user's main wallet) holds funds.
const transport = new HttpTransport();
const info = new InfoClient({ transport });

export interface HlSpotState {
  usdc: number;
  balances: { coin: string; total: number; hold: number }[];
}

export interface HlOrderResult {
  success: boolean;
  oid: number | null;
  filledSize: number;
  avgPrice: number | null;
  resting: boolean;
  error: string | null;
}

export interface HlSpotOrderPreview {
  coin: string;
  pair: string;
  side: 'BUY' | 'SELL';
  topPrice: number;
  limitPrice: number;
  size: number;
  notionalUsdc: number;
  availableBase: number | null;
}

interface SpotPair {
  coin: string;       // base token name, e.g. "HYPE"
  pairName: string;   // identifier for l2Book / mids, e.g. "HYPE/USDC" or "@107"
  assetId: number;    // 10000 + universe index, used as order `a`
  szDecimals: number; // size precision for the base token
}

/** Master account address (fund holder) for an agent = the user's connected main wallet. */
function getMasterAddress(agentWalletId: string): string {
  const db = getDb();
  const row = db.prepare(
    'SELECT u.wallet_address AS addr FROM agent_wallets aw JOIN users u ON u.id = aw.user_id WHERE aw.id = ?'
  ).get(agentWalletId) as { addr: string } | undefined;
  if (!row?.addr) throw new Error('No master account address for agent');
  return row.addr;
}

// ── Spot metadata (cached briefly — the universe changes rarely) ───────────────
let metaCache: { at: number; tokens: { name: string; index: number; szDecimals: number }[]; universe: { name: string; tokens: [number, number]; index: number }[] } | null = null;
async function getSpotMeta() {
  if (metaCache && Date.now() - metaCache.at < 60_000) return metaCache;
  const meta = await info.spotMeta();
  metaCache = { at: Date.now(), tokens: meta.tokens, universe: meta.universe };
  return metaCache;
}

async function resolveSpotPair(coin: string): Promise<SpotPair | null> {
  const meta = await getSpotMeta();
  const token = meta.tokens.find(t => t.name.toUpperCase() === coin.toUpperCase());
  const usdc = meta.tokens.find(t => t.name === 'USDC');
  if (!token || !usdc) return null;
  const pair = meta.universe.find(u => u.tokens[0] === token.index && u.tokens[1] === usdc.index);
  if (!pair) return null;
  return { coin: token.name, pairName: pair.name, assetId: 10000 + pair.index, szDecimals: token.szDecimals };
}

// ── Hyperliquid number formatting ──────────────────────────────────────────────
// Sizes: rounded to the token's szDecimals. Prices (spot): ≤5 significant figures AND
// ≤ (8 - szDecimals) decimal places. Strip trailing zeros — HL rejects them in signed actions.
function fmtNum(n: number): string {
  return String(Number(n));
}
function roundSize(size: number, szDecimals: number): string {
  // Floor so we never spend more than requested (and never exceed the order cap after rounding).
  const f = 10 ** szDecimals;
  return fmtNum(Math.floor(size * f) / f);
}
function roundPrice(px: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 8 - szDecimals);
  const sig = Number(px.toPrecision(5));
  return fmtNum(Number(sig.toFixed(maxDecimals)));
}

interface BuiltSpotOrder {
  pair: SpotPair;
  isBuy: boolean;
  top: number;
  price: string;
  size: string;
  availableBase: number | null;
}

export class HyperliquidClient {
  /** Master account's spot balances (USDC + tokens). */
  async getSpotState(agentWalletId: string): Promise<HlSpotState> {
    const master = getMasterAddress(agentWalletId);
    const state = await info.spotClearinghouseState({ user: master as `0x${string}` });
    const balances = state.balances.map(b => ({
      coin: 'coin' in b ? b.coin : '',
      total: parseFloat(b.total),
      hold: parseFloat(b.hold),
    }));
    const usdc = balances.find(b => b.coin === 'USDC')?.total ?? 0;
    return { usdc, balances: balances.filter(b => b.total > 0) };
  }

  /** Search the spot universe for tokens matching a query, with current mid prices. */
  async searchSpotMarkets(query: string): Promise<{ coin: string; pair: string; price: number | null }[]> {
    const meta = await getSpotMeta();
    const q = query.trim().toUpperCase();
    const mids = await info.allMids().catch(() => ({} as Record<string, string>));
    const usdc = meta.tokens.find(t => t.name === 'USDC');
    const out: { coin: string; pair: string; price: number | null }[] = [];
    for (const token of meta.tokens) {
      if (token.name === 'USDC') continue;
      if (q && !token.name.toUpperCase().includes(q)) continue;
      const pair = usdc && meta.universe.find(u => u.tokens[0] === token.index && u.tokens[1] === usdc.index);
      if (!pair) continue;
      const mid = mids[pair.name];
      out.push({ coin: token.name, pair: pair.name, price: mid ? parseFloat(mid) : null });
      if (out.length >= 15) break;
    }
    return out;
  }

  private async buildSpotOrder(
    agentWalletId: string,
    params: { coin: string; side: 'BUY' | 'SELL'; usdcAmount?: number; fraction?: number },
  ): Promise<BuiltSpotOrder> {
    const pair = await resolveSpotPair(params.coin);
    if (!pair) throw new Error(`Unknown Hyperliquid spot coin: ${params.coin}`);

    const isBuy = params.side === 'BUY';
    const book = await info.l2Book({ coin: pair.pairName });
    const bids = book?.levels?.[0] ?? [];
    const asks = book?.levels?.[1] ?? [];
    const topStr = isBuy ? asks[0]?.px : bids[0]?.px;
    if (!topStr) throw new Error(`No Hyperliquid liquidity for ${pair.coin}`);
    const top = parseFloat(topStr);

    // Marketable IOC: cross the spread with a small slippage cushion (fills, doesn't rest).
    const slip = 0.01;
    const price = roundPrice(isBuy ? top * (1 + slip) : top * (1 - slip), pair.szDecimals);

    let sizeNum: number;
    let availableBase: number | null = null;
    if (!isBuy) {
      const state = await this.getSpotState(agentWalletId);
      const balance = state.balances.find(b => b.coin.toUpperCase() === pair.coin.toUpperCase());
      availableBase = Math.max(0, (balance?.total ?? 0) - (balance?.hold ?? 0));

      if (params.fraction !== undefined && params.usdcAmount === undefined) {
        if (!(params.fraction > 0 && params.fraction <= 1)) {
          throw new Error('Sell fraction must be greater than 0 and at most 1.0.');
        }
        sizeNum = availableBase * params.fraction;
      } else {
        const usd = params.usdcAmount ?? 0;
        sizeNum = usd / top;
      }

      if (sizeNum > availableBase) {
        throw new Error(`Insufficient ${pair.coin} to sell: requested ${sizeNum.toFixed(pair.szDecimals)}, available ${availableBase.toFixed(pair.szDecimals)}.`);
      }
    } else {
      const usd = params.usdcAmount ?? 0;
      sizeNum = usd / top;
    }

    const size = roundSize(sizeNum, pair.szDecimals);
    if (Number(size) <= 0) {
      throw new Error(`Computed size is zero — ${pair.coin} trades in steps of ${1 / (10 ** pair.szDecimals)} (~$${(top / (10 ** pair.szDecimals)).toFixed(2)}); increase the amount.`);
    }

    return { pair, isBuy, top, price, size, availableBase };
  }

  async previewSpotOrder(
    agentWalletId: string,
    params: { coin: string; side: 'BUY' | 'SELL'; usdcAmount?: number; fraction?: number },
  ): Promise<HlSpotOrderPreview> {
    const built = await this.buildSpotOrder(agentWalletId, params);
    const size = Number(built.size);
    const limitPrice = Number(built.price);
    return {
      coin: built.pair.coin,
      pair: built.pair.pairName,
      side: params.side,
      topPrice: built.top,
      limitPrice,
      size,
      notionalUsdc: size * built.top,
      availableBase: built.availableBase,
    };
  }

  /** Place a marketable spot order (IOC) signed by the API wallet, on behalf of the master account. */
  async placeSpotOrder(
    agentWalletId: string,
    params: { coin: string; side: 'BUY' | 'SELL'; usdcAmount?: number; fraction?: number },
  ): Promise<HlOrderResult & { coin: string; pair: string; price: number; size: number }> {
    const creds = getHlCreds(agentWalletId);
    if (!creds) throw new Error('No Hyperliquid API wallet configured for this agent.');

    const { pair, isBuy, price, size } = await this.buildSpotOrder(agentWalletId, params);

    const account = privateKeyToAccount(creds.privateKey as `0x${string}`);
    const exchange = new ExchangeClient({ transport, wallet: account });

    const resp = await exchange.order({
      orders: [{ a: pair.assetId, b: isBuy, p: price, s: size, r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });

    const result = this.parseOrderResponse(resp);
    logger.info({ agentWalletId, coin: pair.coin, side: params.side, price, size, result }, 'Hyperliquid spot order placed');
    return { ...result, coin: pair.coin, pair: pair.pairName, price: Number(price), size: Number(size) };
  }

  private parseOrderResponse(resp: unknown): HlOrderResult {
    try {
      const statuses = (resp as { response?: { data?: { statuses?: unknown[] } } }).response?.data?.statuses ?? [];
      const st = statuses[0] as { error?: string; filled?: { oid: number; totalSz: string; avgPx: string }; resting?: { oid: number } } | undefined;
      if (!st) return { success: false, oid: null, filledSize: 0, avgPrice: null, resting: false, error: 'No order status returned' };
      if (st.error) return { success: false, oid: null, filledSize: 0, avgPrice: null, resting: false, error: st.error };
      if (st.filled) return { success: true, oid: st.filled.oid, filledSize: parseFloat(st.filled.totalSz), avgPrice: parseFloat(st.filled.avgPx), resting: false, error: null };
      if (st.resting) return { success: true, oid: st.resting.oid, filledSize: 0, avgPrice: null, resting: true, error: null };
      return { success: false, oid: null, filledSize: 0, avgPrice: null, resting: false, error: 'Unknown order status' };
    } catch (err) {
      return { success: false, oid: null, filledSize: 0, avgPrice: null, resting: false, error: err instanceof Error ? err.message : 'Parse error' };
    }
  }
}

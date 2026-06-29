import type * as HyperliquidSdk from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { getDb } from '../db/database';
import { getHlCreds } from '../utils/hyperliquidKeyStore';
import { logger } from '../utils/logger';

// Mainnet transport (default). Reads share one InfoClient; writes build a per-agent ExchangeClient
// from the stored API-wallet key (the signer). The master account (the user's main wallet) holds funds.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<typeof HyperliquidSdk>;
let sdkPromise: Promise<typeof HyperliquidSdk> | null = null;
let clientsPromise: Promise<{
  transport: InstanceType<typeof HyperliquidSdk.HttpTransport>;
  info: InstanceType<typeof HyperliquidSdk.InfoClient>;
}> | null = null;

function getHlSdk(): Promise<typeof HyperliquidSdk> {
  sdkPromise ??= importEsm('@nktkas/hyperliquid');
  return sdkPromise;
}

async function getHlClients() {
  clientsPromise ??= getHlSdk().then(({ HttpTransport, InfoClient }) => {
    const transport = new HttpTransport();
    return { transport, info: new InfoClient({ transport }) };
  });
  return clientsPromise;
}

export interface HlSpotState {
  usdc: number;
  balances: { coin: string; total: number; hold: number }[];
  accountAbstraction: HlAccountAbstraction | null;
  portfolioMarginEnabled: boolean;
}

export type HlAccountAbstraction = 'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'default' | 'dexAbstraction';

export interface HlPerpPosition {
  coin: string;
  szi: number;
  side: 'LONG' | 'SHORT';
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  marginUsed: number;
  leverage: number;
  liquidationPx: number | null;
}

export interface HlPerpState {
  accountValue: number;
  withdrawable: number;
  totalNtlPos: number;
  totalMarginUsed: number;
  positions: HlPerpPosition[];
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
  marketType: 'spot';
  topPrice: number;
  limitPrice: number;
  size: number;
  notionalUsdc: number;
  availableBase: number | null;
}

export interface HlPerpOrderPreview {
  coin: string;
  side: 'BUY' | 'SELL';
  marketType: 'perp';
  topPrice: number;
  limitPrice: number;
  size: number;
  notionalUsdc: number;
  reduceOnly: boolean;
  positionSize: number;
  availableMarginUsdc: number;
}

export interface HlLeverageResult {
  success: boolean;
  coin: string;
  leverage: number;
  isCross: boolean;
  maxLeverage: number;
  error: string | null;
}

interface SpotPair {
  coin: string;       // base token name, e.g. "HYPE"
  pairName: string;   // identifier for l2Book / mids, e.g. "HYPE/USDC" or "@107"
  assetId: number;    // 10000 + universe index, used as order `a`
  szDecimals: number; // size precision for the base token
}

interface PerpAsset {
  coin: string;
  assetId: number;    // universe index, used as order `a`
  szDecimals: number;
  maxLeverage: number;
  isDelisted: boolean;
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
  const { info } = await getHlClients();
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

// ── Perp metadata (cached briefly — the universe changes rarely) ──────────────
let perpMetaCache: { at: number; universe: PerpAsset[] } | null = null;
async function getPerpMeta() {
  if (perpMetaCache && Date.now() - perpMetaCache.at < 60_000) return perpMetaCache;
  const { info } = await getHlClients();
  const meta = await info.meta();
  perpMetaCache = {
    at: Date.now(),
    universe: meta.universe.map((u, index) => ({
      coin: u.name,
      assetId: index,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      isDelisted: u.isDelisted === true,
    })),
  };
  return perpMetaCache;
}

async function resolvePerpAsset(coin: string): Promise<PerpAsset | null> {
  const meta = await getPerpMeta();
  const asset = meta.universe.find(u => u.coin.toUpperCase() === coin.toUpperCase());
  if (!asset || asset.isDelisted) return null;
  return asset;
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
function roundHlPrice(px: number, szDecimals: number, maxDecimalsBase: 6 | 8): string {
  const maxDecimals = Math.max(0, maxDecimalsBase - szDecimals);
  const sig = Number(px.toPrecision(5));
  return fmtNum(Number(sig.toFixed(maxDecimals)));
}
function roundSpotPrice(px: number, szDecimals: number): string {
  return roundHlPrice(px, szDecimals, 8);
}
function roundPerpPrice(px: number, szDecimals: number): string {
  return roundHlPrice(px, szDecimals, 6);
}
function symbolMatchScore(symbol: string, query: string): number {
  if (!query) return 0;
  const upper = symbol.toUpperCase();
  if (upper === query) return 3;
  if (upper.startsWith(query)) return 2;
  return upper.includes(query) ? 1 : 0;
}

interface BuiltSpotOrder {
  pair: SpotPair;
  isBuy: boolean;
  top: number;
  price: string;
  size: string;
  availableBase: number | null;
}

interface BuiltPerpOrder {
  asset: PerpAsset;
  isBuy: boolean;
  top: number;
  price: string;
  size: string;
  reduceOnly: boolean;
  positionSize: number;
  availableMarginUsdc: number;
}

function usesUnifiedCollateral(state: Pick<HlSpotState, 'accountAbstraction' | 'portfolioMarginEnabled'>): boolean {
  return state.accountAbstraction === 'unifiedAccount' || state.accountAbstraction === 'portfolioMargin' || state.portfolioMarginEnabled;
}

export class HyperliquidClient {
  /** Master account's spot balances (USDC + tokens). */
  async getSpotState(agentWalletId: string): Promise<HlSpotState> {
    const master = getMasterAddress(agentWalletId);
    const { info } = await getHlClients();
    const user = master as `0x${string}`;
    const [state, accountAbstraction] = await Promise.all([
      info.spotClearinghouseState({ user }),
      info.userAbstraction({ user }).catch(err => {
        logger.warn({ agentWalletId, err }, 'hyperliquid user abstraction fetch failed');
        return null;
      }),
    ]);
    const balances = state.balances.map(b => ({
      coin: 'coin' in b ? b.coin : '',
      total: parseFloat(b.total),
      hold: parseFloat(b.hold),
    }));
    const usdc = balances.find(b => b.coin === 'USDC')?.total ?? 0;
    return {
      usdc,
      balances: balances.filter(b => b.total > 0),
      accountAbstraction,
      portfolioMarginEnabled: state.portfolioMarginEnabled === true,
    };
  }

  /** Master account's perp margin state and open perp positions. */
  async getPerpState(agentWalletId: string): Promise<HlPerpState> {
    const master = getMasterAddress(agentWalletId);
    const { info } = await getHlClients();
    const state = await info.clearinghouseState({ user: master as `0x${string}` });
    const positions = state.assetPositions
      .map(p => {
        const pos = p.position;
        const szi = parseFloat(pos.szi);
        return {
          coin: pos.coin,
          szi,
          side: szi >= 0 ? 'LONG' as const : 'SHORT' as const,
          entryPx: parseFloat(pos.entryPx),
          positionValue: parseFloat(pos.positionValue),
          unrealizedPnl: parseFloat(pos.unrealizedPnl),
          marginUsed: parseFloat(pos.marginUsed),
          leverage: pos.leverage.value,
          liquidationPx: pos.liquidationPx == null ? null : parseFloat(pos.liquidationPx),
        };
      })
      .filter(p => Math.abs(p.szi) > 0);
    return {
      accountValue: parseFloat(state.marginSummary.accountValue),
      withdrawable: parseFloat(state.withdrawable),
      totalNtlPos: parseFloat(state.marginSummary.totalNtlPos),
      totalMarginUsed: parseFloat(state.marginSummary.totalMarginUsed),
      positions,
    };
  }

  /** Search the spot universe for tokens matching a query, with current mid prices. */
  async searchSpotMarkets(query: string): Promise<{ coin: string; pair: string; price: number | null }[]> {
    const meta = await getSpotMeta();
    const q = query.trim().toUpperCase();
    const { info } = await getHlClients();
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
    }
    return out
      .sort((a, b) => symbolMatchScore(b.coin, q) - symbolMatchScore(a.coin, q) || (b.price ?? 0) - (a.price ?? 0))
      .slice(0, 15);
  }

  /** Search the perp universe for assets matching a query, with current mid prices. */
  async searchPerpMarkets(query: string): Promise<{ coin: string; pair: string; price: number | null; maxLeverage: number }[]> {
    const meta = await getPerpMeta();
    const q = query.trim().toUpperCase();
    const { info } = await getHlClients();
    const mids = await info.allMids().catch(() => ({} as Record<string, string>));
    const out: { coin: string; pair: string; price: number | null; maxLeverage: number }[] = [];
    for (const asset of meta.universe) {
      if (asset.isDelisted) continue;
      if (q && !asset.coin.toUpperCase().includes(q)) continue;
      const mid = mids[asset.coin];
      out.push({ coin: asset.coin, pair: `${asset.coin}-PERP`, price: mid ? parseFloat(mid) : null, maxLeverage: asset.maxLeverage });
    }
    return out
      .sort((a, b) => symbolMatchScore(b.coin, q) - symbolMatchScore(a.coin, q) || (b.price ?? 0) - (a.price ?? 0))
      .slice(0, 25);
  }

  async getPerpAssetInfo(coin: string): Promise<{ coin: string; assetId: number; maxLeverage: number } | null> {
    const asset = await resolvePerpAsset(coin);
    return asset ? { coin: asset.coin, assetId: asset.assetId, maxLeverage: asset.maxLeverage } : null;
  }

  private async buildSpotOrder(
    agentWalletId: string,
    params: { coin: string; side: 'BUY' | 'SELL'; usdcAmount?: number; fraction?: number },
  ): Promise<BuiltSpotOrder> {
    const pair = await resolveSpotPair(params.coin);
    if (!pair) throw new Error(`Unknown Hyperliquid spot coin: ${params.coin}`);

    const isBuy = params.side === 'BUY';
    const { info } = await getHlClients();
    const book = await info.l2Book({ coin: pair.pairName });
    const bids = book?.levels?.[0] ?? [];
    const asks = book?.levels?.[1] ?? [];
    const topStr = isBuy ? asks[0]?.px : bids[0]?.px;
    if (!topStr) throw new Error(`No Hyperliquid liquidity for ${pair.coin}`);
    const top = parseFloat(topStr);

    // Marketable IOC: cross the spread with a small slippage cushion (fills, doesn't rest).
    const slip = 0.01;
    const price = roundSpotPrice(isBuy ? top * (1 + slip) : top * (1 - slip), pair.szDecimals);

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

  private async buildPerpOrder(
    agentWalletId: string,
    params: { coin: string; side: 'BUY' | 'SELL'; usdcAmount?: number; fraction?: number; reduceOnly?: boolean },
  ): Promise<BuiltPerpOrder> {
    const asset = await resolvePerpAsset(params.coin);
    if (!asset) throw new Error(`Unknown Hyperliquid perp coin: ${params.coin}`);

    const isBuy = params.side === 'BUY';
    const { info } = await getHlClients();
    const book = await info.l2Book({ coin: asset.coin });
    const bids = book?.levels?.[0] ?? [];
    const asks = book?.levels?.[1] ?? [];
    const topStr = isBuy ? asks[0]?.px : bids[0]?.px;
    if (!topStr) throw new Error(`No Hyperliquid perp liquidity for ${asset.coin}`);
    const top = parseFloat(topStr);

    const slip = 0.01;
    const price = roundPerpPrice(isBuy ? top * (1 + slip) : top * (1 - slip), asset.szDecimals);

    const state = await this.getPerpState(agentWalletId);
    const existing = state.positions.find(p => p.coin.toUpperCase() === asset.coin.toUpperCase());
    const positionSize = existing?.szi ?? 0;

    let reduceOnly = params.reduceOnly === true;
    let sizeNum: number;
    if (params.fraction !== undefined && params.usdcAmount === undefined) {
      if (!(params.fraction > 0 && params.fraction <= 1)) {
        throw new Error('Perp close fraction must be greater than 0 and at most 1.0.');
      }
      const closable = isBuy ? Math.max(0, -positionSize) : Math.max(0, positionSize);
      if (closable <= 0) {
        throw new Error(`No ${asset.coin} ${isBuy ? 'short' : 'long'} perp position to reduce.`);
      }
      sizeNum = closable * params.fraction;
      reduceOnly = true;
    } else {
      const usd = params.usdcAmount ?? 0;
      if (!(usd > 0)) throw new Error('Amount not specified. Ask how much USDC notional to trade.');
      sizeNum = usd / top;

      if (reduceOnly) {
        const closable = isBuy ? Math.max(0, -positionSize) : Math.max(0, positionSize);
        if (closable <= 0) {
          throw new Error(`No ${asset.coin} ${isBuy ? 'short' : 'long'} perp position to reduce.`);
        }
        if (sizeNum > closable) {
          throw new Error(`Requested reduce-only size ${sizeNum.toFixed(asset.szDecimals)} exceeds current ${asset.coin} position ${closable.toFixed(asset.szDecimals)}.`);
        }
      }
    }

    const size = roundSize(sizeNum, asset.szDecimals);
    if (Number(size) <= 0) {
      throw new Error(`Computed size is zero — ${asset.coin} perps trade in steps of ${1 / (10 ** asset.szDecimals)} (~$${(top / (10 ** asset.szDecimals)).toFixed(2)}); increase the amount.`);
    }

    let availableMarginUsdc = state.withdrawable;
    if (!reduceOnly) {
      const spotState = await this.getSpotState(agentWalletId).catch(err => {
        logger.warn({ agentWalletId, coin: asset.coin, err }, 'hyperliquid spot balance fetch failed during perp preview');
        return null;
      });
      if (spotState && usesUnifiedCollateral(spotState)) {
        const usdc = spotState.balances.find(b => b.coin === 'USDC');
        const availableSpotUsdc = Math.max(0, (usdc?.total ?? spotState.usdc) - (usdc?.hold ?? 0));
        availableMarginUsdc = Math.max(availableMarginUsdc, availableSpotUsdc);
      }
    }

    return { asset, isBuy, top, price, size, reduceOnly, positionSize, availableMarginUsdc };
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
      marketType: 'spot',
      topPrice: built.top,
      limitPrice,
      size,
      notionalUsdc: size * built.top,
      availableBase: built.availableBase,
    };
  }

  async previewPerpOrder(
    agentWalletId: string,
    params: { coin: string; side: 'BUY' | 'SELL'; usdcAmount?: number; fraction?: number; reduceOnly?: boolean },
  ): Promise<HlPerpOrderPreview> {
    const built = await this.buildPerpOrder(agentWalletId, params);
    const size = Number(built.size);
    const limitPrice = Number(built.price);
    return {
      coin: built.asset.coin,
      side: params.side,
      marketType: 'perp',
      topPrice: built.top,
      limitPrice,
      size,
      notionalUsdc: size * built.top,
      reduceOnly: built.reduceOnly,
      positionSize: built.positionSize,
      availableMarginUsdc: built.availableMarginUsdc,
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
    const { transport } = await getHlClients();
    const { ExchangeClient } = await getHlSdk();
    const exchange = new ExchangeClient({ transport, wallet: account });

    const resp = await exchange.order({
      orders: [{ a: pair.assetId, b: isBuy, p: price, s: size, r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });

    const result = this.parseOrderResponse(resp);
    logger.info({ agentWalletId, coin: pair.coin, side: params.side, price, size, result }, 'Hyperliquid spot order placed');
    return { ...result, coin: pair.coin, pair: pair.pairName, price: Number(price), size: Number(size) };
  }

  /** Place a marketable perp order (IOC) signed by the API wallet, on behalf of the master account. */
  async placePerpOrder(
    agentWalletId: string,
    params: { coin: string; side: 'BUY' | 'SELL'; usdcAmount?: number; fraction?: number; reduceOnly?: boolean },
  ): Promise<HlOrderResult & { coin: string; pair: string; price: number; size: number; reduceOnly: boolean; positionSize: number }> {
    const creds = getHlCreds(agentWalletId);
    if (!creds) throw new Error('No Hyperliquid API wallet configured for this agent.');

    const { asset, isBuy, price, size, reduceOnly, positionSize } = await this.buildPerpOrder(agentWalletId, params);

    const account = privateKeyToAccount(creds.privateKey as `0x${string}`);
    const { transport } = await getHlClients();
    const { ExchangeClient } = await getHlSdk();
    const exchange = new ExchangeClient({ transport, wallet: account });

    const resp = await exchange.order({
      orders: [{ a: asset.assetId, b: isBuy, p: price, s: size, r: reduceOnly, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });

    const result = this.parseOrderResponse(resp);
    logger.info({ agentWalletId, coin: asset.coin, side: params.side, price, size, reduceOnly, result }, 'Hyperliquid perp order placed');
    return { ...result, coin: asset.coin, pair: `${asset.coin}-PERP`, price: Number(price), size: Number(size), reduceOnly, positionSize };
  }

  /** Update cross or isolated leverage for a perp asset. */
  async updatePerpLeverage(
    agentWalletId: string,
    params: { coin: string; leverage: number; isCross?: boolean },
  ): Promise<HlLeverageResult> {
    const creds = getHlCreds(agentWalletId);
    if (!creds) throw new Error('No Hyperliquid API wallet configured for this agent.');

    const asset = await resolvePerpAsset(params.coin);
    if (!asset) throw new Error(`Unknown Hyperliquid perp coin: ${params.coin}`);
    const leverage = params.leverage;
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error('Leverage must be a whole number greater than or equal to 1.');
    }
    if (leverage > asset.maxLeverage) {
      throw new Error(`Leverage ${leverage}x exceeds Hyperliquid max leverage ${asset.maxLeverage}x for ${asset.coin}.`);
    }

    const account = privateKeyToAccount(creds.privateKey as `0x${string}`);
    const { transport } = await getHlClients();
    const { ExchangeClient } = await getHlSdk();
    const exchange = new ExchangeClient({ transport, wallet: account });

    const isCross = params.isCross ?? true;
    const resp = await exchange.updateLeverage({ asset: asset.assetId, isCross, leverage });
    const status = (resp as { status?: string; response?: unknown }).status;
    const error = status === 'ok' ? null : String((resp as { response?: unknown }).response ?? 'Leverage update failed');
    const result = { success: status === 'ok', coin: asset.coin, leverage, isCross, maxLeverage: asset.maxLeverage, error };
    logger.info({ agentWalletId, coin: asset.coin, leverage, isCross, result }, 'Hyperliquid perp leverage updated');
    return result;
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

import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import type { Market, MarketToken } from '../types/market';
import { logger } from '../utils/logger';

const GAMMA_HOST = process.env.POLYMARKET_GAMMA_HOST ?? 'https://gamma-api.polymarket.com';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * GET against Gamma with retry + backoff. Polymarket rate-limits heavy crawling (HTTP 429);
 * retrying the same request (respecting Retry-After) rather than aborting lets the full-catalogue
 * crawl complete instead of stopping at the first throttle. Also retries transient 5xx/network errors.
 */
async function gammaGet<T>(url: string, config: AxiosRequestConfig, retries = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return (await axios.get<T>(url, config)).data;
    } catch (err) {
      lastErr = err;
      const status = (err as AxiosError).response?.status;
      const retryable = status === undefined || status === 429 || status === 408 || (status >= 500 && status < 600);
      if (attempt === retries || !retryable) throw err;
      const retryAfterHeader = parseInt(String((err as AxiosError).response?.headers?.['retry-after'] ?? ''), 10);
      const delayMs = Number.isFinite(retryAfterHeader)
        ? retryAfterHeader * 1000
        : Math.min(20_000, 750 * 2 ** attempt) + Math.floor(Math.random() * 400);
      logger.warn({ url, status, attempt: attempt + 1, delayMs }, 'Gamma request rate-limited/failed — backing off');
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

interface GammaMarketFlat {
  id: string;
  question: string;
  conditionId?: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  volume: number | string;
  liquidity: number | string;
  clobTokenIds?: string;   // JSON-encoded string array
  outcomes?: string;       // JSON-encoded string array
  negRisk?: boolean;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  endDate?: string;
  category?: string;
  description?: string;
  eventId?: string;
  tags?: string;           // JSON-encoded array
}

function statusFromFlat(m: GammaMarketFlat): Market['status'] {
  if (m.archived) return 'closed';
  if (m.closed) return 'closed';
  if (!m.active) return 'paused';
  return 'active';
}

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function flatToMarket(gm: GammaMarketFlat): Market | null {
  const tokenIds = parseJsonArray(gm.clobTokenIds);
  const outcomeLabels = parseJsonArray(gm.outcomes);
  if (tokenIds.length < 2) return null;

  const tokens: MarketToken[] = tokenIds.map((tokenId, i) => {
    const label = outcomeLabels[i] ?? (i === 0 ? 'Yes' : 'No');
    const outcome: 'YES' | 'NO' = label.toLowerCase() === 'no' ? 'NO' : 'YES';
    return { tokenId, outcome, tickSize: 0.01, negRisk: gm.negRisk ?? false };
  });

  return {
    marketId: gm.id,
    eventId: gm.eventId ?? gm.id,
    title: gm.question,
    description: gm.description ?? '',
    status: statusFromFlat(gm),
    category: gm.category ?? 'uncategorized',
    resolutionDate: gm.endDate ? new Date(gm.endDate) : null,
    liquidityUsdc: parseFloat(String(gm.liquidity ?? 0)),
    volume24hUsdc: 0,
    tags: parseJsonArray(gm.tags),
    tokens,
    metadata: { conditionId: gm.conditionId, bestBid: gm.bestBid, bestAsk: gm.bestAsk, spread: gm.spread },
    updatedAt: new Date(),
  };
}

/** Fetch a single market by its Gamma market ID. Returns null if not found. */
export async function fetchGammaMarketById(marketId: string): Promise<Market | null> {
  const data = await gammaGet<GammaMarketFlat[]>(`${GAMMA_HOST}/markets`, {
    params: { id: marketId },
    timeout: 10_000,
  });
  const markets = (data as GammaMarketFlat[]).map(flatToMarket).filter((m): m is Market => m !== null);
  return markets[0] ?? null;
}

/** Offset-based fetch — limited to ~2500 results by Gamma API. */
export async function fetchGammaMarkets(params: {
  limit?: number;
  offset?: number;
  active?: boolean;
} = {}): Promise<Market[]> {
  const { limit = 100, offset = 0, active } = params;
  const qp: Record<string, string | number | boolean> = { limit, offset };
  if (active === true) { qp.active = true; qp.closed = false; qp.archived = false; }

  const data = await gammaGet<GammaMarketFlat[]>(`${GAMMA_HOST}/markets`, { params: qp, timeout: 15_000 });
  const markets = (data as GammaMarketFlat[]).map(flatToMarket).filter((m): m is Market => m !== null);
  logger.debug({ count: markets.length, offset }, 'Fetched markets from Gamma (offset)');
  return markets;
}

/**
 * Fetch the top N most active markets by 24-hour volume.
 * Catches high-liquidity markets regardless of their position in the keyset cursor.
 */
export async function fetchTopMarketsByVolume(limit = 500): Promise<Market[]> {
  const qp: Record<string, string | number | boolean> = {
    limit,
    active: true,
    closed: false,
    archived: false,
    order: 'volume24hr',
    ascending: false,
  };
  const data = await gammaGet<GammaMarketFlat[]>(`${GAMMA_HOST}/markets`, { params: qp, timeout: 30_000 });
  const markets = (data as GammaMarketFlat[]).map(flatToMarket).filter((m): m is Market => m !== null);
  logger.debug({ count: markets.length }, 'Fetched top markets by 24h volume');
  return markets;
}

/** Keyset/cursor-based fetch — no depth limit, use for full ingestion. */
export async function fetchGammaMarketsKeyset(params: {
  limit?: number;
  cursor?: string;
  active?: boolean;
} = {}): Promise<{ markets: Market[]; nextCursor: string | null }> {
  const { limit = 100, cursor, active } = params;
  const qp: Record<string, string | number | boolean> = { limit };
  if (cursor) qp.next_cursor = cursor;
  if (active === true) { qp.active = true; qp.closed = false; qp.archived = false; }

  const raw = await gammaGet<{ markets: GammaMarketFlat[]; next_cursor?: string }>(
    `${GAMMA_HOST}/markets/keyset`,
    { params: qp, timeout: 15_000 }
  );

  const markets = (raw.markets ?? []).map(flatToMarket).filter((m): m is Market => m !== null);
  const nextCursor = raw.next_cursor ?? null;
  logger.debug({ count: markets.length, cursor: cursor?.slice(0, 20) }, 'Fetched markets from Gamma (keyset)');
  return { markets, nextCursor };
}

interface GammaEvent {
  id: string;
  title?: string;
  description?: string;
  category?: string;
  tags?: Array<{ label?: string }>;
  markets?: GammaMarketFlat[];
}

/**
 * Fetch markets embedded inside events — captures negRisk match markets
 * (e.g. "Will United States win on 2026-06-19?") that don't appear in /markets/keyset.
 */
export async function fetchGammaEventsKeyset(params: {
  limit?: number;
  cursor?: string;
  active?: boolean;
} = {}): Promise<{ markets: Market[]; nextCursor: string | null }> {
  const { limit = 100, cursor, active } = params;
  const qp: Record<string, string | number | boolean> = { limit };
  if (cursor) qp.next_cursor = cursor;
  if (active === true) { qp.active = true; qp.closed = false; qp.archived = false; }

  const raw = await gammaGet<{ events: GammaEvent[]; next_cursor?: string }>(
    `${GAMMA_HOST}/events/keyset`,
    { params: qp, timeout: 15_000 }
  );

  const markets: Market[] = [];

  for (const event of raw.events ?? []) {
    const eventCategory = event.category ?? event.tags?.[0]?.label ?? 'uncategorized';
    for (const gm of event.markets ?? []) {
      // Inherit event-level fields that may be missing on the embedded market
      if (!gm.category) gm.category = eventCategory;
      if (!gm.description && event.description) gm.description = event.description;
      if (!gm.eventId) gm.eventId = event.id;
      const m = flatToMarket(gm);
      if (m) markets.push(m);
    }
  }

  const nextCursor = raw.next_cursor ?? null;
  logger.debug({ count: markets.length, cursor: cursor?.slice(0, 20) }, 'Fetched markets from Gamma events (keyset)');
  return { markets, nextCursor };
}

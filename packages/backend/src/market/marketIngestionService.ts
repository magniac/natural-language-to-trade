import { fetchGammaMarkets, fetchGammaMarketsKeyset, fetchGammaEventsKeyset, fetchTopMarketsByVolume } from './polymarketGammaClient';
import { upsertMarket } from './marketRepository';
import type { Market } from '../types/market';
import { logger } from '../utils/logger';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// Small pause between keyset pages to stay under Gamma's rate limit during the full crawl.
const PAGE_THROTTLE_MS = 200;
// Polymarket has ~60k active markets. A safety floor that skips any with liquidity below the
// policy engine's tradeable minimum ($100) — in practice nearly all active markets far exceed
// this, so it filters little, but it keeps genuinely untradeable rows out of search.
const MIN_LIQUIDITY_TO_STORE = parseFloat(process.env.MIN_MARKET_LIQUIDITY_USDC ?? '100');

type IngestionOutcome = 'success' | 'partial' | 'stalled' | 'failed' | 'skipped';

interface CrawlResult {
  label: string;
  fetched: number;
  upserted: number;
  errors: number;
  pages: number;
  status: 'success' | 'stalled' | 'capped' | 'failed';
  message: string;
}

interface IngestionResult {
  fetched: number;
  upserted: number;
  errors: number;
  durationMs: number;
  status: IngestionOutcome;
  message: string;
  crawls?: CrawlResult[];
}

interface MarketIngestionStatus {
  inProgress: boolean;
  currentRunStartedAt: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastSkippedAt: number | null;
  lastFailedAt: number | null;
  lastError: string | null;
  lastResult: IngestionResult | null;
}

export async function ingestMarkets(options: {
  limit?: number;
  offset?: number;
  activeOnly?: boolean;
} = {}): Promise<IngestionResult> {
  const { limit = 500, offset = 0, activeOnly = false } = options;
  const start = Date.now();
  let fetched = 0;
  let upserted = 0;
  let errors = 0;

  try {
    const markets = await fetchGammaMarkets({ limit, offset, active: activeOnly ? true : undefined });
    fetched = markets.length;

    for (const market of markets) {
      try {
        upsertMarket(market);
        upserted++;
      } catch (err) {
        errors++;
        logger.error({ marketId: market.marketId, err }, 'Failed to upsert market');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Market ingestion fetch failed');
    errors++;
  }

  const durationMs = Date.now() - start;
  const status: IngestionOutcome = errors > 0 ? 'partial' : 'success';
  const message = errors > 0
    ? `Completed with ${errors.toLocaleString()} error${errors === 1 ? '' : 's'}.`
    : 'Completed successfully.';
  logger.info({ fetched, upserted, errors, durationMs, status, message }, 'Market ingestion complete');
  return { fetched, upserted, errors, durationMs, status, message };
}

async function crawlKeyset(
  fetcher: (cursor: string | undefined) => Promise<{ markets: Market[]; nextCursor: string | null }>,
  batchSize: number,
  label: string,
): Promise<CrawlResult> {
  let cursor: string | null = null;
  let fetched = 0, upserted = 0, errors = 0, pages = 0;
  let status: CrawlResult['status'] = 'success';
  let message = 'Completed all pages.';
  // Hard cap so a degraded API response can never spin forever (each page is up to `batchSize`).
  const MAX_PAGES = 3000;
  do {
    let markets: Market[], nextCursor: string | null;
    try {
      ({ markets, nextCursor } = await fetcher(cursor ?? undefined));
    } catch (err) {
      logger.error({ err, cursor, label }, 'Keyset fetch failed');
      errors++;
      status = 'failed';
      message = err instanceof Error ? err.message : 'Keyset fetch failed.';
      break;
    }
    fetched += markets.length;
    for (const market of markets) {
      if (market.liquidityUsdc < MIN_LIQUIDITY_TO_STORE) continue;  // skip untradeable dust
      try { upsertMarket(market); upserted++; }
      catch (err) { errors++; logger.error({ marketId: market.marketId, err }, 'Failed to upsert market'); }
    }
    pages++;
    // Stall guard: if the API returns the same cursor it was given (commonly when rate-limited it
    // re-serves page 0), the crawl would loop forever on the same markets — stop instead.
    if (nextCursor !== null && nextCursor === cursor) {
      logger.warn({ label, pages, cursor: cursor.slice(0, 20) }, 'Keyset cursor did not advance — stopping crawl (API likely rate-limiting)');
      status = 'stalled';
      message = 'Stopped early because the Gamma cursor did not advance; this often means the API is rate-limiting or re-serving the same page.';
      break;
    }
    if (pages >= MAX_PAGES) {
      logger.warn({ label, pages }, 'Keyset crawl hit max page cap — stopping');
      status = 'capped';
      message = `Stopped early after hitting the ${MAX_PAGES.toLocaleString()} page safety cap.`;
      break;
    }
    cursor = nextCursor;
    if (cursor !== null) await sleep(PAGE_THROTTLE_MS);
  } while (cursor !== null);
  logger.info({ label, pages, fetched, upserted, errors, status, message }, 'Keyset crawl finished');
  return { label, fetched, upserted, errors, pages, status, message };
}

// Guard against the periodic timer starting a new crawl while a slow one is still running —
// concurrent crawls double the Gamma load and trigger rate limits.
let ingestionInProgress = false;
const ingestionStatus: MarketIngestionStatus = {
  inProgress: false,
  currentRunStartedAt: null,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastSkippedAt: null,
  lastFailedAt: null,
  lastError: null,
  lastResult: null,
};

export function getMarketIngestionStatus(): MarketIngestionStatus {
  return {
    ...ingestionStatus,
    lastResult: ingestionStatus.lastResult ? { ...ingestionStatus.lastResult } : null,
  };
}

export async function ingestAllMarkets(batchSize = 100): Promise<IngestionResult> {
  if (ingestionInProgress) {
    ingestionStatus.lastSkippedAt = Date.now();
    logger.info('Skipping market ingestion — a previous full crawl is still running');
    return {
      fetched: 0,
      upserted: 0,
      errors: 0,
      durationMs: 0,
      status: 'skipped',
      message: 'Skipped because a previous full crawl is still running.',
    };
  }
  ingestionInProgress = true;
  const start = Date.now();
  ingestionStatus.inProgress = true;
  ingestionStatus.currentRunStartedAt = start;
  ingestionStatus.lastStartedAt = start;
  ingestionStatus.lastError = null;
  let totalFetched = 0, totalUpserted = 0, totalErrors = 0;
  try {
    const crawls: CrawlResult[] = [];

    // Pass 0: top 500 markets by 24h volume — runs first so high-activity markets
    // (e.g. live sports game markets) are immediately available regardless of keyset position
    try {
      const hotMarkets = await fetchTopMarketsByVolume(500);
      totalFetched += hotMarkets.length;
      for (const market of hotMarkets) {
        try { upsertMarket(market); totalUpserted++; }
        catch (err) { totalErrors++; logger.error({ marketId: market.marketId, err }, 'Failed to upsert hot market'); }
      }
      logger.info({ count: hotMarkets.length }, 'Hot markets (by 24h volume) ingested');
    } catch (err) {
      logger.error({ err }, 'Hot markets fetch failed');
      totalErrors++;
    }

    // Pass 1: flat markets keyset (breadth coverage)
    const pass1 = await crawlKeyset(
      cursor => fetchGammaMarketsKeyset({ limit: batchSize, cursor, active: true }),
      batchSize,
      'markets-keyset',
    );
    crawls.push(pass1);
    totalFetched += pass1.fetched;
    totalUpserted += pass1.upserted;
    totalErrors += pass1.errors;

    // Pass 2: events keyset — captures negRisk match markets (sports, head-to-head)
    const pass2 = await crawlKeyset(
      cursor => fetchGammaEventsKeyset({ limit: batchSize, cursor, active: true }),
      batchSize,
      'events-keyset',
    );
    crawls.push(pass2);
    totalFetched += pass2.fetched;
    totalUpserted += pass2.upserted;
    totalErrors += pass2.errors;

    const durationMs = Date.now() - start;
    const stalledCrawl = crawls.find(c => c.status === 'stalled' || c.status === 'capped');
    const failedCrawl = crawls.find(c => c.status === 'failed');
    const status: IngestionOutcome = stalledCrawl ? 'stalled' : failedCrawl || totalErrors > 0 ? 'partial' : 'success';
    const message = stalledCrawl
      ? `${stalledCrawl.label}: ${stalledCrawl.message}`
      : failedCrawl
        ? `${failedCrawl.label}: ${failedCrawl.message}`
        : totalErrors > 0
          ? `Completed with ${totalErrors.toLocaleString()} error${totalErrors === 1 ? '' : 's'}.`
          : 'Completed successfully.';

    logger.info({ totalFetched, totalUpserted, totalErrors, durationMs, status, message }, 'Full market ingestion complete');
    const result = { fetched: totalFetched, upserted: totalUpserted, errors: totalErrors, durationMs, status, message, crawls };
    ingestionStatus.lastCompletedAt = Date.now();
    ingestionStatus.lastResult = result;
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'Market ingestion failed';
    const result: IngestionResult = {
      fetched: totalFetched,
      upserted: totalUpserted,
      errors: totalErrors + 1,
      durationMs,
      status: 'failed',
      message,
    };
    ingestionStatus.lastFailedAt = Date.now();
    ingestionStatus.lastError = message;
    ingestionStatus.lastResult = result;
    throw err;
  } finally {
    ingestionInProgress = false;
    ingestionStatus.inProgress = false;
    ingestionStatus.currentRunStartedAt = null;
  }
}

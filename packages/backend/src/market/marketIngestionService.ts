import { fetchGammaMarkets, fetchGammaMarketsKeyset, fetchGammaEventsKeyset, fetchTopMarketsByVolume } from './polymarketGammaClient';
import { upsertMarket, getActiveMarketCount } from './marketRepository';
import type { Market } from '../types/market';
import { logger } from '../utils/logger';

interface IngestionResult {
  fetched: number;
  upserted: number;
  errors: number;
  durationMs: number;
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
  logger.info({ fetched, upserted, errors, durationMs }, 'Market ingestion complete');
  return { fetched, upserted, errors, durationMs };
}

async function crawlKeyset(
  fetcher: (cursor: string | undefined) => Promise<{ markets: Market[]; nextCursor: string | null }>,
  batchSize: number,
  label: string,
): Promise<{ fetched: number; upserted: number; errors: number }> {
  let cursor: string | null = null;
  let fetched = 0, upserted = 0, errors = 0;
  do {
    let markets: Market[], nextCursor: string | null;
    try {
      ({ markets, nextCursor } = await fetcher(cursor ?? undefined));
    } catch (err) {
      logger.error({ err, cursor, label }, 'Keyset fetch failed');
      errors++;
      break;
    }
    fetched += markets.length;
    for (const market of markets) {
      try { upsertMarket(market); upserted++; }
      catch (err) { errors++; logger.error({ marketId: market.marketId, err }, 'Failed to upsert market'); }
    }
    cursor = nextCursor;
  } while (cursor !== null);
  return { fetched, upserted, errors };
}

export async function ingestAllMarkets(batchSize = 100): Promise<IngestionResult> {
  const start = Date.now();
  let totalFetched = 0, totalUpserted = 0, totalErrors = 0;

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
  totalFetched += pass1.fetched;
  totalUpserted += pass1.upserted;
  totalErrors += pass1.errors;

  // Pass 2: events keyset — captures negRisk match markets (sports, head-to-head)
  const pass2 = await crawlKeyset(
    cursor => fetchGammaEventsKeyset({ limit: batchSize, cursor, active: true }),
    batchSize,
    'events-keyset',
  );
  totalFetched += pass2.fetched;
  totalUpserted += pass2.upserted;
  totalErrors += pass2.errors;

  const durationMs = Date.now() - start;
  logger.info({ totalFetched, totalUpserted, totalErrors, durationMs }, 'Full market ingestion complete');
  return { fetched: totalFetched, upserted: totalUpserted, errors: totalErrors, durationMs };
}

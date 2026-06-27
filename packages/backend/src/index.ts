import 'dotenv/config';
import { createApp } from './api/app';
import { getDb } from './db/database';
import { ensureDevSignerTable } from './agent/devSigner';
import { ingestAllMarkets } from './market/marketIngestionService';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
// Polymarket's full catalogue is ~60k markets; a complete crawl takes a few minutes. Refresh the
// whole catalogue every 30 min (overlap-guarded). Trade-time freshness is handled separately by the
// on-demand re-fetch of the specific market in toolPlaceTrade, so the bulk crawl can be infrequent.
const MARKET_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

async function main() {
  // Initialize DB and dev signer table
  getDb();
  if (process.env.SIGNER_MODE !== 'kms') {
    ensureDevSignerTable();
  }

  // Initial market ingest — paginate through all active Polymarket markets
  ingestAllMarkets(100).catch(err =>
    logger.error({ err }, 'Initial market ingestion failed')
  );

  // Periodic full-catalog refresh. Trade-time freshness is handled by on-demand market refetch.
  setInterval(() => {
    ingestAllMarkets(100).catch(err =>
      logger.error({ err }, 'Periodic market refresh failed')
    );
  }, MARKET_REFRESH_INTERVAL_MS);

  const app = createApp();
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Backend server started');
  });
}

main().catch(err => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

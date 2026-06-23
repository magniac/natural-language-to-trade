import 'dotenv/config';
import { createApp } from './api/app';
import { getDb } from './db/database';
import { ensureDevSignerTable } from './agent/devSigner';
import { ingestAllMarkets } from './market/marketIngestionService';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const MARKET_REFRESH_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes — keeps data within policy engine's 5-min staleness window

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

  // Periodic refresh so market prices stay within the 5-minute staleness window
  setInterval(() => {
    ingestAllMarkets(100).catch(err =>
      logger.error({ err }, 'Periodic market refresh failed')
    );
  }, MARKET_REFRESH_INTERVAL_MS);

  const app = createApp();
  app.listen(PORT, () => {
    logger.info({ port: PORT, liveTradingEnabled: process.env.ENABLE_LIVE_TRADING === 'true' }, 'Backend server started');
  });
}

main().catch(err => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

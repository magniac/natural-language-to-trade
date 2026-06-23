import { Router } from 'express';
import { searchMarkets, getMarketById } from '../../market/marketRepository';
import { resolveMarket, resolveMarketById } from '../../market/marketResolver';
import { ingestAllMarkets } from '../../market/marketIngestionService';
import { requireAdminKey } from '../middleware';

const router = Router();

router.get('/search', async (req, res) => {
  const query = req.query.q as string;
  const minLiquidity = parseFloat((req.query.minLiquidity as string) ?? '0');
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 100);

  if (!query || query.trim().length === 0) {
    const markets = searchMarkets({ status: 'active', minLiquidityUsdc: minLiquidity, limit });
    return res.json({ markets });
  }

  const result = await resolveMarket(query, { minLiquidityUsdc: minLiquidity });
  return res.json(result);
});

router.get('/:marketId', async (req, res) => {
  const { marketId } = req.params;
  const market = getMarketById(marketId);
  if (!market) return res.status(404).json({ error: 'Market not found' });
  return res.json(market);
});

router.get('/:marketId/resolve', async (req, res) => {
  const result = await resolveMarketById(req.params.marketId);
  return res.json(result);
});

// Admin: trigger ingestion
router.post('/admin/ingest', requireAdminKey, async (_req, res) => {
  const result = await ingestAllMarkets(100);
  return res.json(result);
});

export default router;

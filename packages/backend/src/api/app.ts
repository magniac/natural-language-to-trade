import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import marketRoutes from './routes/marketRoutes';
import agentRoutes from './routes/agentRoutes';
import tradeRoutes from './routes/tradeRoutes';
import adminRoutes from './routes/adminRoutes';
import { requireValidSession } from './middleware';
import { logger } from '../utils/logger';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'] }));
  app.use(express.json({ limit: '100kb' }));

  // Global rate limiting
  app.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));

  // Health check — available at both /health and /api/health
  const healthHandler = (_req: express.Request, res: express.Response) =>
    res.json({ status: 'ok', liveTradingEnabled: true });
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // Public market data (no auth required — read-only)
  app.use('/api/market', marketRoutes);

  // User-facing agent management endpoints
  app.use('/api/agents', agentRoutes);

  // Agent proxy endpoints — require session key signature
  app.use('/api/agent/trade', requireValidSession, tradeRoutes);

  // Admin endpoints
  app.use('/api/internal', adminRoutes);

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

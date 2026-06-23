import { Router } from 'express';
import { getDb } from '../../db/database';
import { writeAudit } from '../../db/auditRepository';
import { requireAdminKey } from '../middleware';
import { v4 as uuidv4 } from 'uuid';
import { ingestAllMarkets } from '../../market/marketIngestionService';
import { logger } from '../../utils/logger';

const router = Router();
router.use(requireAdminKey);

router.post('/kill-switch/enable', (req, res) => {
  const db = getDb();
  const { scope = 'global', targetId, reason } = req.body as { scope?: string; targetId?: string; reason?: string };
  const id = uuidv4();
  db.prepare(`
    INSERT INTO kill_switches (id, scope, target_id, reason, enabled_by, enabled_at, disabled_at)
    VALUES (?, ?, ?, ?, 'admin', ?, NULL)
  `).run(id, scope, targetId ?? null, reason ?? null, Date.now());
  writeAudit({ actorType: 'admin', actorId: 'admin', action: 'kill_switch.enable', details: { scope, targetId, reason } });
  return res.json({ id, scope, enabled: true });
});

router.post('/kill-switch/disable', (req, res) => {
  const db = getDb();
  const { id } = req.body as { id: string };
  if (!id) return res.status(400).json({ error: 'id required' });
  db.prepare('UPDATE kill_switches SET disabled_at = ? WHERE id = ?').run(Date.now(), id);
  writeAudit({ actorType: 'admin', actorId: 'admin', action: 'kill_switch.disable', details: { id } });
  return res.json({ id, enabled: false });
});

router.get('/kill-switch', (_req, res) => {
  const db = getDb();
  const switches = db.prepare('SELECT * FROM kill_switches WHERE disabled_at IS NULL').all();
  return res.json({ killSwitches: switches });
});

router.post('/markets/ingest', async (_req, res) => {
  // Fire and forget — returns immediately, ingestion runs in background
  ingestAllMarkets(100)
    .then(r => logger.info(r, 'Manual market ingestion complete'))
    .catch(err => logger.error({ err }, 'Manual market ingestion failed'));
  return res.json({ message: 'Market ingestion started in background' });
});

router.post('/reconcile/orders', async (_req, res) => {
  return res.json({ message: 'Order reconciliation worker not yet implemented — implement with CLOB polling in Milestone 9' });
});

export default router;

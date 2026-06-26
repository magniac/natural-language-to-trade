import type { Request, Response, NextFunction } from 'express';
import { verifySessionRequest, type SessionRequestHeaders } from '../auth/sessionVerifier';
import { logger } from '../utils/logger';

export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) { next(); return; }
  if (req.headers['x-admin-key'] !== adminKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

export async function requireValidSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const policyId = req.headers['x-policy-id'] as string;
  const sessionKey = req.headers['x-session-key'] as string;
  const timestamp = parseInt(req.headers['x-timestamp'] as string ?? '0', 10);
  const nonce = req.headers['x-nonce'] as string;
  const signature = req.headers['x-signature'] as string;

  if (!policyId || !sessionKey || !timestamp || !nonce || !signature) {
    res.status(401).json({ error: 'Missing session headers' });
    return;
  }

  const headers: SessionRequestHeaders = { policyId, sessionKey, timestamp, nonce, signature };
  // Use '' for GET/empty bodies — client signs '' for no-body requests.
  // JSON.stringify({}) would mismatch a client-signed empty string.
  const hasBody = req.body !== undefined && req.body !== null && Object.keys(req.body as object).length > 0;
  const rawBody = hasBody ? JSON.stringify(req.body) : '';
  // Use originalUrl (full path) so the canonical message matches what the client signed.
  // req.path is router-relative ("/portfolio"), but client signs the full path ("/api/agent/trade/portfolio").
  const fullPath = req.originalUrl.split('?')[0];
  const result = await verifySessionRequest(headers, req.method, fullPath, rawBody, ['trade', 'llm', 'market']);

  if (!result.valid) {
    logger.warn({ reasons: result.reasons, path: fullPath }, 'Session verification failed');
    res.status(401).json({ error: 'Session verification failed', reasons: result.reasons });
    return;
  }

  // Attach policy to request
  (req as Request & { policy: typeof result.policy }).policy = result.policy;
  next();
}

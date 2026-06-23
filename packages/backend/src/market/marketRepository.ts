import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import type { Market, MarketToken, Orderbook } from '../types/market';

export function upsertMarket(market: Market): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO markets (id, market_id, event_id, title, description, status, category, resolution_date, liquidity_usdc, volume_24h_usdc, tags, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market_id) DO UPDATE SET
        event_id = excluded.event_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        category = excluded.category,
        resolution_date = excluded.resolution_date,
        liquidity_usdc = excluded.liquidity_usdc,
        volume_24h_usdc = excluded.volume_24h_usdc,
        tags = excluded.tags,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      uuidv4(),
      market.marketId,
      market.eventId,
      market.title,
      market.description,
      market.status,
      market.category,
      market.resolutionDate ? market.resolutionDate.getTime() : null,
      market.liquidityUsdc,
      market.volume24hUsdc,
      JSON.stringify(market.tags),
      JSON.stringify(market.metadata),
      market.updatedAt.getTime(),
    );

    for (const token of market.tokens) {
      db.prepare(`
        INSERT INTO market_tokens (id, market_id, outcome, token_id, tick_size, neg_risk, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          outcome = excluded.outcome,
          tick_size = excluded.tick_size,
          neg_risk = excluded.neg_risk,
          updated_at = excluded.updated_at
      `).run(
        uuidv4(),
        market.marketId,
        token.outcome,
        token.tokenId,
        token.tickSize,
        token.negRisk ? 1 : 0,
        Date.now(),
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMarketById(marketId: string): Market | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM markets WHERE market_id = ?').get(marketId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToMarket(row);
}

export function searchMarkets(options: {
  status?: string;
  category?: string;
  minLiquidityUsdc?: number;
  limit?: number;
  offset?: number;
}): Market[] {
  const db = getDb();
  const { status, category, minLiquidityUsdc = 0, limit = 50, offset = 0 } = options;

  let sql = 'SELECT * FROM markets WHERE liquidity_usdc >= ?';
  const params: unknown[] = [minLiquidityUsdc];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (category) { sql += ' AND category = ?'; params.push(category); }

  sql += ' ORDER BY liquidity_usdc DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db.prepare(sql).all(...(params as any[])) as Record<string, unknown>[]).map(rowToMarket);
}

export function getMarketTokens(marketId: string): MarketToken[] {
  const db = getDb();
  return (db.prepare('SELECT * FROM market_tokens WHERE market_id = ?').all(marketId) as Record<string, unknown>[])
    .map(r => ({
      tokenId: r.token_id as string,
      outcome: r.outcome as 'YES' | 'NO',
      tickSize: r.tick_size as number,
      negRisk: (r.neg_risk as number) === 1,
    }));
}

export function getTokenByTokenId(tokenId: string): { marketId: string; outcome: string; tickSize: number } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM market_tokens WHERE token_id = ?').get(tokenId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { marketId: row.market_id as string, outcome: row.outcome as string, tickSize: row.tick_size as number };
}

/**
 * Keyword-based text search across ALL markets in the DB.
 * Results are ranked first by how many keywords they match (most relevant first),
 * then by liquidity — so a low-liquidity but highly-specific market ranks above
 * a high-liquidity market that merely mentions one of the query's broad terms.
 */
export function searchMarketsByKeywords(options: {
  keywords: string[];
  status?: string;
  minLiquidityUsdc?: number;
  limit?: number;
}): Market[] {
  const { keywords, status = 'active', minLiquidityUsdc = 0, limit = 100 } = options;
  if (keywords.length === 0) return searchMarkets({ status, minLiquidityUsdc, limit });

  const db = getDb();

  // Each keyword contributes 1 to a keyword_score if found in title or description
  const scoreParts = keywords
    .map(() => `(CASE WHEN instr(lower(title), ?) > 0 OR instr(lower(description), ?) > 0 THEN 1 ELSE 0 END)`)
    .join(' + ');

  const filterConditions = keywords
    .map(() => `(instr(lower(title), ?) > 0 OR instr(lower(description), ?) > 0)`)
    .join(' OR ');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoreParams: any[] = [];
  keywords.forEach(k => scoreParams.push(k.toLowerCase(), k.toLowerCase()));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filterParams: any[] = [];
  keywords.forEach(k => filterParams.push(k.toLowerCase(), k.toLowerCase()));

  const sql = `
    SELECT *, (${scoreParts}) AS keyword_score
    FROM markets
    WHERE status = ? AND liquidity_usdc >= ? AND (${filterConditions})
    ORDER BY keyword_score DESC, liquidity_usdc DESC
    LIMIT ?
  `;

  return (db.prepare(sql).all(
    ...scoreParams,
    status, minLiquidityUsdc,
    ...filterParams,
    limit,
  ) as Record<string, unknown>[]).map(rowToMarket);
}

export function getActiveMarketCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM markets WHERE status = 'active'").get() as { cnt: number };
  return row.cnt;
}

function rowToMarket(row: Record<string, unknown>): Market {
  const tokens = getMarketTokens(row.market_id as string);
  return {
    marketId: row.market_id as string,
    eventId: row.event_id as string,
    title: row.title as string,
    description: (row.description as string) ?? '',
    status: row.status as Market['status'],
    category: (row.category as string) ?? 'unknown',
    resolutionDate: row.resolution_date ? new Date(row.resolution_date as number) : null,
    liquidityUsdc: row.liquidity_usdc as number,
    volume24hUsdc: row.volume_24h_usdc as number,
    tags: JSON.parse((row.tags as string) || '[]'),
    tokens,
    metadata: JSON.parse((row.metadata_json as string) || '{}'),
    updatedAt: new Date(row.updated_at as number),
  };
}

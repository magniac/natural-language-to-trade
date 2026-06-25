import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import type { NormalizedOrder, PostOrderResult } from '../types/order';

type Db = ReturnType<typeof getDb>;

export function parseClobDecimalAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function localStatusFromClobPost(postResult: PostOrderResult): 'open' | 'filled' {
  return postResult.clobStatus?.toLowerCase() === 'matched' ? 'filled' : 'open';
}

export function matchedFillFromAmounts(
  side: 'BUY' | 'SELL',
  makingAmount: string | number | null | undefined,
  takingAmount: string | number | null | undefined,
): { price: number; size: number } | null {
  const making = parseClobDecimalAmount(makingAmount);
  const taking = parseClobDecimalAmount(takingAmount);
  if (making === null || taking === null || making <= 0 || taking <= 0) return null;

  const size = side === 'BUY' ? taking : making;
  const notionalUsdc = side === 'BUY' ? making : taking;
  return { price: notionalUsdc / size, size };
}

export function recordImmediateMatchedFill(
  db: Db,
  orderId: string,
  order: NormalizedOrder,
  postResult: PostOrderResult,
): void {
  if (postResult.clobStatus?.toLowerCase() !== 'matched') return;

  const fill = matchedFillFromAmounts(order.side, postResult.makingAmount, postResult.takingAmount);
  const clobTradeId = postResult.tradeIds?.[0] ?? postResult.clobOrderId;
  if (!fill || !clobTradeId) return;

  db.prepare(`
    INSERT INTO fills (id, order_id, clob_trade_id, price, size, side, fee, created_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(clob_trade_id) DO UPDATE SET size = excluded.size, price = excluded.price, raw_json = excluded.raw_json
  `).run(uuidv4(), orderId, clobTradeId, fill.price, fill.size, order.side, Date.now(), JSON.stringify(postResult.raw ?? postResult));
}

/**
 * Repairs fills recorded from matched CLOB post responses. Earlier code treated
 * `makingAmount` / `takingAmount` as fixed-6 integer strings; the SDK returns
 * decimal strings such as "5.154638". That made portfolio spend effectively zero.
 */
export function repairMatchedFillsForAgent(db: Db, agentWalletId: string): number {
  const rows = db.prepare(`
    SELECT
      f.id AS fill_id,
      f.price AS fill_price,
      f.size AS fill_size,
      f.raw_json AS raw_json,
      o.side AS side
    FROM fills f
    JOIN orders o ON o.id = f.order_id
    WHERE o.agent_wallet_id = ?
      AND o.status = 'filled'
      AND f.raw_json LIKE '%makingAmount%'
      AND f.raw_json LIKE '%takingAmount%'
  `).all(agentWalletId) as Array<{
    fill_id: string;
    fill_price: number;
    fill_size: number;
    raw_json: string;
    side: 'BUY' | 'SELL';
  }>;

  let repaired = 0;
  for (const row of rows) {
    let raw: { makingAmount?: string | number; takingAmount?: string | number };
    try {
      raw = JSON.parse(row.raw_json) as { makingAmount?: string | number; takingAmount?: string | number };
    } catch {
      continue;
    }

    const fill = matchedFillFromAmounts(row.side, raw.makingAmount, raw.takingAmount);
    if (!fill) continue;

    if (Math.abs(fill.price - row.fill_price) > 1e-9 || Math.abs(fill.size - row.fill_size) > 1e-9) {
      db.prepare('UPDATE fills SET price = ?, size = ? WHERE id = ?').run(fill.price, fill.size, row.fill_id);
      repaired += 1;
    }
  }

  return repaired;
}

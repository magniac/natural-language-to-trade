import { v4 as uuidv4 } from 'uuid';
import type { TradeIntent } from '../types/intent';
import type { MarketResolverCandidate } from '../types/market';
import type { OrderStatus, Fill } from '../types/order';
import { logger } from '../utils/logger';
import { writeAudit } from '../db/auditRepository';
import { getDb } from '../db/database';

export interface SimulatedPosition {
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  size: number;
  avgPrice: number;
  unrealizedPnlUsdc: number;
}

export interface SimulatedOrder {
  id: string;
  tradeIntentId: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType: string;
  status: OrderStatus;
  filledSize: number;
  fills: Fill[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SimulatorState {
  agentWalletId: string;
  budgetUSDC: number;
  usedUSDC: number;
  positions: Record<string, SimulatedPosition>;
  openOrders: Record<string, SimulatedOrder>;
  closedOrders: SimulatedOrder[];
  dailySpendUSDC: number;
  realizedPnlUsdc: number;
  tradeCount: number;
  auditLog: string[];
}

export interface SimulateTradeInput {
  intent: TradeIntent;
  resolvedMarket: MarketResolverCandidate;
  marketPrice: number;      // current mid price from market data
  agentWalletId: string;
  userId: string;
  policyId: string;
  tradeIntentId: string;
}

export interface SimulateTradeResult {
  success: boolean;
  orderId: string | null;
  fillPrice: number | null;
  fillSize: number | null;
  partialFill: boolean;
  errorMessage: string | null;
  newState: Partial<SimulatorState>;
}

function simulateFill(
  side: 'BUY' | 'SELL',
  limitPrice: number,
  requestedSize: number,
  marketPrice: number,
  liquidity: number
): { filled: boolean; fillPrice: number; fillSize: number; partial: boolean } {
  // Simple fill simulation:
  // BUY fills if limitPrice >= marketPrice (we can get it at market or better)
  // SELL fills if limitPrice <= marketPrice
  const canFill = side === 'BUY' ? limitPrice >= marketPrice : limitPrice <= marketPrice;
  if (!canFill) {
    return { filled: false, fillPrice: 0, fillSize: 0, partial: false };
  }

  // Simulate partial fill based on liquidity (cap at 10% of liquidity per order)
  const maxFillValue = Math.min(liquidity * 0.1, 1000);
  const requestedValue = requestedSize * marketPrice;
  const partial = requestedValue > maxFillValue;
  const fillSize = partial ? maxFillValue / marketPrice : requestedSize;

  return {
    filled: true,
    fillPrice: marketPrice,
    fillSize: Math.max(0, fillSize),
    partial,
  };
}

export function simulateTrade(
  state: SimulatorState,
  input: SimulateTradeInput
): SimulateTradeResult {
  const { intent, resolvedMarket, marketPrice, agentWalletId, userId, policyId, tradeIntentId } = input;

  const tokenId = intent.outcome === 'YES' ? resolvedMarket.yesTokenId : resolvedMarket.noTokenId;
  const orderId = uuidv4();
  const requestedSize = intent.size ?? (intent.maxSpendUSDC ? intent.maxSpendUSDC / intent.limitPrice : 0);

  if (requestedSize <= 0) {
    return { success: false, orderId: null, fillPrice: null, fillSize: null, partialFill: false, errorMessage: 'Could not determine order size', newState: {} };
  }

  const { filled, fillPrice, fillSize, partial } = simulateFill(
    intent.side,
    intent.limitPrice,
    requestedSize,
    marketPrice,
    resolvedMarket.liquidityUsdc,
  );

  const order: SimulatedOrder = {
    id: orderId,
    tradeIntentId,
    marketId: resolvedMarket.marketId,
    tokenId,
    side: intent.side,
    price: intent.limitPrice,
    size: requestedSize,
    orderType: intent.orderType,
    status: filled ? (partial ? 'partially_filled' : 'filled') : 'open',
    filledSize: filled ? fillSize : 0,
    fills: filled ? [{
      id: uuidv4(),
      orderId,
      clobTradeId: `SIM-${uuidv4()}`,
      price: fillPrice,
      size: fillSize,
      side: intent.side,
      fee: fillSize * fillPrice * 0.001,
      createdAt: new Date(),
      rawJson: { simulated: true },
    }] : [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const spendUsdc = filled && intent.side === 'BUY' ? fillSize * fillPrice : 0;
  const newState: Partial<SimulatorState> = {
    usedUSDC: state.usedUSDC + spendUsdc,
    dailySpendUSDC: state.dailySpendUSDC + spendUsdc,
    tradeCount: state.tradeCount + 1,
  };

  if (filled && order.status !== 'open') {
    // Update position
    const posKey = tokenId;
    const existing = state.positions[posKey];
    if (intent.side === 'BUY') {
      if (existing) {
        const totalSize = existing.size + fillSize;
        newState.positions = {
          ...state.positions,
          [posKey]: {
            ...existing,
            size: totalSize,
            avgPrice: (existing.size * existing.avgPrice + fillSize * fillPrice) / totalSize,
            unrealizedPnlUsdc: 0,
          },
        };
      } else {
        newState.positions = {
          ...state.positions,
          [posKey]: {
            marketId: resolvedMarket.marketId,
            tokenId,
            outcome: intent.outcome,
            size: fillSize,
            avgPrice: fillPrice,
            unrealizedPnlUsdc: 0,
          },
        };
      }
    } else {
      // SELL: reduce or remove the position
      const newSize = (existing?.size ?? 0) - fillSize;
      if (newSize <= 0.0001) {
        const { [posKey]: _removed, ...rest } = state.positions;
        newState.positions = rest;
      } else {
        newState.positions = {
          ...state.positions,
          [posKey]: { ...existing!, size: newSize },
        };
      }
    }
  } else if (!filled) {
    newState.openOrders = { ...state.openOrders, [orderId]: order };
  }

  // Persist order and fill to DB so buildAccountState can compute real spend/budget
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO orders (id, trade_intent_id, agent_wallet_id, market_id, token_id, side, price, size, order_type, idempotency_key, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId, tradeIntentId, agentWalletId,
    resolvedMarket.marketId, tokenId,
    intent.side, intent.limitPrice, requestedSize, intent.orderType,
    `sim-${orderId}`,
    order.status, now, now,
  );
  if (filled && order.fills.length > 0) {
    const fill = order.fills[0];
    db.prepare(`
      INSERT INTO fills (id, order_id, clob_trade_id, price, size, side, fee, created_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fill.id, orderId, fill.clobTradeId, fill.price, fill.size, fill.side, fill.fee, now, JSON.stringify(fill.rawJson));
  }

  writeAudit({
    userId,
    agentWalletId,
    policyId,
    actorType: 'agent',
    actorId: agentWalletId,
    action: 'simulator.trade',
    details: {
      orderId,
      marketId: resolvedMarket.marketId,
      side: intent.side,
      outcome: intent.outcome,
      price: intent.limitPrice,
      size: requestedSize,
      filled,
      fillPrice,
      fillSize,
      partial,
      simulated: true,
    },
  });

  logger.info({
    orderId,
    marketId: resolvedMarket.marketId,
    filled,
    fillPrice,
    fillSize,
    partial,
  }, 'Paper trade simulated');

  return {
    success: true,
    orderId,
    fillPrice: filled ? fillPrice : null,
    fillSize: filled ? fillSize : null,
    partialFill: partial,
    errorMessage: null,
    newState,
  };
}

export function createSimulatorState(agentWalletId: string, budgetUSDC: number): SimulatorState {
  return {
    agentWalletId,
    budgetUSDC,
    usedUSDC: 0,
    positions: {},
    openOrders: {},
    closedOrders: [],
    dailySpendUSDC: 0,
    realizedPnlUsdc: 0,
    tradeCount: 0,
    auditLog: [],
  };
}

export function cancelSimulatedOrder(state: SimulatorState, orderId: string): { success: boolean; newState: Partial<SimulatorState> } {
  const order = state.openOrders[orderId];
  if (!order) return { success: false, newState: {} };

  const updated = { ...order, status: 'cancelled' as OrderStatus, updatedAt: new Date() };
  const newOpenOrders = { ...state.openOrders };
  delete newOpenOrders[orderId];

  return {
    success: true,
    newState: {
      openOrders: newOpenOrders,
      closedOrders: [...state.closedOrders, updated],
    },
  };
}

export function cancelAllSimulatedOrders(state: SimulatorState): Partial<SimulatorState> {
  const cancelled = Object.values(state.openOrders).map(o => ({
    ...o, status: 'cancelled' as OrderStatus, updatedAt: new Date(),
  }));
  return {
    openOrders: {},
    closedOrders: [...state.closedOrders, ...cancelled],
  };
}

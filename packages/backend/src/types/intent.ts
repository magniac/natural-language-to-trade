import { z } from 'zod';

export const TradeIntentSchema = z.object({
  action: z.literal('trade'),
  marketQuery: z.string().min(1),
  marketId: z.string().optional(),
  outcome: z.enum(['YES', 'NO']),
  side: z.enum(['BUY', 'SELL']),
  maxSpendUSDC: z.number().positive().optional(),
  size: z.number().positive().optional(),
  /** Fraction of current position to sell (0–1). "Sell all" = 1.0, "sell half" = 0.5. */
  maxFraction: z.number().min(0.001).max(1).optional(),
  limitPrice: z.number().min(0.01).max(0.99),
  orderType: z.enum(['GTD', 'GTC', 'FOK', 'FAK']),
  expirationSeconds: z.number().positive().optional(),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
}).refine(
  (d) => d.maxSpendUSDC !== undefined || d.size !== undefined || d.maxFraction !== undefined,
  { message: 'Either maxSpendUSDC, size, or maxFraction (for "sell all/half") must be specified' }
).refine(
  (d) => d.orderType !== 'GTD' || d.expirationSeconds !== undefined,
  { message: 'GTD orders must include expirationSeconds' }
);

export type TradeIntent = z.infer<typeof TradeIntentSchema>;

export type IntentStatus = 'pending' | 'resolved' | 'denied' | 'submitted' | 'failed' | 'simulated';

export interface StoredTradeIntent {
  id: string;
  userId: string;
  agentWalletId: string;
  policyId: string;
  sessionKeyAddress: string;
  rawInput: string;
  structuredIntent: TradeIntent;
  status: IntentStatus;
  createdAt: Date;
}

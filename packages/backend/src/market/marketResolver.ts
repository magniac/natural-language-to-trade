import { searchMarkets, searchMarketsByKeywords, getMarketById } from './marketRepository';
import type { Market } from '../types/market';
import type { MarketResolverCandidate, MarketResolverResult } from '../types/market';
import { logger } from '../utils/logger';

const CONFIDENCE_THRESHOLD = 0.60;
const AMBIGUITY_THRESHOLD = 0.07;   // if top two candidates within this margin → ambiguous
const MIN_LIQUIDITY_USDC = 100;

export interface ResolverOptions {
  minLiquidityUsdc?: number;
  confidenceThreshold?: number;
  maxCandidates?: number;
}

function normalizeNumbers(s: string): string {
  return s
    .replace(/\$(\d)/g, '$1')                                                          // $100k → 100k
    .replace(/\b(\d+(?:\.\d+)?)\s*k\b/gi, (_, n) => String(Math.round(parseFloat(n) * 1_000)))      // 100k → 100000
    .replace(/\b(\d+(?:\.\d+)?)\s*m\b/gi, (_, n) => String(Math.round(parseFloat(n) * 1_000_000))) // 1m → 1000000
    .replace(/(\d),(\d{3})/g, '$1$2');                                                 // 100,000 → 100000
}

function normalizeText(s: string): string {
  return normalizeNumbers(s.toLowerCase()).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set([
  'will', 'the', 'a', 'an', 'be', 'is', 'are', 'by', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
  'this', 'do', 'does', 'it', 'its', 'if', 'for', 'that', 'than',
  'year', 'month', 'before', 'end', 'by', 'during', 'within',  // temporal filler
]);

// Synonym groups for common prediction-market action verbs
const SYNONYMS: Record<string, string[]> = {
  hit:     ['reach', 'exceed', 'surpass', 'cross', 'touch', 'top', 'break'],
  reach:   ['hit', 'exceed', 'surpass', 'cross', 'touch', 'top', 'break'],
  exceed:  ['hit', 'reach', 'surpass', 'cross', 'top', 'break'],
  surpass: ['hit', 'reach', 'exceed', 'cross', 'top'],
  cross:   ['hit', 'reach', 'exceed', 'surpass', 'break'],
  break:   ['hit', 'reach', 'exceed', 'surpass', 'cross', 'top'],
  fall:    ['drop', 'dip', 'decline', 'sink', 'crash', 'go'],
  drop:    ['fall', 'dip', 'decline', 'sink', 'crash'],
  dip:     ['fall', 'drop', 'decline', 'sink'],
  decline: ['fall', 'drop', 'dip', 'sink'],
  rise:    ['increase', 'grow', 'gain', 'climb', 'surge', 'jump'],
  increase:['rise', 'grow', 'gain', 'climb', 'surge'],
  win:     ['beat', 'take', 'claim', 'secure', 'capture'],
  beat:    ['win', 'defeat', 'overcome'],
  lose:    ['fail', 'miss'],
  fail:    ['lose', 'miss'],
};

// Gerund → base form for prediction-market action verbs that appear in queries
const GERUNDS: Record<string, string> = {
  hitting: 'hit', reaching: 'reach', exceeding: 'exceed', surpassing: 'surpass',
  crossing: 'cross', breaking: 'break', topping: 'top', touching: 'touch',
  falling: 'fall', dropping: 'drop', dipping: 'dip', declining: 'decline', sinking: 'sink',
  crashing: 'crash', rising: 'rise', increasing: 'increase', growing: 'grow',
  gaining: 'gain', climbing: 'climb', surging: 'surge', jumping: 'jump',
  winning: 'win', beating: 'beat', losing: 'lose', failing: 'fail',
};

function stemToken(t: string): string {
  return GERUNDS[t] ?? t;
}

function tokenize(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(stemToken);
}

/**
 * Extract search keywords for SQL LIKE queries.
 * Significant words are passed as-is; numbers with k/m suffixes get format variants
 * so "100k" also finds "$100,000" and "100000" in DB titles.
 * Plain integers (years, counts) are left as-is to avoid '%2%' blasting all markets.
 */
function extractSearchKeywords(query: string): string[] {
  const terms = new Set<string>();

  // Significant non-numeric tokens — entities and adjectives only.
  // Action verbs (hit/reach/win/fall…) are too common in market title patterns to
  // narrow results meaningfully in a SQL LIKE search; omit them here and rely on
  // the scorer's synonym matching instead.
  const SQL_SKIP = new Set(Object.keys(SYNONYMS));
  tokenize(query)
    .filter(t => t.length >= 3 && !/^\d+$/.test(t) && !SQL_SKIP.has(t))
    .forEach(t => terms.add(t));

  // For numbers with explicit k/m suffix, add all format variants:
  // "$100k" → "100000", "100k", "100" (leading digits so "$100,000" also matches)
  const kMatcher = /\$?(\d[\d,]*\.?\d*)\s*([km])\b/gi;
  let m: RegExpExecArray | null;
  while ((m = kMatcher.exec(query)) !== null) {
    const [, digits, suffix] = m;
    const multiplier = suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000;
    const base = parseFloat(digits.replace(/,/g, ''));
    if (!isNaN(base) && base > 0) {
      const value = Math.round(base * multiplier);
      terms.add(String(value));                                              // "100000"
      terms.add((value / 1_000).toFixed(0) + 'k');                         // "100k"
      terms.add(String(Math.round(base)));                                  // "100" (leading digits match "$100,000")
    }
  }

  // Plain integers (years, dollar counts without k/m) — add them verbatim only
  const intMatcher = /\$?(\d[\d,]{2,})\b(?!\s*[km])/gi;
  while ((m = intMatcher.exec(query)) !== null) {
    const digits = m[1].replace(/,/g, '');
    if (/^\d+$/.test(digits)) terms.add(digits);  // "2026", "50000" verbatim
  }

  return Array.from(terms);
}

function scoreCandidate(query: string, market: Market): number {
  const queryTokens = tokenize(query);
  const titleTokens = tokenize(market.title);
  const descTokens = tokenize(market.description);

  if (queryTokens.length === 0) return 0;

  // Numbers must match exactly — "100000" must not match "1000000"
  const isNumeric = (t: string) => /^\d+$/.test(t);
  const tokensMatch = (q: string, t: string): boolean => {
    if (isNumeric(q) || isNumeric(t)) return q === t;
    if (q === t) return true;
    if ((SYNONYMS[q] ?? []).includes(t) || (SYNONYMS[t] ?? []).includes(q)) return true;
    return t.includes(q) || q.includes(t);
  };

  const titleMatches = queryTokens.filter(q => titleTokens.some(t => tokensMatch(q, t))).length;
  const descMatches = queryTokens.filter(q => descTokens.some(t => tokensMatch(q, t))).length;

  const titleScore = titleMatches / queryTokens.length;
  const descScore = descMatches / queryTokens.length;

  // Boost when normalized query is a substring of normalized title (strong signal)
  const normQuery = normalizeText(query);
  const normTitle = normalizeText(market.title);
  const exactBoost = normTitle.includes(normQuery) ? 0.3 : 0;

  // Partial phrase boost: if most query tokens are in the title, stronger signal
  const phraseBoost = titleScore >= 0.8 ? 0.15 : titleScore >= 0.6 ? 0.05 : 0;

  return Math.min(1, titleScore * 0.6 + descScore * 0.15 + exactBoost + phraseBoost);
}

function isTradable(market: Market): boolean {
  return market.status === 'active';
}

function refusalReason(market: Market): string | null {
  if (market.status === 'resolved') return `Market "${market.title}" is already resolved`;
  if (market.status === 'closed') return `Market "${market.title}" is closed`;
  if (market.status === 'paused') return `Market "${market.title}" is paused`;
  if (market.tokens.length < 2) return `Market "${market.title}" has insufficient token data`;
  return null;
}

export async function resolveMarket(
  query: string,
  options: ResolverOptions = {}
): Promise<MarketResolverResult> {
  const {
    minLiquidityUsdc = MIN_LIQUIDITY_USDC,
    confidenceThreshold = CONFIDENCE_THRESHOLD,
    maxCandidates = 5,
  } = options;

  logger.debug({ query }, 'Resolving market query');

  // Extract keywords and search the full market catalogue (not just top-N by liquidity)
  const keywords = extractSearchKeywords(query);
  logger.debug({ keywords }, 'Extracted search keywords');

  let markets = keywords.length > 0
    ? searchMarketsByKeywords({ keywords, status: 'active', minLiquidityUsdc, limit: 150 })
    : [];

  // Fall back to top markets by liquidity if keyword search finds nothing
  if (markets.length < 3) {
    const fallback = searchMarkets({ status: 'active', minLiquidityUsdc, limit: 100 });
    const seen = new Set(markets.map(m => m.marketId));
    markets = [...markets, ...fallback.filter(m => !seen.has(m.marketId))];
  }

  if (markets.length === 0) {
    return {
      query,
      candidates: [],
      ambiguous: false,
      refusalReason: 'No active markets available. Run market ingestion first.',
    };
  }

  const scored = markets
    .map(m => ({ market: m, score: scoreCandidate(query, m) }))
    .filter(s => s.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);

  if (scored.length === 0) {
    return {
      query,
      candidates: [],
      ambiguous: false,
      refusalReason: 'No matching markets found for this query.',
    };
  }

  const top = scored[0];

  if (top.score < confidenceThreshold) {
    return {
      query,
      candidates: [],
      ambiguous: false,
      refusalReason: `Best match confidence (${top.score.toFixed(2)}) is below threshold (${confidenceThreshold}). Query is too ambiguous to trade safely.`,
    };
  }

  // Flag ambiguity when the gap between the top two is small AND both scores are meaningful.
  // No high-confidence bypass: two tied markets at 0.90 are still ambiguous.
  if (scored.length >= 2) {
    const second = scored[1];
    const gap = top.score - second.score;
    if (gap < AMBIGUITY_THRESHOLD && second.score > 0.4) {
      const candidates = scored.map(s => buildCandidate(s.market, s.score));
      logger.warn({ query, topScore: top.score, secondScore: second.score, gap }, 'Ambiguous market resolution');
      return {
        query,
        candidates,
        ambiguous: true,
        refusalReason: 'Multiple similar markets found. Cannot safely determine which market to trade.',
      };
    }
  }

  const candidates: MarketResolverCandidate[] = scored.map(s => buildCandidate(s.market, s.score));

  // Check tradability of top candidate
  const reason = refusalReason(top.market);
  if (reason) {
    return { query, candidates, ambiguous: false, refusalReason: reason };
  }

  return { query, candidates, ambiguous: false, refusalReason: null };
}

function buildCandidate(market: Market, confidence: number): MarketResolverCandidate {
  const yesToken = market.tokens.find(t => t.outcome === 'YES');
  const noToken = market.tokens.find(t => t.outcome === 'NO');
  const meta = market.metadata as { bestBid?: number; bestAsk?: number } | undefined;
  return {
    marketId: market.marketId,
    title: market.title,
    yesTokenId: yesToken?.tokenId ?? '',
    noTokenId: noToken?.tokenId ?? '',
    status: market.status,
    liquidityUsdc: market.liquidityUsdc,
    resolutionDate: market.resolutionDate,
    confidence,
    bestBid: meta?.bestBid ?? null,
    bestAsk: meta?.bestAsk ?? null,
    dataUpdatedAt: market.updatedAt,
  };
}

export async function resolveMarketById(marketId: string): Promise<MarketResolverResult> {
  const market = getMarketById(marketId);
  if (!market) {
    return {
      query: marketId,
      candidates: [],
      ambiguous: false,
      refusalReason: `Market ID "${marketId}" not found in database. Do not trade with unknown market IDs.`,
    };
  }

  const reason = refusalReason(market);
  if (reason) {
    return { query: marketId, candidates: [buildCandidate(market, 1.0)], ambiguous: false, refusalReason: reason };
  }

  return { query: marketId, candidates: [buildCandidate(market, 1.0)], ambiguous: false, refusalReason: null };
}

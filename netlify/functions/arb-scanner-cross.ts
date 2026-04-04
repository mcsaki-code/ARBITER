// V3 DISABLED: Weather-only rebuild. This function is not part of the active pipeline.
// ============================================================
// Netlify Scheduled Function: Cross-Platform Arbitrage Scanner
// Runs every 15 minutes — finds price discrepancies between
// Polymarket and Kalshi for the same events.
//
// STRATEGY: When poly_YES + kalshi_NO < 0.96, buy both sides
// and guarantee a profit regardless of outcome.
// ============================================================

// import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MIN_ARB_EDGE = 0.035;  // 3.5% minimum net edge (after fees)
const POLY_FEE    = 0.0001;  // Polymarket 0.01% fee
const KALSHI_FEE  = 0.07;    // Kalshi ~7% commission on winnings (taken from payout)

// Text similarity — simple token overlap for market matching
function titleSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);

  const tokA = new Set(tokenize(a));
  const tokB = new Set(tokenize(b));
  const intersection = [...tokA].filter(t => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}

// Key phrase extraction for better matching
function extractKeyPhrases(title: string): string[] {
  const t = title.toLowerCase();
  const phrases: string[] = [];

  // Teams
  const teamMatch = t.match(/\b([a-z]+(?:\s[a-z]+)?)\s+(?:win|beat|defeat|over)\b/g);
  if (teamMatch) phrases.push(...teamMatch);

  // Numbers (prices, years, percentages)
  const numbers = t.match(/\b\d+(?:\.\d+)?(?:k|m|b|%|\$)?\b/g);
  if (numbers) phrases.push(...numbers);

  return phrases;
}

interface PolymarketMarket {
  id: string;
  condition_id: string;
  question: string;
  outcome_prices: number[];
  liquidity_usd: number;
  volume_usd: number;
  is_active: boolean;
}

interface KalshiMarketRow {
  ticker: string;
  title: string;
  yes_ask: number;
  no_ask: number;
  yes_bid: number;
  no_bid: number;
  volume: number;
  close_time: string;
  category: string;
}

export const handler = async () => {
  console.log('[arb-scanner-cross] V3 DISABLED — weather-only mode'); return { statusCode: 200 };
  console.log('[arb-cross] Starting cross-platform arbitrage scan');
  const startTime = Date.now();

  // Fetch Polymarket and Kalshi markets in parallel
  const [polyResult, kalshiResult] = await Promise.all([
    supabase
      .from('markets')
      .select('id, condition_id, question, outcome_prices, liquidity_usd, volume_usd, is_active')
      .eq('is_active', true)
      .gt('liquidity_usd', 5000)
      .order('volume_usd', { ascending: false })
      .limit(500),
    supabase
      .from('kalshi_markets')
      .select('ticker, title, yes_ask, no_ask, yes_bid, no_bid, volume, close_time, category')
      .eq('status', 'open')
      .gt('volume', 100)
      .not('ticker', 'like', 'KXMVE%')        // exclude ALL KXMVE* parlay combos (KXMVEC, KXMVES, etc.)
      .not('ticker', 'like', '%MULTIGAME%')   // exclude multi-game extended
      .limit(500),
  ]);

  const polyMarkets = (polyResult.data ?? []) as PolymarketMarket[];
  const kalshiMarkets = (kalshiResult.data ?? []) as KalshiMarketRow[];

  console.log(`[arb-cross] ${polyMarkets.length} Polymarket markets, ${kalshiMarkets.length} Kalshi markets`);

  if (!polyMarkets.length || !kalshiMarkets.length) {
    console.log('[arb-cross] Insufficient markets for comparison');
    return { statusCode: 200 };
  }

  // Find matching pairs
  const arbOpportunities: {
    poly_market_id: string;
    kalshi_ticker: string;
    poly_question: string;
    kalshi_title: string;
    similarity: number;
    // Option A: buy YES on Poly + NO on Kalshi
    costA: number;
    edgeA: number;
    // Option B: buy YES on Kalshi + NO on Poly
    costB: number;
    edgeB: number;
    best_edge: number;
    best_strategy: string;
    poly_yes: number;
    poly_no: number;
    kalshi_yes_ask: number;
    kalshi_no_ask: number;
  }[] = [];

  for (const pm of polyMarkets) {
    if (Date.now() - startTime > 20000) break;
    if (pm.outcome_prices.length < 2) continue;

    const pmYes = pm.outcome_prices[0];
    const pmNo  = pm.outcome_prices[1];

    for (const km of kalshiMarkets) {
      const sim = titleSimilarity(pm.question, km.title);
      if (sim < 0.35) continue; // Minimum similarity threshold

      // Extra validation — at least 2 key phrases must overlap
      const pmPhrases = new Set(extractKeyPhrases(pm.question));
      const kmPhrases = extractKeyPhrases(km.title);
      const phraseOverlap = kmPhrases.filter(p => pmPhrases.has(p)).length;
      if (sim < 0.5 && phraseOverlap < 1) continue;

      // Kalshi effective prices (accounting for their fee structure)
      // Kalshi takes commission from winnings, so effective cost is higher
      const kalshiYesEff = km.yes_ask * (1 + KALSHI_FEE / (1 - km.yes_ask));
      const kalshiNoEff  = km.no_ask  * (1 + KALSHI_FEE / (1 - km.no_ask));

      // Option A: buy YES on Polymarket + buy NO on Kalshi
      // Total cost: pmYes + kalshiNoEff + polyFee
      // Payout: $1.00 regardless of outcome
      const costA = pmYes + kalshiNoEff + POLY_FEE;
      const edgeA = 1.0 - costA;

      // Option B: buy YES on Kalshi + buy NO on Polymarket
      const costB = kalshiYesEff + pmNo + POLY_FEE;
      const edgeB = 1.0 - costB;

      const bestEdge = Math.max(edgeA, edgeB);
      const bestStrategy = edgeA > edgeB ? 'BUY_YES_POLY_NO_KALSHI' : 'BUY_YES_KALSHI_NO_POLY';

      if (bestEdge >= MIN_ARB_EDGE) {
        arbOpportunities.push({
          poly_market_id: pm.id,
          kalshi_ticker: km.ticker,
          poly_question: pm.question,
          kalshi_title: km.title,
          similarity: sim,
          costA, edgeA,
          costB, edgeB,
          best_edge: bestEdge,
          best_strategy: bestStrategy,
          poly_yes: pmYes,
          poly_no: pmNo,
          kalshi_yes_ask: km.yes_ask,
          kalshi_no_ask: km.no_ask,
        });
      }
    }
  }

  arbOpportunities.sort((a, b) => b.best_edge - a.best_edge);
  console.log(`[arb-cross] Found ${arbOpportunities.length} cross-platform arb opportunities (edge >= ${MIN_ARB_EDGE * 100}%)`);

  // Log top opportunities
  for (const arb of arbOpportunities.slice(0, 5)) {
    console.log(`  ${(arb.best_edge * 100).toFixed(1)}% | ${arb.best_strategy} | sim=${arb.similarity.toFixed(2)} | "${arb.poly_question.substring(0, 60)}"`);
  }

  // Store to arb_opportunities table
  if (arbOpportunities.length > 0) {
    // Expire previous cross-platform arbs
    await supabase
      .from('arb_opportunities')
      .update({ status: 'EXPIRED' })
      .eq('status', 'OPEN')
      .eq('platform_b', 'kalshi');

    const rows = arbOpportunities.slice(0, 100).map(arb => ({
      market_a_id: arb.poly_market_id,
      platform_a: 'polymarket',
      platform_b: 'kalshi',
      event_question: arb.poly_question,
      kalshi_ticker: arb.kalshi_ticker,
      kalshi_title: arb.kalshi_title,
      match_similarity: arb.similarity,
      price_yes: arb.poly_yes,
      price_no: arb.poly_no,
      kalshi_yes_ask: arb.kalshi_yes_ask,
      kalshi_no_ask: arb.kalshi_no_ask,
      combined_cost: Math.min(arb.costA, arb.costB),
      gross_edge: arb.best_edge,
      net_edge: arb.best_edge,
      strategy: arb.best_strategy,
      volume_a: 0,
      liquidity_a: 0,
      category: 'cross_platform',
      status: 'OPEN',
      detected_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from('arb_opportunities').insert(rows);
    if (error) console.error('[arb-cross] Insert error:', error.message);
    else console.log(`[arb-cross] Stored ${rows.length} cross-platform arb opportunities`);
  }

  console.log(`[arb-cross] Done in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

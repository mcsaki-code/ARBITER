// ============================================================
// Netlify Scheduled Function: Market Making Scanner
// Runs every 30 minutes — identifies market-making opportunities
//
// This is a SCANNER that identifies opportunities and logs them
// to the arb_opportunities table. We're not executing limit orders
// yet (that requires live trading), but the intelligence layer
// is ready.
//
// Opportunities identified:
// - High liquidity (>$100K) with wide bid-ask spreads
// - Active trading volume
// - Non-trending markets (avoid MM in volatile markets)
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface GammaMarket {
  conditionId: string;
  question: string;
  outcomes: string;
  outcomePrices: string;
  volume: string;
  liquidity: string;
  endDate: string;
  active: boolean;
  closed: boolean;
}

interface MMOpportunity {
  market_id: string;
  question: string;
  mid_price: number;
  spread: number;
  spread_pct: number;
  estimated_profit_pct: number;
  liquidity: number;
  volume: number;
  is_trending: boolean;
  trend_strength: number;
}

// Parse outcome prices
function parseOutcomePrices(raw: string): number[] {
  try {
    return JSON.parse(raw).map((p: string) => parseFloat(p));
  } catch {
    return raw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
  }
}

// Estimate spread based on liquidity tier
// From place-bets.ts logic, adjusted for higher-liquidity markets
function estimateSpread(liquidity: number): number {
  if (liquidity > 500000) return 0.002;    // 0.2% — deep markets
  if (liquidity > 100000) return 0.005;    // 0.5% — good liquidity
  if (liquidity > 50000) return 0.010;     // 1.0%
  if (liquidity > 20000) return 0.015;     // 1.5%
  if (liquidity > 10000) return 0.025;     // 2.5%
  return 0.050;                             // 5.0% — thin markets
}

// Estimate profit from simultaneous BUY_YES + BUY_NO orders
// at ±spread around the mid-price
function estimateMMProfit(midPrice: number, spread: number): number {
  // Market maker places:
  // - BUY_YES limit at (mid - spread)
  // - BUY_NO limit at (1 - mid - spread) = (1 - (mid + spread))
  //
  // If both fill, total cost = (mid - spread) + (1 - (mid + spread))
  //                          = mid - spread + 1 - mid - spread
  //                          = 1 - 2*spread
  // Profit if one order fills and other doesn't = spread
  //
  // Expected value (assuming random fills) = spread * fill_rate
  // Conservative estimate: 0.5 of the spread (50% fill rate)

  const maxSpreadProfit = spread * 0.5;
  return Math.max(0.001, maxSpreadProfit); // min 0.1% profit
}

// Check if market is trending (avoid MM in volatile markets)
// Trend detected if price volatility is high
async function isTrendingMarket(
  marketId: string,
  basePrice: number
): Promise<{ isTrending: boolean; strength: number }> {
  // Fetch recent resolved bets on this market to gauge volatility
  // For MVP: use simple heuristic based on market data patterns
  // A real implementation would fetch order book depth or historical prices

  // Heuristic: if liquidity is very high (>$500K) but volume is low,
  // it's likely a whale-influenced trending market (avoid)
  // If volume is high relative to liquidity, it's liquid and stable (good for MM)

  // For now, return false — all markets are candidates
  // TODO: fetch price history from Gamma API or our own market_snapshots table
  return { isTrending: false, strength: 0 };
}

// Fetch all Polymarket markets
async function fetchAllMarkets(): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  const seenIds = new Set<string>();

  // Parallel fetch (15 pages × 500 = up to 7500 markets)
  const BULK_PAGES = 15;
  const bulkFetches = Array.from({ length: BULK_PAGES }, (_, i) =>
    fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&offset=${i * 500}`,
      { signal: AbortSignal.timeout(10000) }
    )
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  );

  const pages = await Promise.all(bulkFetches);
  for (const page of pages) {
    if (Array.isArray(page)) {
      for (const m of page) {
        if (m.conditionId && !seenIds.has(m.conditionId)) {
          seenIds.add(m.conditionId);
          allMarkets.push(m);
        }
      }
    }
  }

  console.log(`[market-maker] Fetched ${allMarkets.length} active markets`);
  return allMarkets;
}

export const handler = schedule('*/30 * * * *', async () => {
  console.log('[market-maker] Starting market-making opportunity scan');
  const startTime = Date.now();

  // Fetch all markets
  const allMarkets = await fetchAllMarkets();
  if (allMarkets.length === 0) {
    console.log('[market-maker] No markets found');
    return { statusCode: 200 };
  }

  // Scan for opportunities: high liquidity + decent spread
  const opportunities: MMOpportunity[] = [];

  for (const m of allMarkets) {
    const liquidity = parseFloat(m.liquidity);
    const volume = parseFloat(m.volume);

    // Filter: must have high liquidity
    if (liquidity < 100000) continue;

    // Parse prices
    const prices = parseOutcomePrices(m.outcomePrices);

    // For binary markets: compute mid-price and estimate spread
    if (prices.length === 2) {
      const [pYes, pNo] = prices;
      if (pYes <= 0 || pNo <= 0) continue;

      const midPrice = (pYes + pNo) / 2;
      const estimatedSpread = estimateSpread(liquidity);
      const spreadPct = (estimatedSpread / midPrice) * 100;

      // Check if market is trending (avoid if so)
      const trendAnalysis = await isTrendingMarket(m.conditionId, midPrice);

      // Estimate profit from placing both sides
      const mmProfit = estimateMMProfit(midPrice, estimatedSpread);
      const mmProfitPct = (mmProfit / 1.0) * 100;

      // Only track if estimated profit is worthwhile (>0.2%)
      if (mmProfitPct > 0.2) {
        opportunities.push({
          market_id: m.conditionId,
          question: m.question,
          mid_price: midPrice,
          spread: estimatedSpread,
          spread_pct: spreadPct,
          estimated_profit_pct: mmProfitPct,
          liquidity,
          volume,
          is_trending: trendAnalysis.isTrending,
          trend_strength: trendAnalysis.strength,
        });
      }
    }

    // For multi-outcome markets: estimate spread as average of pairs
    if (prices.length > 2) {
      // Simplified: use first two outcomes as proxy for overall spread
      const pFirst = prices[0];
      const pSecond = prices[1];

      if (pFirst > 0 && pSecond > 0) {
        const midPrice = (pFirst + pSecond) / 2;
        const estimatedSpread = estimateSpread(liquidity);
        const spreadPct = (estimatedSpread / midPrice) * 100;

        const mmProfit = estimateMMProfit(midPrice, estimatedSpread);
        const mmProfitPct = (mmProfit / 1.0) * 100;

        if (mmProfitPct > 0.2) {
          opportunities.push({
            market_id: m.conditionId,
            question: m.question,
            mid_price: midPrice,
            spread: estimatedSpread,
            spread_pct: spreadPct,
            estimated_profit_pct: mmProfitPct,
            liquidity,
            volume,
            is_trending: false,
            trend_strength: 0,
          });
        }
      }
    }
  }

  console.log(`[market-maker] Found ${opportunities.length} market-making opportunities (liq >$100K, profit >0.2%)`);

  // Sort by estimated profit descending
  opportunities.sort((a, b) => b.estimated_profit_pct - a.estimated_profit_pct);

  // Log top 5
  console.log('[market-maker] Top 5 opportunities:');
  for (let i = 0; i < Math.min(5, opportunities.length); i++) {
    const opp = opportunities[i];
    console.log(
      `  ${i + 1}. Spread ${(opp.spread_pct).toFixed(2)}% | Profit est. ${opp.estimated_profit_pct.toFixed(2)}% | ` +
      `$${opp.liquidity.toFixed(0)} liq | ${opp.question.substring(0, 70)}`
    );
  }

  // Store to arb_opportunities table
  if (opportunities.length > 0) {
    // Mark all existing OPEN market_making opportunities as EXPIRED (fresh scan replaces them)
    await supabase
      .from('arb_opportunities')
      .update({ status: 'EXPIRED' })
      .eq('status', 'OPEN')
      .eq('category', 'market_making');

    // Insert fresh batch
    const rows = opportunities.map((opp) => ({
      market_a_id: opp.market_id,
      platform_a: 'polymarket',
      event_question: opp.question,
      price_yes: opp.mid_price,
      price_no: 1 - opp.mid_price,
      combined_cost: 1.0,
      gross_edge: opp.estimated_profit_pct / 100,
      net_edge: opp.estimated_profit_pct / 100,
      volume_a: opp.volume,
      liquidity_a: opp.liquidity,
      category: 'market_making',
      status: 'OPEN',
      detected_at: new Date().toISOString(),
      notes: `MM: ${opp.spread_pct.toFixed(2)}% spread, ${opp.estimated_profit_pct.toFixed(2)}% profit est.`,
    }));

    // Insert in chunks
    const chunkSize = 100;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await supabase.from('arb_opportunities').insert(chunk);

      if (error) {
        console.error('[market-maker] Insert error:', error.message);
      } else {
        inserted += chunk.length;
      }
    }
    console.log(`[market-maker] Inserted ${inserted} MM opportunities to arb_opportunities table`);
  }

  // Cleanup: delete expired MM opps older than 24h
  await supabase
    .from('arb_opportunities')
    .delete()
    .eq('status', 'EXPIRED')
    .eq('category', 'market_making')
    .lt('detected_at', new Date(Date.now() - 86400000).toISOString());

  const elapsed = Date.now() - startTime;
  console.log(`[market-maker] Done in ${elapsed}ms. ${opportunities.length} opportunities identified.`);

  return { statusCode: 200 };
});

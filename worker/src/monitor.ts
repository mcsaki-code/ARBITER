/**
 * Market Price Monitor
 * Persistent in-memory state to detect when market prices shift > 3%.
 * On Netlify this is impossible (no state between invocations).
 * On Railway it runs continuously — catches repricing events in real time.
 */

import { SupabaseClient } from '@supabase/supabase-js';

interface MarketSnapshot {
  id: string;
  question: string;
  category: string;
  outcome_prices: number[];
  liquidity_usd: number;
  lastSeenAt: number;
}

// In-memory price cache — persists as long as worker process is alive
const priceCache = new Map<string, MarketSnapshot>();
let totalCycles = 0;

export interface MonitorResult {
  totalActive: number;
  priceShifts: number;
  newMarkets: number;
  cycleMs: number;
}

/**
 * Scan all active markets, compare prices to cached snapshot.
 * Returns list of market IDs that had significant price movement.
 */
export async function scanMarketPrices(supabase: SupabaseClient): Promise<{ result: MonitorResult; changedIds: string[] }> {
  const cycleStart = Date.now();
  totalCycles++;

  const { data: markets, error } = await supabase
    .from('markets')
    .select('id, question, category, outcome_prices, liquidity_usd, resolution_date')
    .eq('is_active', true)
    .gt('liquidity_usd', 400)
    .gt('resolution_date', new Date(Date.now() + 1800000).toISOString())
    .order('liquidity_usd', { ascending: false })
    .limit(2000);

  if (error || !markets) {
    console.error('[monitor] Market fetch error:', error?.message);
    return { result: { totalActive: 0, priceShifts: 0, newMarkets: 0, cycleMs: Date.now() - cycleStart }, changedIds: [] };
  }

  const changedIds: string[] = [];
  let priceShifts = 0;
  let newMarkets = 0;
  const now = Date.now();

  for (const market of markets) {
    const cached = priceCache.get(market.id);

    if (!cached) {
      // First time seeing this market
      newMarkets++;
      priceCache.set(market.id, {
        id: market.id,
        question: market.question,
        category: market.category,
        outcome_prices: market.outcome_prices,
        liquidity_usd: market.liquidity_usd,
        lastSeenAt: now,
      });
      continue;
    }

    // Compare YES price (index 0) to cached
    const currentYesPrice = market.outcome_prices?.[0] ?? 0.5;
    const cachedYesPrice  = cached.outcome_prices?.[0] ?? 0.5;
    const shift = Math.abs(currentYesPrice - cachedYesPrice);

    if (shift >= 0.03) {
      // Price moved 3%+ — flag for re-analysis
      priceShifts++;
      changedIds.push(market.id);
      console.log(
        `[monitor] 🔔 Price shift: ${market.category} "${market.question.substring(0, 60)}" ` +
        `${(cachedYesPrice * 100).toFixed(1)}% → ${(currentYesPrice * 100).toFixed(1)}% ` +
        `(Δ${(shift * 100).toFixed(1)}%)`
      );
    }

    // Update cache
    priceCache.set(market.id, {
      ...cached,
      outcome_prices: market.outcome_prices,
      liquidity_usd: market.liquidity_usd,
      lastSeenAt: now,
    });
  }

  // Prune stale entries from cache (markets no longer in active set)
  const activeIds = new Set(markets.map(m => m.id));
  for (const [id] of priceCache) {
    if (!activeIds.has(id)) priceCache.delete(id);
  }

  const result: MonitorResult = {
    totalActive: markets.length,
    priceShifts,
    newMarkets,
    cycleMs: Date.now() - cycleStart,
  };

  if (totalCycles % 10 === 0 || priceShifts > 0) {
    console.log(`[monitor] Cycle #${totalCycles}: ${markets.length} active, ${newMarkets} new, ${priceShifts} shifts in ${result.cycleMs}ms`);
  }

  return { result, changedIds };
}

export function getCacheSize(): number {
  return priceCache.size;
}

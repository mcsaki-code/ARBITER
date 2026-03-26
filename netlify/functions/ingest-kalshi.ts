// ============================================================
// Netlify Scheduled Function: Ingest Kalshi Markets
// Runs every 15 minutes — fetches Kalshi open markets + prices
// for cross-platform arbitrage detection.
//
// Kalshi market data is PUBLIC — no auth required.
// Auth (KALSHI_API_KEY) only needed for placing orders.
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Primary: main trading API (has BTC, S&P, politics, economics single-event markets)
// Fallback: legacy elections domain (only serves sports parlays)
const KALSHI_BASE = 'https://trading-api.kalshi.com/trade-api/v2';

async function fetchJson(url: string, timeoutMs = 10000): Promise<unknown> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[ingest-kalshi] HTTP ${res.status}: ${url.split('?')[0]}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[ingest-kalshi] Error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  // Kalshi v2 API returns dollar-denominated string fields
  yes_ask_dollars: string;
  no_ask_dollars: string;
  yes_bid_dollars: string;
  no_bid_dollars: string;
  last_price_dollars: string;
  volume_fp: string | number;
  open_interest_fp: string | number;
  close_time: string;
  status: string;  // 'active' in response body, but query uses 'open'
  category?: string;
}

interface KalshiResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

interface KalshiEvent {
  event_ticker: string;
  title: string;
  category: string;
  markets: KalshiMarket[];
}

interface KalshiEventsResponse {
  events: KalshiEvent[];
  cursor?: string;
}

export const handler = schedule('*/15 * * * *', async () => {
  console.log('[ingest-kalshi] Starting Kalshi market ingestion');
  const startTime = Date.now();

  // Fetch markets in parallel across key categories
  const categories = ['Politics', 'Sports', 'Financials', 'Economics', 'Climate'];

  const fetches = categories.map(cat =>
    fetchJson(`${KALSHI_BASE}/markets?status=open&limit=200&category=${cat}`)
      .then(r => ((r as KalshiResponse | null)?.markets ?? []))
  );

  // Also fetch with no category filter for uncategorized markets
  fetches.push(
    fetchJson(`${KALSHI_BASE}/markets?status=open&limit=200`)
      .then(r => ((r as KalshiResponse | null)?.markets ?? []))
  );

  const pages = await Promise.all(fetches);
  const seenTickers = new Set<string>();
  const allMarkets: KalshiMarket[] = [];

  for (const page of pages) {
    for (const m of page) {
      if (!seenTickers.has(m.ticker)) {
        seenTickers.add(m.ticker);
        allMarkets.push(m);
      }
    }
  }

  console.log(`[ingest-kalshi] Fetched ${allMarkets.length} unique Kalshi markets`);

  if (allMarkets.length === 0) {
    console.warn('[ingest-kalshi] No markets returned — Kalshi API may have changed');
    return { statusCode: 200 };
  }

  // Upsert to kalshi_markets table
  // NOTE: Kalshi v2 API response uses 'active' for open markets (not 'open')
  // Prices are in decimal strings e.g. "0.5000" (already 0-1 range)
  //
  // FILTER: Exclude auto-generated parlay/combo markets (KXMVE* tickers).
  // These are multi-leg parlays with no equivalent Polymarket question —
  // they only clutter the DB and make cross-arb matching impossible.
  // Single-event markets have tickers like KXBTCD-*, KXINXD-*, KXFEDRATE-*, etc.
  const rows = allMarkets
    .filter(m => (m.status === 'active' || m.status === 'open') &&
      parseFloat(m.yes_ask_dollars ?? '0') > 0 &&
      parseFloat(m.no_ask_dollars ?? '0') > 0 &&
      !m.ticker.includes('MVEC') &&          // exclude multi-variable event combos
      !m.ticker.includes('MULTIGAME')        // exclude multi-game extended parlays
    )
    .map(m => ({
      ticker: m.ticker,
      event_ticker: m.event_ticker,
      title: m.title,
      subtitle: m.subtitle ?? null,
      yes_ask: parseFloat(m.yes_ask_dollars ?? '0'),   // already decimal 0-1
      no_ask: parseFloat(m.no_ask_dollars ?? '0'),
      yes_bid: parseFloat(m.yes_bid_dollars ?? '0'),
      no_bid: parseFloat(m.no_bid_dollars ?? '0'),
      last_price: parseFloat(m.last_price_dollars ?? '0'),
      volume: parseFloat(String(m.volume_fp ?? '0')),
      open_interest: parseFloat(String(m.open_interest_fp ?? '0')),
      close_time: m.close_time,
      status: 'open',   // normalize to 'open' in our DB
      category: m.category ?? 'other',
      updated_at: new Date().toISOString(),
    }));

  if (rows.length > 0) {
    // Upsert in chunks
    const chunkSize = 200;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const { error } = await supabase
        .from('kalshi_markets')
        .upsert(rows.slice(i, i + chunkSize), { onConflict: 'ticker' });
      if (error) console.error(`[ingest-kalshi] Upsert error chunk ${i}:`, error.message);
      else upserted += rows.slice(i, i + chunkSize).length;
    }
    console.log(`[ingest-kalshi] Upserted ${upserted} Kalshi markets`);
  }

  // Cleanup closed markets
  await supabase
    .from('kalshi_markets')
    .update({ status: 'closed' })
    .lt('close_time', new Date().toISOString());

  console.log(`[ingest-kalshi] Done in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

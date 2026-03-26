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

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

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
  yes_ask: number;   // cents (0-99)
  no_ask: number;
  yes_bid: number;
  no_bid: number;
  last_price: number;
  volume: number;
  open_interest: number;
  close_time: string;
  status: string;
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
  const rows = allMarkets
    .filter(m => m.status === 'open' && m.yes_ask > 0 && m.no_ask > 0)
    .map(m => ({
      ticker: m.ticker,
      event_ticker: m.event_ticker,
      title: m.title,
      subtitle: m.subtitle ?? null,
      yes_ask: m.yes_ask / 100,   // convert cents to decimal
      no_ask: m.no_ask / 100,
      yes_bid: m.yes_bid / 100,
      no_bid: m.no_bid / 100,
      last_price: m.last_price / 100,
      volume: m.volume,
      open_interest: m.open_interest,
      close_time: m.close_time,
      status: m.status,
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

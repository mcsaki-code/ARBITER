/**
 * Kalshi KXHIGH Ingest — cross-platform leg of the reset plan.
 *
 * Snapshots Kalshi's daily-high temperature markets (KXHIGH* series) into
 * `kalshi_snapshots` (append-only). Two downstream uses:
 *   1. DIVERGENCE SIGNAL — when Kalshi and Polymarket price the same
 *      city/date/threshold differently, the average tends to beat either;
 *      the cheap side is a candidate entry. (Test on data before acting.)
 *   2. CROSS-VENUE ARB — YES on one venue + NO on the other when combined
 *      cost < $1 − fees. Mechanical; needs no forecasting skill.
 *
 * Market data is public — no auth needed. KALSHI_API_KEY only for orders.
 */

import { SupabaseClient } from '@supabase/supabase-js';

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Known KXHIGH city series (US cities). The generic prefix query is tried
// first; this list is the fallback if the API requires exact series tickers.
const KNOWN_SERIES = [
  'KXHIGHNY', 'KXHIGHCHI', 'KXHIGHLAX', 'KXHIGHMIA',
  'KXHIGHDEN', 'KXHIGHPHIL', 'KXHIGHAUS', 'KXHIGHT',
];

interface KalshiMarketRaw {
  ticker: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  status?: string;
  close_time?: string;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
  yes_bid?: number | string;
  yes_ask?: number | string;
  last_price?: number | string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume?: number | string;
  volume_fp?: number | string;
  open_interest?: number | string;
  open_interest_fp?: number | string;
}

/** Kalshi prices appear as cents ints (3-97) or dollar strings ("0.03"). Normalize to 0-1. */
export function normKalshiPrice(...candidates: Array<number | string | undefined>): number | null {
  for (const c of candidates) {
    if (c == null) continue;
    const v = typeof c === 'string' ? parseFloat(c) : c;
    if (!Number.isFinite(v)) continue;
    if (v > 1.5) return Math.max(0, Math.min(1, v / 100)); // cents
    return Math.max(0, Math.min(1, v));                     // dollars
  }
  return null;
}

function normNum(...candidates: Array<number | string | undefined>): number | null {
  for (const c of candidates) {
    if (c == null) continue;
    const v = typeof c === 'string' ? parseFloat(c) : c;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchMarkets(seriesTicker: string): Promise<KalshiMarketRaw[]> {
  try {
    const res = await fetch(
      `${KALSHI_BASE}/markets?series_ticker=${seriesTicker}&status=open&limit=200`,
      {
        signal: AbortSignal.timeout(12000),
        headers: { 'Accept': 'application/json', 'User-Agent': 'ARBITER/1.2 (+https://arbit3r.netlify.app)' },
      }
    );
    if (!res.ok) return [];
    const data = await res.json() as { markets?: KalshiMarketRaw[] };
    return data.markets ?? [];
  } catch {
    return [];
  }
}

export async function ingestKalshiSnapshots(
  supabase: SupabaseClient,
  options: { verbose?: boolean } = {}
): Promise<{ markets: number; inserted: number; errors: number }> {
  const verbose = options.verbose ?? true;
  const log = (m: string) => { if (verbose) console.log(`[kalshi-ingest] ${m}`); };
  let errors = 0;

  // Try the generic prefix first (works if the API treats KXHIGH as a family),
  // then fall back to the known city series.
  const byTicker = new Map<string, KalshiMarketRaw>();
  const generic = await fetchMarkets('KXHIGH');
  for (const m of generic) byTicker.set(m.ticker, m);
  if (byTicker.size === 0) {
    for (const s of KNOWN_SERIES) {
      const ms = await fetchMarkets(s);
      for (const m of ms) byTicker.set(m.ticker, m);
      await sleep(250);
    }
  }

  if (byTicker.size === 0) {
    log('No KXHIGH markets returned (API shape may have changed — check series tickers)');
    return { markets: 0, inserted: 0, errors };
  }

  const now = new Date().toISOString();
  const rows = [...byTicker.values()].map((m) => {
    // Ticker form: KXHIGHNY-26JUN12-B82.5 → city hint NY, strike from API fields
    const seriesMatch = m.ticker.match(/^(KXHIGH[A-Z]*)/);
    const cityHint = seriesMatch ? seriesMatch[1].replace('KXHIGH', '') : null;
    const validDate = m.close_time ? m.close_time.slice(0, 10) : null;
    return {
      ticker: m.ticker,
      series: seriesMatch ? seriesMatch[1] : null,
      title: (m.title ?? '').slice(0, 300),
      city_hint: cityHint || null,
      valid_date: validDate,
      strike_type: m.strike_type ?? null,
      floor_f: normNum(m.floor_strike),
      cap_f: normNum(m.cap_strike),
      yes_bid: normKalshiPrice(m.yes_bid, m.yes_bid_dollars),
      yes_ask: normKalshiPrice(m.yes_ask, m.yes_ask_dollars),
      last_price: normKalshiPrice(m.last_price, m.last_price_dollars),
      volume: normNum(m.volume, m.volume_fp),
      open_interest: normNum(m.open_interest, m.open_interest_fp),
      status: m.status ?? null,
      fetched_at: now,
    };
  });

  const { error: insErr } = await supabase.from('kalshi_snapshots').insert(rows);
  if (insErr) { errors++; console.warn(`[kalshi-ingest] insert: ${insErr.message}`); }

  log(`Done: markets=${rows.length} inserted=${insErr ? 0 : rows.length} errors=${errors}`);
  return { markets: rows.length, inserted: insErr ? 0 : rows.length, errors };
}

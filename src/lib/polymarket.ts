// ============================================================
// Polymarket Gamma API Integration
// ============================================================
// gamma-api.polymarket.com — No key, no signup

import { WeatherCity } from './types';

interface GammaMarket {
  conditionId: string;
  question: string;
  outcomes: string;       // JSON string: '["44-45°F","46-47°F",...]'
  outcomePrices: string;  // JSON string: '["0.08","0.62",...]'
  volume: string;
  liquidity: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  tags?: { label: string }[];
}

export interface ParsedMarket {
  condition_id: string;
  question: string;
  category: string;
  outcomes: string[];
  outcome_prices: number[];
  volume_usd: number;
  liquidity_usd: number;
  resolution_date: string;
  is_active: boolean;
}

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// ============================================================
// All tracked cities — must match Supabase weather_cities
// Includes international cities that have active Polymarket markets
// (they use Open-Meteo GFS/ECMWF/ICON even without NWS)
// ============================================================
const CITY_KEYWORDS: Record<string, string[]> = {
  // US cities (NWS + Open-Meteo)
  'New York City': ['new york', 'nyc', 'manhattan'],
  'Chicago': ['chicago'],
  'Miami': ['miami'],
  'Seattle': ['seattle'],
  'Denver': ['denver'],
  'Los Angeles': ['los angeles', 'l.a.'],
  'Oklahoma City': ['oklahoma city', 'okc'],
  'Omaha': ['omaha'],
  'Minneapolis': ['minneapolis', 'twin cities'],
  'Phoenix': ['phoenix'],
  'Atlanta': ['atlanta'],
  'Houston': ['houston'],
  'Dallas': ['dallas'],
  'San Francisco': ['san francisco', 'sf'],
  'Boston': ['boston'],
  'Philadelphia': ['philadelphia', 'philly'],
  'Washington DC': ['washington', 'washington dc', 'd.c.'],
  'Las Vegas': ['las vegas', 'vegas'],
  'Austin': ['austin'],
  'San Antonio': ['san antonio'],
  'Portland': ['portland'],
  'Nashville': ['nashville'],
  'Charlotte': ['charlotte'],
  'Indianapolis': ['indianapolis'],
  'Columbus': ['columbus'],
  'Jacksonville': ['jacksonville'],
  'Memphis': ['memphis'],
  'Detroit': ['detroit'],
  'Milwaukee': ['milwaukee'],
  'Kansas City': ['kansas city'],
  'St. Louis': ['st. louis', 'st louis', 'saint louis'],
  'Tampa': ['tampa'],
  'Orlando': ['orlando'],
  'Baltimore': ['baltimore'],
  'Pittsburgh': ['pittsburgh'],
  'Cincinnati': ['cincinnati'],
  'Cleveland': ['cleveland'],
  'Sacramento': ['sacramento'],
  'San Diego': ['san diego'],
  'Raleigh': ['raleigh'],
  'Salt Lake City': ['salt lake city', 'salt lake'],
  'New Orleans': ['new orleans'],
  // International cities (Open-Meteo only)
  'London': ['london'],
  'Tel Aviv': ['tel aviv'],
  'Tokyo': ['tokyo'],
  'Paris': ['paris'],
  'Toronto': ['toronto'],
  'Seoul': ['seoul'],
  'Sydney': ['sydney'],
  'Dubai': ['dubai'],
  'Berlin': ['berlin'],
  'Madrid': ['madrid'],
  'Rome': ['rome'],
  'Mumbai': ['mumbai'],
  'Singapore': ['singapore'],
  'Mexico City': ['mexico city'],
  'Cairo': ['cairo'],
  'Bangkok': ['bangkok'],
  'Istanbul': ['istanbul'],
  'São Paulo': ['são paulo', 'sao paulo'],
  'Buenos Aires': ['buenos aires'],
};

// ============================================================
// Weather market validation — CRITICAL filter
// This runs server-side to prevent sports/politics from entering the DB
// ============================================================
const WEATHER_POSITIVE = [
  'temperature', 'weather', '°f', '°c', 'degrees fahrenheit', 'degrees celsius',
  'high temp', 'low temp', 'precipitation', 'rainfall', 'snowfall',
  'hurricane', 'tropical storm', 'heat wave', 'cold snap', 'frost',
  'wind chill', 'heat index', 'daily high', 'daily low',
  'warmest', 'coldest', 'record high', 'record low',
];

// Terms that indicate this is NOT a weather market even if it contains weather-like words
const WEATHER_NEGATIVE = [
  'nba', 'nfl', 'mlb', 'nhl', 'ncaa', 'premier league', 'champions league',
  'world cup', 'ufc', 'mma', 'boxing', 'tennis', 'golf', 'f1', 'formula',
  'election', 'president', 'congress', 'senate', 'democrat', 'republican',
  'bitcoin', 'ethereum', 'crypto', 'stock', 'nasdaq', 's&p',
  'touchdown', 'field goal', 'three-pointer', 'home run', 'strikeout',
  'assists', 'rebounds', 'rushing', 'passing yards', 'sacks',
  'points scored', 'total points', 'over under', 'spread',
  'winner of', 'win the', 'championship', 'playoff', 'super bowl',
  'world series', 'stanley cup', 'finals', 'mvp',
  'oscar', 'emmy', 'grammy', 'box office',
];

export function isWeatherMarket(question: string): boolean {
  const q = question.toLowerCase();

  // First check: reject if it matches any negative (sports/politics/crypto) term
  for (const term of WEATHER_NEGATIVE) {
    if (q.includes(term)) return false;
  }

  // Second check: must match at least one positive weather term
  for (const term of WEATHER_POSITIVE) {
    if (q.includes(term)) return true;
  }

  // Third check: if question mentions a tracked city AND contains degree-like patterns
  // e.g., "What will the high be in NYC?" or "Will it be above 80 in Chicago?"
  const degreesPattern = /\d+\s*°|above \d+|below \d+|over \d+|under \d+/;
  const hasCityMention = Object.values(CITY_KEYWORDS).flat().some((kw) => q.includes(kw));

  if (hasCityMention && degreesPattern.test(q)) return true;

  return false;
}

export function matchCityToMarket(
  question: string,
  cities: WeatherCity[]
): string | null {
  const q = question.toLowerCase();
  for (const city of cities) {
    const keywords = CITY_KEYWORDS[city.name] || [city.name.toLowerCase()];
    for (const kw of keywords) {
      if (q.includes(kw)) return city.id;
    }
  }
  return null;
}

function parseGammaMarket(m: GammaMarket): ParsedMarket | null {
  try {
    let outcomes: string[];
    let outcomePrices: number[];

    try {
      outcomes = JSON.parse(m.outcomes);
    } catch {
      outcomes = m.outcomes.split(',').map((s: string) => s.trim());
    }

    try {
      const priceStrs = JSON.parse(m.outcomePrices);
      outcomePrices = priceStrs.map((p: string) => parseFloat(p));
    } catch {
      outcomePrices = m.outcomePrices.split(',').map((s: string) => parseFloat(s.trim()));
    }

    const tagLabels = m.tags?.map((t) => t.label.toLowerCase()) || [];
    const q = m.question.toLowerCase();

    // Classify market type
    let category = 'weather';
    if (q.includes('precipitation') || q.includes('rainfall') || q.includes('rain') || tagLabels.includes('precipitation')) {
      category = 'precipitation';
    } else if (q.includes('snowfall') || q.includes('snow')) {
      category = 'snowfall';
    } else if (tagLabels.includes('temperature') || q.includes('temperature') || q.includes('°f') || q.includes('°c')) {
      category = 'temperature';
    } else if (tagLabels.includes('climate') || q.includes('climate') || q.includes('global temp')) {
      category = 'climate';
    }

    return {
      condition_id: m.conditionId,
      question: m.question,
      category,
      outcomes,
      outcome_prices: outcomePrices,
      volume_usd: parseFloat(m.volume) || 0,
      liquidity_usd: parseFloat(m.liquidity) || 0,
      resolution_date: m.endDate,
      is_active: m.active && !m.closed,
    };
  } catch {
    return null;
  }
}

export async function fetchPolymarketWeatherMarkets(): Promise<ParsedMarket[]> {
  try {
    const params = new URLSearchParams({
      tag: 'temperature',
      active: 'true',
      limit: '100',
    });

    const res = await fetch(`${GAMMA_BASE}/markets?${params}`, {
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`Polymarket Gamma API error: ${res.status}`);
      return [];
    }

    const rawMarkets: GammaMarket[] = await res.json();
    const markets: ParsedMarket[] = [];

    for (const m of rawMarkets) {
      // Server-side weather filter
      if (!isWeatherMarket(m.question)) continue;

      const parsed = parseGammaMarket(m);
      if (parsed) markets.push(parsed);
    }

    return markets;
  } catch (err) {
    console.error('Polymarket fetch failed:', err);
    return [];
  }
}

export async function fetchPolymarketAllWeather(): Promise<ParsedMarket[]> {
  const results: ParsedMarket[] = [];

  // Search ALL weather-related tags
  for (const tag of ['temperature', 'weather', 'precipitation', 'climate', 'climate-weather']) {
    try {
      const params = new URLSearchParams({
        tag,
        active: 'true',
        limit: '100',
      });

      const res = await fetch(`${GAMMA_BASE}/markets?${params}`, {
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) continue;
      const rawMarkets: GammaMarket[] = await res.json();

      for (const m of rawMarkets) {
        if (results.some((r) => r.condition_id === m.conditionId)) continue;
        if (!isWeatherMarket(m.question)) continue;

        const parsed = parseGammaMarket(m);
        if (parsed) results.push(parsed);
      }
    } catch {
      // skip tag
    }
  }

  return results;
}

// Re-export CITY_KEYWORDS for use by other modules
export { CITY_KEYWORDS };

// ============================================================
// Phase 1 — Volume-Spike Exit Trigger (Dry-Run)
// ============================================================
// Helpers for the position monitor. All read-only against the
// public Polymarket Data API (no auth needed).
//
// Verified 2026-05-01 against `https://data-api.polymarket.com/trades`:
//   - `market=<conditionId>` filter works
//   - returns trades sorted DESC by `timestamp` (unix seconds)
//   - per-trade fields used here: timestamp, size, price, side
//   - server-side cap: requests for limit > 1000 are silently capped
//     at 1000. Confirmed via probe: `?market=…&limit=2000` returned
//     1000 trades.
//
// For ARBITER's weather-only universe (low volume) 1000 trades easily
// covers > 24h. For the high-volume markets we'd hit in the future,
// 1000 trades may be < 24h and the baseline would reflect recent flow
// rather than a true 24h average — paginate with `offset` if so.
// ============================================================

const DATA_API_BASE = 'https://data-api.polymarket.com';
const DATA_API_TIMEOUT_MS = 8000;

interface DataApiTrade {
  timestamp: number; // unix seconds
  size: number;
  price: number;
  side: 'BUY' | 'SELL';
  conditionId: string;
  asset: string;
}

/**
 * Fetch raw trades for a market from the public data API.
 * Returns [] on any error (fail-open contract for the monitor).
 */
async function fetchMarketTrades(
  conditionId: string,
  limit = 500
): Promise<DataApiTrade[]> {
  try {
    const params = new URLSearchParams({
      market: conditionId,
      limit: String(limit),
    });
    const res = await fetch(`${DATA_API_BASE}/trades?${params}`, {
      signal: AbortSignal.timeout(DATA_API_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[polymarket] data-api /trades ${res.status} for ${conditionId.slice(0, 12)}…`);
      return [];
    }
    const trades = (await res.json()) as DataApiTrade[];
    return Array.isArray(trades) ? trades : [];
  } catch (err) {
    console.warn(
      `[polymarket] data-api /trades failed for ${conditionId.slice(0, 12)}…:`,
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * USD-equivalent trade volume for a market over the trailing N minutes.
 * Sums (size * price) for trades where `now - timestamp <= windowMinutes`.
 *
 * USD-denominated to match the rest of the schema (markets.volume_usd,
 * markets.liquidity_usd are all USD). Treats BUY and SELL identically —
 * we care about flow, not direction.
 *
 * Returns 0 on error. Phase 1 is dry-run; never throws.
 */
export async function getRecentVolume(
  conditionId: string,
  windowMinutes: number
): Promise<number> {
  const trades = await fetchMarketTrades(conditionId, 500);
  if (trades.length === 0) return 0;

  const cutoff = Math.floor(Date.now() / 1000) - windowMinutes * 60;
  let total = 0;
  for (const t of trades) {
    if (t.timestamp < cutoff) continue;
    const size = Number(t.size) || 0;
    const price = Number(t.price) || 0;
    total += size * price;
  }
  return total;
}

/**
 * Average USD-equivalent trade volume per `windowMinutes` window over the
 * trailing `hours` hours. Used as the rolling baseline for spike detection.
 *
 * Implementation: pull up to 1000 recent trades (server-side cap), bucket
 * by integer-divided window-index, average across buckets that contain at
 * least one trade. Empty buckets are excluded — averaging over
 * time-elapsed/window would understate baselines for sleepy markets and
 * trip false alerts.
 *
 * Returns 0 on error or insufficient data. The monitor treats 0 as
 * "no usable baseline" and skips the alert check.
 */
export async function getTrailingVolumeAverage(
  conditionId: string,
  hours: number,
  windowMinutes: number
): Promise<number> {
  const trades = await fetchMarketTrades(conditionId, 1000);
  if (trades.length === 0) return 0;

  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  const windowSeconds = windowMinutes * 60;

  // Bucket key = floor(timestamp / windowSeconds). Each bucket holds the
  // sum of (size*price) for trades that fell inside that window.
  const buckets = new Map<number, number>();
  for (const t of trades) {
    if (t.timestamp < cutoff) continue;
    const bucket = Math.floor(t.timestamp / windowSeconds);
    const size = Number(t.size) || 0;
    const price = Number(t.price) || 0;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + size * price);
  }

  if (buckets.size === 0) return 0;
  let sum = 0;
  for (const v of buckets.values()) sum += v;
  return sum / buckets.size;
}

/**
 * Best-effort current price for a market outcome.
 *
 * Uses Gamma's `/markets?condition_ids=…` (PLURAL) filter — verified
 * 2026-05-01 to return the matching market correctly for both sports
 * and weather conditionIds. The memory `feedback_gamma_api` warning
 * is about the SINGULAR `?condition_id=` filter (which returns random
 * legacy 2020-era markets); the plural batch filter is the documented
 * working endpoint.
 *
 * Falls through to null on any error so the monitor can fall back to
 * its own DB read of `markets.outcome_prices`.
 *
 * @param conditionId Polymarket condition_id
 * @param outcomeIdx 0 = YES (default), 1 = NO
 */
export async function getCurrentMidPrice(
  conditionId: string,
  outcomeIdx = 0
): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      condition_ids: conditionId,
      limit: '1',
    });
    const res = await fetch(`${GAMMA_BASE}/markets?${params}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as GammaMarket[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];

    let prices: number[] = [];
    try {
      const parsed = JSON.parse(row.outcomePrices);
      prices = parsed.map((p: string) => parseFloat(p));
    } catch {
      prices = row.outcomePrices.split(',').map((s) => parseFloat(s.trim()));
    }
    const price = prices[outcomeIdx];
    if (!Number.isFinite(price)) return null;
    return price;
  } catch {
    return null;
  }
}


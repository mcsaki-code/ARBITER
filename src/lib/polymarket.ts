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

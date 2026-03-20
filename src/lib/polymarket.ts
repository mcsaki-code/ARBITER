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

// City name keywords for matching markets to cities
const CITY_KEYWORDS: Record<string, string[]> = {
  'New York City': ['new york', 'nyc', 'manhattan'],
  'Chicago': ['chicago'],
  'Miami': ['miami'],
  'Seattle': ['seattle'],
  'Denver': ['denver'],
  'Los Angeles': ['los angeles', 'la', 'l.a.'],
  'London': ['london'],
  'Tel Aviv': ['tel aviv'],
  'Tokyo': ['tokyo'],
  'Paris': ['paris'],
};

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

export async function fetchPolymarketWeatherMarkets(): Promise<ParsedMarket[]> {
  try {
    // Try temperature tag first
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
      try {
        // Parse outcomes and prices — Gamma returns these as JSON strings
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

        // Determine category from tags or question
        const tagLabels = m.tags?.map((t) => t.label.toLowerCase()) || [];
        let category = 'weather';
        if (tagLabels.includes('temperature') || m.question.toLowerCase().includes('temperature')) {
          category = 'temperature';
        }

        markets.push({
          condition_id: m.conditionId,
          question: m.question,
          category,
          outcomes,
          outcome_prices: outcomePrices,
          volume_usd: parseFloat(m.volume) || 0,
          liquidity_usd: parseFloat(m.liquidity) || 0,
          resolution_date: m.endDate,
          is_active: m.active && !m.closed,
        });
      } catch (err) {
        console.error(`Failed to parse market ${m.conditionId}:`, err);
      }
    }

    return markets;
  } catch (err) {
    console.error('Polymarket fetch failed:', err);
    return [];
  }
}

// Also fetch weather-tagged markets as backup
export async function fetchPolymarketAllWeather(): Promise<ParsedMarket[]> {
  const results: ParsedMarket[] = [];

  for (const tag of ['temperature', 'weather']) {
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
        // Skip if already have this market
        if (results.some((r) => r.condition_id === m.conditionId)) continue;

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

          results.push({
            condition_id: m.conditionId,
            question: m.question,
            category: tag,
            outcomes,
            outcome_prices: outcomePrices,
            volume_usd: parseFloat(m.volume) || 0,
            liquidity_usd: parseFloat(m.liquidity) || 0,
            resolution_date: m.endDate,
            is_active: m.active && !m.closed,
          });
        } catch {
          // skip malformed
        }
      }
    } catch {
      // skip tag
    }
  }

  return results;
}

// ============================================================
// Netlify Scheduled Function: Refresh Markets
// Runs every 30 minutes — fetches active weather markets from Polymarket
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

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  markets: GammaMarket[];
}

// City keyword matching
const CITY_KEYWORDS: Record<string, string[]> = {
  'New York City': ['new york', 'nyc', 'manhattan'],
  Chicago: ['chicago'],
  Miami: ['miami'],
  Seattle: ['seattle'],
  Denver: ['denver'],
  'Los Angeles': ['los angeles', 'la ', 'l.a.'],
  London: ['london'],
  'Tel Aviv': ['tel aviv'],
  Tokyo: ['tokyo'],
  Paris: ['paris'],
  'Oklahoma City': ['oklahoma city', 'okc'],
  Omaha: ['omaha'],
  Minneapolis: ['minneapolis', 'twin cities'],
  Phoenix: ['phoenix'],
  Atlanta: ['atlanta'],
};

async function fetchGamma(url: string): Promise<unknown[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      console.log(`[refresh-markets] ${url} returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`[refresh-markets] Fetch error: ${url}`, err);
    return [];
  }
}

export const handler = schedule('*/30 * * * *', async () => {
  console.log('[refresh-markets] Starting market refresh');

  // Get cities for matching
  const { data: cities } = await supabase
    .from('weather_cities')
    .select('id, name')
    .eq('is_active', true);

  const cityLookup = new Map<string, string>();
  if (cities) {
    for (const city of cities) {
      const keywords = CITY_KEYWORDS[city.name] || [city.name.toLowerCase()];
      for (const kw of keywords) {
        cityLookup.set(kw, city.id);
      }
    }
  }

  function matchCity(question: string): string | null {
    const q = question.toLowerCase();
    for (const [kw, id] of cityLookup) {
      if (q.includes(kw)) return id;
    }
    return null;
  }

  // ======== MULTI-STRATEGY SEARCH ========
  // Strategy 1: Tag-based search (markets endpoint)
  // Strategy 2: Text search on markets
  // Strategy 3: Events endpoint with tag
  // Strategy 4: Events endpoint with text search
  // Strategy 5: Broader keyword search

  const allMarkets: GammaMarket[] = [];
  const seenIds = new Set<string>();

  function addMarket(m: GammaMarket) {
    if (!seenIds.has(m.conditionId)) {
      seenIds.add(m.conditionId);
      allMarkets.push(m);
    }
  }

  // Strategy 1 & 2: Direct market search with tags and text
  const marketSearches = [
    'https://gamma-api.polymarket.com/markets?tag=temperature&active=true&closed=false&limit=100',
    'https://gamma-api.polymarket.com/markets?tag=weather&active=true&closed=false&limit=100',
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=temperature',
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=weather+high',
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=degrees',
  ];

  for (const url of marketSearches) {
    const results = (await fetchGamma(url)) as GammaMarket[];
    for (const m of results) {
      if (m.conditionId && m.question) addMarket(m);
    }
  }

  // Strategy 3 & 4: Events endpoint
  const eventSearches = [
    'https://gamma-api.polymarket.com/events?tag=temperature&active=true&closed=false&limit=50',
    'https://gamma-api.polymarket.com/events?tag=weather&active=true&closed=false&limit=50',
    'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&search=temperature',
    'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&search=weather+high',
  ];

  for (const url of eventSearches) {
    const events = (await fetchGamma(url)) as GammaEvent[];
    for (const event of events) {
      if (event.markets && Array.isArray(event.markets)) {
        for (const m of event.markets) {
          if (m.conditionId && m.question) addMarket(m);
        }
      }
    }
  }

  console.log(`[refresh-markets] Found ${allMarkets.length} markets across all strategies`);

  // Upsert each market
  let upserted = 0;
  for (const m of allMarkets) {
    try {
      let outcomes: string[];
      let outcomePrices: number[];

      try {
        outcomes = JSON.parse(m.outcomes);
      } catch {
        outcomes = m.outcomes?.split(',').map((s: string) => s.trim()) || ['Yes', 'No'];
      }

      try {
        outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p));
      } catch {
        outcomePrices = m.outcomePrices?.split(',').map((s: string) => parseFloat(s.trim())) || [0.5, 0.5];
      }

      const cityId = matchCity(m.question);
      const q = m.question.toLowerCase();
      const category = q.includes('temperature') || q.includes('°f') || q.includes('°c') || q.includes('degrees')
        ? 'temperature'
        : 'weather';

      const { error } = await supabase.from('markets').upsert(
        {
          condition_id: m.conditionId,
          question: m.question,
          category,
          city_id: cityId,
          outcomes,
          outcome_prices: outcomePrices,
          volume_usd: parseFloat(m.volume) || 0,
          liquidity_usd: parseFloat(m.liquidity) || 0,
          resolution_date: m.endDate,
          is_active: m.active && !m.closed,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'condition_id' }
      );

      if (!error) upserted++;
      else console.error(`[refresh-markets] Upsert error for ${m.conditionId}:`, error.message);
    } catch (err) {
      console.error(`[refresh-markets] Error processing ${m.conditionId}:`, err);
    }
  }

  // Mark old markets as inactive (not updated in last 2 hours)
  await supabase
    .from('markets')
    .update({ is_active: false })
    .lt('updated_at', new Date(Date.now() - 7200000).toISOString())
    .eq('is_active', true);

  console.log(`[refresh-markets] Done. Upserted ${upserted} markets`);
  return { statusCode: 200 };
});

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
};

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

  // Fetch from Gamma API
  const markets: GammaMarket[] = [];
  for (const tag of ['temperature', 'weather']) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?tag=${tag}&active=true&limit=100`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) continue;
      const data: GammaMarket[] = await res.json();
      for (const m of data) {
        if (!markets.some((e) => e.conditionId === m.conditionId)) {
          markets.push(m);
        }
      }
    } catch (err) {
      console.error(`[refresh-markets] Fetch error for tag=${tag}:`, err);
    }
  }

  console.log(`[refresh-markets] Found ${markets.length} markets`);

  // Upsert each market
  for (const m of markets) {
    try {
      let outcomes: string[];
      let outcomePrices: number[];

      try {
        outcomes = JSON.parse(m.outcomes);
      } catch {
        outcomes = m.outcomes.split(',').map((s: string) => s.trim());
      }

      try {
        outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p));
      } catch {
        outcomePrices = m.outcomePrices.split(',').map((s: string) => parseFloat(s.trim()));
      }

      const cityId = matchCity(m.question);

      await supabase.from('markets').upsert(
        {
          condition_id: m.conditionId,
          question: m.question,
          category: m.question.toLowerCase().includes('temperature') ? 'temperature' : 'weather',
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
    } catch (err) {
      console.error(`[refresh-markets] Error processing ${m.conditionId}:`, err);
    }
  }

  // Mark old markets as inactive
  await supabase
    .from('markets')
    .update({ is_active: false })
    .lt('updated_at', new Date(Date.now() - 3600000).toISOString())
    .eq('is_active', true);

  console.log('[refresh-markets] Done');
  return { statusCode: 200 };
});

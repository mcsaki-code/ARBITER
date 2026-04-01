// ============================================================
// Netlify Scheduled Function: Refresh Markets
// Runs every 30 minutes — fetches active weather markets from Polymarket
// Filters out sports/politics/crypto at ingestion time
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

// ============================================================
// All tracked cities (US + international with Polymarket markets)
// ============================================================
const CITY_KEYWORDS: Record<string, string[]> = {
  'New York City': ['new york', 'nyc', 'manhattan'],
  Chicago: ['chicago'],
  Miami: ['miami'],
  Seattle: ['seattle'],
  Denver: ['denver'],
  'Los Angeles': ['los angeles', 'l.a.'],
  'Oklahoma City': ['oklahoma city', 'okc'],
  Omaha: ['omaha'],
  Minneapolis: ['minneapolis', 'twin cities'],
  Phoenix: ['phoenix'],
  Atlanta: ['atlanta'],
  Houston: ['houston'],
  Dallas: ['dallas'],
  'San Francisco': ['san francisco', 'sf'],
  Boston: ['boston'],
  Philadelphia: ['philadelphia', 'philly'],
  'Washington DC': ['washington', 'washington dc', 'd.c.'],
  'Las Vegas': ['las vegas', 'vegas'],
  Austin: ['austin'],
  'San Antonio': ['san antonio'],
  Portland: ['portland'],
  Nashville: ['nashville'],
  Charlotte: ['charlotte'],
  Indianapolis: ['indianapolis'],
  Columbus: ['columbus'],
  Jacksonville: ['jacksonville'],
  Memphis: ['memphis'],
  Detroit: ['detroit'],
  Milwaukee: ['milwaukee'],
  'Kansas City': ['kansas city'],
  'St. Louis': ['st. louis', 'st louis', 'saint louis'],
  Tampa: ['tampa'],
  Orlando: ['orlando'],
  Baltimore: ['baltimore'],
  Pittsburgh: ['pittsburgh'],
  Cincinnati: ['cincinnati'],
  Cleveland: ['cleveland'],
  Sacramento: ['sacramento'],
  'San Diego': ['san diego'],
  Raleigh: ['raleigh'],
  'Salt Lake City': ['salt lake city', 'salt lake'],
  'New Orleans': ['new orleans'],
  London: ['london'],
  'Tel Aviv': ['tel aviv'],
  Tokyo: ['tokyo'],
  Paris: ['paris'],
  Toronto: ['toronto'],
  Seoul: ['seoul'],
  Sydney: ['sydney'],
  Dubai: ['dubai'],
  Berlin: ['berlin'],
  Madrid: ['madrid'],
  Rome: ['rome'],
  Mumbai: ['mumbai'],
  Singapore: ['singapore'],
  'Mexico City': ['mexico city'],
  Cairo: ['cairo'],
  Bangkok: ['bangkok'],
  Istanbul: ['istanbul'],
  'São Paulo': ['são paulo', 'sao paulo'],
  'Buenos Aires': ['buenos aires'],
};

// ============================================================
// Weather market filter — prevents sports/politics from entering DB
// ============================================================
const WEATHER_POSITIVE = [
  'temperature', 'weather', '°f', '°c', 'degrees fahrenheit', 'degrees celsius',
  'high temp', 'low temp', 'precipitation', 'rainfall', 'snowfall',
  'hurricane', 'tropical storm', 'heat wave', 'cold snap', 'frost',
  'wind chill', 'heat index', 'daily high', 'daily low',
  'warmest', 'coldest', 'record high', 'record low',
];

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

function isWeatherMarket(question: string): boolean {
  const q = question.toLowerCase();

  for (const term of WEATHER_NEGATIVE) {
    if (q.includes(term)) return false;
  }

  for (const term of WEATHER_POSITIVE) {
    if (q.includes(term)) return true;
  }

  const degreesPattern = /\d+\s*°|above \d+|below \d+|over \d+|under \d+/;
  const hasCityMention = Object.values(CITY_KEYWORDS).flat().some((kw) => q.includes(kw));
  if (hasCityMention && degreesPattern.test(q)) return true;

  return false;
}

async function fetchGamma(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      console.log(`[refresh-markets] ${url} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[refresh-markets] Fetch error: ${url}`, err);
    return null;
  }
}

export const handler = schedule('*/30 * * * *', async () => {
  console.log('[refresh-markets] Starting market refresh');

  // Get cities for matching (active only from DB)
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

  // ======== TAG-BASED MARKET DISCOVERY (via tag_id) ========
  // Per Polymarket docs: tag_id is the QUERY param for /events and /markets,
  // while tag_slug is a PATH param only for /tags/slug/{slug} lookup.
  const allMarkets: GammaMarket[] = [];
  const seenIds = new Set<string>();

  function addMarket(m: GammaMarket) {
    if (m.conditionId && !seenIds.has(m.conditionId)) {
      seenIds.add(m.conditionId);
      allMarkets.push(m);
    }
  }

  const PAGE_SIZE = 100;
  const MAX_PAGES = 5;

  // Step 1: Resolve tag slugs → tag IDs
  const tagSlugs = ['temperature', 'weather', 'climate'];
  const tagIds: number[] = [];

  for (const slug of tagSlugs) {
    const tag = await fetchGamma(
      `https://gamma-api.polymarket.com/tags/slug/${slug}`
    ) as { id?: number } | null;
    if (tag?.id) {
      tagIds.push(tag.id);
      console.log(`[refresh-markets] Tag "${slug}" → id ${tag.id}`);
    } else {
      console.log(`[refresh-markets] Tag "${slug}" → not found`);
    }
  }

  // Step 2: For each tag_id, paginate through events and markets
  for (const tagId of tagIds) {
    // Events (contain nested bracket markets)
    for (let offset = 0; offset < MAX_PAGES * PAGE_SIZE; offset += PAGE_SIZE) {
      const page = await fetchGamma(
        `https://gamma-api.polymarket.com/events?tag_id=${tagId}&active=true&closed=false&limit=${PAGE_SIZE}&offset=${offset}`
      );
      if (!Array.isArray(page) || page.length === 0) break;
      for (const event of page as GammaEvent[]) {
        if (event.markets && Array.isArray(event.markets)) {
          for (const m of event.markets) addMarket(m);
        }
      }
      if (page.length < PAGE_SIZE) break;
    }

    // Markets directly (some may not be nested in events)
    for (let offset = 0; offset < MAX_PAGES * PAGE_SIZE; offset += PAGE_SIZE) {
      const page = await fetchGamma(
        `https://gamma-api.polymarket.com/markets?tag_id=${tagId}&active=true&closed=false&limit=${PAGE_SIZE}&offset=${offset}`
      );
      if (!Array.isArray(page) || page.length === 0) break;
      for (const m of page as GammaMarket[]) addMarket(m);
      if (page.length < PAGE_SIZE) break;
    }
  }

  // Step 3: Fallback — dedicated /search endpoint with keyword
  const searchData = await fetchGamma(
    'https://gamma-api.polymarket.com/search?keyword=temperature&limit=100'
  ) as { markets?: GammaMarket[]; events?: GammaEvent[] } | null;

  if (searchData?.markets) {
    for (const m of searchData.markets) addMarket(m);
  }
  if (searchData?.events) {
    for (const event of searchData.events) {
      if (event.markets && Array.isArray(event.markets)) {
        for (const m of event.markets) addMarket(m);
      }
    }
  }

  console.log(`[refresh-markets] Found ${allMarkets.length} unique markets across all strategies`);

  // ======== WEATHER FILTER — reject non-weather markets ========
  const weatherOnly = allMarkets.filter((m) => isWeatherMarket(m.question));
  const rejected = allMarkets.length - weatherOnly.length;
  if (rejected > 0) {
    console.log(`[refresh-markets] Filtered out ${rejected} non-weather markets`);
  }
  console.log(`[refresh-markets] ${weatherOnly.length} weather markets to upsert`);

  // Upsert each weather market
  let upserted = 0;
  for (const m of weatherOnly) {
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
          is_active: m.active && !m.closed && new Date(m.endDate) > new Date(),
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

  // Mark expired markets as inactive based on resolution_date (primary check)
  await supabase
    .from('markets')
    .update({ is_active: false })
    .lt('resolution_date', new Date().toISOString())
    .eq('is_active', true);

  // Also mark old weather markets as inactive if not refreshed in 2 hours
  // (catches markets removed from Polymarket's API before resolution)
  await supabase
    .from('markets')
    .update({ is_active: false })
    .lt('updated_at', new Date(Date.now() - 7200000).toISOString())
    .eq('is_active', true)
    .not('city_id', 'is', null);  // weather markets only

  console.log(`[refresh-markets] Done. Upserted ${upserted} weather markets`);
  return { statusCode: 200 };
});

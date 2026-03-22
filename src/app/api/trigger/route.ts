import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ============================================================
// Manual Pipeline Trigger — lightweight version
// GET /api/trigger — ingest weather (3 cities) + refresh markets + log results
// Designed to complete within Netlify's 10s function timeout
// ============================================================

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
  'high temp', 'low temp', 'highest temperature', 'lowest temperature',
  'precipitation', 'rainfall', 'snowfall',
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

async function safeFetchJson(url: string, timeoutMs = 6000): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET() {
  const log: string[] = [];

  try {
    const supabase = getSupabaseAdmin();
    const startTime = Date.now();

    // ======== STEP 1: Get cities from DB ========
    // Weather ingestion is handled by ingest-weather.ts (every 15 min).
    // This trigger focuses on market discovery + upsert to stay within 10s.
    log.push('STEP 1: Loading cities');

    const { data: cities, error: citiesErr } = await supabase
      .from('weather_cities')
      .select('*')
      .eq('is_active', true);

    if (citiesErr || !cities) {
      log.push(`ERROR fetching cities: ${citiesErr?.message || 'no data'}`);
      return NextResponse.json({ success: false, log }, { status: 500 });
    }

    log.push(`Found ${cities.length} active cities`);
    // ======== STEP 2: Market Search via tag_id ========
    // Weather ingestion is handled by scheduled functions (ingest-weather.ts every 15 min).
    // This trigger ONLY refreshes markets to stay within Netlify's 10s limit.
    log.push('STEP 2: Market search');

    const cityLookup = new Map<string, string>();
    for (const city of cities) {
      const keywords = CITY_KEYWORDS[city.name] || [city.name.toLowerCase()];
      for (const kw of keywords) cityLookup.set(kw, city.id);
    }

    function matchCity(question: string): string | null {
      const q = question.toLowerCase();
      for (const [kw, id] of cityLookup) {
        if (q.includes(kw)) return id;
      }
      return null;
    }

    const seenIds = new Set<string>();
    const allMarkets: GammaMarket[] = [];

    function addMarket(m: GammaMarket) {
      if (m.conditionId && !seenIds.has(m.conditionId)) {
        seenIds.add(m.conditionId);
        allMarkets.push(m);
      }
    }

    // Step A: Get tag_ids for ALL weather-related categories
    const tagSlugs = ['temperature', 'weather', 'precipitation', 'climate', 'climate-weather'];
    const tagIds: { slug: string; id: number }[] = [];

    for (const slug of tagSlugs) {
      const tagData = await safeFetchJson(
        `https://gamma-api.polymarket.com/tags/slug/${slug}`
      ) as { id?: number } | null;
      if (tagData?.id) {
        tagIds.push({ slug, id: tagData.id });
      }
    }

    log.push(`  Tags found: ${tagIds.map((t) => `${t.slug}=${t.id}`).join(', ') || 'NONE'}`);

    // Step B: Fetch events for EACH tag (catches precip, snowfall, climate markets)
    for (const tag of tagIds) {
      if (Date.now() - startTime > 7000) {
        log.push('  Time limit approaching, stopping tag search');
        break;
      }

      const eventsPage = await safeFetchJson(
        `https://gamma-api.polymarket.com/events?tag_id=${tag.id}&active=true&closed=false&limit=100&offset=0`
      );
      if (Array.isArray(eventsPage)) {
        let tagCount = 0;
        for (const event of eventsPage as { markets?: GammaMarket[] }[]) {
          if (event.markets && Array.isArray(event.markets)) {
            for (const m of event.markets) {
              if (!seenIds.has(m.conditionId)) tagCount++;
              addMarket(m);
            }
          }
        }
        log.push(`  Tag "${tag.slug}" (${tag.id}): ${eventsPage.length} events → ${tagCount} new markets`);
      }
    }

    if (tagIds.length === 0) {
      log.push('  SKIPPING market fetch — no tag_ids found');
    }

    log.push(`  ${allMarkets.length} unique markets after dedup`);

    // Weather filter
    const weatherOnly = allMarkets.filter((m) => isWeatherMarket(m.question));
    const rejected = allMarkets.length - weatherOnly.length;
    if (rejected > 0) {
      log.push(`  Filtered out ${rejected} non-weather markets`);
    }
    log.push(`  ${weatherOnly.length} weather markets to upsert`);

    // Batch upsert (single DB call instead of 165+ sequential calls)
    const upsertRows = weatherOnly.map((m) => {
      let outcomes: string[];
      let outcomePrices: number[];

      try { outcomes = JSON.parse(m.outcomes); }
      catch { outcomes = m.outcomes?.split(',').map((s) => s.trim()) || ['Yes', 'No']; }

      try { outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p)); }
      catch { outcomePrices = m.outcomePrices?.split(',').map((s) => parseFloat(s.trim())) || [0.5, 0.5]; }

      const cityId = matchCity(m.question);
      const q = m.question.toLowerCase();

      // Classify market type
      let category = 'weather';
      let marketType = 'other';
      if (q.includes('precipitation') || q.includes('rainfall') || q.includes('rain')) {
        category = 'precipitation';
        marketType = 'precipitation';
      } else if (q.includes('snowfall') || q.includes('snow')) {
        category = 'snowfall';
        marketType = 'snowfall';
      } else if (q.includes('low temp') || q.includes('lowest temp') || q.includes('daily low') || q.includes('overnight')) {
        category = 'temperature';
        marketType = 'temperature_low';
      } else if (q.includes('temperature') || q.includes('°f') || q.includes('°c') || q.includes('degrees') || q.includes('high temp') || q.includes('highest temp')) {
        category = 'temperature';
        marketType = 'temperature_high';
      } else if (q.includes('climate') || q.includes('global temp') || q.includes('hottest year')) {
        category = 'climate';
        marketType = 'climate';
      }

      return {
        condition_id: m.conditionId,
        question: m.question,
        category,
        market_type: marketType,
        city_id: cityId,
        outcomes,
        outcome_prices: outcomePrices,
        volume_usd: parseFloat(m.volume) || 0,
        liquidity_usd: parseFloat(m.liquidity) || 0,
        resolution_date: m.endDate,
        is_active: m.active && !m.closed,
        updated_at: new Date().toISOString(),
      };
    });

    let upserted = 0;
    if (upsertRows.length > 0) {
      const { error, count } = await supabase
        .from('markets')
        .upsert(upsertRows, { onConflict: 'condition_id', count: 'exact' });

      if (error) {
        log.push(`  Upsert error: ${error.message}`);
      } else {
        upserted = count ?? upsertRows.length;
      }
    }

    const cityMatched = upsertRows.filter((r) => r.city_id).length;
    log.push(`  Upserted ${upserted} weather markets (${cityMatched} matched to cities)`);

    const elapsed = Date.now() - startTime;
    log.push(`Done in ${elapsed}ms`);

    return NextResponse.json({
      success: true,
      summary: {
        totalCities: cities.length,
        tagsFound: tagIds.map((t) => t.slug),
        marketsFound: allMarkets.length,
        weatherMarketsFiltered: weatherOnly.length,
        marketsUpserted: upserted,
        cityMatched,
        durationMs: elapsed,
      },
      log,
    });
  } catch (err) {
    log.push(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, log, error: String(err) }, { status: 500 });
  }
}

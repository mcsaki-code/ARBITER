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
  London: ['london'],
  'Tel Aviv': ['tel aviv'],
  Tokyo: ['tokyo'],
  Paris: ['paris'],
  Toronto: ['toronto'],
  Seoul: ['seoul'],
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

async function safeFetchJson(url: string, timeoutMs = 6000): Promise<unknown[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function GET() {
  const log: string[] = [];

  try {
    const supabase = getSupabaseAdmin();
    const startTime = Date.now();

    // ======== STEP 1: Ingest Weather (parallel, 3 cities max) ========
    log.push('STEP 1: Weather ingestion');

    const { data: cities, error: citiesErr } = await supabase
      .from('weather_cities')
      .select('*')
      .eq('is_active', true)
      .limit(10);

    if (citiesErr || !cities) {
      log.push(`ERROR fetching cities: ${citiesErr?.message || 'no data'}`);
      return NextResponse.json({ success: false, log }, { status: 500 });
    }

    log.push(`Found ${cities.length} active cities`);

    // Process first 3 cities in parallel
    const weatherBatch = cities.slice(0, 3);
    let totalForecasts = 0;

    const weatherResults = await Promise.all(
      weatherBatch.map(async (city) => {
        const forecasts: {
          city_id: string;
          valid_date: string;
          source: string;
          temp_high_f: number;
          temp_low_f: number;
          precip_prob: number;
          conditions: string;
        }[] = [];

        // Fetch all 3 Open-Meteo models in parallel
        const models = [
          { key: 'gfs_seamless', name: 'gfs' },
          { key: 'ecmwf_ifs025', name: 'ecmwf' },
          { key: 'icon_global', name: 'icon' },
        ];

        const modelResults = await Promise.all(
          models.map(async (model) => {
            try {
              const params = new URLSearchParams({
                latitude: city.lat.toString(),
                longitude: city.lon.toString(),
                daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,rain_sum,snowfall_sum',
                models: model.key,
                forecast_days: '3',
                temperature_unit: 'fahrenheit',
                timezone: 'auto',
              });

              const res = await fetch(
                `https://api.open-meteo.com/v1/forecast?${params}`,
                { signal: AbortSignal.timeout(5000) }
              );

              if (!res.ok) return [];
              const data = await res.json();
              const daily = data.daily;
              if (!daily?.time) return [];

              const results = [];
              for (let i = 0; i < daily.time.length; i++) {
                results.push({
                  city_id: city.id,
                  valid_date: daily.time[i],
                  source: model.name,
                  temp_high_f: Math.round(daily.temperature_2m_max[i]),
                  temp_low_f: Math.round(daily.temperature_2m_min[i]),
                  precip_prob: daily.precipitation_probability_max?.[i] ?? 0,
                  conditions: `${model.key} forecast`,
                });
              }
              return results;
            } catch {
              return [];
            }
          })
        );

        for (const r of modelResults) forecasts.push(...r);

        // NWS (US only, non-blocking)
        if (city.nws_office && city.nws_grid_x && city.nws_grid_y) {
          try {
            const url = `https://api.weather.gov/gridpoints/${city.nws_office}/${city.nws_grid_x},${city.nws_grid_y}/forecast/hourly`;
            const res = await fetch(url, {
              headers: {
                'User-Agent': 'ARBITER-Weather-Edge (contact@arbiter.app)',
                Accept: 'application/geo+json',
              },
              signal: AbortSignal.timeout(4000),
            });

            if (res.ok) {
              const data = await res.json();
              const periods = data.properties?.periods || [];
              const byDate = new Map<string, number[]>();

              for (const p of periods) {
                const date = p.startTime.split('T')[0];
                if (!byDate.has(date)) byDate.set(date, []);
                const temp =
                  p.temperatureUnit === 'F'
                    ? p.temperature
                    : (p.temperature * 9) / 5 + 32;
                byDate.get(date)!.push(temp);
              }

              let count = 0;
              for (const [date, temps] of byDate) {
                if (count >= 3) break;
                forecasts.push({
                  city_id: city.id,
                  valid_date: date,
                  source: 'nws',
                  temp_high_f: Math.round(Math.max(...temps)),
                  temp_low_f: Math.round(Math.min(...temps)),
                  precip_prob: 0,
                  conditions: 'NWS forecast',
                });
                count++;
              }
            }
          } catch {
            // NWS timeout — not critical
          }
        }

        return { city: city.name, forecasts };
      })
    );

    // Insert all forecasts + compute consensus
    for (const result of weatherResults) {
      if (result.forecasts.length > 0) {
        const { error: insertErr } = await supabase
          .from('weather_forecasts')
          .insert(result.forecasts);

        if (insertErr) {
          log.push(`  ${result.city}: insert error — ${insertErr.message}`);
        } else {
          totalForecasts += result.forecasts.length;
          log.push(`  ${result.city}: ${result.forecasts.length} forecasts`);
        }

        // Consensus per date
        const dates = [...new Set(result.forecasts.map((f) => f.valid_date))];
        for (const date of dates) {
          const dayF = result.forecasts.filter((f) => f.valid_date === date);
          if (dayF.length < 2) continue;

          const highs = dayF.map((f) => f.temp_high_f);
          const sources = dayF.map((f) => f.source);
          const spread = Math.max(...highs) - Math.min(...highs);
          const avg = highs.reduce((a, b) => a + b, 0) / highs.length;
          const agreement =
            spread <= 2 ? 'HIGH' : spread <= 5 ? 'MEDIUM' : 'LOW';

          await supabase.from('weather_consensus').insert({
            city_id: result.forecasts[0].city_id,
            valid_date: date,
            consensus_high_f: Math.round(avg),
            model_spread_f: Math.round(spread * 10) / 10,
            agreement,
            models_used: sources,
          });
        }
      } else {
        log.push(`  ${result.city}: no forecasts returned`);
      }
    }

    log.push(`Total: ${totalForecasts} forecasts ingested`);

    // ======== STEP 2: Market Search (parallel, fast) ========
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

    // Run market searches in parallel
    const [tagTemp, tagWeather, searchTemp, searchWeatherHigh, searchDegrees] =
      await Promise.all([
        safeFetchJson(
          'https://gamma-api.polymarket.com/markets?tag=temperature&active=true&closed=false&limit=100'
        ),
        safeFetchJson(
          'https://gamma-api.polymarket.com/markets?tag=weather&active=true&closed=false&limit=100'
        ),
        safeFetchJson(
          'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=temperature'
        ),
        safeFetchJson(
          'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=weather+high'
        ),
        safeFetchJson(
          'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=degrees+fahrenheit'
        ),
      ]);

    log.push(
      `  tag=temperature: ${tagTemp.length}, tag=weather: ${tagWeather.length}, search=temperature: ${searchTemp.length}, search=weather+high: ${searchWeatherHigh.length}, search=degrees+fahrenheit: ${searchDegrees.length}`
    );

    // Deduplicate
    const allRaw = [
      ...tagTemp,
      ...tagWeather,
      ...searchTemp,
      ...searchWeatherHigh,
      ...searchDegrees,
    ] as GammaMarket[];
    const seenIds = new Set<string>();
    const allMarkets: GammaMarket[] = [];

    for (const m of allRaw) {
      if (m.conditionId && !seenIds.has(m.conditionId)) {
        seenIds.add(m.conditionId);
        allMarkets.push(m);
      }
    }

    log.push(`  ${allMarkets.length} unique markets after dedup`);

    // Weather filter
    const weatherOnly = allMarkets.filter((m) => isWeatherMarket(m.question));
    const rejected = allMarkets.length - weatherOnly.length;
    if (rejected > 0) {
      log.push(`  Filtered out ${rejected} non-weather markets`);
    }
    log.push(`  ${weatherOnly.length} weather markets to upsert`);

    // Upsert
    let upserted = 0;
    for (const m of weatherOnly) {
      try {
        let outcomes: string[];
        let outcomePrices: number[];

        try {
          outcomes = JSON.parse(m.outcomes);
        } catch {
          outcomes = m.outcomes?.split(',').map((s) => s.trim()) || [
            'Yes',
            'No',
          ];
        }

        try {
          outcomePrices = JSON.parse(m.outcomePrices).map((p: string) =>
            parseFloat(p)
          );
        } catch {
          outcomePrices = m.outcomePrices
            ?.split(',')
            .map((s) => parseFloat(s.trim())) || [0.5, 0.5];
        }

        const cityId = matchCity(m.question);
        const q = m.question.toLowerCase();
        const category =
          q.includes('temperature') ||
          q.includes('°f') ||
          q.includes('°c') ||
          q.includes('degrees')
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

        if (!error) {
          upserted++;
          if (cityId)
            log.push(
              `  Matched: "${m.question.substring(0, 50)}..." → city`
            );
        }
      } catch {
        // skip
      }
    }

    log.push(`  Upserted ${upserted} weather markets`);

    const elapsed = Date.now() - startTime;
    log.push(`Done in ${elapsed}ms`);

    return NextResponse.json({
      success: true,
      summary: {
        cities: weatherBatch.length,
        totalCities: cities.length,
        forecasts: totalForecasts,
        marketsFound: weatherOnly.length,
        marketsUpserted: upserted,
        durationMs: elapsed,
      },
      log,
    });
  } catch (err) {
    log.push(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, log, error: String(err) }, { status: 500 });
  }
}

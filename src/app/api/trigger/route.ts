import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ============================================================
// Manual Pipeline Trigger
// GET /api/trigger — runs ingest + market refresh + analysis inline
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

interface GammaEvent {
  id?: string;
  title?: string;
  markets?: GammaMarket[];
}

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

async function safeFetch(url: string): Promise<unknown[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function GET() {
  const supabase = getSupabaseAdmin();
  const log: string[] = [];
  const startTime = Date.now();

  // ======== STEP 1: Ingest Weather ========
  log.push('--- STEP 1: Weather Ingestion ---');

  const { data: cities, error: citiesErr } = await supabase
    .from('weather_cities')
    .select('*')
    .eq('is_active', true);

  if (citiesErr || !cities) {
    log.push(`ERROR: Failed to fetch cities: ${citiesErr?.message}`);
    return NextResponse.json({ log, error: 'Failed to fetch cities' }, { status: 500 });
  }

  log.push(`Found ${cities.length} active cities`);

  let totalForecasts = 0;
  let totalConsensus = 0;

  for (const city of cities) {
    if (Date.now() - startTime > 45000) {
      log.push('WARNING: Approaching time limit, stopping weather ingestion');
      break;
    }

    // Fetch Open-Meteo (all cities)
    const models = ['gfs_seamless', 'ecmwf_ifs025', 'icon_global'] as const;
    const sourceMap: Record<string, string> = {
      gfs_seamless: 'gfs',
      ecmwf_ifs025: 'ecmwf',
      icon_global: 'icon',
    };

    const forecasts: {
      city_id: string;
      valid_date: string;
      source: string;
      temp_high_f: number;
      temp_low_f: number;
      precip_prob: number;
      conditions: string;
    }[] = [];

    for (const model of models) {
      try {
        const params = new URLSearchParams({
          latitude: city.lat.toString(),
          longitude: city.lon.toString(),
          daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
          models: model,
          forecast_days: '3',
          temperature_unit: 'fahrenheit',
          timezone: 'auto',
        });

        const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) continue;
        const data = await res.json();
        const daily = data.daily;
        if (!daily?.time) continue;

        for (let i = 0; i < daily.time.length; i++) {
          forecasts.push({
            city_id: city.id,
            valid_date: daily.time[i],
            source: sourceMap[model],
            temp_high_f: Math.round(daily.temperature_2m_max[i]),
            temp_low_f: Math.round(daily.temperature_2m_min[i]),
            precip_prob: daily.precipitation_probability_max?.[i] ?? 0,
            conditions: `${model} forecast`,
          });
        }
      } catch {
        log.push(`  Open-Meteo error for ${city.name} (${model})`);
      }
    }

    // Fetch NWS (US cities only)
    if (city.nws_office && city.nws_grid_x && city.nws_grid_y) {
      try {
        const url = `https://api.weather.gov/gridpoints/${city.nws_office}/${city.nws_grid_x},${city.nws_grid_y}/forecast/hourly`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'ARBITER-Weather-Edge (contact@arbiter.app)',
            Accept: 'application/geo+json',
          },
          signal: AbortSignal.timeout(8000),
        });

        if (res.ok) {
          const data = await res.json();
          const periods = data.properties?.periods || [];
          const byDate = new Map<string, number[]>();
          for (const p of periods) {
            const date = p.startTime.split('T')[0];
            if (!byDate.has(date)) byDate.set(date, []);
            const temp = p.temperatureUnit === 'F' ? p.temperature : (p.temperature * 9) / 5 + 32;
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
        log.push(`  NWS error for ${city.name}`);
      }
    }

    if (forecasts.length > 0) {
      const { error: insertErr } = await supabase
        .from('weather_forecasts')
        .insert(forecasts);

      if (insertErr) {
        log.push(`  Insert error for ${city.name}: ${insertErr.message}`);
      } else {
        totalForecasts += forecasts.length;
      }

      // Calculate consensus for each date
      const dates = [...new Set(forecasts.map((f) => f.valid_date))];
      for (const date of dates) {
        const dayForecasts = forecasts.filter((f) => f.valid_date === date);
        if (dayForecasts.length < 2) continue;

        const highs = dayForecasts.map((f) => f.temp_high_f);
        const sources = dayForecasts.map((f) => f.source);
        const spread = Math.max(...highs) - Math.min(...highs);
        const avg = highs.reduce((a, b) => a + b, 0) / highs.length;
        const agreement = spread <= 2 ? 'HIGH' : spread <= 5 ? 'MEDIUM' : 'LOW';

        const { error: consErr } = await supabase.from('weather_consensus').insert({
          city_id: city.id,
          valid_date: date,
          consensus_high_f: Math.round(avg),
          model_spread_f: Math.round(spread * 10) / 10,
          agreement,
          models_used: sources,
        });

        if (!consErr) totalConsensus++;
      }
    }

    log.push(`  ${city.name}: ${forecasts.length} forecasts ingested`);
  }

  log.push(`Weather total: ${totalForecasts} forecasts, ${totalConsensus} consensus records`);

  // ======== STEP 2: Refresh Markets ========
  log.push('--- STEP 2: Market Refresh ---');

  const cityLookup = new Map<string, string>();
  for (const city of cities) {
    const keywords = CITY_KEYWORDS[city.name] || [city.name.toLowerCase()];
    for (const kw of keywords) {
      cityLookup.set(kw, city.id);
    }
  }

  function matchCity(question: string): string | null {
    const q = question.toLowerCase();
    for (const [kw, id] of cityLookup) {
      if (q.includes(kw)) return id;
    }
    return null;
  }

  const allMarkets: GammaMarket[] = [];
  const seenIds = new Set<string>();

  function addMarket(m: GammaMarket) {
    if (m.conditionId && !seenIds.has(m.conditionId)) {
      seenIds.add(m.conditionId);
      allMarkets.push(m);
    }
  }

  // Multi-strategy Polymarket search
  const searchUrls = [
    'https://gamma-api.polymarket.com/markets?tag=temperature&active=true&closed=false&limit=100',
    'https://gamma-api.polymarket.com/markets?tag=weather&active=true&closed=false&limit=100',
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=temperature',
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=weather+high',
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&search=degrees',
  ];

  for (const url of searchUrls) {
    const results = (await safeFetch(url)) as GammaMarket[];
    log.push(`  ${url.split('?')[1]?.substring(0, 60)}: ${results.length} results`);
    for (const m of results) addMarket(m);
  }

  // Events search
  const eventUrls = [
    'https://gamma-api.polymarket.com/events?tag=temperature&active=true&closed=false&limit=50',
    'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&search=temperature',
    'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&search=weather+high',
  ];

  for (const url of eventUrls) {
    const events = (await safeFetch(url)) as GammaEvent[];
    log.push(`  events ${url.split('?')[1]?.substring(0, 60)}: ${events.length} events`);
    for (const event of events) {
      if (event.markets && Array.isArray(event.markets)) {
        for (const m of event.markets) addMarket(m);
      }
    }
  }

  log.push(`Total unique markets found: ${allMarkets.length}`);

  // Upsert markets
  let upserted = 0;
  for (const m of allMarkets) {
    try {
      let outcomes: string[];
      let outcomePrices: number[];

      try {
        outcomes = JSON.parse(m.outcomes);
      } catch {
        outcomes = m.outcomes?.split(',').map((s) => s.trim()) || ['Yes', 'No'];
      }

      try {
        outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p));
      } catch {
        outcomePrices = m.outcomePrices?.split(',').map((s) => parseFloat(s.trim())) || [0.5, 0.5];
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

      if (!error) {
        upserted++;
        if (cityId) log.push(`  Matched "${m.question.substring(0, 60)}" → city`);
      }
    } catch {
      // skip
    }
  }

  log.push(`Upserted ${upserted} markets`);

  // ======== STEP 3: Generate Signals (even without markets) ========
  log.push('--- STEP 3: Signal Generation ---');

  // Get consensus data for tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  const { data: consensusData } = await supabase
    .from('weather_consensus')
    .select('*')
    .in('valid_date', [todayStr, tomorrowStr])
    .order('calculated_at', { ascending: false });

  // Get markets that matched cities
  const { data: activeMarkets } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true)
    .not('city_id', 'is', null);

  const marketsWithCities = activeMarkets || [];
  log.push(`Active markets with city matches: ${marketsWithCities.length}`);

  // For cities with markets AND consensus, generate analysis if we have an API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let analyzed = 0;

  if (apiKey && marketsWithCities.length > 0) {
    for (const market of marketsWithCities.slice(0, 3)) {
      const consensus = consensusData?.find((c) => c.city_id === market.city_id);
      if (!consensus) continue;
      if (consensus.agreement === 'LOW') continue;

      const city = cities.find((c) => c.id === market.city_id);
      if (!city) continue;

      // Get forecasts for this city
      const { data: forecasts } = await supabase
        .from('weather_forecasts')
        .select('*')
        .eq('city_id', city.id)
        .eq('valid_date', consensus.valid_date)
        .order('fetched_at', { ascending: false })
        .limit(10);

      const nws = forecasts?.find((f: { source: string }) => f.source === 'nws');
      const gfs = forecasts?.find((f: { source: string }) => f.source === 'gfs');
      const ecmwf = forecasts?.find((f: { source: string }) => f.source === 'ecmwf');
      const icon = forecasts?.find((f: { source: string }) => f.source === 'icon');

      const outcomesList = market.outcomes
        .map((o: string, i: number) => `${o} → $${market.outcome_prices[i]?.toFixed(2) || '?'}`)
        .join('\n');

      const prompt = `You are ARBITER's weather analyst. Compare forecast models to Polymarket temperature brackets and identify mispricings.

CITY: ${city.name}
DATE: ${consensus.valid_date}

FORECAST MODELS:
- NWS official high: ${nws?.temp_high_f ?? 'N/A'}°F
- GFS model high:   ${gfs?.temp_high_f ?? 'N/A'}°F
- ECMWF model high: ${ecmwf?.temp_high_f ?? 'N/A'}°F
- ICON model high:  ${icon?.temp_high_f ?? 'N/A'}°F
- Consensus high:   ${consensus.consensus_high_f}°F
- Model spread:     ${consensus.model_spread_f}°F
- Agreement:        ${consensus.agreement}

POLYMARKET BRACKETS (outcome → current YES price):
${outcomesList}

MARKET INFO:
- Liquidity: $${market.liquidity_usd?.toLocaleString() || '0'}
- Volume:    $${market.volume_usd?.toLocaleString() || '0'}

TASK:
1. Identify which bracket(s) the consensus falls within
2. Estimate true probability for EACH bracket (must sum to ~1.0)
3. Calculate edge = true_prob - market_price per bracket
4. Select the single best bet (highest edge that meets criteria)
5. Return edge + confidence accurately for Kelly calculation
6. Set auto_eligible = true only if agreement=HIGH, confidence=HIGH, edge>=0.08

SKIP (return best_bet: null) if: agreement=LOW, liquidity<$25k, edge<0.05

Respond ONLY in JSON:
{
  "city": string,
  "consensus_high_f": number,
  "spread_f": number,
  "agreement": "HIGH"|"MEDIUM"|"LOW",
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number,
    "true_prob": number,
    "edge": number,
    "direction": "BUY_YES"|"BUY_NO"|"PASS",
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "kelly_fraction": number,
    "reasoning": string
  } | null,
  "all_outcomes": [{"index": number, "label": string, "market_price": number, "true_prob": number, "edge": number}],
  "auto_eligible": boolean,
  "flags": string[]
}`;

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(20000),
        });

        if (!res.ok) {
          log.push(`  Claude API error: ${res.status}`);
          continue;
        }

        const data = await res.json();
        const text = data.content?.[0]?.text;
        if (!text) continue;

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        const analysis = JSON.parse(jsonMatch[0]);

        // Calculate Kelly
        let kellyFraction = 0;
        let recBetUsd = 0;
        if (analysis.best_bet) {
          const p = analysis.best_bet.true_prob;
          const c = analysis.best_bet.market_price;
          const edge = p - c;
          if (edge >= 0.05) {
            const b = (1 - c) / c;
            const fullKelly = (p * b - (1 - p)) / b;
            if (fullKelly > 0) {
              const confMult = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.2 }[
                analysis.best_bet.confidence as string
              ] || 0.2;
              const adjusted = fullKelly * 0.25 * (confMult as number);
              const liquidityCap = (market.liquidity_usd * 0.02) / 500;
              kellyFraction = Math.min(adjusted, 0.05, liquidityCap);
              recBetUsd = Math.max(1, Math.round(500 * kellyFraction * 100) / 100);
            }
          }
        }

        await supabase.from('weather_analyses').insert({
          market_id: market.id,
          city_id: city.id,
          consensus_id: consensus.id,
          model_high_f: consensus.consensus_high_f,
          model_spread_f: consensus.model_spread_f,
          model_agreement: consensus.agreement,
          best_outcome_idx: analysis.best_bet?.outcome_index ?? null,
          best_outcome_label: analysis.best_bet?.outcome_label ?? null,
          market_price: analysis.best_bet?.market_price ?? null,
          true_prob: analysis.best_bet?.true_prob ?? null,
          edge: analysis.best_bet?.edge ?? null,
          direction: analysis.best_bet?.direction ?? 'PASS',
          confidence: analysis.best_bet?.confidence ?? 'LOW',
          kelly_fraction: kellyFraction,
          rec_bet_usd: recBetUsd,
          reasoning: analysis.best_bet?.reasoning ?? null,
          auto_eligible: analysis.auto_eligible || false,
          flags: analysis.flags || [],
        });

        analyzed++;
        log.push(`  Analyzed ${city.name}: edge=${analysis.best_bet?.edge ?? 0}`);
      } catch (err) {
        log.push(`  Analysis failed for ${city.name}: ${err}`);
      }
    }
  } else if (!apiKey) {
    log.push('  ANTHROPIC_API_KEY not set — skipping Claude analysis');
  } else {
    log.push('  No markets with city matches — skipping analysis');
  }

  log.push(`Analyzed ${analyzed} cities`);
  log.push(`--- COMPLETE in ${Date.now() - startTime}ms ---`);

  return NextResponse.json({
    success: true,
    summary: {
      cities: cities.length,
      forecasts: totalForecasts,
      consensus: totalConsensus,
      marketsFound: allMarkets.length,
      marketsUpserted: upserted,
      marketsWithCities: marketsWithCities.length,
      analyzed,
      durationMs: Date.now() - startTime,
    },
    log,
  });
}

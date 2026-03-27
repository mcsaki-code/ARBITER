// ============================================================
// Netlify Scheduled Function: Analyze Weather V2
// Runs every 20 minutes — Claude analysis with ensemble data
// Supports: temperature (high/low), precipitation, snowfall
// Max 5 markets per invocation to stay under time limit
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

export const handler = schedule('*/20 * * * *', async () => {
  console.log('[analyze-weather-v2] Starting enhanced weather analysis');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[analyze-weather-v2] ANTHROPIC_API_KEY not set');
    return { statusCode: 500 };
  }

  // Get active weather markets with city data — only those with 2+ hours remaining
  // (prevents already-resolved today's markets from blocking future market analysis)
  const minResolutionDate = new Date(Date.now() + 2 * 3600000).toISOString();
  const { data: markets } = await supabase
    .from('markets')
    .select('*, weather_cities(*)')
    .eq('is_active', true)
    .not('city_id', 'is', null)
    .neq('category', 'temperature')   // temperature markets handled by Phase 2 statistical analysis
    .gt('resolution_date', minResolutionDate);

  if (!markets || markets.length === 0) {
    console.log('[analyze-weather-v2] No active markets with city matches');
    return { statusCode: 200 };
  }

  // Pre-load recently analyzed market IDs to avoid re-analyzing same markets every run.
  // Use 6h window so we cycle through ALL active markets rather than repeatedly hitting
  // the same top-liquidity one (e.g., Tokyo). This lets the queue rotate properly.
  const weatherRecentCutoff = new Date(Date.now() - 6 * 3600000).toISOString();
  const { data: recentWeatherRows } = await supabase
    .from('weather_analyses')
    .select('market_id')
    .gte('analyzed_at', weatherRecentCutoff);
  const recentWeatherIds = new Set((recentWeatherRows ?? []).map((r: { market_id: string }) => r.market_id?.toString()));

  // Sort: unanalyzed first, then by liquidity DESC
  const sortedMarkets = [...markets].sort((a, b) => {
    const aRecent = recentWeatherIds.has(a.id?.toString() ?? '') ? 1 : 0;
    const bRecent = recentWeatherIds.has(b.id?.toString() ?? '') ? 1 : 0;
    if (aRecent !== bRecent) return aRecent - bRecent;
    return (b.liquidity_usd || 0) - (a.liquidity_usd || 0);
  });

  let processed = 0;
  for (const market of sortedMarkets.slice(0, 4)) {
    // STRICT time guard: 14s — leaves 16s for Phase 2 statistical analysis
    if (Date.now() - startTime > 14000) break;

    const city = market.weather_cities;
    if (!city) continue;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // Get latest consensus (now includes ensemble + precip data)
    const { data: consensusArr } = await supabase
      .from('weather_consensus')
      .select('*')
      .eq('city_id', city.id)
      .eq('valid_date', tomorrowStr)
      .order('calculated_at', { ascending: false })
      .limit(1);

    const consensus = consensusArr?.[0];
    if (!consensus) continue;

    // Skip LOW agreement for temperature markets
    const marketType = market.market_type || detectMarketType(market.question);
    if (consensus.agreement === 'LOW' && marketType.startsWith('temperature')) continue;

    // Get individual model forecasts
    const { data: forecasts } = await supabase
      .from('weather_forecasts')
      .select('*')
      .eq('city_id', city.id)
      .eq('valid_date', tomorrowStr)
      .order('fetched_at', { ascending: false })
      .limit(15);

    const nws = forecasts?.find((f: { source: string }) => f.source === 'nws');
    const gfs = forecasts?.find((f: { source: string }) => f.source === 'gfs');
    const ecmwf = forecasts?.find((f: { source: string }) => f.source === 'ecmwf');
    const icon = forecasts?.find((f: { source: string }) => f.source === 'icon');
    const hrrr = forecasts?.find((f: { source: string }) => f.source === 'hrrr');

    const hoursRemaining = market.resolution_date
      ? (new Date(market.resolution_date).getTime() - Date.now()) / 3600000
      : 0;

    // Skip markets that are already resolved or resolving within 2h
    if (hoursRemaining < 2) {
      console.log(`[analyze-weather-v2] Skip ${city.name} — ${hoursRemaining < 0 ? 'already resolved' : `only ${hoursRemaining.toFixed(1)}h left`}`);
      continue;
    }
    if (market.liquidity_usd < 5000) {
      console.log(`[analyze-weather-v2] Skip ${city.name} — low liquidity $${market.liquidity_usd}`);
      continue;
    }

    const outcomesList = market.outcomes
      .map((o: string, i: number) => `${o} → $${market.outcome_prices[i]?.toFixed(2) || '?'}`)
      .join('\n');

    // Build the appropriate prompt based on market type
    const prompt = buildAnalysisPrompt(
      marketType,
      city,
      tomorrowStr,
      consensus,
      { nws, gfs, ecmwf, icon, hrrr },
      market,
      outcomesList,
      hoursRemaining
    );

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!res.ok) {
        console.error(`[analyze-weather-v2] Claude API error: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (!text) continue;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const analysis = JSON.parse(jsonMatch[0]);

      // Calculate Kelly bet size
      let kellyFraction = 0;
      let recBetUsd = 0;
      if (analysis.best_bet) {
        const { data: configRows } = await supabase
          .from('system_config')
          .select('key, value')
          .in('key', ['paper_bankroll', 'kelly_fraction']);

        const config: Record<string, string> = {};
        configRows?.forEach((r: { key: string; value: string }) => {
          config[r.key] = r.value;
        });
        const bankroll = parseFloat(config.paper_bankroll || '5000');

        const p = analysis.best_bet.true_prob;
        const c = analysis.best_bet.market_price;
        const edge = p - c;
        if (edge >= 0.05) { // 5% minimum edge (up from 2%)
          const b = (1 - c) / c;
          const fullKelly = (p * b - (1 - p)) / b;
          if (fullKelly > 0) {
            const confMult = { HIGH: 0.8, MEDIUM: 0.5, LOW: 0.2 }[
              analysis.best_bet.confidence as string
            ] || 0.2;

            // Lower Kelly fraction for precip/snowfall (less predictable)
            const typeMult = marketType === 'precipitation' ? 0.6
              : marketType === 'snowfall' ? 0.5
              : 1.0;

            // 1/8th Kelly (professional standard) instead of 1/4
            const adjusted = fullKelly * 0.125 * (confMult as number) * typeMult;
            const liquidityCap = (market.liquidity_usd * 0.02) / bankroll;
            kellyFraction = Math.min(adjusted, 0.03, liquidityCap);
            recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
          }
        }
      }

      // Normalize edge value — Claude sometimes returns edge as percentage (e.g. 84.9)
      // or as raw large number instead of 0-1 decimal
      let rawEdge = analysis.best_bet?.edge ?? null;
      if (rawEdge !== null && rawEdge > 1) {
        // Edge > 1 means Claude returned it in a non-standard format
        // If > 100, likely edge * 1000; if 1-100, likely percentage
        rawEdge = rawEdge > 100 ? rawEdge / 1000 : rawEdge / 100;
      }
      // For BUY_NO bets, edge = true_prob - market_price (negative when YES is overpriced).
      // Store the absolute magnitude so place-bets' edge > MIN_EDGE filter works correctly.
      if (rawEdge !== null && analysis.best_bet?.direction === 'BUY_NO' && rawEdge < 0) {
        rawEdge = -rawEdge;
      }

      // Also normalize market_price and true_prob if they look like percentages
      let mktPrice = analysis.best_bet?.market_price ?? null;
      if (mktPrice !== null && mktPrice > 1) mktPrice = mktPrice / 100;
      let trueProb = analysis.best_bet?.true_prob ?? null;
      if (trueProb !== null && trueProb > 1) trueProb = trueProb / 100;

      // Store analysis
      await supabase.from('weather_analyses').insert({
        market_id: market.id,
        city_id: city.id,
        consensus_id: consensus.id,
        model_high_f: consensus.consensus_high_f,
        model_spread_f: consensus.model_spread_f,
        model_agreement: consensus.agreement,
        market_type: marketType,
        best_outcome_idx: analysis.best_bet?.outcome_index ?? null,
        best_outcome_label: analysis.best_bet?.outcome_label ?? null,
        market_price: mktPrice,
        true_prob: trueProb,
        edge: rawEdge,
        direction: analysis.best_bet?.direction ?? 'PASS',
        confidence: analysis.best_bet?.confidence ?? 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: analysis.best_bet?.reasoning ?? null,
        auto_eligible: analysis.auto_eligible || false,
        ensemble_prob: analysis.best_bet?.ensemble_prob ?? null,
        ensemble_edge: analysis.best_bet?.ensemble_edge ?? null,
        precip_consensus: consensus.precip_consensus_mm ?? null,
        flags: analysis.flags || [],
      });

      processed++;
      console.log(
        `[analyze-weather-v2] ${city.name} (${marketType}): edge=${analysis.best_bet?.edge ?? 0}, ensemble=${analysis.best_bet?.ensemble_prob ? 'yes' : 'no'}`
      );
    } catch (err) {
      console.error(`[analyze-weather-v2] Analysis failed for ${city.name}:`, err);
    }
  }

  console.log(`[analyze-weather-v2] Processed ${processed} weather markets in ${Date.now() - startTime}ms`);

  // ── Phase 2: Temperature category market statistical analysis ──────────────
  // 1,166+ markets: "Will the highest temp in Shanghai be 12°C on March 27?"
  // Avg $50-70k liquidity, resolve within 3 days.
  // No LLM needed — pure statistical edge using our weather_forecasts data.
  // P(max = X°C) or P(max <= X°C) from Gaussian forecast distribution.
  const tempAnalyzed = await analyzeTemperatureMarkets(startTime);
  console.log(`[analyze-weather-v2] Done. +${tempAnalyzed} temperature markets. Total: ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

// ──────────────────────────────────────────────────────────────────────
// Temperature Market Statistical Analysis
// Uses weather_forecasts data to compute P(max_temp = threshold) etc.
// Sigma = 2°C (typical 1-day forecast accuracy for max temperature)
// ──────────────────────────────────────────────────────────────────────

// Normal distribution CDF (Abramowitz & Stegun approximation, error < 7.5e-8)
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const phi = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * poly;
  return x >= 0 ? phi : 1 - phi;
}

interface TemperatureParsed {
  city: string;
  threshold_c: number;
  operator: 'exact' | 'lte' | 'gte';
  date_str: string;   // e.g. "March 27"
}

function parseTemperatureQuestion(question: string): TemperatureParsed | null {
  // Matches °C markets: "Will the highest temperature in [CITY] be [N]°C[ or below| or above] on [DATE]?"
  const matchC = question.match(
    /highest temperature in ([A-Za-z\s\u00C0-\u024F]+?) be (\d+)°C( or below| or above)? on ([A-Za-z]+ \d+)/i
  );
  if (matchC) {
    return {
      city: matchC[1].trim(),
      threshold_c: parseInt(matchC[2]),
      operator: matchC[3]?.toLowerCase().includes('below') ? 'lte'
               : matchC[3]?.toLowerCase().includes('above') ? 'gte'
               : 'exact',
      date_str: matchC[4].trim(),
    };
  }
  // Matches °F markets: "Will the highest temperature in [CITY] be [N]°F[ or higher| or lower] on [DATE]?"
  const matchF = question.match(
    /highest temperature in ([A-Za-z\s\u00C0-\u024F]+?) be (\d+)°F( or higher| or lower| or above| or below)? on ([A-Za-z]+ \d+)/i
  );
  if (matchF) {
    const f = parseInt(matchF[2]);
    const op = matchF[3]?.toLowerCase();
    return {
      city: matchF[1].trim(),
      threshold_c: Math.round((f - 32) * 5 / 9),  // convert °F to °C
      operator: (op?.includes('lower') || op?.includes('below')) ? 'lte'
               : (op?.includes('higher') || op?.includes('above')) ? 'gte'
               : 'exact',
      date_str: matchF[4].trim(),
    };
  }
  return null;
}

// Convert "March 27" to a YYYY-MM-DD string (nearest future occurrence)
function resolveDateStr(dateStr: string): string | null {
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const parts = dateStr.toLowerCase().split(/\s+/);
  const monthNum = months[parts[0]];
  const day = parseInt(parts[1]);
  if (monthNum === undefined || isNaN(day)) return null;

  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, monthNum, day);
  if (candidate < now) candidate.setFullYear(year + 1);
  return candidate.toISOString().split('T')[0];
}

async function analyzeTemperatureMarkets(startTime: number): Promise<number> {
  // Uses module-level `supabase` client (same service role as the main handler)
  const MIN_EDGE = 0.08;          // 8% minimum — temp markets are niche
  const SIGMA_C  = 2.0;           // ±2°C typical 1-day forecast accuracy
  const MAX_PER_RUN = 50;         // Phase 1 now capped at 14s → Phase 2 gets ~16s, enough for 50 markets

  // Fetch temperature markets resolving in next 3 days.
  // These markets have $400-$2K liquidity (NOT $5K+) — pure statistical analysis
  // needs no LLM so low liquidity is fine. 5000 threshold was blocking ALL of them.
  const soon = new Date(Date.now() + 3 * 86400000).toISOString();
  const { data: tempMarkets } = await supabase
    .from('markets')
    .select('id, question, outcome_prices, liquidity_usd, resolution_date')
    .eq('is_active', true)
    .eq('category', 'temperature')
    .gt('liquidity_usd', 400)      // lowered from 5000 — temp markets are $400-$2K
    .gt('resolution_date', new Date(Date.now() + 1800000).toISOString()) // 30min min
    .lt('resolution_date', soon)
    .order('liquidity_usd', { ascending: false })
    .limit(100);

  if (!tempMarkets?.length) return 0;

  // Pre-load recently analyzed to avoid duplicates
  const recentCutoff = new Date(Date.now() - 4 * 3600000).toISOString();
  const { data: recentTempRows } = await supabase
    .from('weather_analyses')
    .select('market_id')
    .gte('analyzed_at', recentCutoff)
    .eq('market_type', 'temperature_statistical')   // only skip if Phase 2 already ran (not Phase 1 LLM attempts)
    .in('market_id', tempMarkets.map(m => m.id));
  const recentTempIds = new Set((recentTempRows ?? []).map((r: { market_id: string }) => r.market_id));

  // Pre-load all weather_cities for matching
  const { data: allCities } = await supabase.from('weather_cities').select('id, name');  // no 'country' col in schema
  const cityList = allCities ?? [];

  let analyzed = 0;

  for (const market of tempMarkets) {
    if (Date.now() - startTime > 29000) break;  // stay under 30s Netlify limit
    if (analyzed >= MAX_PER_RUN) break;
    if (recentTempIds.has(market.id)) continue;

    const parsed = parseTemperatureQuestion(market.question);
    if (!parsed) continue;

    const targetDate = resolveDateStr(parsed.date_str);
    if (!targetDate) continue;

    // Match city name (case-insensitive contains)
    const cityNameLc = parsed.city.toLowerCase();
    const city = cityList.find(c =>
      c.name.toLowerCase() === cityNameLc ||
      c.name.toLowerCase().includes(cityNameLc) ||
      cityNameLc.includes(c.name.toLowerCase())
    );
    if (!city) continue; // No weather data for this city

    // Get most recent forecast for this city and date
    const { data: forecasts } = await supabase
      .from('weather_forecasts')
      .select('temp_high_f, source, fetched_at')
      .eq('city_id', city.id)
      .eq('valid_date', targetDate)
      .order('fetched_at', { ascending: false })
      .limit(5);

    if (!forecasts?.length) continue;

    // Average across sources for a consensus forecast
    const avgHighF = forecasts.reduce((sum, f) => sum + (f.temp_high_f ?? 0), 0) / forecasts.length;
    const mu_c = (avgHighF - 32) * 5 / 9;  // Forecast high in Celsius

    // Compute probability based on operator
    let trueProb: number;
    const T = parsed.threshold_c;
    if (parsed.operator === 'exact') {
      // P(T - 0.5 < actual < T + 0.5) — what chance the rounded max == T?
      trueProb = normalCDF((T + 0.5 - mu_c) / SIGMA_C) - normalCDF((T - 0.5 - mu_c) / SIGMA_C);
    } else if (parsed.operator === 'lte') {
      trueProb = normalCDF((T - mu_c) / SIGMA_C);
    } else { // gte
      trueProb = 1 - normalCDF((T - mu_c) / SIGMA_C);
    }

    const marketPrice = market.outcome_prices?.[0] ?? 0.5;
    const edge = trueProb - marketPrice;
    const absEdge = Math.abs(edge);

    if (absEdge < MIN_EDGE) continue; // Not enough edge

    const direction = edge > 0 ? 'BUY_YES' : 'BUY_NO';
    const confidence = absEdge >= 0.20 ? 'HIGH' : absEdge >= 0.10 ? 'MEDIUM' : 'LOW';

    // Kelly bet sizing
    const { data: cfgRows } = await supabase.from('system_config').select('key, value').eq('key', 'paper_bankroll');
    const bankroll = parseFloat(cfgRows?.[0]?.value ?? '5000');
    const p = trueProb;
    const c = direction === 'BUY_YES' ? marketPrice : (1 - marketPrice);
    const b = (1 - c) / c;
    const fullKelly = (p * b - (1 - p)) / b;
    const confMult = confidence === 'HIGH' ? 0.8 : confidence === 'MEDIUM' ? 0.5 : 0.2;
    const kellyFraction = fullKelly > 0 ? Math.min(fullKelly * 0.125 * confMult, 0.03) : 0;
    const recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);

    await supabase.from('weather_analyses').insert({
      market_id: market.id,
      city_id: city.id,
      consensus_id: null,
      model_high_f: avgHighF,
      model_spread_f: SIGMA_C * 1.8,   // approx spread in F
      model_agreement: forecasts.length >= 3 ? 'HIGH' : 'MEDIUM',
      market_type: 'temperature_statistical',
      best_outcome_label: direction === 'BUY_YES' ? 'Yes' : 'No',
      market_price: marketPrice,
      true_prob: trueProb,
      edge: Math.min(absEdge, 0.50),   // cap at 0.50 per policy
      direction,
      confidence,
      kelly_fraction: kellyFraction,
      rec_bet_usd: recBetUsd,
      reasoning: `Statistical: forecast high ${mu_c.toFixed(1)}°C (${avgHighF.toFixed(1)}°F), threshold ${T}°C ${parsed.operator}, P(match)=${(trueProb*100).toFixed(1)}%, market=${(marketPrice*100).toFixed(2)}%, edge=${(edge*100).toFixed(1)}%`,
      auto_eligible: false,  // let place-bets decide based on confidence + edge
      ensemble_prob: trueProb,
      ensemble_edge: edge,
      precip_consensus: null,
      flags: [`forecast_sources_${forecasts.length}`, `sigma_${SIGMA_C}C`],
    });

    analyzed++;
    console.log(`[analyze-weather-v2] 🌡️ ${parsed.city} ${parsed.operator} ${T}°C: forecast=${mu_c.toFixed(1)}°C, P=${(trueProb*100).toFixed(1)}%, market=${(marketPrice*100).toFixed(2)}%, edge=${(edge*100).toFixed(1)}%`);
  }

  return analyzed;
}

// ============================================================
// Market type detection from question text
// ============================================================
function detectMarketType(question: string): string {
  const q = question.toLowerCase();
  if (q.includes('precipitation') || q.includes('rainfall') || q.includes('rain')) return 'precipitation';
  if (q.includes('snowfall') || q.includes('snow')) return 'snowfall';
  if (q.includes('low temp') || q.includes('lowest') || q.includes('daily low')) return 'temperature_low';
  if (q.includes('climate') || q.includes('global temp') || q.includes('hottest year')) return 'climate';
  return 'temperature_high';
}

// ============================================================
// Build analysis prompt based on market type
// ============================================================
function buildAnalysisPrompt(
  marketType: string,
  city: { name: string },
  date: string,
  consensus: {
    consensus_high_f: number;
    consensus_low_f?: number;
    model_spread_f: number;
    agreement: string;
    precip_consensus_mm?: number;
    precip_agreement?: string;
    snowfall_consensus_cm?: number;
    ensemble_members?: number;
    ensemble_prob_above?: Record<number, number>;
    ensemble_prob_below?: Record<number, number>;
  },
  models: {
    nws?: { temp_high_f: number; temp_low_f: number; precip_prob: number; precip_mm?: number; snowfall_cm?: number; wind_speed_max?: number } | null;
    gfs?: { temp_high_f: number; temp_low_f: number; precip_prob: number; precip_mm?: number; snowfall_cm?: number } | null;
    ecmwf?: { temp_high_f: number; temp_low_f: number; precip_prob: number; precip_mm?: number; snowfall_cm?: number } | null;
    icon?: { temp_high_f: number; temp_low_f: number; precip_prob: number; precip_mm?: number; snowfall_cm?: number } | null;
    hrrr?: { temp_high_f: number; temp_low_f: number; precip_mm?: number; snowfall_cm?: number; wind_speed_max?: number } | null;
  },
  market: { liquidity_usd: number; volume_usd: number },
  outcomesList: string,
  hoursRemaining: number
): string {
  // Ensemble section (if available)
  let ensembleSection = '';
  if (consensus.ensemble_members && consensus.ensemble_prob_above) {
    const probEntries = Object.entries(consensus.ensemble_prob_above)
      .filter(([, p]) => p > 0.05 && p < 0.95)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([temp, prob]) => `  ${temp}°F: ${(prob * 100).toFixed(0)}% chance of reaching or exceeding`)
      .join('\n');

    ensembleSection = `
GFS ENSEMBLE (${consensus.ensemble_members} members) — THIS IS YOUR PRIMARY EDGE SOURCE:
${probEntries}
USE THESE PROBABILITIES DIRECTLY to estimate true bracket probabilities.
Count how many members fall in each bracket — that fraction IS the probability.
The ensemble is more reliable than any single model for bracket pricing.
`;
  }

  if (marketType === 'precipitation') {
    return `You are ARBITER's weather analyst specializing in PRECIPITATION markets. Precipitation markets are less efficient than temperature — humans overestimate rain probability (wet bias).

CITY: ${city.name}
DATE: ${date}

PRECIPITATION FORECASTS:
- NWS precip probability: ${models.nws?.precip_prob ?? 'N/A'}%, amount: ${models.nws?.precip_mm ?? 'N/A'}mm
- GFS precip: ${models.gfs?.precip_mm ?? 'N/A'}mm, prob: ${models.gfs?.precip_prob ?? 'N/A'}%
- ECMWF precip: ${models.ecmwf?.precip_mm ?? 'N/A'}mm, prob: ${models.ecmwf?.precip_prob ?? 'N/A'}%
- ICON precip: ${models.icon?.precip_mm ?? 'N/A'}mm, prob: ${models.icon?.precip_prob ?? 'N/A'}%
- HRRR precip: ${models.hrrr?.precip_mm ?? 'N/A'}mm
- Consensus: ${consensus.precip_consensus_mm ?? 0}mm
- Agreement: ${consensus.precip_agreement ?? 'UNKNOWN'}

KEY INSIGHT: Commercial weather apps have a systematic WET BIAS — they overestimate rain probability by 5-15%. If NWS/GFS show low precip but the market is pricing high, that's edge.

Precipitation accuracy is ~70% (vs 85% for temperature) — be more conservative with sizing.
Resolution uses NOAA official data measured to 0.01" precision.

POLYMARKET OUTCOMES:
${outcomesList}

MARKET: Liquidity $${market.liquidity_usd.toLocaleString()}, Volume $${market.volume_usd.toLocaleString()}, Resolves in ${Math.round(hoursRemaining)}h

TASK:
1. Estimate true probability for each outcome using model consensus
2. Look for wet bias — where market overprices rain probability
3. Calculate edge = true_prob - market_price per outcome
4. Select the single best bet
5. Set auto_eligible = true if agreement >= MEDIUM, confidence >= MEDIUM, edge >= 0.04
6. SKIP if edge < 0.02 or agreement = LOW

Respond ONLY in JSON:
{
  "city": string,
  "market_type": "precipitation",
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number,
    "true_prob": number,
    "edge": number,
    "direction": "BUY_YES"|"BUY_NO"|"PASS",
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "ensemble_prob": number|null,
    "ensemble_edge": number|null,
    "reasoning": string
  } | null,
  "all_outcomes": [{"index": number, "label": string, "market_price": number, "true_prob": number, "edge": number}],
  "auto_eligible": boolean,
  "flags": string[]
}`;
  }

  if (marketType === 'snowfall') {
    return `You are ARBITER's weather analyst specializing in SNOWFALL markets. Snowfall is the hardest weather variable to predict — markets are often wildly mispriced.

CITY: ${city.name}
DATE: ${date}

SNOWFALL FORECASTS:
- GFS: ${models.gfs?.snowfall_cm ?? 'N/A'}cm
- ECMWF: ${models.ecmwf?.snowfall_cm ?? 'N/A'}cm
- ICON: ${models.icon?.snowfall_cm ?? 'N/A'}cm
- HRRR: ${models.hrrr?.snowfall_cm ?? 'N/A'}cm
- Consensus: ${consensus.snowfall_consensus_cm ?? 0}cm

Temperature context: High ${consensus.consensus_high_f}°F / Low ${consensus.consensus_low_f ?? 'N/A'}°F
Wind: ${models.nws?.wind_speed_max ?? models.hrrr?.wind_speed_max ?? 'N/A'} mph

KEY: Snow accumulation depends heavily on temperature (32-34°F sweet spot) and wind. If temps are marginal, models disagree wildly on snow totals.

POLYMARKET OUTCOMES:
${outcomesList}

MARKET: Liquidity $${market.liquidity_usd.toLocaleString()}, Volume $${market.volume_usd.toLocaleString()}, Resolves in ${Math.round(hoursRemaining)}h

Use EXTREME CAUTION with snowfall — only bet on HIGH confidence situations. Kelly fraction should be 50% of normal.

Respond ONLY in JSON:
{
  "city": string,
  "market_type": "snowfall",
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number,
    "true_prob": number,
    "edge": number,
    "direction": "BUY_YES"|"BUY_NO"|"PASS",
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "ensemble_prob": number|null,
    "ensemble_edge": number|null,
    "reasoning": string
  } | null,
  "all_outcomes": [{"index": number, "label": string, "market_price": number, "true_prob": number, "edge": number}],
  "auto_eligible": boolean,
  "flags": string[]
}`;
  }

  // Default: Temperature market (high or low)
  const tempField = marketType === 'temperature_low' ? 'Low' : 'High';
  const tempValue = marketType === 'temperature_low'
    ? (consensus.consensus_low_f ?? consensus.consensus_high_f - 15)
    : consensus.consensus_high_f;

  return `You are ARBITER's expert meteorological analyst. Compare multi-model forecast ensemble to Polymarket temperature brackets and identify mispricings.

CITY: ${city.name}
DATE: ${date}
MARKET TYPE: Daily ${tempField} Temperature

DETERMINISTIC FORECAST MODELS:
- NWS official:  ${models.nws?.temp_high_f ?? 'N/A'}°F high / ${models.nws?.temp_low_f ?? 'N/A'}°F low
- GFS:          ${models.gfs?.temp_high_f ?? 'N/A'}°F high / ${models.gfs?.temp_low_f ?? 'N/A'}°F low
- ECMWF:        ${models.ecmwf?.temp_high_f ?? 'N/A'}°F high / ${models.ecmwf?.temp_low_f ?? 'N/A'}°F low
- ICON:         ${models.icon?.temp_high_f ?? 'N/A'}°F high / ${models.icon?.temp_low_f ?? 'N/A'}°F low
- HRRR (3km):   ${models.hrrr?.temp_high_f ?? 'N/A'}°F high / ${models.hrrr?.temp_low_f ?? 'N/A'}°F low
- Weighted consensus ${tempField.toLowerCase()}: ${tempValue}°F
- Model spread: ${consensus.model_spread_f}°F
- Agreement:    ${consensus.agreement}
${ensembleSection}
POLYMARKET BRACKETS (outcome → current YES price):
${outcomesList}

MARKET INFO:
- Liquidity: $${market.liquidity_usd.toLocaleString()}
- Volume:    $${market.volume_usd.toLocaleString()}
- Resolves:  ${Math.round(hoursRemaining)} hours from now

METEOROLOGICAL CONTEXT:
- NWS is the resolution data source — weight it heavily for day-of forecasts
- HRRR at 3km resolution catches local effects (sea breeze, urban heat island) that coarser models miss
- ECMWF is most accurate globally at 3+ day range
- Model spread indicates forecast uncertainty: ≤2°F = HIGH confidence, 2-5°F = MEDIUM, >5°F = LOW
- Weather transitions (fronts passing) create the widest forecast spreads and biggest mispricings
- Record-breaking temps are systematically underpriced by markets

TASK:
1. If ensemble data available: use member distribution as PRIMARY probability estimate for each bracket
2. If no ensemble: estimate bracket probabilities from deterministic model consensus ± historical error
3. Calculate edge = true_prob - market_price per bracket
4. Select the single best bet (highest edge × confidence)
5. Set auto_eligible = true if agreement=HIGH or MEDIUM, confidence=HIGH or MEDIUM, edge >= 0.04
6. SKIP if: agreement=LOW, liquidity<$10k, hours_remaining<2, edge<0.02

Respond ONLY in JSON:
{
  "city": string,
  "market_type": "${marketType}",
  "consensus_high_f": number,
  "spread_f": number,
  "agreement": "HIGH"|"MEDIUM"|"LOW",
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number,
    "true_prob": number,
    "edge": number,
    "ensemble_prob": number|null,
    "ensemble_edge": number|null,
    "direction": "BUY_YES"|"BUY_NO"|"PASS",
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "kelly_fraction": number,
    "reasoning": string
  } | null,
  "all_outcomes": [{"index": number, "label": string, "market_price": number, "true_prob": number, "edge": number}],
  "auto_eligible": boolean,
  "flags": string[]
}`;
}

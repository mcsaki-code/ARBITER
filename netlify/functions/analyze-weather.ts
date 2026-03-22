// ============================================================
// Netlify Scheduled Function: Analyze Weather V2
// Runs every 20 minutes — Claude analysis with ensemble data
// Supports: temperature (high/low), precipitation, snowfall
// Max 3 markets per invocation to stay under time limit
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

  // Get ALL active weather markets with city data
  const { data: markets } = await supabase
    .from('markets')
    .select('*, weather_cities(*)')
    .eq('is_active', true)
    .not('city_id', 'is', null);

  if (!markets || markets.length === 0) {
    console.log('[analyze-weather-v2] No active markets with city matches');
    return { statusCode: 200 };
  }

  let processed = 0;
  for (const market of markets.slice(0, 3)) {
    // STRICT time guard: 20s
    if (Date.now() - startTime > 20000) break;

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
      ? Math.max(0, (new Date(market.resolution_date).getTime() - Date.now()) / 3600000)
      : 0;

    if (hoursRemaining < 2) continue;
    if (market.liquidity_usd < 10000) continue;

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
        const bankroll = parseFloat(config.paper_bankroll || '500');

        const p = analysis.best_bet.true_prob;
        const c = analysis.best_bet.market_price;
        const edge = p - c;
        if (edge >= 0.02) {
          const b = (1 - c) / c;
          const fullKelly = (p * b - (1 - p)) / b;
          if (fullKelly > 0) {
            const confMult = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.2 }[
              analysis.best_bet.confidence as string
            ] || 0.2;

            // Lower Kelly fraction for precip/snowfall (less predictable)
            const typeMult = marketType === 'precipitation' ? 0.6
              : marketType === 'snowfall' ? 0.5
              : 1.0;

            const adjusted = fullKelly * 0.25 * (confMult as number) * typeMult;
            const liquidityCap = (market.liquidity_usd * 0.02) / bankroll;
            kellyFraction = Math.min(adjusted, 0.05, liquidityCap);
            recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
          }
        }
      }

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
        market_price: analysis.best_bet?.market_price ?? null,
        true_prob: analysis.best_bet?.true_prob ?? null,
        edge: analysis.best_bet?.edge ?? null,
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

  console.log(`[analyze-weather-v2] Done. Processed ${processed} markets in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

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

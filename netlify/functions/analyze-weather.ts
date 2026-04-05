// ============================================================
// Netlify Scheduled Function: Analyze Weather V2
// Runs every 20 minutes — Claude analysis with ensemble data
// Supports: temperature (high/low), precipitation, snowfall
// Max 5 markets per invocation to stay under time limit
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ensembleAnalyze, type EnsembleResult } from '../../src/lib/ensemble';
import { getCityCalibration, getEdgeMultiplier, getBiasCorrection, getCalibrationContext } from '../../src/lib/calibration';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// Feature flag: DISABLED — ensemble abstraction is lossy, strips domain
// fields and causes validation failures. Direct Claude works fine.
const USE_ENSEMBLE = false;

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
    .in('category', ['temperature', 'precipitation', 'snowfall', 'weather'])  // V3: analyze ALL weather categories
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
  for (const market of sortedMarkets.slice(0, 8)) {
    // Time guard: 26s — Phase 2 statistical analysis now runs in its own function
    if (Date.now() - startTime > 26000) break;

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
    if (market.liquidity_usd < 400) {
      console.log(`[analyze-weather-v2] Skip ${city.name} — low liquidity $${market.liquidity_usd}`);
      continue;
    }

    // Refresh market prices from Gamma API — DB prices can be 30+ minutes stale
    if (market.gamma_market_id) {
      try {
        const freshRes = await fetch(`https://gamma-api.polymarket.com/markets/${market.gamma_market_id}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (freshRes.ok) {
          const freshData = await freshRes.json() as { outcomePrices?: string; liquidity?: string };
          if (freshData.outcomePrices) {
            try {
              const freshPrices = JSON.parse(freshData.outcomePrices).map((p: string) => parseFloat(p));
              if (freshPrices.length === market.outcome_prices.length) {
                market.outcome_prices = freshPrices;
                console.log(`[analyze-weather-v2] Refreshed prices for ${city.name}: ${freshPrices.map((p: number) => p.toFixed(3)).join(', ')}`);
              }
            } catch { /* keep DB prices */ }
          }
          if (freshData.liquidity) {
            const freshLiq = parseFloat(freshData.liquidity);
            if (!isNaN(freshLiq) && freshLiq > 0) market.liquidity_usd = freshLiq;
          }
        }
      } catch {
        console.log(`[analyze-weather-v2] Price refresh failed for ${city.name} — using DB prices`);
      }
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
      let analysis: any;
      let ensembleData: EnsembleResult | null = null;

      if (USE_ENSEMBLE) {
        // Use ensemble: run Claude + GPT-4o + Gemini in parallel
        ensembleData = await ensembleAnalyze(prompt);

        // Extract Claude's response from ensemble (Claude has 40% weight, goes first)
        const claudeModelResponse = ensembleData.model_responses.find((r) => r.model === 'claude');
        if (!claudeModelResponse || !claudeModelResponse.reasoning) {
          console.log(
            `[analyze-weather-v2] ${city.name} — no valid Claude response from ensemble, using fallback`
          );
          // Fall through to direct Claude call
        } else {
          // Claude responded in ensemble — parse its reasoning field
          try {
            const jsonMatch = claudeModelResponse.reasoning.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
              console.log(
                `[analyze-weather-v2] ${city.name} — no JSON in Claude ensemble response, using fallback`
              );
            } else {
              analysis = JSON.parse(jsonMatch[0]);
              // Successfully parsed Claude's response from ensemble — skip to validation
            }
          } catch {
            console.log(
              `[analyze-weather-v2] ${city.name} — JSON parse failed in ensemble Claude, using fallback`
            );
          }
        }
      }

      // Fallback: direct Claude API call if ensemble didn't work or isn't enabled
      if (!analysis) {
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

        try {
          analysis = JSON.parse(jsonMatch[0]);
        } catch {
          console.error(`[analyze-weather] JSON parse error for market ${market.id}`);
          continue;
        }
      }

      // Runtime validation — reject malformed Claude responses
      const { validateWeatherAnalysis } = await import('../../src/lib/validate-analysis');
      const validation = validateWeatherAnalysis(analysis);
      if (!validation.valid) {
        console.error(`[analyze-weather] VALIDATION FAILED for ${market.id}:`, validation.errors.join('; '));
        continue;
      }
      // Overwrite raw values with validated + normalized ones
      if (analysis.best_bet && typeof analysis.best_bet === 'object') {
        const bb = analysis.best_bet as Record<string, unknown>;
        bb.model_prob = validation.data.best_bet.model_prob;
        bb.market_price = validation.data.best_bet.market_price;
        bb.edge = validation.data.best_bet.edge;
        bb.direction = validation.data.best_bet.direction;
        bb.confidence = validation.data.best_bet.confidence;
      }
      analysis.auto_eligible = validation.data.auto_eligible;
      analysis.flags = validation.data.flags;

      // Cross-validate with ensemble consensus if available
      if (ensembleData && analysis.best_bet) {
        const ensembleDir = ensembleData.consensus_direction;
        const claudeDir = analysis.best_bet.direction;
        const agreementScore = ensembleData.agreement_score;

        // Store ensemble metadata for later calibration
        analysis.ensemble_agreement_score = agreementScore;
        analysis.ensemble_used_models = ensembleData.used_models;

        // If Claude and ensemble disagree on direction, downgrade confidence
        if (ensembleDir !== 'PASS' && claudeDir !== ensembleDir && claudeDir !== 'PASS') {
          const oldConfidence = analysis.best_bet.confidence;
          // Downgrade by one level: HIGH→MEDIUM, MEDIUM→LOW, LOW→LOW
          if (oldConfidence === 'HIGH') {
            analysis.best_bet.confidence = 'MEDIUM';
            analysis.flags.push('ensemble_disagreement_downgrade_high_to_medium');
          } else if (oldConfidence === 'MEDIUM') {
            analysis.best_bet.confidence = 'LOW';
            analysis.flags.push('ensemble_disagreement_downgrade_medium_to_low');
          }
          console.log(
            `[analyze-weather-v2] ${city.name} — ensemble disagreement: Claude=${claudeDir}, Ensemble=${ensembleDir}, downgraded confidence from ${oldConfidence}`
          );
        } else if (agreementScore === 1.0 && ensembleDir === claudeDir && ensembleDir !== 'PASS') {
          // All models agree — boost confidence by one level
          const oldConfidence = analysis.best_bet.confidence;
          if (oldConfidence === 'MEDIUM') {
            analysis.best_bet.confidence = 'HIGH';
            analysis.flags.push('ensemble_full_agreement_boost_medium_to_high');
          } else if (oldConfidence === 'LOW') {
            analysis.best_bet.confidence = 'MEDIUM';
            analysis.flags.push('ensemble_full_agreement_boost_low_to_medium');
          }
        }

        // Log ensemble performance
        console.log(
          `[analyze-weather-v2] Ensemble: agreement=${(agreementScore * 100).toFixed(1)}%, models=[${ensembleData.used_models.join(',')}], consensus_dir=${ensembleDir}, consensus_conf=${ensembleData.consensus_confidence}`
        );
      }

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

        // Look up latest calibration for this category + confidence tier
        const { data: calData } = await supabase
          .from('calibration_snapshots')
          .select('total_bets, predicted_win_rate, actual_win_rate')
          .eq('category', 'weather')
          .eq('confidence_tier', analysis.best_bet.confidence || 'LOW')
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .single();

        const { computeKelly, getCalibrationDiscount } = await import('../../src/lib/trading-math');
        const calDiscount = getCalibrationDiscount(calData);
        const kelly = computeKelly({
          trueProb: analysis.best_bet.true_prob,
          marketPrice: analysis.best_bet.market_price,
          direction: analysis.best_bet.direction,
          confidence: analysis.best_bet.confidence,
          category: 'weather',
          weatherSubtype: marketType,
          liquidityUsd: market.liquidity_usd,
          bankroll,
          calibrationDiscount: calDiscount,
        });
        kellyFraction = kelly.kellyFraction;
        recBetUsd = kelly.recBetUsd;
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
      // Sanity cap: weather edges above 35% are almost certainly Claude overconfidence.
      // Real forecasting edges are rarely > 20-25%. Cap prevents DB avg inflation
      // and ensures calibration metrics stay meaningful.
      if (rawEdge !== null && rawEdge > 0.35) rawEdge = 0.35;

      // Apply city-based calibration multiplier upstream (before place-bets sees the edge)
      // Tier 1 cities (most reliable) get 1.0x, Tier 4 cities get 0.5x
      // Learning agent can override with dynamic weights in system_config
      let adjustedEdge = rawEdge;
      if (rawEdge !== null && rawEdge > 0) {
        let edgeMultiplier = getEdgeMultiplier(city.name);

        // Check for learning agent's dynamic override
        const dynamicKey = `calibration_${city.name.toLowerCase().replace(/\s+/g, '_')}`;
        const { data: dynamicCal } = await supabase
          .from('system_config')
          .select('value')
          .eq('key', dynamicKey)
          .single();
        if (dynamicCal?.value) {
          const dynamicMult = parseFloat(dynamicCal.value);
          if (!isNaN(dynamicMult) && dynamicMult > 0) {
            edgeMultiplier = dynamicMult;
            console.log(`[analyze-weather-v2] ${city.name} using LEARNED calibration: ${dynamicMult.toFixed(4)}`);
          }
        }

        adjustedEdge = rawEdge * edgeMultiplier;
        if (edgeMultiplier !== 1.0) {
          console.log(
            `[analyze-weather-v2] ${city.name} edge calibration: raw=${rawEdge.toFixed(4)} × ${edgeMultiplier.toFixed(2)} = adjusted=${adjustedEdge.toFixed(4)}`
          );
        }
      }

      // Also normalize market_price and true_prob if they look like percentages
      let mktPrice = analysis.best_bet?.market_price ?? null;
      if (mktPrice !== null && mktPrice > 1) mktPrice = mktPrice / 100;
      let trueProb = analysis.best_bet?.true_prob ?? null;
      if (trueProb !== null && trueProb > 1) trueProb = trueProb / 100;

      // Derive analysis_date from market resolution_date (the weather event date)
      const analysisDate = market.resolution_date
        ? new Date(market.resolution_date).toISOString().split('T')[0]
        : null;

      // Compute dynamic sigma for storage (used by place-bets for Kelly scaling)
      const sigmaForStorage = getDynamicSigma(hoursRemaining);

      // Store analysis — use adjusted edge (post-calibration)
      await supabase.from('weather_analyses').insert({
        market_id: market.id,
        city_id: city.id,
        consensus_id: consensus.id,
        analysis_date: analysisDate,
        model_high_f: consensus.consensus_high_f,
        model_spread_f: consensus.model_spread_f,
        model_agreement: consensus.agreement,
        market_type: marketType,
        best_outcome_idx: analysis.best_bet?.outcome_index ?? null,
        best_outcome_label: analysis.best_bet?.outcome_label ?? null,
        market_price: mktPrice,
        true_prob: trueProb,
        edge: adjustedEdge,  // Use calibration-adjusted edge
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
        ensemble_agreement_score: analysis.ensemble_agreement_score ?? null,
        ensemble_used_models: analysis.ensemble_used_models ?? null,
      });

      processed++;
      const usedEnsemble = ensembleData ? `ensemble(${ensembleData.used_models.join(',')})` : 'claude-only';
      console.log(
        `[analyze-weather-v2] ${city.name} (${marketType}): edge=${adjustedEdge?.toFixed(4) ?? 0} (calibrated), used=${usedEnsemble}, confidence=${analysis.best_bet?.confidence ?? 'PASS'}`
      );
    } catch (err) {
      console.error(`[analyze-weather-v2] Analysis failed for ${city.name}:`, err);
    }
  }

  console.log(`[analyze-weather-v2] Processed ${processed} weather markets in ${Date.now() - startTime}ms`);
  // Phase 2 (temperature_statistical) now runs in analyze-temperature.ts (its own scheduled function)
  return { statusCode: 200 };
});

// ============================================================
// Dynamic sigma scaling — forecast uncertainty by lead time
// Derived from top bot strategies (gopfan2, meropi, 1pixel)
// Short lead = tight sigma = confident bets
// Long lead = wide sigma = conservative or pass
// ============================================================
function getDynamicSigma(hoursRemaining: number): number {
  if (hoursRemaining <= 6) return 0.8;       // Day-of: very tight
  if (hoursRemaining <= 12) return 1.2;      // Same-day evening
  if (hoursRemaining <= 24) return 1.8;      // Next-day morning
  if (hoursRemaining <= 48) return 2.5;      // 2-day out
  if (hoursRemaining <= 72) return 3.2;      // 3-day out
  if (hoursRemaining <= 120) return 4.0;     // 5-day out
  if (hoursRemaining <= 168) return 4.8;     // 7-day out
  return 5.5;                                 // 10+ days out
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
    const calibrationContext = getCalibrationContext(city.name);
    return `You are ARBITER's weather analyst specializing in PRECIPITATION markets. Precipitation markets are less efficient than temperature — humans overestimate rain probability (wet bias).

CITY: ${city.name}
DATE: ${date}

${calibrationContext}

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
    const calibrationContext = getCalibrationContext(city.name);
    return `You are ARBITER's weather analyst specializing in SNOWFALL markets. Snowfall is the hardest weather variable to predict — markets are often wildly mispriced.

CITY: ${city.name}
DATE: ${date}

${calibrationContext}

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
  const calibrationContext = getCalibrationContext(city.name);

  // Dynamic sigma scaling — forecast uncertainty grows with lead time
  // Top bots (gopfan2, meropi) scale from ~0.8°F at <6h to ~5.5°F at 10d+
  const sigmaF = getDynamicSigma(hoursRemaining);
  const sigmaSection = `
FORECAST UNCERTAINTY (dynamic sigma based on ${Math.round(hoursRemaining)}h lead time):
- 1-sigma uncertainty: ±${sigmaF.toFixed(1)}°F around consensus
- Use this to scale bracket probability distributions
- Brackets within 1σ of consensus: higher confidence
- Brackets beyond 2σ: low probability unless ensemble supports it
- CRITICAL: shorter lead time = tighter sigma = sharper probability estimates
`;

  return `You are ARBITER's expert meteorological analyst. Compare multi-model forecast ensemble to Polymarket temperature brackets and identify mispricings.

CITY: ${city.name}
DATE: ${date}
MARKET TYPE: Daily ${tempField} Temperature

${calibrationContext}
${ensembleSection}
${sigmaSection}
DETERMINISTIC FORECAST MODELS (use as SECONDARY validation, NOT primary):
- NWS official:  ${models.nws?.temp_high_f ?? 'N/A'}°F high / ${models.nws?.temp_low_f ?? 'N/A'}°F low
- GFS:          ${models.gfs?.temp_high_f ?? 'N/A'}°F high / ${models.gfs?.temp_low_f ?? 'N/A'}°F low
- ECMWF:        ${models.ecmwf?.temp_high_f ?? 'N/A'}°F high / ${models.ecmwf?.temp_low_f ?? 'N/A'}°F low
- ICON:         ${models.icon?.temp_high_f ?? 'N/A'}°F high / ${models.icon?.temp_low_f ?? 'N/A'}°F low
- HRRR (3km):   ${models.hrrr?.temp_high_f ?? 'N/A'}°F high / ${models.hrrr?.temp_low_f ?? 'N/A'}°F low
- Weighted consensus ${tempField.toLowerCase()}: ${tempValue}°F
- Model spread: ${consensus.model_spread_f}°F
- Agreement:    ${consensus.agreement}

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
- USE DYNAMIC SIGMA (±${sigmaF.toFixed(1)}°F) to scale your probability distribution — do NOT use a fixed uncertainty

TASK:
1. If ensemble data available: use member distribution as PRIMARY probability estimate for each bracket
2. Use dynamic sigma (±${sigmaF.toFixed(1)}°F) to build probability distribution around consensus
3. Cross-validate ensemble probs against deterministic models — flag disagreements
4. Calculate edge = true_prob - market_price per bracket
5. Select the single best bet (highest edge × confidence)
6. Set auto_eligible = true if agreement=HIGH or MEDIUM, confidence=HIGH or MEDIUM, edge >= 0.04
7. SKIP if: agreement=LOW, liquidity<$10k, hours_remaining<2, edge<0.02

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

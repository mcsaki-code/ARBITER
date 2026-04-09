/**
 * Temperature Statistical Analysis
 * Ported from analyze-temperature.ts — no 30s Netlify timeout here.
 * Processes ALL eligible markets every cycle.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  computeBracketProbability,
  type ForecastMember,
  type BracketRange,
} from './forecast-ensemble';
import { writeShadowRow } from './backtest-shadow';

const MIN_EDGE  = 0.08;   // 8% minimum edge
// Fallback sigma for when we only have 1-2 forecast members and must
// use a climatological floor rather than the sample std. Matches the
// lead-time-aware table in forecast-ensemble.ts (in °F, converted to °C).
// Sigma scales with forecast lead time (uncertainty grows with √t)
// Day-0: 1.5°C, Day-1: 2.5°C, Day-2: 3.5°C, Day-3+: 4.5°C (legacy fallback)

// normalCDF removed — forecast-ensemble.ts provides the CDF internally.

interface TemperatureParsed {
  city: string;
  threshold_c: number;
  operator: 'exact' | 'lte' | 'gte';
  date_str: string;
}

export function parseTemperatureQuestion(question: string): TemperatureParsed | null {
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
  const matchF = question.match(
    /highest temperature in ([A-Za-z\s\u00C0-\u024F]+?) be (\d+)°F( or higher| or lower| or above| or below)? on ([A-Za-z]+ \d+)/i
  );
  if (matchF) {
    const f = parseInt(matchF[2]);
    const op = matchF[3]?.toLowerCase() ?? '';
    return {
      city: matchF[1].trim(),
      threshold_c: Math.round((f - 32) * 5 / 9),
      operator: (op.includes('lower') || op.includes('below')) ? 'lte'
               : (op.includes('higher') || op.includes('above')) ? 'gte'
               : 'exact',
      date_str: matchF[4].trim(),
    };
  }
  return null;
}

export function resolveDateStr(dateStr: string): string | null {
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const parts = dateStr.toLowerCase().split(/\s+/);
  const monthNum = months[parts[0]];
  const day = parseInt(parts[1]);
  if (monthNum === undefined || isNaN(day)) return null;
  const now = new Date();
  const candidate = new Date(now.getFullYear(), monthNum, day);
  if (candidate < now) candidate.setFullYear(now.getFullYear() + 1);
  return candidate.toISOString().split('T')[0];
}

function sigmaCForDaysOut(daysOut: number): number {
  if (daysOut <= 0) return 1.5;   // same-day: tight ±1.5°C
  if (daysOut <= 1) return 2.5;   // 1-day out: ±2.5°C
  if (daysOut <= 2) return 3.5;   // 2-day out: ±3.5°C
  return 4.5;                     // 3-5 day out: ±4.5°C
}

export interface TempAnalysisResult {
  analyzed: number;
  skippedRecent: number;
  skippedNoCity: number;
  skippedNoForecast: number;
  skippedLowEdge: number;
  errors: number;
  durationMs: number;
}

export async function analyzeTemperatureMarkets(
  supabase: SupabaseClient,
  options: { daysLookahead?: number; recentWindowHours?: number; verbose?: boolean } = {}
): Promise<TempAnalysisResult> {
  const start = Date.now();
  const daysLookahead = options.daysLookahead ?? 5;   // Railway: look 5 days out (vs 3 on Netlify)
  const recentWindowHours = options.recentWindowHours ?? 4;
  const verbose = options.verbose ?? true;

  const log = (msg: string) => { if (verbose) console.log(`[temp-analysis] ${msg}`); };
  const err  = (msg: string) => console.error(`[temp-analysis] ERROR: ${msg}`);

  // Fetch ALL eligible temperature markets (no limit — no timeout constraint)
  const soon = new Date(Date.now() + daysLookahead * 86400000).toISOString();
  const { data: tempMarkets, error: mktErr } = await supabase
    .from('markets')
    .select('id, question, outcome_prices, liquidity_usd, resolution_date')
    .eq('is_active', true)
    .eq('category', 'temperature')
    .gt('liquidity_usd', 400)
    .gt('resolution_date', new Date(Date.now() + 1800000).toISOString())
    .lt('resolution_date', soon)
    .order('liquidity_usd', { ascending: false });
    // NOTE: No .limit() — Railway has no timeout, process everything

  if (mktErr) {
    err(`Market fetch: ${mktErr.message}`);
    return { analyzed: 0, skippedRecent: 0, skippedNoCity: 0, skippedNoForecast: 0, skippedLowEdge: 0, errors: 1, durationMs: Date.now() - start };
  }

  if (!tempMarkets?.length) {
    log('No eligible markets');
    return { analyzed: 0, skippedRecent: 0, skippedNoCity: 0, skippedNoForecast: 0, skippedLowEdge: 0, errors: 0, durationMs: Date.now() - start };
  }

  log(`Found ${tempMarkets.length} eligible markets (${daysLookahead}-day lookahead)`);

  // Pre-load recently analyzed to avoid churn
  // NOTE: Do NOT use .in() with 1000+ IDs — exceeds PostgREST URL length limit (~8KB).
  // Instead, fetch ALL recent temperature_statistical analyses and filter in JS.
  const recentCutoff = new Date(Date.now() - recentWindowHours * 3600000).toISOString();
  const { data: recentRows, error: recentErr } = await supabase
    .from('weather_analyses')
    .select('market_id')
    .gte('analyzed_at', recentCutoff)
    .eq('market_type', 'temperature_statistical');
  if (recentErr) {
    err(`Recent analyses fetch: ${recentErr.message}`);
  }
  const recentIds = new Set((recentRows ?? []).map((r: { market_id: string }) => r.market_id));

  // Pre-load all cities
  const { data: allCities } = await supabase.from('weather_cities').select('id, name');
  const cityList = allCities ?? [];

  // Fetch bankroll once
  const { data: cfgRows } = await supabase.from('system_config').select('key, value').eq('key', 'paper_bankroll');
  const bankroll = parseFloat(cfgRows?.[0]?.value ?? '5000');

  let analyzed = 0, skippedRecent = 0, skippedNoCity = 0, skippedNoForecast = 0, skippedLowEdge = 0, errors = 0;

  for (const market of tempMarkets) {
    if (recentIds.has(market.id)) { skippedRecent++; continue; }

    const parsed = parseTemperatureQuestion(market.question);
    if (!parsed) continue;

    const targetDate = resolveDateStr(parsed.date_str);
    if (!targetDate) continue;

    // Days out from today — used only as a legacy fallback.
    // Real sigma now comes from the forecast member sample std
    // (with a lead-time-aware floor) via forecast-ensemble.ts.
    const daysOut = Math.round((new Date(targetDate).getTime() - Date.now()) / 86400000);
    const hoursRemaining = Math.max(
      0,
      (new Date(targetDate).getTime() - Date.now()) / 3600000
    );
    const legacySigmaC = sigmaCForDaysOut(daysOut);

    // Match city
    const cityNameLc = parsed.city.toLowerCase();
    const city = cityList.find(c =>
      c.name.toLowerCase() === cityNameLc ||
      c.name.toLowerCase().includes(cityNameLc) ||
      cityNameLc.includes(c.name.toLowerCase())
    );
    if (!city) { skippedNoCity++; continue; }

    // Fetch forecasts for city + date
    const { data: forecasts, error: fcErr } = await supabase
      .from('weather_forecasts')
      .select('temp_high_f, source, fetched_at')
      .eq('city_id', city.id)
      .eq('valid_date', targetDate)
      .order('fetched_at', { ascending: false })
      .limit(5);

    if (fcErr) { errors++; continue; }
    if (!forecasts?.length) { skippedNoForecast++; continue; }

    // ── FORECAST-MEMBER DISTRIBUTION MATH (phase 2 port) ──────
    // Build ForecastMember[] in °F (the bracket lib expects °F),
    // then convert the threshold from °C back to °F for the call.
    // This is what gopfan2 / suislanchez actually do — use the
    // spread of individual model forecasts, not a fixed sigma table.
    const members: ForecastMember[] = forecasts
      .filter((f: { temp_high_f: number | null }) => f.temp_high_f != null)
      .map((f: { temp_high_f: number; source: string }) => ({
        source: f.source,
        temp_high_f: f.temp_high_f,
      }));
    if (members.length < 2) { skippedNoForecast++; continue; }

    const avgHighF = members.reduce((s, m) => s + m.temp_high_f, 0) / members.length;
    const mu_c = (avgHighF - 32) * 5 / 9;

    const T_c = parsed.threshold_c;
    const T_f = T_c * 9 / 5 + 32;
    // Build a bracket range in °F from the operator.
    // 'exact' = half-open degree window (centered on T), matching how
    // Polymarket resolves "exactly X°C" questions (±0.5°C = ±0.9°F).
    let bracket: BracketRange;
    const halfWindowF = 0.5 * 9 / 5; // 0.9°F
    if (parsed.operator === 'exact') {
      bracket = {
        low_f: T_f - halfWindowF,
        high_f: T_f + halfWindowF,
        kind: 'exact',
        label: `${T_c}°C (exact)`,
      };
    } else if (parsed.operator === 'lte') {
      bracket = {
        low_f: -Infinity,
        high_f: T_f,
        kind: 'at_or_below',
        label: `<=${T_c}°C`,
      };
    } else {
      bracket = {
        low_f: T_f,
        high_f: Infinity,
        kind: 'at_or_above',
        label: `>=${T_c}°C`,
      };
    }

    const forecastProb = computeBracketProbability(members, bracket, hoursRemaining);
    const trueProb = forecastProb.probability;
    const sigmaFEff = forecastProb.sigma_f;
    const sigmaCEff = sigmaFEff * 5 / 9;

    const marketPrice = market.outcome_prices?.[0] ?? 0.5;
    const edge = trueProb - marketPrice;
    const absEdge = Math.abs(edge);

    // ── SHADOW BACKTEST WRITE ─────────────────────────────────
    // Fire-and-forget: records v2's prediction for EVERY bracket we
    // analyze, regardless of whether we'd bet on it. Scored later
    // when the market resolves. Never throws — wrapped internally.
    // This is our cheap self-building calibration loop (Path B).
    await writeShadowRow(supabase, {
      marketId: String(market.id),
      cityId: city.id,
      cityName: city.name,
      bracketKind: bracket.kind,
      thresholdC: parsed.threshold_c,
      thresholdF: T_f,
      bracketLabel: bracket.label,
      predictedProb: trueProb,
      sigmaF: sigmaFEff,
      method: forecastProb.method,
      nMembers: members.length,
      meanF: avgHighF,
      leadTimeHours: hoursRemaining,
      marketPriceYes: marketPrice,
      marketLiquidityUsd: market.liquidity_usd ?? null,
      sourceAnalyzer: 'railway_worker_v2',
    });

    if (absEdge < MIN_EDGE) { skippedLowEdge++; continue; }

    // BUY_NO is empirically 0/11 in V3.2 — skip rather than emit dead
    // analyses that place-bets.ts will just throw away. This keeps the
    // analyses table clean and lets the learning loop see only the
    // directions we actually trade.
    if (edge <= 0) {
      skippedLowEdge++;
      log(`SKIP ${parsed.city} ${parsed.operator}${T_c}°C — BUY_NO suppressed (edge ${(edge*100).toFixed(1)}%)`);
      continue;
    }

    const direction = 'BUY_YES';
    const confidence = absEdge >= 0.20 ? 'HIGH' : absEdge >= 0.10 ? 'MEDIUM' : 'LOW';

    // Kelly — CORRECT formula for BUY_NO: pWin = 1 - trueProb
    const pWin = direction === 'BUY_YES' ? trueProb : (1 - trueProb);
    const c    = direction === 'BUY_YES' ? marketPrice : (1 - marketPrice);
    const b    = (1 - c) / c;
    const fullKelly = (pWin * b - (1 - pWin)) / b;
    const confMult  = confidence === 'HIGH' ? 0.8 : confidence === 'MEDIUM' ? 0.5 : 0.2;
    const kellyFraction = fullKelly > 0 ? Math.min(fullKelly * 0.125 * confMult, 0.03) : 0;
    const recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);

    const { error: insertErr } = await supabase.from('weather_analyses').insert({
      market_id: market.id,
      city_id: city.id,
      consensus_id: null,
      model_high_f: avgHighF,
      model_spread_f: sigmaCEff * 1.8,
      model_agreement: members.length >= 3 ? 'HIGH' : 'MEDIUM',
      market_type: 'temperature_statistical',
      best_outcome_label: direction === 'BUY_YES' ? 'Yes' : 'No',
      market_price: marketPrice,
      true_prob: trueProb,
      edge: Math.min(absEdge, 0.50),
      direction,
      confidence,
      kelly_fraction: kellyFraction,
      rec_bet_usd: recBetUsd,
      reasoning: `[Railway-v2] Member-distribution: n=${members.length} forecasts, mean ${mu_c.toFixed(1)}°C (${avgHighF.toFixed(1)}°F), sigma=${sigmaCEff.toFixed(2)}°C (${sigmaFEff.toFixed(2)}°F, method=${forecastProb.method}, ${daysOut}d out), threshold ${T_c}°C ${parsed.operator}, P=${(trueProb*100).toFixed(1)}%, mkt=${(marketPrice*100).toFixed(2)}%, edge=${(edge*100).toFixed(1)}%`,
      auto_eligible: confidence === 'HIGH' && members.length >= 3 && absEdge >= MIN_EDGE,
      ensemble_prob: trueProb,
      ensemble_edge: edge,
      precip_consensus: null,
      flags: [
        `railway_worker_v2`,
        `forecast_sources_${members.length}`,
        `sigma_${sigmaCEff.toFixed(2)}C_${forecastProb.method}`,
        `days_out_${daysOut}`,
        `pWin_${(pWin * 100).toFixed(1)}pct`,
        `legacy_sigma_${legacySigmaC.toFixed(1)}C`,
      ],
    });

    if (insertErr) { errors++; continue; }

    analyzed++;
    log(`✅ ${parsed.city} ${parsed.operator}${T_c}°C | ${daysOut}d out σ=${sigmaCEff.toFixed(2)}°C (${forecastProb.method}) | forecast=${mu_c.toFixed(1)}°C | n=${members.length} | edge=${(edge*100).toFixed(1)}% ${direction} $${recBetUsd}`);
  }

  const durationMs = Date.now() - start;
  log(`Done: analyzed=${analyzed} skipped=(recent=${skippedRecent} noCity=${skippedNoCity} noForecast=${skippedNoForecast} lowEdge=${skippedLowEdge}) errors=${errors} in ${durationMs}ms`);
  return { analyzed, skippedRecent, skippedNoCity, skippedNoForecast, skippedLowEdge, errors, durationMs };
}

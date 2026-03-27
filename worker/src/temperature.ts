/**
 * Temperature Statistical Analysis
 * Ported from analyze-temperature.ts — no 30s Netlify timeout here.
 * Processes ALL eligible markets every cycle.
 */

import { SupabaseClient } from '@supabase/supabase-js';

const MIN_EDGE  = 0.08;   // 8% minimum edge
const SIGMA_C   = 2.0;    // ±2°C typical 1-day forecast accuracy
const SIGMA_2D  = 2.8;    // ±2.8°C for 2-day forecasts (σ grows with √t)
const SIGMA_3D  = 3.4;    // ±3.4°C for 3-day forecasts
const SIGMA_5D  = 4.5;    // ±4.5°C for 4-5 day forecasts

// Abramowitz & Stegun normal CDF (error < 7.5e-8)
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
  if (daysOut <= 1) return SIGMA_C;
  if (daysOut <= 2) return SIGMA_2D;
  if (daysOut <= 3) return SIGMA_3D;
  return SIGMA_5D;
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
  const recentCutoff = new Date(Date.now() - recentWindowHours * 3600000).toISOString();
  const { data: recentRows } = await supabase
    .from('weather_analyses')
    .select('market_id')
    .gte('analyzed_at', recentCutoff)
    .eq('market_type', 'temperature_statistical')
    .in('market_id', tempMarkets.map(m => m.id));
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

    // Days out from today — determines forecast sigma
    const daysOut = Math.round((new Date(targetDate).getTime() - Date.now()) / 86400000);
    const sigma = sigmaCForDaysOut(daysOut);

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

    // Multi-model consensus
    const avgHighF = forecasts.reduce((sum, f) => sum + (f.temp_high_f ?? 0), 0) / forecasts.length;
    const mu_c = (avgHighF - 32) * 5 / 9;

    // Compute probability
    const T = parsed.threshold_c;
    let trueProb: number;
    if (parsed.operator === 'exact') {
      trueProb = normalCDF((T + 0.5 - mu_c) / sigma) - normalCDF((T - 0.5 - mu_c) / sigma);
    } else if (parsed.operator === 'lte') {
      trueProb = normalCDF((T - mu_c) / sigma);
    } else {
      trueProb = 1 - normalCDF((T - mu_c) / sigma);
    }

    const marketPrice = market.outcome_prices?.[0] ?? 0.5;
    const edge = trueProb - marketPrice;
    const absEdge = Math.abs(edge);

    if (absEdge < MIN_EDGE) { skippedLowEdge++; continue; }

    const direction = edge > 0 ? 'BUY_YES' : 'BUY_NO';
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
      model_spread_f: sigma * 1.8,
      model_agreement: forecasts.length >= 3 ? 'HIGH' : 'MEDIUM',
      market_type: 'temperature_statistical',
      best_outcome_label: direction === 'BUY_YES' ? 'Yes' : 'No',
      market_price: marketPrice,
      true_prob: trueProb,
      edge: Math.min(absEdge, 0.50),
      direction,
      confidence,
      kelly_fraction: kellyFraction,
      rec_bet_usd: recBetUsd,
      reasoning: `[Railway] Statistical: forecast ${mu_c.toFixed(1)}°C (${avgHighF.toFixed(1)}°F), threshold ${T}°C ${parsed.operator}, sigma=${sigma}°C (${daysOut}d out), P=${(trueProb*100).toFixed(1)}%, mkt=${(marketPrice*100).toFixed(2)}%, edge=${(edge*100).toFixed(1)}%`,
      auto_eligible: false,
      ensemble_prob: trueProb,
      ensemble_edge: edge,
      precip_consensus: null,
      flags: [`railway_worker`, `forecast_sources_${forecasts.length}`, `sigma_${sigma}C`, `days_out_${daysOut}`],
    });

    if (insertErr) { errors++; continue; }

    analyzed++;
    log(`✅ ${parsed.city} ${parsed.operator}${T}°C | ${daysOut}d out σ=${sigma}°C | forecast=${mu_c.toFixed(1)}°C | edge=${(edge*100).toFixed(1)}% ${direction} $${recBetUsd}`);
  }

  const durationMs = Date.now() - start;
  log(`Done: analyzed=${analyzed} skipped=(recent=${skippedRecent} noCity=${skippedNoCity} noForecast=${skippedNoForecast} lowEdge=${skippedLowEdge}) errors=${errors} in ${durationMs}ms`);
  return { analyzed, skippedRecent, skippedNoCity, skippedNoForecast, skippedLowEdge, errors, durationMs };
}

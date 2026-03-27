// ============================================================
// Netlify Scheduled Function: analyze-temperature
// Runs every 15 minutes — PURE STATISTICAL (no LLM)
// Phase 2: temperature category markets ($400+ liquidity)
// Uses Gaussian P(temp meets threshold) from forecast consensus
// Gets its OWN 30s execution window, independent of Phase 1 LLM timing
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MIN_EDGE  = 0.08;   // 8% minimum edge — temperature niche markets
const SIGMA_C   = 2.0;    // ±2°C typical 1-day forecast accuracy for max temperature
const MAX_PER_RUN = 80;   // Full 28s window → process up to 80 markets

// ──────────────────────────────────────────────────────────────────────
// Normal distribution CDF (Abramowitz & Stegun, error < 7.5e-8)
// ──────────────────────────────────────────────────────────────────────
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

function parseTemperatureQuestion(question: string): TemperatureParsed | null {
  // Celsius markets: "Will the highest temperature in [CITY] be [N]°C[ or below| or above] on [DATE]?"
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
  // Fahrenheit markets: "Will the highest temperature in [CITY] be [N]°F[ or higher| or lower] on [DATE]?"
  const matchF = question.match(
    /highest temperature in ([A-Za-z\s\u00C0-\u024F]+?) be (\d+)°F( or higher| or lower| or above| or below)? on ([A-Za-z]+ \d+)/i
  );
  if (matchF) {
    const f = parseInt(matchF[2]);
    const op = matchF[3]?.toLowerCase();
    return {
      city: matchF[1].trim(),
      threshold_c: Math.round((f - 32) * 5 / 9),
      operator: (op?.includes('lower') || op?.includes('below')) ? 'lte'
               : (op?.includes('higher') || op?.includes('above')) ? 'gte'
               : 'exact',
      date_str: matchF[4].trim(),
    };
  }
  return null;
}

// Convert "March 27" to YYYY-MM-DD (nearest future occurrence)
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
  const candidate = new Date(now.getFullYear(), monthNum, day);
  if (candidate < now) candidate.setFullYear(now.getFullYear() + 1);
  return candidate.toISOString().split('T')[0];
}

export const handler = schedule('*/15 * * * *', async () => {
  const startTime = Date.now();
  console.log('[analyze-temperature] Starting Phase 2 statistical analysis');

  // Fetch temperature markets resolving in next 3 days
  const soon = new Date(Date.now() + 3 * 86400000).toISOString();
  const { data: tempMarkets, error: mktErr } = await supabase
    .from('markets')
    .select('id, question, outcome_prices, liquidity_usd, resolution_date')
    .eq('is_active', true)
    .eq('category', 'temperature')
    .gt('liquidity_usd', 400)
    .gt('resolution_date', new Date(Date.now() + 1800000).toISOString()) // 30min min
    .lt('resolution_date', soon)
    .order('liquidity_usd', { ascending: false })
    .limit(200);

  if (mktErr) {
    console.error('[analyze-temperature] Market fetch error:', mktErr.message);
    return { statusCode: 500 };
  }

  if (!tempMarkets?.length) {
    console.log('[analyze-temperature] No eligible temperature markets');
    return { statusCode: 200 };
  }

  console.log(`[analyze-temperature] Found ${tempMarkets.length} eligible markets`);

  // Pre-load recently analyzed (last 4h) to avoid re-analysis.
  // NOTE: Do NOT use .in() with 200 market IDs — it hits PostgREST URL length
  // limits and silently returns empty, causing every market to be re-analyzed
  // every run. Load ALL recent temperature_statistical rows and filter in memory.
  const recentCutoff = new Date(Date.now() - 4 * 3600000).toISOString();
  const { data: recentRows } = await supabase
    .from('weather_analyses')
    .select('market_id')
    .gte('analyzed_at', recentCutoff)
    .eq('market_type', 'temperature_statistical');
  const recentIds = new Set((recentRows ?? []).map((r: { market_id: string }) => r.market_id));

  // Pre-load all weather cities for matching
  const { data: allCities } = await supabase.from('weather_cities').select('id, name');
  const cityList = allCities ?? [];

  // Fetch bankroll for Kelly sizing (once, not per market)
  const { data: cfgRows } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['paper_bankroll', 'kelly_fraction']);
  const config: Record<string, string> = {};
  cfgRows?.forEach((r: { key: string; value: string }) => { config[r.key] = r.value; });
  const bankroll = parseFloat(config.paper_bankroll || '5000');

  let analyzed = 0;
  let skippedRecent = 0;
  let skippedNoCity = 0;
  let skippedNoForecast = 0;
  let skippedLowEdge = 0;

  for (const market of tempMarkets) {
    if (Date.now() - startTime > 28000) break;  // strict 28s guard
    if (analyzed >= MAX_PER_RUN) break;
    if (recentIds.has(market.id)) { skippedRecent++; continue; }

    const parsed = parseTemperatureQuestion(market.question);
    if (!parsed) continue;

    const targetDate = resolveDateStr(parsed.date_str);
    if (!targetDate) continue;

    // Match city (case-insensitive)
    const cityNameLc = parsed.city.toLowerCase();
    const city = cityList.find(c =>
      c.name.toLowerCase() === cityNameLc ||
      c.name.toLowerCase().includes(cityNameLc) ||
      cityNameLc.includes(c.name.toLowerCase())
    );
    if (!city) { skippedNoCity++; continue; }

    // Get recent forecasts for this city + date
    const { data: forecasts } = await supabase
      .from('weather_forecasts')
      .select('temp_high_f, source, fetched_at')
      .eq('city_id', city.id)
      .eq('valid_date', targetDate)
      .order('fetched_at', { ascending: false })
      .limit(5);

    if (!forecasts?.length) { skippedNoForecast++; continue; }

    // Multi-model consensus forecast
    const avgHighF = forecasts.reduce((sum, f) => sum + (f.temp_high_f ?? 0), 0) / forecasts.length;
    const mu_c = (avgHighF - 32) * 5 / 9;  // Convert to Celsius

    // P(max temp meets condition)
    const T = parsed.threshold_c;
    let trueProb: number;
    if (parsed.operator === 'exact') {
      trueProb = normalCDF((T + 0.5 - mu_c) / SIGMA_C) - normalCDF((T - 0.5 - mu_c) / SIGMA_C);
    } else if (parsed.operator === 'lte') {
      trueProb = normalCDF((T - mu_c) / SIGMA_C);
    } else {
      trueProb = 1 - normalCDF((T - mu_c) / SIGMA_C);
    }

    const marketPrice = market.outcome_prices?.[0] ?? 0.5;
    const edge = trueProb - marketPrice;
    const absEdge = Math.abs(edge);

    if (absEdge < MIN_EDGE) { skippedLowEdge++; continue; }

    const direction = edge > 0 ? 'BUY_YES' : 'BUY_NO';
    const confidence = absEdge >= 0.20 ? 'HIGH' : absEdge >= 0.10 ? 'MEDIUM' : 'LOW';

    // ─────────────────────────────────────────────────────────────────
    // Kelly bet sizing — FIXED for BUY_NO bets
    // pWin = P(winning the bet):
    //   BUY_YES → we win if YES resolves → pWin = trueProb (P_YES)
    //   BUY_NO  → we win if NO resolves  → pWin = 1 - trueProb (P_NO)
    // c = entry price (what we pay per share):
    //   BUY_YES → marketPrice (YES token price)
    //   BUY_NO  → 1 - marketPrice (NO token price)
    // ─────────────────────────────────────────────────────────────────
    const pWin = direction === 'BUY_YES' ? trueProb : (1 - trueProb);
    const c    = direction === 'BUY_YES' ? marketPrice : (1 - marketPrice);
    const b    = (1 - c) / c;                              // net odds per $1 risked
    const fullKelly = (pWin * b - (1 - pWin)) / b;
    const confMult  = confidence === 'HIGH' ? 0.8 : confidence === 'MEDIUM' ? 0.5 : 0.2;
    const kellyFraction = fullKelly > 0 ? Math.min(fullKelly * 0.125 * confMult, 0.03) : 0;
    const recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);

    // Upsert with conflict on (market_id, analysis_date) unique index.
    // If a concurrent Netlify instance already wrote this market today,
    // we update in place rather than inserting a duplicate row.
    const todayDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const { error: insertErr } = await supabase.from('weather_analyses').upsert({
      market_id: market.id,
      city_id: city.id,
      consensus_id: null,
      model_high_f: avgHighF,
      model_spread_f: SIGMA_C * 1.8,
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
      reasoning: `Statistical: forecast high ${mu_c.toFixed(1)}°C (${avgHighF.toFixed(1)}°F), threshold ${T}°C ${parsed.operator}, P(match)=${(trueProb * 100).toFixed(1)}%, market=${(marketPrice * 100).toFixed(2)}%, edge=${(edge * 100).toFixed(1)}%`,
      auto_eligible: false,
      ensemble_prob: trueProb,
      ensemble_edge: edge,
      precip_consensus: null,
      flags: [`forecast_sources_${forecasts.length}`, `sigma_${SIGMA_C}C`, `pWin_${(pWin * 100).toFixed(1)}pct`],
      analysis_date: todayDate,
      analyzed_at: new Date().toISOString(),
    }, { onConflict: 'market_id,analysis_date', ignoreDuplicates: false });

    if (insertErr) {
      console.error(`[analyze-temperature] Upsert error for market ${market.id}:`, insertErr.message);
      continue;
    }

    analyzed++;
    console.log(
      `[analyze-temperature] ✅ ${parsed.city} ${parsed.operator}${T}°C | forecast=${mu_c.toFixed(1)}°C | ` +
      `P=${(trueProb * 100).toFixed(1)}% | mkt=${(marketPrice * 100).toFixed(2)}% | ` +
      `edge=${(edge * 100).toFixed(1)}% | ${direction} | Kelly=$${recBetUsd}`
    );
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `[analyze-temperature] Done in ${elapsed}ms. ` +
    `analyzed=${analyzed} skipped=(recent=${skippedRecent} noCity=${skippedNoCity} noForecast=${skippedNoForecast} lowEdge=${skippedLowEdge})`
  );
  return { statusCode: 200 };
});

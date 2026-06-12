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
  type CalibrationPrior,
} from './forecast-ensemble';
import { writeShadowRow } from './backtest-shadow';
import {
  loadCalibrationSnapshot,
  lookupSigma,
  lookupWeight,
  debiasMembers,
} from './calibration-lookup';

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
  /** Exact threshold in °F — preserves °F-question precision (math_v4).
   *  Previously °F thresholds were rounded to whole °C, losing up to 0.9°F. */
  threshold_f: number;
  /** Unit the question (and its resolution rounding) is denominated in. */
  unit: 'c' | 'f';
  operator: 'exact' | 'lte' | 'gte';
  date_str: string;
}

export function parseTemperatureQuestion(question: string): TemperatureParsed | null {
  const matchC = question.match(
    /highest temperature in ([A-Za-z\s\u00C0-\u024F]+?) be (\d+)°C( or below| or above)? on ([A-Za-z]+ \d+)/i
  );
  if (matchC) {
    const c = parseInt(matchC[2]);
    return {
      city: matchC[1].trim(),
      threshold_c: c,
      threshold_f: c * 9 / 5 + 32,
      unit: 'c',
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
      threshold_f: f,
      unit: 'f',
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
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), monthNum, day));
  // math_v4 FIX: previously rolled to NEXT YEAR the moment local midnight of
  // the target day passed, which made every market invisible ON its target
  // day (forecasts for next year don't exist → skippedNoForecast). Only roll
  // forward when the date is more than 72h in the past — markets resolve
  // within ~36h of the target date, so 72h safely distinguishes "this date
  // already happened" from "this date is today/recent".
  if (now.getTime() - candidate.getTime() > 72 * 3600000) {
    candidate.setUTCFullYear(now.getUTCFullYear() + 1);
  }
  return candidate.toISOString().split('T')[0];
}

/**
 * math_v4 (2026-06-12): hours until the EVENT being forecast — the daily
 * maximum temperature, which occurs mid-afternoon LOCAL time (~15:00) on
 * the target date. The previous code measured hours to *midnight UTC* of
 * the target date, understating lead time by ~14-21h and selecting sigma
 * floors 2-4x too tight (0.8°F instead of 2.5-3.2°F) — the root cause of
 * systematic tail over-confidence (see ARBITER_QA_2026-06-11.md).
 */
export function hoursUntilDailyHigh(targetDate: string, timezone: string | null): number {
  let offsetMs = 0;
  if (timezone) {
    try {
      // Offset = local wall time − UTC at noon UTC on the target date.
      const probe = new Date(`${targetDate}T12:00:00Z`);
      const local = new Date(probe.toLocaleString('en-US', { timeZone: timezone }));
      const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
      offsetMs = local.getTime() - utc.getTime();
    } catch {
      offsetMs = 0; // unknown tz → treat as UTC (still far better than midnight)
    }
  }
  // 15:00 local on target date, expressed in UTC ms:
  const highUtcMs = Date.parse(`${targetDate}T15:00:00Z`) - offsetMs;
  return (highUtcMs - Date.now()) / 3600000;
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
  /** Edge #4 (2026-06-10): markets re-analyzed early because forecast shifted */
  shiftRetriggers?: number;
  /** Edge #4 (2026-06-10): analyses flagged repricing_lag=true this cycle */
  lagFlagged?: number;
}

/**
 * Edge #4 (2026-06-10) — repricing-lag detection.
 * Previous-analysis snapshot used to measure how much OUR probability
 * moved vs how much the MARKET moved since the last analysis.
 */
interface PrevAnalysisSnap {
  analyzed_at: string;
  true_prob: number | null;
  market_price: number | null;
  model_high_f: number | null;
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

  // Pre-load all cities (timezone needed for time-of-high lead computation, math_v4)
  const { data: allCities } = await supabase.from('weather_cities').select('id, name, timezone');
  const cityList = (allCities ?? []) as Array<{ id: string; name: string; timezone: string | null }>;

  // Fetch config once (bankroll + Edge #4 lag thresholds)
  const { data: cfgRows } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['paper_bankroll', 'lag_min_prob_shift', 'lag_max_price_shift', 'forecast_shift_reanalyze_f']);
  const cfg: Record<string, string> = {};
  (cfgRows ?? []).forEach((r: { key: string; value: string }) => { cfg[r.key] = r.value; });
  const bankroll = parseFloat(cfg.paper_bankroll ?? '5000');

  // ── Edge #4 (2026-06-10): repricing-lag thresholds ────────────────
  // The actual structural edge in weather markets is the window between
  // a forecast model update and the market repricing (per gopfan2 +
  // public research). We detect it by comparing this analysis to the
  // previous one for the same market:
  //   prob_shift  = our probability now − our probability last time
  //   price_shift = market price now − market price last time
  // repricing_lag=true ⇔ forecast moved toward our side ≥ minProbShift
  // while the market moved ≤ maxPriceShift. Observe-only for now —
  // place-bets gates on it only when require_repricing_lag='true'.
  const parseNum = (raw: string | undefined, fallback: number) => {
    const v = parseFloat(raw ?? '');
    return isNaN(v) || v <= 0 ? fallback : v;
  };
  const LAG_MIN_PROB_SHIFT = parseNum(cfg.lag_min_prob_shift, 0.05);
  const LAG_MAX_PRICE_SHIFT = parseNum(cfg.lag_max_price_shift, 0.02);
  // Forecast-mean move (°F) that justifies re-analyzing BEFORE the 4h
  // recent-window expires. This un-inverts the old behaviour where we
  // re-analyzed on MARKET moves but slept through FORECAST moves.
  const FORECAST_SHIFT_REANALYZE_F = parseNum(cfg.forecast_shift_reanalyze_f, 0.9);
  const LAG_MAX_PREV_AGE_MS = 6 * 3600000; // prev older than 6h ⇒ shift timing unknown ⇒ not "fresh"
  log(`Edge#4 lag config: minProbShift=${LAG_MIN_PROB_SHIFT} maxPriceShift=${LAG_MAX_PRICE_SHIFT} reanalyzeF=${FORECAST_SHIFT_REANALYZE_F}°F`);

  // Bulk-load the most recent prior analysis per market (last 24h) so we
  // can compute shifts without a per-market query.
  const prevCutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  const { data: prevRows } = await supabase
    .from('weather_analyses')
    .select('market_id, analyzed_at, true_prob, market_price, model_high_f')
    .eq('market_type', 'temperature_statistical')
    .gte('analyzed_at', prevCutoff)
    .order('analyzed_at', { ascending: false })
    .limit(5000);
  const prevByMarket = new Map<string, PrevAnalysisSnap>();
  for (const row of prevRows ?? []) {
    const mid = String((row as { market_id: string }).market_id);
    if (!prevByMarket.has(mid)) {
      prevByMarket.set(mid, row as unknown as PrevAnalysisSnap);
    }
  }
  log(`Edge#4: loaded prev snapshots for ${prevByMarket.size} markets`);

  // Load calibration snapshot once per run (Phase A.3).
  // Respects system_config.calibration_enabled. Returns EMPTY_SNAPSHOT if
  // disabled — every lookup becomes a no-op and we fall back to raw math.
  const calibration = await loadCalibrationSnapshot(supabase);
  if (calibration.enabled) {
    log(`Calibration loaded: sigma=${calibration.rowCounts.sigma} bias=${calibration.rowCounts.bias} weights=${calibration.rowCounts.weights}`);
  }

  let analyzed = 0, skippedRecent = 0, skippedNoCity = 0, skippedNoForecast = 0, skippedLowEdge = 0, errors = 0;
  let shiftRetriggers = 0, lagFlagged = 0;

  for (const market of tempMarkets) {
    // Edge #4 (2026-06-10): the recently-analyzed skip moved BELOW the
    // forecast fetch so a material forecast shift can bypass it — we now
    // re-analyze when the FORECAST moves, not only when the price moves.

    const parsed = parseTemperatureQuestion(market.question);
    if (!parsed) continue;

    const targetDate = resolveDateStr(parsed.date_str);
    if (!targetDate) continue;

    // math_v4: lead time is measured to the EVENT (the afternoon daily high),
    // not to midnight UTC of the target date. daysOut is calendar days,
    // matching calibration-ingest's lead_days semantics exactly.
    const todayUtc = new Date().toISOString().split('T')[0];
    const daysOut = Math.max(0, Math.round(
      (Date.parse(targetDate) - Date.parse(todayUtc)) / 86400000
    ));
    const legacySigmaC = sigmaCForDaysOut(daysOut);

    // Match city
    const cityNameLc = parsed.city.toLowerCase();
    const city = cityList.find(c =>
      c.name.toLowerCase() === cityNameLc ||
      c.name.toLowerCase().includes(cityNameLc) ||
      cityNameLc.includes(c.name.toLowerCase())
    );
    if (!city) { skippedNoCity++; continue; }

    // math_v4: effective lead time to the afternoon high (local 15:00).
    const hoursRemaining = Math.max(0, hoursUntilDailyHigh(targetDate, city.timezone));

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

    // ── Edge #4: shift-aware recent-skip ──────────────────────
    // Skip recently-analyzed markets UNLESS the forecast mean moved
    // materially since the previous analysis — in that case re-analyze
    // immediately to capture the repricing-lag window.
    const prev = prevByMarket.get(String(market.id)) ?? null;
    const forecastShiftF = prev?.model_high_f != null ? avgHighF - prev.model_high_f : null;
    if (recentIds.has(market.id)) {
      const bigShift = forecastShiftF !== null && Math.abs(forecastShiftF) >= FORECAST_SHIFT_REANALYZE_F;
      if (!bigShift) { skippedRecent++; continue; }
      shiftRetriggers++;
      log(`⚡ Forecast shift ${forecastShiftF!.toFixed(1)}°F on "${market.question.substring(0, 55)}" — re-analyzing before recent-window expiry`);
    }

    const T_c = parsed.threshold_c;
    const T_f = parsed.threshold_f; // math_v4: exact °F for °F questions (no °C round-trip)
    // Build a bracket range in °F from the operator.
    // Resolution rounds the observed high to the nearest whole degree IN THE
    // QUESTION'S UNIT, so every operator gets a ±0.5-unit window:
    //   exact:        actual ∈ [T-0.5, T+0.5)
    //   lte ("or below"):  YES ⇔ rounded ≤ T ⇔ actual < T+0.5
    //   gte ("or higher"): YES ⇔ rounded ≥ T ⇔ actual ≥ T-0.5
    // math_v4 FIX: lte/gte previously used the bare threshold (no half
    // window), systematically underestimating P(YES) by the probability
    // mass in the missing 0.5-unit sliver — the source of fake BUY_NO
    // edges (BUY_NO 0/10, gte 0/11 lifetime).
    let bracket: BracketRange;
    const halfWindowF = parsed.unit === 'c' ? 0.5 * 9 / 5 : 0.5; // 0.9°F or 0.5°F
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
        high_f: T_f + halfWindowF,
        kind: 'at_or_below',
        label: `<=${T_c}°C`,
      };
    } else {
      bracket = {
        low_f: T_f - halfWindowF,
        high_f: Infinity,
        kind: 'at_or_above',
        label: `>=${T_c}°C`,
      };
    }

    // ── Build calibration prior (Phase A.3) ──────────────────
    // When calibration is enabled AND we have enough samples for this
    // (city, lead, month) bucket, we apply:
    //   1. Per-model bias correction (debias each member)
    //   2. Empirical sigma blend (alpha = n_cal/30)
    //   3. Per-model weighted empirical CDF
    // All three degrade gracefully — if any lookup misses, it falls
    // back to raw-math behavior for just that component.
    // math_v4: calendar-day lead — matches calibration-ingest lead_days
    // semantics (issue date → valid date). The old round(hoursRemaining/24)
    // mapped evening-before analyses to lead-0 buckets (day-of error stats,
    // much tighter), corrupting the sigma blend.
    const leadDays = daysOut;
    const monthNum = Number(targetDate.slice(5, 7));
    let prior: CalibrationPrior | undefined;
    if (calibration.enabled) {
      const debiased = debiasMembers(members, calibration, city.id, leadDays, monthNum);
      const sigmaLookup = lookupSigma(calibration, city.id, leadDays, monthNum);
      // Build weight map across the sources actually present, normalize
      // so they sum to 1 over the set of members with a known weight.
      const weightEntries: Array<[string, number]> = [];
      let weightSum = 0;
      for (const m of members) {
        const w = lookupWeight(calibration, city.id, m.source, leadDays);
        if (w) {
          weightEntries.push([m.source, w.weight]);
          weightSum += w.weight;
        }
      }
      const weightBySource = new Map<string, number>();
      if (weightSum > 0) {
        for (const [src, w] of weightEntries) weightBySource.set(src, w / weightSum);
      }
      prior = {
        debiasedMembers: debiased,
        empiricalSigmaF: sigmaLookup?.sigma_f ?? null,
        nCalSigma: sigmaLookup?.n ?? null,
        weightBySource: weightBySource.size > 0 ? weightBySource : undefined,
      };
    }

    const forecastProb = computeBracketProbability(members, bracket, hoursRemaining, prior);
    const trueProb = forecastProb.probability;
    const sigmaFEff = forecastProb.sigma_f;
    const sigmaCEff = sigmaFEff * 5 / 9;

    const marketPrice = market.outcome_prices?.[0] ?? 0.5;
    const edge = trueProb - marketPrice;
    const absEdge = Math.abs(edge);

    // ── Edge #4: repricing-lag signal ─────────────────────────
    // repricing_lag=true means: since the previous analysis, OUR
    // probability moved ≥ LAG_MIN_PROB_SHIFT toward the side we'd bet,
    // while the MARKET moved ≤ LAG_MAX_PRICE_SHIFT — i.e. the forecast
    // updated and the market hasn't repriced yet. This is the window
    // where public evidence says weather-market alpha actually lives.
    let probShift: number | null = null;
    let priceShift: number | null = null;
    let repricingLag = false;
    if (prev && prev.true_prob != null && prev.market_price != null) {
      probShift = trueProb - prev.true_prob;
      priceShift = marketPrice - prev.market_price;
      const prevAgeMs = Date.now() - new Date(prev.analyzed_at).getTime();
      const towardOurSide = edge > 0
        ? probShift >= LAG_MIN_PROB_SHIFT
        : probShift <= -LAG_MIN_PROB_SHIFT;
      repricingLag = towardOurSide
        && Math.abs(priceShift) <= LAG_MAX_PRICE_SHIFT
        && prevAgeMs <= LAG_MAX_PREV_AGE_MS;
    }
    if (repricingLag) {
      lagFlagged++;
      log(`🎯 REPRICING LAG: "${market.question.substring(0, 55)}" probΔ=${((probShift ?? 0) * 100).toFixed(1)}pp priceΔ=${((priceShift ?? 0) * 100).toFixed(1)}pp`);
    }

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

    // 2026-04-20: BUY_NO suppression removed. The V3.2-era "0/11" sample
    // pre-dates V3.3 reset and biased the learner's direction audit (100%
    // of bets were BUY_YES, so the learner blocked BUY_YES and starved the
    // whole pipeline). Emit both directions; let place-bets.ts filter on
    // learned blocks, and let the learning loop see real data.
    const direction: 'BUY_YES' | 'BUY_NO' = edge > 0 ? 'BUY_YES' : 'BUY_NO';
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
      reasoning: `[Railway-v3] Member-distribution: n=${members.length} forecasts, mean ${mu_c.toFixed(1)}°C (${avgHighF.toFixed(1)}°F), sigma=${sigmaCEff.toFixed(2)}°C (${sigmaFEff.toFixed(2)}°F, method=${forecastProb.method}, σ_source=${forecastProb.sigma_source}${forecastProb.calibration_used ? ', calibrated' : ''}${forecastProb.n_cal_sigma ? `, n_cal=${forecastProb.n_cal_sigma}` : ''}, ${daysOut}d out), threshold ${T_c}°C ${parsed.operator}, P=${(trueProb*100).toFixed(1)}%, mkt=${(marketPrice*100).toFixed(2)}%, edge=${(edge*100).toFixed(1)}%`,
      auto_eligible: confidence === 'HIGH' && members.length >= 3 && absEdge >= MIN_EDGE,
      ensemble_prob: trueProb,
      ensemble_edge: edge,
      precip_consensus: null,
      // Edge #4 (2026-06-10): repricing-lag telemetry
      prob_shift: probShift,
      price_shift: priceShift,
      repricing_lag: repricingLag,
      prev_analyzed_at: prev?.analyzed_at ?? null,
      flags: [
        `railway_worker_v2`,
        `math_v4`,
        `lead_h_${hoursRemaining.toFixed(0)}`,
        `forecast_sources_${members.length}`,
        `sigma_${sigmaCEff.toFixed(2)}C_${forecastProb.method}`,
        `sigma_source_${forecastProb.sigma_source}`,
        `days_out_${daysOut}`,
        `pWin_${(pWin * 100).toFixed(1)}pct`,
        `legacy_sigma_${legacySigmaC.toFixed(1)}C`,
        ...(forecastProb.calibration_used ? ['calibrated_v1'] : []),
        ...(forecastProb.method === 'empirical_weighted' ? ['weighted_ecdf'] : []),
        ...(repricingLag ? ['repricing_lag'] : []),
        ...(forecastShiftF !== null && Math.abs(forecastShiftF) >= FORECAST_SHIFT_REANALYZE_F ? ['forecast_shift_retrigger'] : []),
      ],
    });

    if (insertErr) { errors++; continue; }

    analyzed++;
    log(`✅ ${parsed.city} ${parsed.operator}${T_c}°C | ${daysOut}d out σ=${sigmaCEff.toFixed(2)}°C (${forecastProb.method}) | forecast=${mu_c.toFixed(1)}°C | n=${members.length} | edge=${(edge*100).toFixed(1)}% ${direction} $${recBetUsd}`);
  }

  const durationMs = Date.now() - start;
  log(`Done: analyzed=${analyzed} skipped=(recent=${skippedRecent} noCity=${skippedNoCity} noForecast=${skippedNoForecast} lowEdge=${skippedLowEdge}) shiftRetriggers=${shiftRetriggers} lagFlagged=${lagFlagged} errors=${errors} in ${durationMs}ms`);
  return { analyzed, skippedRecent, skippedNoCity, skippedNoForecast, skippedLowEdge, errors, durationMs, shiftRetriggers, lagFlagged };
}

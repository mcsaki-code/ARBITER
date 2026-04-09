/**
 * Path A — Phase A.2: Derive calibration tables from raw pairs.
 *
 * Reads weather_calibration_raw (populated by calibration-ingest.ts) and
 * rolls it up into the three tables consumed at analysis time:
 *
 *   weather_calibration_sigma   — empirical σ per (city, lead_days, month)
 *   weather_calibration_bias    — per-model bias per (city, source, lead_days, month)
 *   weather_calibration_weights — ensemble weights per (city, source, lead_days)
 *
 * This is an aggregation-only pass. It never writes to _raw. Safe to re-run
 * at any time — UPSERTs on the natural keys.
 *
 * USAGE:
 *   cd worker && npm run derive:calibration
 *
 * VALIDATION (logged at end):
 *   - rows written to each table
 *   - sigma range sanity check (should be 0.5°F - 6°F)
 *   - weight sums (should sum to ~1.0 per (city, lead_days))
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface RawRow {
  city_id: string;
  valid_date: string;
  source: string;
  lead_days: number;
  forecast_high_f: number | null;
  observed_high_f: number | null;
  error_f: number | null;
}

const MIN_SAMPLES = 20; // drop buckets below this — too noisy to trust
const SIGMA_EPSILON = 1e-4; // weight calc denominator guard

function monthOf(dateStr: string): number {
  return Number(dateStr.slice(5, 7));
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddevSample(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function rmse(errors: number[]): number {
  if (errors.length === 0) return 0;
  return Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
}

function mae(errors: number[]): number {
  if (errors.length === 0) return 0;
  return errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length;
}

/**
 * Fetch weather_calibration_raw per-city to avoid Supabase statement timeouts.
 * With ~688k rows total, offset-based paging on the whole table times out past
 * ~550k. Querying per-city (~40k rows each, 34 cities) stays well within limits.
 */
async function fetchAllRaw(supabase: SupabaseClient): Promise<RawRow[]> {
  // First get all distinct city_ids
  const { data: cities, error: citiesErr } = await supabase
    .from('weather_calibration_raw')
    .select('city_id')
    .not('error_f', 'is', null)
    .limit(1000);
  if (citiesErr) throw new Error(`city list fetch: ${citiesErr.message}`);
  const cityIds = [...new Set((cities ?? []).map((r: { city_id: string }) => r.city_id))];

  // Actually, get city_ids from weather_cities to be sure
  const { data: allCities, error: allCitiesErr } = await supabase
    .from('weather_cities')
    .select('id')
    .eq('is_active', true);
  if (allCitiesErr) throw new Error(`weather_cities fetch: ${allCitiesErr.message}`);
  const activeCityIds = (allCities ?? []).map((c: { id: string }) => c.id);

  const all: RawRow[] = [];
  for (const cityId of activeCityIds) {
    const PAGE = 1000; // Supabase caps responses at 1000 rows
    let from = 0;
    let cityCount = 0;
    while (true) {
      const { data, error } = await supabase
        .from('weather_calibration_raw')
        .select('city_id, valid_date, source, lead_days, forecast_high_f, observed_high_f, error_f')
        .eq('city_id', cityId)
        .not('error_f', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`raw fetch city ${cityId}: ${error.message}`);
      if (!data || data.length === 0) break;
      all.push(...(data as RawRow[]));
      cityCount += data.length;
      if (data.length < PAGE) break;
      from += PAGE;
    }
    if (cityCount > 0) {
      console.log(`[calibration-derive] loaded city ${cityId}: ${cityCount} rows`);
    }
    if (all.length % 100000 < 50000 && all.length > 50000) {
      console.log(`[calibration-derive] total so far: ${all.length} rows…`);
    }
  }
  return all;
}

/**
 * Group rows by a composite key. Returns Map<key, RawRow[]>.
 */
function groupBy<K extends string>(
  rows: RawRow[],
  keyFn: (r: RawRow) => K
): Map<K, RawRow[]> {
  const m = new Map<K, RawRow[]>();
  for (const r of rows) {
    const k = keyFn(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

async function upsertChunks<T>(
  supabase: SupabaseClient,
  table: string,
  rows: T[],
  onConflict: string
): Promise<number> {
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) {
      console.error(`[calibration-derive] ${table} upsert failed: ${error.message}`);
      break;
    }
    inserted += batch.length;
  }
  return inserted;
}

export async function deriveCalibration(): Promise<void> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase env vars');
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  console.log('[calibration-derive] loading raw rows…');
  const raw = await fetchAllRaw(supabase);
  console.log(`[calibration-derive] loaded ${raw.length} raw rows`);
  if (raw.length === 0) {
    console.warn('[calibration-derive] no raw rows — run ingest:calibration first');
    return;
  }

  // ── SIGMA: (city, lead_days, month) across all sources ──────────────
  const sigmaGroups = groupBy(raw, (r) => `${r.city_id}|${r.lead_days}|${monthOf(r.valid_date)}`);
  const sigmaRows: Array<{
    city_id: string;
    lead_days: number;
    month: number;
    n: number;
    empirical_sigma_f: number;
    mean_error_f: number;
  }> = [];
  let sigmaMin = Infinity, sigmaMax = -Infinity;
  for (const [key, group] of sigmaGroups) {
    if (group.length < MIN_SAMPLES) continue;
    const [city_id, leadStr, monthStr] = key.split('|');
    const errors = group.map((r) => Number(r.error_f));
    const sigma = stddevSample(errors);
    const bias = mean(errors);
    sigmaRows.push({
      city_id,
      lead_days: Number(leadStr),
      month: Number(monthStr),
      n: group.length,
      empirical_sigma_f: sigma,
      mean_error_f: bias,
    });
    if (sigma < sigmaMin) sigmaMin = sigma;
    if (sigma > sigmaMax) sigmaMax = sigma;
  }
  const sigmaInserted = await upsertChunks(
    supabase,
    'weather_calibration_sigma',
    sigmaRows,
    'city_id,lead_days,month'
  );
  console.log(
    `[calibration-derive] sigma: ${sigmaInserted} rows (range ${sigmaMin.toFixed(2)}°F – ${sigmaMax.toFixed(2)}°F)`
  );

  // ── BIAS: (city, source, lead_days, month) ──────────────────────────
  const biasGroups = groupBy(
    raw,
    (r) => `${r.city_id}|${r.source}|${r.lead_days}|${monthOf(r.valid_date)}`
  );
  const biasRows: Array<{
    city_id: string;
    source: string;
    lead_days: number;
    month: number;
    n: number;
    bias_f: number;
    mae_f: number;
    rmse_f: number;
  }> = [];
  for (const [key, group] of biasGroups) {
    if (group.length < MIN_SAMPLES) continue;
    const [city_id, source, leadStr, monthStr] = key.split('|');
    const errors = group.map((r) => Number(r.error_f));
    biasRows.push({
      city_id,
      source,
      lead_days: Number(leadStr),
      month: Number(monthStr),
      n: group.length,
      bias_f: mean(errors),
      mae_f: mae(errors),
      rmse_f: rmse(errors),
    });
  }
  const biasInserted = await upsertChunks(
    supabase,
    'weather_calibration_bias',
    biasRows,
    'city_id,source,lead_days,month'
  );
  console.log(`[calibration-derive] bias: ${biasInserted} rows`);

  // ── WEIGHTS: (city, source, lead_days) via inverse-RMSE² ────────────
  // Pool across months for weights (stable signal; per-month-per-source
  // would be too thin for many buckets and we want a smoother ensemble).
  const wGroups = groupBy(raw, (r) => `${r.city_id}|${r.source}|${r.lead_days}`);
  // First pass: compute per-(city, source, lead) RMSE.
  type WStat = { city_id: string; source: string; lead_days: number; n: number; rmse_f: number };
  const wStats: WStat[] = [];
  for (const [key, group] of wGroups) {
    if (group.length < MIN_SAMPLES) continue;
    const [city_id, source, leadStr] = key.split('|');
    const errors = group.map((r) => Number(r.error_f));
    wStats.push({
      city_id,
      source,
      lead_days: Number(leadStr),
      n: group.length,
      rmse_f: rmse(errors),
    });
  }
  // Second pass: normalize across sources within each (city, lead_days).
  const wByCityLead = new Map<string, WStat[]>();
  for (const s of wStats) {
    const k = `${s.city_id}|${s.lead_days}`;
    const arr = wByCityLead.get(k);
    if (arr) arr.push(s);
    else wByCityLead.set(k, [s]);
  }
  const weightRows: Array<{
    city_id: string;
    source: string;
    lead_days: number;
    weight: number;
    rmse_f: number;
    n: number;
  }> = [];
  const weightSumCheck: number[] = [];
  for (const [, stats] of wByCityLead) {
    const rawWeights = stats.map((s) => 1 / (s.rmse_f * s.rmse_f + SIGMA_EPSILON));
    const total = rawWeights.reduce((a, b) => a + b, 0);
    let sum = 0;
    for (let i = 0; i < stats.length; i++) {
      const w = rawWeights[i] / total;
      sum += w;
      weightRows.push({
        city_id: stats[i].city_id,
        source: stats[i].source,
        lead_days: stats[i].lead_days,
        weight: w,
        rmse_f: stats[i].rmse_f,
        n: stats[i].n,
      });
    }
    weightSumCheck.push(sum);
  }
  const weightsInserted = await upsertChunks(
    supabase,
    'weather_calibration_weights',
    weightRows,
    'city_id,source,lead_days'
  );
  const minSum = Math.min(...weightSumCheck);
  const maxSum = Math.max(...weightSumCheck);
  console.log(
    `[calibration-derive] weights: ${weightsInserted} rows (sum range ${minSum.toFixed(4)} – ${maxSum.toFixed(4)})`
  );

  console.log('[calibration-derive] DONE');
}

if (require.main === module) {
  deriveCalibration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[calibration-derive] FATAL:', err);
      process.exit(1);
    });
}

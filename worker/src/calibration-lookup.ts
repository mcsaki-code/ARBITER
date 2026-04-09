/**
 * Path A — Phase A.3/A.4: Runtime calibration lookup.
 *
 * Loads weather_calibration_{sigma,bias,weights} into memory once per
 * analyzer run and exposes fast lookup functions. Designed to be called
 * at the top of temperature.ts, then passed into computeBracketProbability
 * and the 3-AI prompt builders.
 *
 * Safe-by-default: if the feature flag is off, or the tables are empty,
 * or Supabase errors, returns an EMPTY_SNAPSHOT and every lookup becomes
 * a no-op. Callers should treat missing calibration as "use literature
 * defaults" — nothing breaks.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface CalibrationSnapshot {
  enabled: boolean;
  // (city_id, lead_days, month) -> { sigma, n, mean_error }
  sigma: Map<string, { sigma_f: number; n: number; mean_error_f: number }>;
  // (city_id, source, lead_days, month) -> { bias, mae, rmse, n }
  bias: Map<string, { bias_f: number; mae_f: number; rmse_f: number; n: number }>;
  // (city_id, source, lead_days) -> { weight, rmse, n }
  weights: Map<string, { weight: number; rmse_f: number; n: number }>;
  loadedAt: string;
  rowCounts: { sigma: number; bias: number; weights: number };
}

export const EMPTY_SNAPSHOT: CalibrationSnapshot = {
  enabled: false,
  sigma: new Map(),
  bias: new Map(),
  weights: new Map(),
  loadedAt: new Date(0).toISOString(),
  rowCounts: { sigma: 0, bias: 0, weights: 0 },
};

function sigmaKey(city_id: string, lead_days: number, month: number): string {
  return `${city_id}|${lead_days}|${month}`;
}

function biasKey(city_id: string, source: string, lead_days: number, month: number): string {
  return `${city_id}|${source}|${lead_days}|${month}`;
}

function weightKey(city_id: string, source: string, lead_days: number): string {
  return `${city_id}|${source}|${lead_days}`;
}

/**
 * Load the calibration snapshot. Respects system_config.calibration_enabled
 * — if false, returns EMPTY_SNAPSHOT (every lookup is a no-op).
 */
export async function loadCalibrationSnapshot(
  supabase: SupabaseClient
): Promise<CalibrationSnapshot> {
  try {
    const { data: flagRow } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'calibration_enabled')
      .maybeSingle();
    const enabled = flagRow?.value === 'true' || flagRow?.value === true;
    if (!enabled) return EMPTY_SNAPSHOT;

    const [sigmaRes, biasRes, weightsRes] = await Promise.all([
      supabase.from('weather_calibration_sigma').select('*'),
      supabase.from('weather_calibration_bias').select('*'),
      supabase.from('weather_calibration_weights').select('*'),
    ]);

    if (sigmaRes.error || biasRes.error || weightsRes.error) {
      console.warn('[calibration-lookup] load error, using empty snapshot', {
        sigma: sigmaRes.error?.message,
        bias: biasRes.error?.message,
        weights: weightsRes.error?.message,
      });
      return EMPTY_SNAPSHOT;
    }

    const snap: CalibrationSnapshot = {
      enabled: true,
      sigma: new Map(),
      bias: new Map(),
      weights: new Map(),
      loadedAt: new Date().toISOString(),
      rowCounts: {
        sigma: sigmaRes.data?.length ?? 0,
        bias: biasRes.data?.length ?? 0,
        weights: weightsRes.data?.length ?? 0,
      },
    };

    for (const r of sigmaRes.data ?? []) {
      snap.sigma.set(sigmaKey(r.city_id, r.lead_days, r.month), {
        sigma_f: Number(r.empirical_sigma_f),
        n: Number(r.n),
        mean_error_f: Number(r.mean_error_f),
      });
    }
    for (const r of biasRes.data ?? []) {
      snap.bias.set(biasKey(r.city_id, r.source, r.lead_days, r.month), {
        bias_f: Number(r.bias_f),
        mae_f: Number(r.mae_f),
        rmse_f: Number(r.rmse_f),
        n: Number(r.n),
      });
    }
    for (const r of weightsRes.data ?? []) {
      snap.weights.set(weightKey(r.city_id, r.source, r.lead_days), {
        weight: Number(r.weight),
        rmse_f: Number(r.rmse_f),
        n: Number(r.n),
      });
    }

    console.log(
      `[calibration-lookup] loaded: sigma=${snap.rowCounts.sigma} bias=${snap.rowCounts.bias} weights=${snap.rowCounts.weights}`
    );
    return snap;
  } catch (err: any) {
    console.warn('[calibration-lookup] exception, using empty snapshot:', err?.message ?? err);
    return EMPTY_SNAPSHOT;
  }
}

/**
 * Get empirical sigma for (city, lead, month). Returns null if not enough data.
 * Lead bucket is clamped to the nearest stored bucket (0,1,2,3,5,7).
 */
export function lookupSigma(
  snap: CalibrationSnapshot,
  city_id: string,
  lead_days: number,
  month: number
): { sigma_f: number; n: number } | null {
  if (!snap.enabled) return null;
  const lead = clampLead(lead_days);
  const row = snap.sigma.get(sigmaKey(city_id, lead, month));
  if (!row || row.n < 20) return null;
  return { sigma_f: row.sigma_f, n: row.n };
}

export function lookupBias(
  snap: CalibrationSnapshot,
  city_id: string,
  source: string,
  lead_days: number,
  month: number
): { bias_f: number; mae_f: number; rmse_f: number; n: number } | null {
  if (!snap.enabled) return null;
  const lead = clampLead(lead_days);
  const row = snap.bias.get(biasKey(city_id, source, lead, month));
  if (!row || row.n < 20) return null;
  return row;
}

export function lookupWeight(
  snap: CalibrationSnapshot,
  city_id: string,
  source: string,
  lead_days: number
): { weight: number; rmse_f: number; n: number } | null {
  if (!snap.enabled) return null;
  const lead = clampLead(lead_days);
  const row = snap.weights.get(weightKey(city_id, source, lead));
  if (!row || row.n < 20) return null;
  return row;
}

/**
 * Clamp lead time to nearest stored bucket (0, 1, 2, 3, 5, 7).
 * Matches the lead_days values produced by calibration-ingest.ts.
 */
function clampLead(lead_days: number): number {
  const buckets = [0, 1, 2, 3, 5, 7];
  let best = buckets[0];
  let bestDiff = Math.abs(lead_days - best);
  for (const b of buckets) {
    const d = Math.abs(lead_days - b);
    if (d < bestDiff) {
      best = b;
      bestDiff = d;
    }
  }
  return best;
}

/**
 * Blend a sample sigma with an empirical sigma using sample-size shrinkage.
 *   alpha = min(1, n_cal / 30)
 *   blended^2 = alpha * emp^2 + (1 - alpha) * max(sample, floor)^2
 *
 * Result: when we have lots of calibration data, trust it; when we have
 * little, fall back to literature floor. Never "erases" a strong sample
 * signal from actual model disagreement on this forecast.
 */
export function blendSigma(
  sampleSigma: number,
  floorSigma: number,
  empiricalSigma: number | null,
  nCal: number | null
): { sigma: number; source: 'sample' | 'floor' | 'blend' } {
  const baseline = Math.max(sampleSigma, floorSigma);
  if (empiricalSigma == null || nCal == null || nCal < 20) {
    return { sigma: baseline, source: sampleSigma >= floorSigma ? 'sample' : 'floor' };
  }
  const alpha = Math.min(1, nCal / 30);
  const blended = Math.sqrt(alpha * empiricalSigma ** 2 + (1 - alpha) * baseline ** 2);
  return { sigma: blended, source: 'blend' };
}

/**
 * Apply per-model bias correction to a list of forecast members.
 * Returns a new array with bias-corrected temperatures. Members without
 * calibration data pass through unchanged.
 */
export function debiasMembers<T extends { source: string; temp_high_f: number }>(
  members: T[],
  snap: CalibrationSnapshot,
  city_id: string,
  lead_days: number,
  month: number
): Array<T & { original_temp_f: number; bias_correction_f: number }> {
  return members.map((m) => {
    const row = lookupBias(snap, city_id, m.source, lead_days, month);
    const correction = row ? row.bias_f : 0;
    return {
      ...m,
      original_temp_f: m.temp_high_f,
      bias_correction_f: correction,
      temp_high_f: m.temp_high_f - correction,
    };
  });
}

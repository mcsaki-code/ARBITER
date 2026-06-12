/**
 * Ensemble Ingest — Phase 1 of the 2026-06-12 reset plan.
 *
 * Fetches TRUE ensemble members (GFS ENS ~31, ECMWF ENS ~51) from the
 * Open-Meteo Ensemble API and appends them to `ensemble_forecasts`.
 * This replaces the 3-correlated-deterministic-snapshots pipeline that
 * the corpus replay proved has zero edge (k*=0).
 *
 * Design principles (each one is a lesson from the 6/11-6/12 QA):
 *   1. APPEND-ONLY. Never overwrite. History is the calibration asset.
 *      (The old open-meteo ingest upserted in place and destroyed all
 *      forecast history for non-NWS cities.)
 *   2. RUN-ALIGNED. We fetch when a new model run becomes available,
 *      not on a flat timer — the repricing-lag edge lives in the minutes
 *      after a run lands. run_label dedupes so we store each run once.
 *   3. °F end-to-end, daily max computed per member from hourly values
 *      in the city's LOCAL timezone (timezone=auto).
 *
 * API: https://open-meteo.com/en/docs/ensemble-api (free, no key, 10k/day)
 * Budget: ~60 cities × (4 GFS + 2 ECMWF) runs/day ≈ 360 calls/day.
 */

import { SupabaseClient } from '@supabase/supabase-js';

// Ensemble models served by Open-Meteo. gfs_seamless = GEFS (31 members),
// ecmwf_ifs025 = ECMWF IFS ENS 0.25° (51 members, open-data since 2025-10).
const MODELS: Array<{ model: string; runHoursUtc: number[]; availabilityLagH: number }> = [
  { model: 'gfs_seamless', runHoursUtc: [0, 6, 12, 18], availabilityLagH: 4.5 },
  { model: 'ecmwf_ifs025', runHoursUtc: [0, 12], availabilityLagH: 8 },
];

const FORECAST_DAYS = 4;          // today + 3 — enables multi-day strategies
const FETCH_DELAY_MS = 250;       // be polite to the free API
const MIN_MEMBERS_TO_STORE = 10;  // below this something is wrong with the response

export interface EnsembleIngestResult {
  fetched: number;
  skippedUpToDate: number;
  rowsInserted: number;
  errors: number;
  durationMs: number;
}

/** Latest run of a model that should be available at `now`. */
export function latestAvailableRun(
  model: { runHoursUtc: number[]; availabilityLagH: number },
  now: Date
): { runLabel: (m: string) => string; runIso: string } {
  // Walk back hour by hour until we find a run hour whose availability lag has passed.
  for (let back = 0; back < 48; back++) {
    const cand = new Date(now.getTime() - back * 3600000);
    const h = cand.getUTCHours();
    if (model.runHoursUtc.includes(h)) {
      const runStart = new Date(Date.UTC(
        cand.getUTCFullYear(), cand.getUTCMonth(), cand.getUTCDate(), h
      ));
      if (now.getTime() - runStart.getTime() >= model.availabilityLagH * 3600000) {
        const iso = runStart.toISOString();
        const label = `${iso.slice(0, 10)}T${String(h).padStart(2, '0')}Z`;
        return { runLabel: (m: string) => `${m}_${label}`, runIso: iso };
      }
    }
  }
  // Degenerate fallback — shouldn't happen
  const iso = now.toISOString();
  return { runLabel: (m: string) => `${m}_${iso.slice(0, 13)}Z`, runIso: iso };
}

interface HourlyBlock {
  time: string[];                       // local time strings (timezone=auto)
  [key: string]: string[] | number[] | undefined;
}

/** Per-member daily max from an hourly response block. Returns date → members[]. */
export function dailyMaxByMember(hourly: HourlyBlock): Map<string, number[]> {
  const memberKeys = Object.keys(hourly).filter(
    (k) => k === 'temperature_2m' || k.startsWith('temperature_2m_member')
  );
  const times = hourly.time;
  const byDate = new Map<string, number[]>(); // date → max per member (indexed like memberKeys)
  for (let i = 0; i < times.length; i++) {
    const date = String(times[i]).slice(0, 10);
    let arr = byDate.get(date);
    if (!arr) {
      arr = new Array(memberKeys.length).fill(-Infinity);
      byDate.set(date, arr);
    }
    for (let m = 0; m < memberKeys.length; m++) {
      const v = (hourly[memberKeys[m]] as number[])[i];
      if (v != null && Number.isFinite(v) && v > arr[m]) arr[m] = v;
    }
  }
  // Drop members that never got a finite value
  for (const [date, arr] of byDate) {
    byDate.set(date, arr.filter((v) => Number.isFinite(v)));
  }
  return byDate;
}

function sampleStats(values: number[]): { mean: number; std: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, std: 0 };
  const sq = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return { mean, std: Math.sqrt(sq / (n - 1)) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One ingest cycle. Call every ~10 minutes from index.ts — it no-ops
 * unless a new model run is available for a (city, model) pair.
 */
export async function ingestEnsembleForecasts(
  supabase: SupabaseClient,
  options: { verbose?: boolean } = {}
): Promise<EnsembleIngestResult> {
  const start = Date.now();
  const verbose = options.verbose ?? true;
  const log = (m: string) => { if (verbose) console.log(`[ens-ingest] ${m}`); };

  let fetched = 0, skippedUpToDate = 0, rowsInserted = 0, errors = 0;

  // Active cities (rotation-proof: all active cities, not just allowlist)
  const { data: cities, error: cityErr } = await supabase
    .from('weather_cities')
    .select('id, name, lat, lon')
    .eq('is_active', true);
  if (cityErr || !cities?.length) {
    if (cityErr) { console.error(`[ens-ingest] cities fetch: ${cityErr.message}`); errors++; }
    return { fetched, skippedUpToDate, rowsInserted, errors, durationMs: Date.now() - start };
  }

  const now = new Date();

  // Which (city, model, run) combos do we already have? One query.
  const currentLabels = MODELS.map((m) => latestAvailableRun(m, now).runLabel(m.model));
  const { data: haveRows } = await supabase
    .from('ensemble_forecasts')
    .select('city_id, model, run_label')
    .in('run_label', currentLabels);
  const have = new Set((haveRows ?? []).map(
    (r: { city_id: string; model: string; run_label: string }) => `${r.city_id}|${r.run_label}`
  ));

  for (const mdl of MODELS) {
    const run = latestAvailableRun(mdl, now);
    const runLabel = run.runLabel(mdl.model);

    for (const city of cities) {
      if (have.has(`${city.id}|${runLabel}`)) { skippedUpToDate++; continue; }
      if (city.lat == null || city.lon == null) continue;

      try {
        const url =
          `https://ensemble-api.open-meteo.com/v1/ensemble` +
          `?latitude=${city.lat}&longitude=${city.lon}` +
          `&hourly=temperature_2m&models=${mdl.model}` +
          `&forecast_days=${FORECAST_DAYS}&temperature_unit=fahrenheit&timezone=auto`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          errors++;
          console.warn(`[ens-ingest] HTTP ${res.status} for ${city.name}/${mdl.model}`);
          await sleep(FETCH_DELAY_MS);
          continue;
        }
        const data = await res.json() as { hourly?: HourlyBlock };
        fetched++;
        if (!data.hourly?.time?.length) { errors++; await sleep(FETCH_DELAY_MS); continue; }

        const byDate = dailyMaxByMember(data.hourly);
        const rows: Array<Record<string, unknown>> = [];
        for (const [date, members] of byDate) {
          // Skip past dates and partial first/last days with <10 members
          if (members.length < MIN_MEMBERS_TO_STORE) continue;
          const { mean, std } = sampleStats(members);
          rows.push({
            city_id: city.id,
            valid_date: date,
            model: mdl.model,
            run_label: runLabel,
            members_high_f: members.map((v) => Math.round(v * 10) / 10),
            n_members: members.length,
            mean_f: Math.round(mean * 100) / 100,
            std_f: Math.round(std * 100) / 100,
            fetched_at: new Date().toISOString(),
          });
        }
        if (rows.length > 0) {
          const { error: insErr, count } = await supabase
            .from('ensemble_forecasts')
            .upsert(rows, {
              onConflict: 'city_id,valid_date,model,run_label',
              ignoreDuplicates: true,
              count: 'exact',
            });
          if (insErr) { errors++; console.warn(`[ens-ingest] insert ${city.name}: ${insErr.message}`); }
          else rowsInserted += count ?? rows.length;
        }
      } catch (e) {
        errors++;
        console.warn(`[ens-ingest] ${city.name}/${mdl.model}: ${e instanceof Error ? e.message : e}`);
      }
      await sleep(FETCH_DELAY_MS);
    }
  }

  const durationMs = Date.now() - start;
  log(`Done: fetched=${fetched} skipped=${skippedUpToDate} rows=${rowsInserted} errors=${errors} in ${(durationMs / 1000).toFixed(1)}s`);
  return { fetched, skippedUpToDate, rowsInserted, errors, durationMs };
}

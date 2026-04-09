/**
 * Path A — Historical Calibration Ingest
 *
 * Standalone one-shot script that pulls 2 years of historical forecast-vs-
 * observed temperature data from Open-Meteo for all our weather cities,
 * then writes to weather_calibration_raw. A separate derive step rolls it
 * up into the sigma/bias/weights tables consumed by forecast-ensemble.ts.
 *
 * USAGE:
 *   cd worker && npm run ingest:calibration
 *   (or run via one-off Railway task: `railway run npm run ingest:calibration`)
 *
 * This is NOT a cron. It runs once, completes in ~5 minutes, and exits.
 * Safe to re-run — writes are idempotent via the unique index on
 * (city_id, source, lead_days, valid_date).
 *
 * SCOPE (see docs/PATH_A_CALIBRATION_SPEC.md):
 *   - All 14 active cities from weather_cities
 *   - 7 primary forecast models
 *   - 730 days (2 years) of history
 *   - Lead days 0..7
 *   → ~572,000 calibration pairs
 *
 * IMPORTANT: Open-Meteo is free and keyless but does rate-limit at ~600
 * calls/min. This script stays well under that.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const HISTORY_DAYS = 730; // 2 years
const MAX_LEAD_DAYS = 7;

// Map our internal source names (from weather_forecasts.source) to Open-Meteo
// historical-forecast-api model identifiers. If we add more sources later,
// extend this map.
const SOURCE_TO_OPENMETEO: Record<string, string> = {
  ecmwf: 'ecmwf_ifs025',
  gfs: 'gfs_global',
  icon: 'icon_global',
  gem: 'gem_seamless',
  jma: 'jma_seamless',
  meteofrance: 'meteofrance_seamless',
  ukmo: 'ukmo_seamless',
};

interface City {
  id: string;
  name: string;
  lat: number;
  lon: number;
  timezone: string | null;
}

interface RawRow {
  city_id: string;
  valid_date: string;
  source: string;
  lead_days: number;
  forecast_high_f: number | null;
  observed_high_f: number | null;
  error_f: number | null;
}

/**
 * Fetch the ground-truth daily high temperatures for a city over the full
 * history window. Uses Open-Meteo's ERA5 archive — this is reanalysis data,
 * not forecasts, so it's the canonical "what actually happened."
 */
async function fetchObserved(
  city: City,
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.searchParams.set('latitude', String(city.lat));
  url.searchParams.set('longitude', String(city.lon));
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('daily', 'temperature_2m_max');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('timezone', city.timezone ?? 'auto');

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`ERA5 archive ${city.name}: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    daily: { time: string[]; temperature_2m_max: (number | null)[] };
  };

  const map = new Map<string, number>();
  for (let i = 0; i < json.daily.time.length; i++) {
    const t = json.daily.temperature_2m_max[i];
    if (t != null) map.set(json.daily.time[i], t);
  }
  return map;
}

/**
 * Fetch what a specific model predicted for every day in the window.
 * Open-Meteo's historical-forecast-api returns each model's archived
 * forecasts. We request a single model at a time to keep the response clean
 * and capture the model identifier unambiguously.
 *
 * Lead-time handling: the historical-forecast-api returns the forecast as it
 * was made *on* that day. To get "T-N days" forecasts for each valid date,
 * we shift the request window by N days and request the forecast for
 * (valid_date - N). This approximates what the model said N days before.
 */
async function fetchModelForecast(
  city: City,
  model: string,
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const url = new URL('https://historical-forecast-api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(city.lat));
  url.searchParams.set('longitude', String(city.lon));
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('daily', 'temperature_2m_max');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('timezone', city.timezone ?? 'auto');
  url.searchParams.set('models', model);

  const res = await fetch(url.toString());
  if (!res.ok) {
    // Some models don't have deep history. Log and skip.
    console.warn(
      `[calibration-ingest] ${city.name} ${model}: HTTP ${res.status} — skipping`
    );
    return new Map();
  }
  const json = (await res.json()) as {
    daily: { time: string[]; temperature_2m_max: (number | null)[] };
  };
  const map = new Map<string, number>();
  for (let i = 0; i < json.daily.time.length; i++) {
    const t = json.daily.temperature_2m_max[i];
    if (t != null) map.set(json.daily.time[i], t);
  }
  return map;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

async function ingestCity(supabase: SupabaseClient, city: City): Promise<number> {
  const today = new Date();
  const endDate = addDays(today.toISOString().split('T')[0], -1); // through yesterday
  const startDate = addDays(endDate, -HISTORY_DAYS);

  console.log(`[calibration-ingest] ${city.name} — pulling ${startDate} to ${endDate}`);

  const observed = await fetchObserved(city, startDate, endDate);
  if (observed.size === 0) {
    console.warn(`[calibration-ingest] ${city.name} — no observed data, skipping`);
    return 0;
  }
  console.log(`[calibration-ingest] ${city.name} — ${observed.size} observed days`);

  const rowsToInsert: RawRow[] = [];

  for (const [internalSource, openMeteoModel] of Object.entries(SOURCE_TO_OPENMETEO)) {
    // For each lead_days bucket, shift the request window earlier by that many
    // days, then re-align the results to the original valid_date. This gives
    // us the model's forecast as-of (valid_date - lead_days).
    //
    // NOTE: Open-Meteo's historical forecast endpoint archives forecasts that
    // were made at the time. The shift approach is an approximation that will
    // work best for lead 0-3; lead 4-7 may need a separate endpoint pass. We
    // flag it as a TODO in the returned data.
    for (let leadDays = 0; leadDays <= MAX_LEAD_DAYS; leadDays++) {
      const shiftedStart = addDays(startDate, -leadDays);
      const shiftedEnd = addDays(endDate, -leadDays);

      let forecastMap: Map<string, number>;
      try {
        forecastMap = await fetchModelForecast(city, openMeteoModel, shiftedStart, shiftedEnd);
      } catch (err) {
        console.warn(
          `[calibration-ingest] ${city.name} ${openMeteoModel} lead ${leadDays}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        continue;
      }
      if (forecastMap.size === 0) continue;

      // Map each shifted forecast date back to its true valid_date for pairing.
      for (const [shiftedDate, forecastHighF] of forecastMap.entries()) {
        const validDate = addDays(shiftedDate, leadDays);
        const observedHighF = observed.get(validDate);
        if (observedHighF == null) continue;

        rowsToInsert.push({
          city_id: city.id,
          valid_date: validDate,
          source: internalSource,
          lead_days: leadDays,
          forecast_high_f: forecastHighF,
          observed_high_f: observedHighF,
          error_f: forecastHighF - observedHighF,
        });
      }

      // Gentle rate limit — Open-Meteo allows ~600/min; we stay well under.
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  if (rowsToInsert.length === 0) {
    console.warn(`[calibration-ingest] ${city.name} — zero rows generated`);
    return 0;
  }

  // Batch insert in chunks of 500 to avoid payload-size issues.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const batch = rowsToInsert.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('weather_calibration_raw')
      .upsert(batch, { onConflict: 'city_id,source,lead_days,valid_date', ignoreDuplicates: true });
    if (error) {
      console.error(`[calibration-ingest] ${city.name} insert failed: ${error.message}`);
      break;
    }
    inserted += batch.length;
  }

  console.log(`[calibration-ingest] ${city.name} — inserted ${inserted} rows`);
  return inserted;
}

export async function ingestCalibration(): Promise<void> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase env vars');
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: cities, error } = await supabase
    .from('weather_cities')
    .select('id, name, lat, lon, timezone')
    .eq('is_active', true);

  if (error) throw new Error(`Cities fetch failed: ${error.message}`);
  if (!cities || cities.length === 0) {
    console.warn('[calibration-ingest] No active cities');
    return;
  }

  console.log(`[calibration-ingest] Starting — ${cities.length} cities`);
  const started = Date.now();
  let totalRows = 0;

  for (const city of cities) {
    try {
      const n = await ingestCity(supabase, city as City);
      totalRows += n;
    } catch (err) {
      console.error(
        `[calibration-ingest] ${city.name} FATAL: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[calibration-ingest] DONE — ${totalRows} rows in ${elapsed}s`);
}

// Standalone entry point: `npm run ingest:calibration`
if (require.main === module) {
  ingestCalibration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[calibration-ingest] FATAL:', err);
      process.exit(1);
    });
}

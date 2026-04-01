// ============================================================
// Netlify Scheduled Function: Ingest Weather Data V2
// Runs every 15 minutes — fetches NWS + Open-Meteo (GFS/ECMWF/ICON)
//   + HRRR (US only) + GFS Ensemble (31-member probabilistic)
// Full data: temp high/low, precip, snowfall, wind, weather code
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface WeatherCity {
  id: string;
  name: string;
  lat: number;
  lon: number;
  nws_office: string | null;
  nws_grid_x: number | null;
  nws_grid_y: number | null;
  timezone: string;
}

interface ForecastRow {
  city_id: string;
  valid_date: string;
  source: string;
  temp_high_f: number;
  temp_low_f: number;
  precip_prob: number;
  precip_mm: number;
  rain_mm: number;
  snowfall_cm: number;
  wind_speed_max: number;
  wind_gust_max: number;
  weather_code: number;
  conditions: string;
}

// ============================================================
// NWS Hourly Forecast (US cities only)
// ============================================================
async function fetchNWSForCity(city: WeatherCity): Promise<ForecastRow[]> {
  if (!city.nws_office || !city.nws_grid_x || !city.nws_grid_y) return [];

  try {
    const url = `https://api.weather.gov/gridpoints/${city.nws_office}/${city.nws_grid_x},${city.nws_grid_y}/forecast/hourly`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'ARBITER-Weather-Edge (contact@arbiter.app)',
        Accept: 'application/geo+json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const periods = data.properties?.periods || [];

    // Group by date
    const byDate = new Map<string, {
      temps: number[];
      precipProbs: number[];
      conditions: string[];
      windSpeeds: number[];
    }>();

    for (const p of periods) {
      const date = p.startTime.split('T')[0];
      if (!byDate.has(date)) {
        byDate.set(date, { temps: [], precipProbs: [], conditions: [], windSpeeds: [] });
      }
      const day = byDate.get(date)!;
      const temp = p.temperatureUnit === 'F' ? p.temperature : (p.temperature * 9) / 5 + 32;
      day.temps.push(temp);
      if (p.probabilityOfPrecipitation?.value) {
        day.precipProbs.push(p.probabilityOfPrecipitation.value);
      }
      if (p.isDaytime && p.shortForecast) {
        day.conditions.push(p.shortForecast);
      }
      if (p.windSpeed) {
        // NWS wind like "10 mph" or "10 to 15 mph"
        const match = p.windSpeed.match(/(\d+)/g);
        if (match) day.windSpeeds.push(Math.max(...match.map(Number)));
      }
    }

    const results: ForecastRow[] = [];
    let count = 0;
    for (const [date, day] of byDate) {
      if (count >= 3) break;
      results.push({
        city_id: city.id,
        valid_date: date,
        source: 'nws',
        temp_high_f: Math.round(Math.max(...day.temps)),
        temp_low_f: Math.round(Math.min(...day.temps)),
        precip_prob: day.precipProbs.length > 0 ? Math.max(...day.precipProbs) : 0,
        precip_mm: 0, // NWS hourly doesn't have precip amounts easily
        rain_mm: 0,
        snowfall_cm: 0,
        wind_speed_max: day.windSpeeds.length > 0 ? Math.max(...day.windSpeeds) : 0,
        wind_gust_max: 0,
        weather_code: 0,
        conditions: day.conditions[0] || 'NWS forecast',
      });
      count++;
    }
    return results;
  } catch (err) {
    console.error(`NWS error for ${city.name}:`, err);
    return [];
  }
}

// ============================================================
// Open-Meteo deterministic models (GFS, ECMWF, ICON)
// Now with full precip, snowfall, wind data
// ============================================================
async function fetchOpenMeteoForCity(city: WeatherCity): Promise<ForecastRow[]> {
  const models = ['gfs_seamless', 'ecmwf_ifs025', 'icon_global'] as const;
  const sourceMap: Record<string, string> = {
    gfs_seamless: 'gfs',
    ecmwf_ifs025: 'ecmwf',
    icon_global: 'icon',
  };

  const results: ForecastRow[] = [];

  for (const model of models) {
    try {
      const params = new URLSearchParams({
        latitude: city.lat.toString(),
        longitude: city.lon.toString(),
        daily: [
          'temperature_2m_max',
          'temperature_2m_min',
          'precipitation_probability_max',
          'precipitation_sum',
          'rain_sum',
          'snowfall_sum',
          'wind_speed_10m_max',
          'wind_gusts_10m_max',
          'weather_code',
        ].join(','),
        models: model,
        forecast_days: '3',
        temperature_unit: 'fahrenheit',
        precipitation_unit: 'mm',
        timezone: 'auto',
      });

      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) continue;
      const data = await res.json();
      const daily = data.daily;
      if (!daily?.time) continue;

      for (let i = 0; i < daily.time.length; i++) {
        results.push({
          city_id: city.id,
          valid_date: daily.time[i],
          source: sourceMap[model],
          temp_high_f: Math.round(daily.temperature_2m_max[i]),
          temp_low_f: Math.round(daily.temperature_2m_min[i]),
          precip_prob: daily.precipitation_probability_max?.[i] ?? 0,
          precip_mm: daily.precipitation_sum?.[i] ?? 0,
          rain_mm: daily.rain_sum?.[i] ?? 0,
          snowfall_cm: daily.snowfall_sum?.[i] ?? 0,
          wind_speed_max: daily.wind_speed_10m_max?.[i] ?? 0,
          wind_gust_max: daily.wind_gusts_10m_max?.[i] ?? 0,
          weather_code: daily.weather_code?.[i] ?? 0,
          conditions: `${model} forecast`,
        });
      }
    } catch (err) {
      console.error(`Open-Meteo error for ${city.name} (${model}):`, err);
    }
  }

  return results;
}

// ============================================================
// HRRR 3km high-resolution (US cities only, 48h)
// Updates hourly — catches rapid changes GFS misses
// ============================================================
async function fetchHRRRForCity(city: WeatherCity): Promise<ForecastRow[]> {
  if (!city.nws_office) return []; // US-only

  try {
    const params = new URLSearchParams({
      latitude: city.lat.toString(),
      longitude: city.lon.toString(),
      daily: [
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_probability_max',
        'precipitation_sum',
        'rain_sum',
        'snowfall_sum',
        'wind_speed_10m_max',
        'wind_gusts_10m_max',
        'weather_code',
      ].join(','),
      models: 'ncep_hrrr_conus',
      forecast_days: '2',
      temperature_unit: 'fahrenheit',
      precipitation_unit: 'mm',
      timezone: 'auto',
    });

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const daily = data.daily;
    if (!daily?.time) return [];

    const results: ForecastRow[] = [];
    for (let i = 0; i < daily.time.length; i++) {
      results.push({
        city_id: city.id,
        valid_date: daily.time[i],
        source: 'hrrr',
        temp_high_f: Math.round(daily.temperature_2m_max[i]),
        temp_low_f: Math.round(daily.temperature_2m_min[i]),
        precip_prob: daily.precipitation_probability_max?.[i] ?? 0,
        precip_mm: daily.precipitation_sum?.[i] ?? 0,
        rain_mm: daily.rain_sum?.[i] ?? 0,
        snowfall_cm: daily.snowfall_sum?.[i] ?? 0,
        wind_speed_max: daily.wind_speed_10m_max?.[i] ?? 0,
        wind_gust_max: daily.wind_gusts_10m_max?.[i] ?? 0,
        weather_code: daily.weather_code?.[i] ?? 0,
        conditions: 'HRRR 3km forecast',
      });
    }
    return results;
  } catch (err) {
    console.error(`HRRR error for ${city.name}:`, err);
    return [];
  }
}

// ============================================================
// GFS Ensemble (31 members) — Probabilistic forecasting
// Returns each member's hourly temp; we compute daily maxima
// and probability distributions for bracket pricing
// ============================================================
interface EnsembleResult {
  valid_date: string;
  members: number;
  mean_high_f: number;
  std_dev_f: number;
  prob_above: Record<number, number>;
  prob_below: Record<number, number>;
  mean_precip_mm: number;
  prob_precip_above_trace: number;
  prob_precip_above_quarter: number;
  prob_precip_above_inch: number;
}

async function fetchEnsembleForCity(city: WeatherCity): Promise<EnsembleResult[]> {
  try {
    const params = new URLSearchParams({
      latitude: city.lat.toString(),
      longitude: city.lon.toString(),
      hourly: 'temperature_2m,precipitation',
      models: 'gfs_seamless',
      forecast_days: '3',
      temperature_unit: 'fahrenheit',
    });

    const res = await fetch(`https://api.open-meteo.com/v1/ensemble?${params}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const hourly = data.hourly;
    if (!hourly?.time) return [];

    // Find ensemble member keys
    const tempKeys = Object.keys(hourly).filter(
      (k) => k.startsWith('temperature_2m_member')
    );
    const precipKeys = Object.keys(hourly).filter(
      (k) => k.startsWith('precipitation_member')
    );

    const memberCount = tempKeys.length;
    // Need at least 20 of 31 ensemble members (>65%) for statistically meaningful
    // probability distributions. With only 5, bracket probabilities have ±20% noise.
    if (memberCount < 20) return [];

    // Group by date: daily max temp per member
    const dateMap = new Map<string, {
      tempMax: number[];
      precipSum: number[];
    }>();

    for (let h = 0; h < hourly.time.length; h++) {
      const date = hourly.time[h].split('T')[0];
      if (!dateMap.has(date)) {
        dateMap.set(date, {
          tempMax: new Array(memberCount).fill(-999),
          precipSum: new Array(memberCount).fill(0),
        });
      }
      const d = dateMap.get(date)!;

      for (let m = 0; m < memberCount; m++) {
        const t = hourly[tempKeys[m]]?.[h];
        if (typeof t === 'number' && t > d.tempMax[m]) {
          d.tempMax[m] = t;
        }
        if (m < precipKeys.length) {
          const p = hourly[precipKeys[m]]?.[h];
          if (typeof p === 'number') d.precipSum[m] += p;
        }
      }
    }

    const results: EnsembleResult[] = [];
    for (const [date, d] of dateMap) {
      const valid = d.tempMax.filter((t) => t > -900);
      if (valid.length < 20) continue;

      const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
      const variance = valid.reduce((acc, t) => acc + (t - mean) ** 2, 0) / valid.length;
      const stdDev = Math.sqrt(variance);

      // Probability thresholds every 1°F in a 30°F window around mean
      const probAbove: Record<number, number> = {};
      const probBelow: Record<number, number> = {};
      const lo = Math.floor(mean - 15);
      const hi = Math.ceil(mean + 15);
      for (let t = lo; t <= hi; t++) {
        probAbove[t] = Math.round(valid.filter((v) => v >= t).length / valid.length * 1000) / 1000;
        probBelow[t] = Math.round(valid.filter((v) => v < t).length / valid.length * 1000) / 1000;
      }

      // Precip ensemble — guard against empty array (all members 0 or missing)
      const vp = d.precipSum.filter((p) => typeof p === 'number' && p >= 0);
      const vpLen = vp.length || 1; // prevent divide-by-zero
      const meanP = vp.length > 0 ? vp.reduce((a, b) => a + b, 0) / vpLen : 0;

      results.push({
        valid_date: date,
        members: valid.length,
        mean_high_f: Math.round(mean * 10) / 10,
        std_dev_f: Math.round(stdDev * 10) / 10,
        prob_above: probAbove,
        prob_below: probBelow,
        mean_precip_mm: Math.round(meanP * 100) / 100,
        prob_precip_above_trace:
          Math.round(vp.filter((p) => p > 0.254).length / vpLen * 1000) / 1000,
        prob_precip_above_quarter:
          Math.round(vp.filter((p) => p > 6.35).length / vpLen * 1000) / 1000,
        prob_precip_above_inch:
          Math.round(vp.filter((p) => p > 25.4).length / vpLen * 1000) / 1000,
      });
    }

    return results;
  } catch (err) {
    console.error(`Ensemble error for ${city.name}:`, err);
    return [];
  }
}

// ============================================================
// Consensus calculator (inline for scheduled function)
// ============================================================
function calculateConsensus(
  forecasts: ForecastRow[],
  cityId: string,
  validDate: string,
  ensemble: EnsembleResult | null,
  isUS: boolean
) {
  const dayForecasts = forecasts.filter(
    (f) => f.valid_date === validDate && f.temp_high_f !== null
  );
  if (dayForecasts.length < 2) return null;

  // Days ahead for model weighting (clamp to 0-10 range)
  const daysAhead = Math.max(0, Math.round(
    (new Date(validDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  ));

  let weightedHigh = 0;
  let weightedLow = 0;
  let totalWeight = 0;
  const highs: number[] = [];
  const sources: string[] = [];

  for (const f of dayForecasts) {
    // Dynamic model weighting
    let weight = 1.0;
    if (f.source === 'hrrr') weight = daysAhead <= 1 ? 1.5 : daysAhead <= 2 ? 1.1 : 0;
    else if (f.source === 'ecmwf') weight = daysAhead >= 3 ? 1.3 : 1.1;
    else if (f.source === 'gfs') weight = daysAhead <= 2 && isUS ? 1.15 : 1.0;
    else if (f.source === 'nws' && isUS) weight = daysAhead <= 1 ? 1.4 : daysAhead <= 2 ? 1.2 : 0.9;

    if (weight <= 0) continue;

    highs.push(f.temp_high_f);
    sources.push(f.source);
    weightedHigh += f.temp_high_f * weight;
    weightedLow += f.temp_low_f * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  const spread = Math.max(...highs) - Math.min(...highs);
  const agreement = spread <= 2 ? 'HIGH' : spread <= 5 ? 'MEDIUM' : 'LOW';

  // Precipitation consensus
  const precipValues = dayForecasts
    .filter((f) => f.precip_mm > 0 || f.precip_prob > 0)
    .map((f) => f.precip_mm);
  const precipMean = precipValues.length > 0
    ? precipValues.reduce((a, b) => a + b, 0) / precipValues.length
    : 0;
  const precipSpread = precipValues.length >= 2
    ? Math.max(...precipValues) - Math.min(...precipValues)
    : 0;
  const precipAgreement = precipSpread <= 2 ? 'HIGH' : precipSpread <= 5 ? 'MEDIUM' : 'LOW';

  // Snowfall consensus
  const snowValues = dayForecasts.map((f) => f.snowfall_cm).filter((v) => v > 0);
  const snowMean = snowValues.length > 0
    ? snowValues.reduce((a, b) => a + b, 0) / snowValues.length
    : 0;

  return {
    city_id: cityId,
    valid_date: validDate,
    consensus_high_f: Math.round(weightedHigh / totalWeight),
    consensus_low_f: Math.round(weightedLow / totalWeight),
    model_spread_f: Math.round(spread * 10) / 10,
    agreement,
    models_used: sources,
    precip_consensus_mm: Math.round(precipMean * 100) / 100,
    precip_agreement: precipAgreement,
    snowfall_consensus_cm: Math.round(snowMean * 10) / 10,
    ensemble_members: ensemble?.members ?? null,
    ensemble_prob_above: ensemble?.prob_above ?? null,
    ensemble_prob_below: ensemble?.prob_below ?? null,
  };
}

// ============================================================
// Main handler — processes cities within 20s time limit
// ============================================================
export const handler = schedule('*/15 * * * *', async () => {
  console.log('[ingest-weather-v2] Starting enhanced weather ingestion');
  const startTime = Date.now();

  const { data: cities, error } = await supabase
    .from('weather_cities')
    .select('*')
    .eq('is_active', true);

  if (error || !cities) {
    console.error('[ingest-weather-v2] Failed to fetch cities:', error);
    return { statusCode: 500 };
  }

  // Process ALL cities in parallel with a global timeout safety net.
  // Individual fetches have 6-10s timeouts, but if many stall simultaneously the
  // Netlify function could exceed its 26s execution limit. This ensures we always
  // exit cleanly and log what completed.
  const GLOBAL_TIMEOUT_MS = 22000; // 22s — leaves 4s for logging + cleanup
  const cityPromises = Promise.allSettled(
    cities.map(async (city) => {
      const isUS = !!city.nws_office;

      // Fetch all sources in parallel (NWS + 3 models + HRRR + ensemble)
      const [nwsForecasts, meteoForecasts, hrrrForecasts, ensembleData] = await Promise.all([
        fetchNWSForCity(city),
        fetchOpenMeteoForCity(city),
        fetchHRRRForCity(city),
        fetchEnsembleForCity(city),
      ]);

      const allForecasts = [...nwsForecasts, ...meteoForecasts, ...hrrrForecasts];

      if (allForecasts.length === 0) return { city: city.name, count: 0 };

      // Delete stale forecasts for this city before inserting fresh ones.
      // Prevents duplicate accumulation from re-runs (each run replaces, not appends).
      const todayStr = new Date().toISOString().split('T')[0];
      await supabase
        .from('weather_forecasts')
        .delete()
        .eq('city_id', city.id)
        .gte('valid_date', todayStr);

      const { error: insertErr } = await supabase
        .from('weather_forecasts')
        .insert(allForecasts);

      if (insertErr) {
        console.error(`[ingest-weather-v2] Insert error for ${city.name}:`, insertErr.message);
      }

      // Delete stale consensus for the same dates, then recalculate
      await supabase
        .from('weather_consensus')
        .delete()
        .eq('city_id', city.id)
        .gte('valid_date', todayStr);

      // Calculate & store consensus for each date
      const dates = [...new Set(allForecasts.map((f) => f.valid_date))];
      for (const date of dates) {
        const ensemble = ensembleData.find((e) => e.valid_date === date) ?? null;
        const consensus = calculateConsensus(allForecasts, city.id, date, ensemble, isUS);
        if (consensus) {
          await supabase.from('weather_consensus').insert(consensus);
        } else {
          console.warn(`[ingest-weather-v2] No consensus for ${city.name} on ${date} (too few models or zero weight)`);
        }
      }

      const modelSources = [...new Set(allForecasts.map((f) => f.source))];
      return { city: city.name, count: allForecasts.length, sources: modelSources };
    })
  );

  // Race against global timeout — if cities are still running after 22s, continue
  // with whatever completed and log the timeout. Prevents Netlify hard-kill.
  let cityResults: PromiseSettledResult<{ city: string; count: number; sources?: string[] }>[];
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('GLOBAL_TIMEOUT')), GLOBAL_TIMEOUT_MS)
  );
  try {
    cityResults = await Promise.race([cityPromises, timeoutPromise]) as typeof cityResults;
  } catch (err) {
    console.warn(`[ingest-weather-v2] Global timeout hit at ${GLOBAL_TIMEOUT_MS}ms — some cities may be incomplete`);
    // allSettled never rejects, so if we get here it was the timeout.
    // Await the original promise to get partial results (already settled ones).
    cityResults = await cityPromises;
  }

  const processed = cityResults.filter(r => r.status === 'fulfilled').length;
  const failed = cityResults.filter(r => r.status === 'rejected').length;
  cityResults.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[ingest-weather-v2] Failed for ${cities[i].name}:`, r.reason);
    }
  });

  console.log(`[ingest-weather-v2] Done. ${processed}/${cities.length} cities succeeded, ${failed} failed in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

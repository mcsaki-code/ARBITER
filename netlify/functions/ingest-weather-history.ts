// ============================================================
// Netlify Scheduled Function: Ingest Historical Weather Actuals
// Runs daily at 08:00 UTC — fetches observed weather data from
// Open-Meteo Historical API for all weather cities.
//
// Purpose:
// 1. Calibration — compare our forecast predictions to actual outcomes
// 2. Seasonal baselines — understand typical temperature ranges per city
// 3. Edge validation — backtest if our "edge" calls were actually correct
// 4. Resolution verification — cross-check Polymarket outcomes vs actual data
//
// Data source: Open-Meteo Archive API (free, no API key needed)
// Coverage: 1940-present, global, ~0.25° grid resolution
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
  timezone: string;
}

interface DailyData {
  time: string[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  precipitation_sum: (number | null)[];
  rain_sum: (number | null)[];
  snowfall_sum: (number | null)[];
  wind_speed_10m_max: (number | null)[];
  wind_gusts_10m_max: (number | null)[];
  weather_code: (number | null)[];
}

// Fahrenheit to Celsius
function fToC(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 10) / 10;
}

// Weather code to human-readable conditions
function weatherCodeToCondition(code: number | null): string {
  if (code === null) return 'Unknown';
  const map: Record<number, string> = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Heavy freezing rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
  };
  return map[code] || `Code ${code}`;
}

async function fetchHistoricalForCity(
  city: WeatherCity,
  startDate: string,
  endDate: string
): Promise<number> {
  const params = new URLSearchParams({
    latitude: city.lat.toString(),
    longitude: city.lon.toString(),
    daily: [
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'rain_sum',
      'snowfall_sum',
      'wind_speed_10m_max',
      'wind_gusts_10m_max',
      'weather_code',
    ].join(','),
    start_date: startDate,
    end_date: endDate,
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'mm',
    timezone: 'auto',
  });

  const res = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params}`, {
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    console.error(`[weather-history] Open-Meteo error for ${city.name}: ${res.status}`);
    return 0;
  }

  const data = await res.json();
  const daily = data.daily as DailyData;
  if (!daily?.time?.length) return 0;

  const rows = [];
  for (let i = 0; i < daily.time.length; i++) {
    const highF = daily.temperature_2m_max[i];
    const lowF = daily.temperature_2m_min[i];
    if (highF === null && lowF === null) continue; // Skip days with no data

    rows.push({
      city_id: city.id,
      date: daily.time[i],
      temp_high_f: highF,
      temp_low_f: lowF,
      temp_high_c: highF !== null ? fToC(highF) : null,
      temp_low_c: lowF !== null ? fToC(lowF) : null,
      precip_mm: daily.precipitation_sum[i] ?? 0,
      rain_mm: daily.rain_sum[i] ?? 0,
      snowfall_cm: daily.snowfall_sum[i] ?? 0,
      wind_speed_max: daily.wind_speed_10m_max[i] ?? null,
      wind_gust_max: daily.wind_gusts_10m_max[i] ?? null,
      weather_code: daily.weather_code[i] ?? null,
      conditions: weatherCodeToCondition(daily.weather_code[i]),
      source: 'open-meteo-historical',
    });
  }

  if (rows.length === 0) return 0;

  // Upsert — on conflict (city_id, date) update with fresh data
  const { error } = await supabase
    .from('weather_actuals')
    .upsert(rows, { onConflict: 'city_id,date' });

  if (error) {
    console.error(`[weather-history] DB error for ${city.name}: ${error.message}`);
    return 0;
  }

  return rows.length;
}

export const handler = schedule('0 8 * * *', async () => {
  const startTime = Date.now();
  console.log('[weather-history] Starting historical weather ingestion');

  // Get all weather cities
  const { data: cities, error } = await supabase
    .from('weather_cities')
    .select('id, name, lat, lon, timezone');

  if (error || !cities?.length) {
    console.error('[weather-history] Failed to fetch cities:', error?.message);
    return { statusCode: 500, body: 'Failed to fetch cities' };
  }

  // Determine date range:
  // - Check what's already in the DB to avoid re-fetching
  // - Default: last 90 days for initial backfill
  // - After initial: just last 3 days (yesterday + buffer for timezone lag)
  const { data: latestRow } = await supabase
    .from('weather_actuals')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);

  const now = new Date();
  let startDate: string;
  const endDate = new Date(now.getTime() - 24 * 60 * 60 * 1000) // Yesterday
    .toISOString().split('T')[0];

  if (latestRow?.length && latestRow[0].date) {
    // Incremental: fetch from 3 days before latest to catch any gaps
    const latest = new Date(latestRow[0].date);
    latest.setDate(latest.getDate() - 3);
    startDate = latest.toISOString().split('T')[0];
    console.log(`[weather-history] Incremental mode: ${startDate} → ${endDate}`);
  } else {
    // Initial backfill: 90 days
    const start = new Date(now);
    start.setDate(start.getDate() - 90);
    startDate = start.toISOString().split('T')[0];
    console.log(`[weather-history] Initial backfill: ${startDate} → ${endDate}`);
  }

  let totalRows = 0;
  let citiesProcessed = 0;

  // Process cities in batches of 5 to respect rate limits
  for (let i = 0; i < cities.length; i += 5) {
    if (Date.now() - startTime > 120000) {
      console.log(`[weather-history] Time guard at ${citiesProcessed}/${cities.length} cities`);
      break;
    }

    const batch = cities.slice(i, i + 5) as WeatherCity[];
    const results = await Promise.all(
      batch.map(city => fetchHistoricalForCity(city, startDate, endDate).catch(err => {
        console.error(`[weather-history] Error for ${city.name}:`, err);
        return 0;
      }))
    );

    for (let j = 0; j < batch.length; j++) {
      if (results[j] > 0) {
        console.log(`[weather-history] ${batch[j].name}: ${results[j]} days ingested`);
      }
      totalRows += results[j];
      citiesProcessed++;
    }

    // Brief pause between batches to be polite to Open-Meteo
    if (i + 5 < cities.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[weather-history] Done: ${totalRows} rows across ${citiesProcessed} cities in ${elapsed}s`);

  return {
    statusCode: 200,
    body: JSON.stringify({ totalRows, citiesProcessed, elapsed }),
  };
});

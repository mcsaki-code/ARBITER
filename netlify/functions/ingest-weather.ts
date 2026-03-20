// ============================================================
// Netlify Scheduled Function: Ingest Weather Data
// Runs every 15 minutes — fetches NWS + Open-Meteo for all cities
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

async function fetchNWSForCity(city: WeatherCity) {
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
    const byDate = new Map<string, number[]>();
    for (const p of periods) {
      const date = p.startTime.split('T')[0];
      if (!byDate.has(date)) byDate.set(date, []);
      const temp = p.temperatureUnit === 'F' ? p.temperature : (p.temperature * 9) / 5 + 32;
      byDate.get(date)!.push(temp);
    }

    const results = [];
    let count = 0;
    for (const [date, temps] of byDate) {
      if (count >= 3) break;
      results.push({
        city_id: city.id,
        valid_date: date,
        source: 'nws',
        temp_high_f: Math.round(Math.max(...temps)),
        temp_low_f: Math.round(Math.min(...temps)),
        precip_prob: 0,
        conditions: 'NWS forecast',
      });
      count++;
    }
    return results;
  } catch (err) {
    console.error(`NWS error for ${city.name}:`, err);
    return [];
  }
}

async function fetchOpenMeteoForCity(city: WeatherCity) {
  const models = ['gfs_seamless', 'ecmwf_ifs025', 'icon_global'] as const;
  const sourceMap: Record<string, string> = {
    gfs_seamless: 'gfs',
    ecmwf_ifs025: 'ecmwf',
    icon_global: 'icon',
  };

  const results = [];

  for (const model of models) {
    try {
      const params = new URLSearchParams({
        latitude: city.lat.toString(),
        longitude: city.lon.toString(),
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        models: model,
        forecast_days: '3',
        temperature_unit: 'fahrenheit',
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
          conditions: `${model} forecast`,
        });
      }
    } catch (err) {
      console.error(`Open-Meteo error for ${city.name} (${model}):`, err);
    }
  }

  return results;
}

function calculateConsensus(
  forecasts: { source: string; temp_high_f: number; valid_date: string }[],
  cityId: string,
  validDate: string
) {
  const dayForecasts = forecasts.filter(
    (f) => f.valid_date === validDate && f.temp_high_f !== null
  );
  if (dayForecasts.length < 2) return null;

  const highs = dayForecasts.map((f) => f.temp_high_f);
  const sources = dayForecasts.map((f) => f.source);
  const spread = Math.max(...highs) - Math.min(...highs);
  const avg = highs.reduce((a, b) => a + b, 0) / highs.length;
  const agreement = spread <= 2 ? 'HIGH' : spread <= 5 ? 'MEDIUM' : 'LOW';

  return {
    city_id: cityId,
    valid_date: validDate,
    consensus_high_f: Math.round(avg),
    model_spread_f: Math.round(spread * 10) / 10,
    agreement,
    models_used: sources,
  };
}

export const handler = schedule('*/15 * * * *', async () => {
  console.log('[ingest-weather] Starting weather data ingestion');
  const startTime = Date.now();

  // Get active cities
  const { data: cities, error } = await supabase
    .from('weather_cities')
    .select('*')
    .eq('is_active', true);

  if (error || !cities) {
    console.error('[ingest-weather] Failed to fetch cities:', error);
    return { statusCode: 500 };
  }

  // Process cities one at a time to stay under 25s
  for (const city of cities) {
    if (Date.now() - startTime > 22000) {
      console.warn('[ingest-weather] Approaching time limit, stopping');
      break;
    }

    console.log(`[ingest-weather] Processing ${city.name}`);

    // Fetch forecasts
    const [nwsForecasts, meteoForecasts] = await Promise.all([
      fetchNWSForCity(city),
      fetchOpenMeteoForCity(city),
    ]);

    const allForecasts = [...nwsForecasts, ...meteoForecasts];

    if (allForecasts.length > 0) {
      // Insert forecasts
      const { error: insertErr } = await supabase
        .from('weather_forecasts')
        .insert(allForecasts);

      if (insertErr) {
        console.error(`[ingest-weather] Insert error for ${city.name}:`, insertErr);
      }

      // Calculate & store consensus for each date
      const dates = [...new Set(allForecasts.map((f) => f.valid_date))];
      for (const date of dates) {
        const consensus = calculateConsensus(
          allForecasts as { source: string; temp_high_f: number; valid_date: string }[],
          city.id,
          date
        );
        if (consensus) {
          await supabase.from('weather_consensus').insert(consensus);
        }
      }
    }
  }

  console.log(`[ingest-weather] Done in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

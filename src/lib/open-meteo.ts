// ============================================================
// Open-Meteo API Integration — Global, 3 Models
// ============================================================
// api.open-meteo.com — No key, no signup
// Returns GFS, ECMWF, ICON models in one call

import { WeatherCity } from './types';

interface OpenMeteoModelDaily {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_probability_max: number[];
}

interface OpenMeteoResponse {
  daily: OpenMeteoModelDaily;
  // When multiple models requested, each gets its own key
  [key: string]: unknown;
}

export interface OpenMeteoForecastResult {
  valid_date: string;
  source: 'gfs' | 'ecmwf' | 'icon';
  temp_high_f: number;
  temp_low_f: number;
  precip_prob: number;
}

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

export async function fetchOpenMeteoForecast(
  city: WeatherCity
): Promise<OpenMeteoForecastResult[]> {
  // Fetch each model separately for cleaner parsing
  const models = ['gfs_seamless', 'ecmwf_ifs025', 'icon_global'] as const;
  const sourceMap: Record<string, 'gfs' | 'ecmwf' | 'icon'> = {
    gfs_seamless: 'gfs',
    ecmwf_ifs025: 'ecmwf',
    icon_global: 'icon',
  };

  const results: OpenMeteoForecastResult[] = [];

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

      const res = await fetch(`${OPEN_METEO_BASE}?${params}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        console.error(`Open-Meteo error for ${city.name} (${model}): ${res.status}`);
        continue;
      }

      const data: OpenMeteoResponse = await res.json();
      const daily = data.daily;

      if (!daily?.time) continue;

      for (let i = 0; i < daily.time.length; i++) {
        results.push({
          valid_date: daily.time[i],
          source: sourceMap[model],
          temp_high_f: Math.round(daily.temperature_2m_max[i]),
          temp_low_f: Math.round(daily.temperature_2m_min[i]),
          precip_prob: daily.precipitation_probability_max?.[i] ?? 0,
        });
      }
    } catch (err) {
      console.error(`Open-Meteo fetch failed for ${city.name} (${model}):`, err);
    }
  }

  return results;
}

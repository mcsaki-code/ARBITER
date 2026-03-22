// ============================================================
// Open-Meteo API Integration — V2: Multi-Model + Ensemble
// ============================================================
// api.open-meteo.com — No key, no signup
// Models: GFS, ECMWF, ICON (deterministic) + GFS Ensemble (31-member)
// HRRR: 3km resolution for US cities (first 48h)
// Ensemble: Probabilistic temperature distribution for bracket pricing

import { WeatherCity } from './types';

interface OpenMeteoDaily {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_probability_max?: number[];
  precipitation_sum?: number[];
  rain_sum?: number[];
  snowfall_sum?: number[];
  wind_speed_10m_max?: number[];
  wind_gusts_10m_max?: number[];
  weather_code?: number[];
}

interface OpenMeteoResponse {
  daily: OpenMeteoDaily;
}

export interface OpenMeteoForecastResult {
  valid_date: string;
  source: 'gfs' | 'ecmwf' | 'icon' | 'hrrr';
  temp_high_f: number;
  temp_low_f: number;
  precip_prob: number;
  precip_mm: number;
  rain_mm: number;
  snowfall_cm: number;
  wind_speed_max: number;
  wind_gust_max: number;
  weather_code: number;
}

// ============================================================
// Ensemble forecast result — probabilistic bracket pricing
// ============================================================
export interface EnsembleForecastResult {
  valid_date: string;
  members: number;           // e.g. 31 for GFS ensemble
  temp_highs_f: number[];    // each member's max temp
  mean_high_f: number;
  median_high_f: number;
  std_dev_f: number;
  // Probability of exceeding temperature thresholds
  prob_above: Record<number, number>; // e.g. { 70: 0.87, 75: 0.42, 80: 0.06 }
  prob_below: Record<number, number>; // e.g. { 60: 0.13, 65: 0.35 }
  // Precipitation ensemble
  precip_totals_mm: number[];
  mean_precip_mm: number;
  prob_precip_above_trace: number; // probability of > 0.01"
  prob_precip_above_quarter: number; // probability of > 0.25"
  prob_precip_above_half: number; // probability of > 0.5"
  prob_precip_above_inch: number; // probability of > 1.0"
}

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE_BASE = 'https://api.open-meteo.com/v1/ensemble';

// ============================================================
// Deterministic model forecasts (GFS, ECMWF, ICON)
// Now with full precipitation, snowfall, wind data
// ============================================================
export async function fetchOpenMeteoForecast(
  city: WeatherCity
): Promise<OpenMeteoForecastResult[]> {
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

      const res = await fetch(`${FORECAST_BASE}?${params}`, {
        signal: AbortSignal.timeout(8000),
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
          precip_mm: daily.precipitation_sum?.[i] ?? 0,
          rain_mm: daily.rain_sum?.[i] ?? 0,
          snowfall_cm: daily.snowfall_sum?.[i] ?? 0,
          wind_speed_max: daily.wind_speed_10m_max?.[i] ?? 0,
          wind_gust_max: daily.wind_gusts_10m_max?.[i] ?? 0,
          weather_code: daily.weather_code?.[i] ?? 0,
        });
      }
    } catch (err) {
      console.error(`Open-Meteo fetch failed for ${city.name} (${model}):`, err);
    }
  }

  return results;
}

// ============================================================
// HRRR high-resolution forecasts (US cities only, 3km, 48h)
// ============================================================
export async function fetchHRRRForecast(
  city: WeatherCity
): Promise<OpenMeteoForecastResult[]> {
  // HRRR only covers continental US
  if (!city.nws_office) return [];

  try {
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
      models: 'ncep_hrrr_conus',
      forecast_days: '2',
      temperature_unit: 'fahrenheit',
      precipitation_unit: 'mm',
      timezone: 'auto',
    });

    const res = await fetch(`${FORECAST_BASE}?${params}`, {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];

    const data: OpenMeteoResponse = await res.json();
    const daily = data.daily;
    if (!daily?.time) return [];

    const results: OpenMeteoForecastResult[] = [];
    for (let i = 0; i < daily.time.length; i++) {
      results.push({
        valid_date: daily.time[i],
        source: 'hrrr',
        temp_high_f: Math.round(daily.temperature_2m_max[i]),
        temp_low_f: Math.round(daily.temperature_2m_min[i]),
        precip_prob: 0, // HRRR doesn't have probability, uses raw amounts
        precip_mm: daily.precipitation_sum?.[i] ?? 0,
        rain_mm: daily.rain_sum?.[i] ?? 0,
        snowfall_cm: daily.snowfall_sum?.[i] ?? 0,
        wind_speed_max: daily.wind_speed_10m_max?.[i] ?? 0,
        wind_gust_max: daily.wind_gusts_10m_max?.[i] ?? 0,
        weather_code: daily.weather_code?.[i] ?? 0,
      });
    }

    return results;
  } catch (err) {
    console.error(`HRRR fetch failed for ${city.name}:`, err);
    return [];
  }
}

// ============================================================
// GFS Ensemble (31 members) — THE KEY EDGE
// Returns probability distributions, not point forecasts
// This is what the $24K weather bots use
// ============================================================
export async function fetchEnsembleForecast(
  city: WeatherCity
): Promise<EnsembleForecastResult[]> {
  try {
    const params = new URLSearchParams({
      latitude: city.lat.toString(),
      longitude: city.lon.toString(),
      hourly: 'temperature_2m,precipitation',
      models: 'gfs_seamless',
      forecast_days: '3',
      temperature_unit: 'fahrenheit',
    });

    const res = await fetch(`${ENSEMBLE_BASE}?${params}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`Ensemble API error for ${city.name}: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const hourly = data.hourly;
    if (!hourly?.time) return [];

    // Detect ensemble members: keys like temperature_2m_member00, temperature_2m_member01, etc.
    const tempMemberKeys = Object.keys(hourly).filter(
      (k) => k.startsWith('temperature_2m_member')
    );
    const precipMemberKeys = Object.keys(hourly).filter(
      (k) => k.startsWith('precipitation_member')
    );

    const memberCount = tempMemberKeys.length;
    if (memberCount < 5) {
      console.warn(`[ensemble] Only ${memberCount} members found for ${city.name}`);
      return [];
    }

    // Group hourly data by date, find daily max per member
    const dateMap = new Map<string, { tempMaxPerMember: number[]; precipSumPerMember: number[] }>();

    for (let h = 0; h < hourly.time.length; h++) {
      const date = hourly.time[h].split('T')[0];
      if (!dateMap.has(date)) {
        dateMap.set(date, {
          tempMaxPerMember: new Array(memberCount).fill(-999),
          precipSumPerMember: new Array(memberCount).fill(0),
        });
      }
      const dayData = dateMap.get(date)!;

      for (let m = 0; m < memberCount; m++) {
        const tempKey = tempMemberKeys[m];
        const temp = hourly[tempKey]?.[h];
        if (typeof temp === 'number' && temp > dayData.tempMaxPerMember[m]) {
          dayData.tempMaxPerMember[m] = temp;
        }

        if (m < precipMemberKeys.length) {
          const precipKey = precipMemberKeys[m];
          const precip = hourly[precipKey]?.[h];
          if (typeof precip === 'number') {
            dayData.precipSumPerMember[m] += precip;
          }
        }
      }
    }

    // Convert to results with probability distributions
    const results: EnsembleForecastResult[] = [];

    for (const [date, dayData] of dateMap) {
      const validTemps = dayData.tempMaxPerMember.filter((t) => t > -900);
      if (validTemps.length < 5) continue;

      const sorted = [...validTemps].sort((a, b) => a - b);
      const mean = validTemps.reduce((a, b) => a + b, 0) / validTemps.length;
      const median = sorted[Math.floor(sorted.length / 2)];
      const variance = validTemps.reduce((acc, t) => acc + (t - mean) ** 2, 0) / validTemps.length;
      const stdDev = Math.sqrt(variance);

      // Calculate probability of exceeding various temperature thresholds
      // These thresholds will be matched to Polymarket bracket boundaries
      const probAbove: Record<number, number> = {};
      const probBelow: Record<number, number> = {};

      // Generate thresholds every 2°F around the mean (covers typical bracket width)
      const minThresh = Math.floor(mean - 15);
      const maxThresh = Math.ceil(mean + 15);
      for (let t = minThresh; t <= maxThresh; t += 1) {
        const above = validTemps.filter((v) => v >= t).length / validTemps.length;
        const below = validTemps.filter((v) => v < t).length / validTemps.length;
        probAbove[t] = Math.round(above * 1000) / 1000;
        probBelow[t] = Math.round(below * 1000) / 1000;
      }

      // Precipitation ensemble stats
      const validPrecip = dayData.precipSumPerMember.filter((p) => p >= 0);
      const meanPrecip = validPrecip.length > 0
        ? validPrecip.reduce((a, b) => a + b, 0) / validPrecip.length
        : 0;

      // Convert mm thresholds: trace=0.254mm (0.01"), quarter=6.35mm, half=12.7mm, inch=25.4mm
      const probPrecipAboveTrace = validPrecip.length > 0
        ? validPrecip.filter((p) => p > 0.254).length / validPrecip.length
        : 0;
      const probPrecipAboveQuarter = validPrecip.length > 0
        ? validPrecip.filter((p) => p > 6.35).length / validPrecip.length
        : 0;
      const probPrecipAboveHalf = validPrecip.length > 0
        ? validPrecip.filter((p) => p > 12.7).length / validPrecip.length
        : 0;
      const probPrecipAboveInch = validPrecip.length > 0
        ? validPrecip.filter((p) => p > 25.4).length / validPrecip.length
        : 0;

      results.push({
        valid_date: date,
        members: validTemps.length,
        temp_highs_f: validTemps.map((t) => Math.round(t)),
        mean_high_f: Math.round(mean * 10) / 10,
        median_high_f: Math.round(median),
        std_dev_f: Math.round(stdDev * 10) / 10,
        prob_above: probAbove,
        prob_below: probBelow,
        precip_totals_mm: validPrecip,
        mean_precip_mm: Math.round(meanPrecip * 100) / 100,
        prob_precip_above_trace: Math.round(probPrecipAboveTrace * 1000) / 1000,
        prob_precip_above_quarter: Math.round(probPrecipAboveQuarter * 1000) / 1000,
        prob_precip_above_half: Math.round(probPrecipAboveHalf * 1000) / 1000,
        prob_precip_above_inch: Math.round(probPrecipAboveInch * 1000) / 1000,
      });
    }

    return results;
  } catch (err) {
    console.error(`Ensemble fetch failed for ${city.name}:`, err);
    return [];
  }
}

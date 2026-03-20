// ============================================================
// NWS API Integration — US Cities Only
// ============================================================
// api.weather.gov — No key, no signup
// IMPORTANT: Only call for cities where nws_office IS NOT NULL

import { WeatherCity } from './types';

interface NWSForecastPeriod {
  startTime: string;
  endTime: string;
  temperature: number;
  temperatureUnit: string;
  isDaytime: boolean;
  shortForecast: string;
  probabilityOfPrecipitation?: { value: number | null };
}

interface NWSHourlyResponse {
  properties: {
    periods: NWSForecastPeriod[];
  };
}

export interface NWSForecastResult {
  valid_date: string;
  temp_high_f: number;
  temp_low_f: number;
  precip_prob: number;
  conditions: string;
}

const NWS_BASE = 'https://api.weather.gov';
const NWS_HEADERS = {
  'User-Agent': 'ARBITER-Weather-Edge (contact@arbiter.app)',
  Accept: 'application/geo+json',
};

export function canFetchNWS(city: WeatherCity): boolean {
  return city.nws_office !== null && city.nws_grid_x !== null && city.nws_grid_y !== null;
}

export async function fetchNWSForecast(city: WeatherCity): Promise<NWSForecastResult[]> {
  if (!canFetchNWS(city)) {
    return [];
  }

  const url = `${NWS_BASE}/gridpoints/${city.nws_office}/${city.nws_grid_x},${city.nws_grid_y}/forecast/hourly`;

  const res = await fetch(url, {
    headers: NWS_HEADERS,
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    console.error(`NWS API error for ${city.name}: ${res.status} ${res.statusText}`);
    return [];
  }

  const data: NWSHourlyResponse = await res.json();
  const periods = data.properties.periods;

  // Group hourly periods by date, extract daily high/low
  const byDate = new Map<string, NWSForecastPeriod[]>();
  for (const p of periods) {
    const date = p.startTime.split('T')[0];
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(p);
  }

  const results: NWSForecastResult[] = [];
  for (const [date, dayPeriods] of byDate) {
    // Only next 3 days
    if (results.length >= 3) break;

    const temps = dayPeriods.map((p) => {
      // Convert to Fahrenheit if needed
      if (p.temperatureUnit === 'F') return p.temperature;
      return (p.temperature * 9) / 5 + 32;
    });

    const precipProbs = dayPeriods
      .map((p) => p.probabilityOfPrecipitation?.value ?? 0)
      .filter((v) => v > 0);

    // Get most common daytime condition
    const daytimePeriods = dayPeriods.filter((p) => p.isDaytime);
    const conditions = daytimePeriods.length > 0 ? daytimePeriods[0].shortForecast : 'Unknown';

    results.push({
      valid_date: date,
      temp_high_f: Math.round(Math.max(...temps)),
      temp_low_f: Math.round(Math.min(...temps)),
      precip_prob: precipProbs.length > 0 ? Math.max(...precipProbs) : 0,
      conditions,
    });
  }

  return results;
}

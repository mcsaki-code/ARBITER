import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ============================================================
// Weather-only trigger — ingests forecasts for a batch of cities
// GET /api/trigger/weather?offset=0 — processes cities 0-4
// GET /api/trigger/weather?offset=5 — processes cities 5-9
// ============================================================

export async function GET(request: Request) {
  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = 5;

  try {
    const supabase = getSupabaseAdmin();
    const log: string[] = [];

    const { data: cities, error } = await supabase
      .from('weather_cities')
      .select('*')
      .eq('is_active', true)
      .order('name')
      .range(offset, offset + limit - 1);

    if (error || !cities || cities.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No cities in this range',
        offset,
        log: [`No cities at offset ${offset}`],
      });
    }

    log.push(`Processing ${cities.length} cities (offset=${offset})`);
    let totalForecasts = 0;

    // Process all cities in parallel
    const results = await Promise.all(
      cities.map(async (city) => {
        const forecasts: {
          city_id: string;
          valid_date: string;
          source: string;
          temp_high_f: number;
          temp_low_f: number;
          precip_prob: number;
          conditions: string;
        }[] = [];

        const models = [
          { key: 'gfs_seamless', name: 'gfs' },
          { key: 'ecmwf_ifs025', name: 'ecmwf' },
          { key: 'icon_global', name: 'icon' },
        ];

        const modelResults = await Promise.all(
          models.map(async (model) => {
            try {
              const params = new URLSearchParams({
                latitude: city.lat.toString(),
                longitude: city.lon.toString(),
                daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,rain_sum,snowfall_sum',
                models: model.key,
                forecast_days: '3',
                temperature_unit: 'fahrenheit',
                timezone: 'auto',
              });

              const res = await fetch(
                `https://api.open-meteo.com/v1/forecast?${params}`,
                { signal: AbortSignal.timeout(5000) }
              );

              if (!res.ok) return [];
              const data = await res.json();
              const daily = data.daily;
              if (!daily?.time) return [];

              return daily.time.map((date: string, i: number) => ({
                city_id: city.id,
                valid_date: date,
                source: model.name,
                temp_high_f: Math.round(daily.temperature_2m_max[i]),
                temp_low_f: Math.round(daily.temperature_2m_min[i]),
                precip_prob: daily.precipitation_probability_max?.[i] ?? 0,
                conditions: `${model.key} forecast`,
              }));
            } catch {
              return [];
            }
          })
        );

        for (const r of modelResults) forecasts.push(...r);

        // NWS (US only)
        if (city.nws_office && city.nws_grid_x && city.nws_grid_y) {
          try {
            const nwsUrl = `https://api.weather.gov/gridpoints/${city.nws_office}/${city.nws_grid_x},${city.nws_grid_y}/forecast/hourly`;
            const res = await fetch(nwsUrl, {
              headers: {
                'User-Agent': 'ARBITER-Weather-Edge (contact@arbiter.app)',
                Accept: 'application/geo+json',
              },
              signal: AbortSignal.timeout(4000),
            });

            if (res.ok) {
              const data = await res.json();
              const periods = data.properties?.periods || [];
              const byDate = new Map<string, number[]>();

              for (const p of periods) {
                const date = p.startTime.split('T')[0];
                if (!byDate.has(date)) byDate.set(date, []);
                const temp =
                  p.temperatureUnit === 'F' ? p.temperature : (p.temperature * 9) / 5 + 32;
                byDate.get(date)!.push(temp);
              }

              let count = 0;
              for (const [date, temps] of byDate) {
                if (count >= 3) break;
                forecasts.push({
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
            }
          } catch {
            // NWS can be slow, skip
          }
        }

        return { city: city.name, cityId: city.id, forecasts };
      })
    );

    // Insert forecasts + consensus
    for (const result of results) {
      if (result.forecasts.length > 0) {
        const { error: insertErr } = await supabase
          .from('weather_forecasts')
          .insert(result.forecasts);

        if (insertErr) {
          log.push(`${result.city}: ERROR ${insertErr.message}`);
        } else {
          totalForecasts += result.forecasts.length;
          log.push(`${result.city}: ${result.forecasts.length} forecasts`);
        }

        // Consensus
        const dates = [...new Set(result.forecasts.map((f) => f.valid_date))];
        for (const date of dates) {
          const dayF = result.forecasts.filter((f) => f.valid_date === date);
          if (dayF.length < 2) continue;

          const highs = dayF.map((f) => f.temp_high_f);
          const sources = dayF.map((f) => f.source);
          const spread = Math.max(...highs) - Math.min(...highs);
          const avg = highs.reduce((a, b) => a + b, 0) / highs.length;
          const agreement = spread <= 2 ? 'HIGH' : spread <= 5 ? 'MEDIUM' : 'LOW';

          await supabase.from('weather_consensus').insert({
            city_id: result.cityId,
            valid_date: date,
            consensus_high_f: Math.round(avg),
            model_spread_f: Math.round(spread * 10) / 10,
            agreement,
            models_used: sources,
          });
        }
      } else {
        log.push(`${result.city}: no data`);
      }
    }

    return NextResponse.json({
      success: true,
      summary: { cities: cities.length, forecasts: totalForecasts, offset },
      log,
      next: cities.length === limit ? `/api/trigger/weather?offset=${offset + limit}` : null,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

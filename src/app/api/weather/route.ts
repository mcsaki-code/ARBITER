import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabaseAdmin();

  // Get all active cities
  const { data: cities, error: citiesErr } = await supabase
    .from('weather_cities')
    .select('*')
    .eq('is_active', true)
    .order('name');

  if (citiesErr) {
    return NextResponse.json({ error: 'Failed to fetch cities' }, { status: 500 });
  }

  // Get latest consensus for each city (tomorrow)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // Also check today
  const todayStr = new Date().toISOString().split('T')[0];

  const { data: consensus } = await supabase
    .from('weather_consensus')
    .select('*')
    .in('valid_date', [todayStr, tomorrowStr])
    .order('calculated_at', { ascending: false });

  // Get active markets with city_id
  const { data: markets } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true);

  // Get latest analyses
  const { data: analyses } = await supabase
    .from('weather_analyses')
    .select('*')
    .order('analyzed_at', { ascending: false })
    .limit(50);

  // Get latest forecasts
  const { data: forecasts } = await supabase
    .from('weather_forecasts')
    .select('*')
    .in('valid_date', [todayStr, tomorrowStr])
    .order('fetched_at', { ascending: false })
    .limit(100);

  // Assemble per-city data
  const cityData = cities?.map((city) => {
    const cityConsensus = consensus?.find(
      (c) => c.city_id === city.id
    ) || null;

    const cityMarket = markets?.find(
      (m) => m.city_id === city.id
    ) || null;

    const cityAnalysis = analyses?.find(
      (a) => a.city_id === city.id
    ) || null;

    const cityForecasts = forecasts?.filter(
      (f) => f.city_id === city.id
    ) || [];

    return {
      city,
      consensus: cityConsensus,
      market: cityMarket,
      analysis: cityAnalysis,
      forecasts: cityForecasts,
    };
  });

  return NextResponse.json({
    cities: cityData,
    lastUpdated: new Date().toISOString(),
  });
}

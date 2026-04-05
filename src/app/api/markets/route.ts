import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabaseAdmin();

  // V3: Weather-only — server-side filter ensures no non-weather data leaks
  const { data: markets, error } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true)
    .in('category', ['temperature', 'precipitation', 'snowfall', 'weather'])
    .order('updated_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch markets' }, { status: 500 });
  }

  return NextResponse.json({
    markets: markets || [],
    lastUpdated: new Date().toISOString(),
  });
}

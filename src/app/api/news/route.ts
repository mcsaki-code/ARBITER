import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET /api/news — recent news signals
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    const { data: signals, error } = await supabase
      .from('news_signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json({ signals: [], error: error.message });
    }

    // Stats
    const highImpact = (signals || []).filter(s => s.impact === 'HIGH').length;
    const mediumImpact = (signals || []).filter(s => s.impact === 'MEDIUM').length;

    return NextResponse.json({
      signals: signals || [],
      stats: {
        total: signals?.length || 0,
        highImpact,
        mediumImpact,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { signals: [], error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

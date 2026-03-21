import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabaseAdmin();

  // Fetch open arb opportunities, sorted by net edge
  const { data: arbs, error } = await supabase
    .from('arb_opportunities')
    .select('*')
    .eq('status', 'OPEN')
    .order('net_edge', { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Summary stats
  const totalArbs = arbs?.length || 0;
  const avgEdge = totalArbs > 0
    ? arbs!.reduce((sum: number, a: { net_edge: number }) => sum + (a.net_edge || 0), 0) / totalArbs
    : 0;
  const totalLiquidity = arbs?.reduce((sum: number, a: { liquidity_a: number }) => sum + (a.liquidity_a || 0), 0) || 0;

  // Category breakdown
  const byCategory: Record<string, number> = {};
  for (const arb of arbs || []) {
    const cat = arb.category || 'other';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  return NextResponse.json({
    summary: {
      total_open: totalArbs,
      avg_net_edge: avgEdge,
      total_liquidity: totalLiquidity,
      by_category: byCategory,
    },
    opportunities: arbs,
  });
}

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabaseAdmin();

  const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 3600000).toISOString();
  const twoHoursAgo      = new Date(Date.now() - 2 * 3600000).toISOString();

  const [
    { data: rawAnalyses },
    { data: openBets },
    { data: allBets },
  ] = await Promise.all([
    // Latest politics analyses (deduplicated by market_id below)
    supabase.from('politics_analyses')
      .select('*')
      .order('analyzed_at', { ascending: false })
      .limit(200),

    // Open politics bets
    supabase.from('bets')
      .select('id, market_id, direction, entry_price, amount_usd, status, placed_at, pnl, condition_id')
      .eq('category', 'politics')
      .eq('status', 'OPEN')
      .eq('is_paper', true),

    // All-time politics bets for P&L
    supabase.from('bets')
      .select('id, market_id, direction, entry_price, amount_usd, status, placed_at, pnl')
      .eq('category', 'politics')
      .eq('is_paper', true)
      .order('placed_at', { ascending: false })
      .limit(100),
  ]);

  // Deduplicate analyses: keep only the latest per market_id
  const seenMarkets = new Set<string>();
  const analyses = (rawAnalyses ?? []).filter((a: { market_id: string }) => {
    if (seenMarkets.has(a.market_id)) return false;
    seenMarkets.add(a.market_id);
    return true;
  });

  // Enrich analyses with current market data
  const marketIds = [...new Set(analyses.map((a: { market_id: string }) => a.market_id))];
  const { data: markets } = await supabase
    .from('markets')
    .select('id, question, liquidity_usd, resolution_date, is_active, outcome_prices')
    .in('id', marketIds.slice(0, 100));

  const marketMap = new Map((markets ?? []).map((m: { id: string }) => [m.id, m]));

  // Enrich analyses with market details
  const enrichedAnalyses = analyses.map((a: Record<string, unknown>) => ({
    ...a,
    market: marketMap.get(a.market_id as string) ?? null,
  }));

  // Category breakdown
  const categoryBreakdown: Record<string, { count: number; avg_edge: number }> = {};
  for (const a of analyses as Array<{ category?: string; edge?: number | string }>) {
    const cat = a.category ?? 'other';
    if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { count: 0, avg_edge: 0 };
    categoryBreakdown[cat].count++;
    categoryBreakdown[cat].avg_edge += parseFloat(String(a.edge ?? 0));
  }
  for (const cat of Object.keys(categoryBreakdown)) {
    const n = categoryBreakdown[cat].count;
    categoryBreakdown[cat].avg_edge = n > 0 ? categoryBreakdown[cat].avg_edge / n : 0;
  }

  // Recent analyses (last 2h) — what's hot right now
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recentAnalyses = (enrichedAnalyses as any[]).filter(
    (a) => a.analyzed_at && a.analyzed_at > twoHoursAgo
  );

  // P&L summary
  const resolvedBets = (allBets ?? []).filter((b: { status: string }) => ['WON', 'LOST', 'EXPIRED'].includes(b.status));
  const totalPnl = resolvedBets.reduce((sum: number, b: { pnl?: number | null }) => sum + (b.pnl ?? 0), 0);
  const wins     = resolvedBets.filter((b: { status: string }) => b.status === 'WON').length;
  const winRate  = resolvedBets.length > 0 ? wins / resolvedBets.length : null;

  // Top opportunities: betable analyses sorted by |edge|
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topOpportunities = (enrichedAnalyses as any[])
    .filter((a) => a.direction !== 'PASS' && parseFloat(String(a.edge ?? 0)) >= 0.05)
    .sort((a, b) => Math.abs(parseFloat(String(b.edge ?? 0))) - Math.abs(parseFloat(String(a.edge ?? 0))))
    .slice(0, 20);

  return NextResponse.json({
    summary: {
      total_analyses: analyses.length,
      recent_analyses_2h: recentAnalyses.length,
      open_bets: (openBets ?? []).length,
      total_deployed: (openBets ?? []).reduce((s: number, b: { amount_usd?: number }) => s + (b.amount_usd ?? 0), 0),
      resolved_bets: resolvedBets.length,
      total_pnl: totalPnl,
      win_rate: winRate,
      category_breakdown: categoryBreakdown,
    },
    top_opportunities: topOpportunities,
    open_bets: openBets ?? [],
    all_bets: allBets ?? [],
  });
}

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabaseAdmin();

  // Fetch active sports markets from Polymarket
  const { data: sportsMarkets, error: marketsErr } = await supabase
    .from('markets')
    .select('*')
    .eq('category', 'sports')
    .eq('is_active', true)
    .order('volume_usd', { ascending: false })
    .limit(100);

  // Fetch recent sports odds (last 2 hours)
  const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
  const { data: recentOdds, error: oddsErr } = await supabase
    .from('sports_odds')
    .select('*')
    .gte('fetched_at', twoHoursAgo)
    .order('fetched_at', { ascending: false })
    .limit(200);

  // Fetch recent sports analyses (get more, then deduplicate by market_id)
  const { data: rawAnalyses, error: analysesErr } = await supabase
    .from('sports_analyses')
    .select('*')
    .order('analyzed_at', { ascending: false })
    .limit(100);

  // Deduplicate: keep only the LATEST analysis per market_id
  const seenMarkets = new Set<string>();
  const analyses = (rawAnalyses || []).filter((a: { market_id: string }) => {
    if (seenMarkets.has(a.market_id)) return false;
    seenMarkets.add(a.market_id);
    return true;
  });

  if (marketsErr || oddsErr) {
    return NextResponse.json({
      error: marketsErr?.message || oddsErr?.message
    }, { status: 500 });
  }

  // Compute league breakdown
  const leagueBreakdown: Record<string, { markets: number; volume: number }> = {};
  for (const m of sportsMarkets || []) {
    const q = m.question.toLowerCase();
    let league = 'Other';
    if (/nba|basketball/.test(q)) league = 'NBA';
    else if (/nfl|football/.test(q) && !/ncaa/.test(q)) league = 'NFL';
    else if (/mlb|baseball/.test(q)) league = 'MLB';
    else if (/nhl|hockey/.test(q)) league = 'NHL';
    else if (/ncaa|college|march madness/.test(q)) league = 'NCAA';
    else if (/ufc|mma/.test(q)) league = 'UFC/MMA';
    else if (/soccer|premier|champions league|fifa/.test(q)) league = 'Soccer';

    if (!leagueBreakdown[league]) leagueBreakdown[league] = { markets: 0, volume: 0 };
    leagueBreakdown[league].markets += 1;
    leagueBreakdown[league].volume += m.volume_usd || 0;
  }

  return NextResponse.json({
    summary: {
      total_markets: sportsMarkets?.length || 0,
      total_volume: sportsMarkets?.reduce((s: number, m: { volume_usd: number }) => s + (m.volume_usd || 0), 0) || 0,
      total_odds_datapoints: recentOdds?.length || 0,
      total_analyses: analyses?.length || 0,
      league_breakdown: leagueBreakdown,
    },
    markets: sportsMarkets,
    recent_odds: recentOdds?.slice(0, 50),
    analyses: analyses,
  });
}

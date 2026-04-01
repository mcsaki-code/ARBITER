import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET — list bets with market context and reasoning
export async function GET() {
  const supabase = getSupabaseAdmin();

  // Fetch v2_start_date to filter out legacy bets
  const { data: v2Config } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'v2_start_date')
    .single();

  const v2StartDate = v2Config?.value || null;

  // Fetch bets joined with markets for the question text
  let betsQuery = supabase
    .from('bets')
    .select('*, markets(question, outcomes, outcome_prices, resolution_date, is_resolved)')
    .order('placed_at', { ascending: false })
    .limit(100);

  // Only show bets placed after v2 start date (filters out legacy pre-rule-change bets)
  if (v2StartDate) {
    betsQuery = betsQuery.gte('placed_at', v2StartDate);
  }

  const { data: bets, error } = await betsQuery;

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch bets' }, { status: 500 });
  }

  // Enrich bets with market question and reasoning from analysis tables
  const enrichedBets = [];
  let totalExposure = 0;
  let totalPotentialProfit = 0;
  let openCount = 0;

  for (const bet of bets || []) {
    const market = bet.markets as { question: string; outcomes: string[]; outcome_prices: number[]; resolution_date: string | null; is_resolved: boolean } | null;

    let reasoning: string | null = null;

    // Fetch reasoning from the appropriate analysis table
    if (bet.analysis_id && bet.category === 'weather') {
      const { data: analysis } = await supabase
        .from('weather_analyses')
        .select('reasoning')
        .eq('id', bet.analysis_id)
        .single();
      reasoning = analysis?.reasoning || null;
    }

    // For sports/crypto, analysis_id is null (FK constraint), so search by market_id + time
    if (!reasoning && bet.category === 'sports') {
      const { data: analysis } = await supabase
        .from('sports_analyses')
        .select('reasoning')
        .eq('market_id', bet.market_id)
        .order('analyzed_at', { ascending: false })
        .limit(1)
        .single();
      reasoning = analysis?.reasoning || null;
    }

    if (!reasoning && bet.category === 'crypto') {
      const { data: analysis } = await supabase
        .from('crypto_analyses')
        .select('reasoning')
        .eq('market_id', bet.market_id)
        .order('analyzed_at', { ascending: false })
        .limit(1)
        .single();
      reasoning = analysis?.reasoning || null;
    }

    // Calculate potential payout and profit for OPEN bets
    let potential_payout: number | null = null;
    let potential_profit: number | null = null;

    if (bet.status === 'OPEN') {
      potential_payout = bet.amount_usd / bet.entry_price;
      potential_profit = potential_payout - bet.amount_usd;
      totalExposure += bet.amount_usd;
      totalPotentialProfit += potential_profit;
      openCount += 1;
    }

    enrichedBets.push({
      ...bet,
      market_question: market?.question || null,
      reasoning,
      current_prices: market?.outcome_prices || null,
      resolution_date: market?.resolution_date || null,
      is_resolved: market?.is_resolved || false,
      potential_payout,
      potential_profit,
      markets: undefined, // Don't send the raw join to the client
    });
  }

  // Get performance stats
  const { data: config } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', [
      'paper_bankroll',
      'total_paper_bets',
      'paper_win_rate',
      'paper_trade_start_date',
      'paper_days_required',
      'v2_start_date',
      'v2_bankroll',
    ]);

  const configMap: Record<string, string> = {};
  config?.forEach((r) => {
    configMap[r.key] = r.value;
  });

  // Get snapshots for chart (only v2 period)
  let snapshotsQuery = supabase
    .from('performance_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: true })
    .limit(90);

  if (v2StartDate) {
    snapshotsQuery = snapshotsQuery.gte('snapshot_date', v2StartDate.split('T')[0]);
  }

  const { data: snapshots } = await snapshotsQuery;

  return NextResponse.json({
    bets: enrichedBets,
    config: configMap,
    snapshots: snapshots || [],
    lastUpdated: new Date().toISOString(),
    pipeline_summary: {
      total_exposure: totalExposure,
      total_potential_profit: totalPotentialProfit,
      open_count: openCount,
    },
  });
}

// POST endpoint removed — all bets are now placed exclusively
// by the automated place-bets pipeline (Netlify scheduled function)

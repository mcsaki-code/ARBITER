import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET — list bets with market context and reasoning
export async function GET() {
  const supabase = getSupabaseAdmin();

  // Fetch bets joined with markets for the question text
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*, markets(question, outcomes, outcome_prices, resolution_date, is_resolved)')
    .order('placed_at', { ascending: false })
    .limit(100);

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
    ]);

  const configMap: Record<string, string> = {};
  config?.forEach((r) => {
    configMap[r.key] = r.value;
  });

  // Get snapshots for chart
  const { data: snapshots } = await supabase
    .from('performance_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: true })
    .limit(90);

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

// POST — place a paper bet
export async function POST(req: NextRequest) {
  const supabase = getSupabaseAdmin();

  try {
    const body = await req.json();
    const {
      market_id,
      analysis_id,
      category,
      direction,
      outcome_label,
      entry_price,
      amount_usd,
    } = body;

    // Validate required fields
    if (!market_id || !direction || !entry_price || !amount_usd) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Insert bet
    const { data: bet, error } = await supabase
      .from('bets')
      .insert({
        market_id,
        analysis_id: analysis_id || null,
        category: category || 'weather',
        direction,
        outcome_label,
        entry_price,
        amount_usd,
        is_paper: true,
        status: 'OPEN',
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: 'Failed to place bet' }, { status: 500 });
    }

    // Update paper_trade_start_date if this is the first bet
    const { data: startConfig } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'paper_trade_start_date')
      .single();

    if (startConfig && !startConfig.value) {
      await supabase
        .from('system_config')
        .update({
          value: new Date().toISOString().split('T')[0],
          updated_at: new Date().toISOString(),
        })
        .eq('key', 'paper_trade_start_date');
    }

    // Update total bets count
    const { count } = await supabase
      .from('bets')
      .select('*', { count: 'exact', head: true });

    await supabase
      .from('system_config')
      .update({
        value: (count || 0).toString(),
        updated_at: new Date().toISOString(),
      })
      .eq('key', 'total_paper_bets');

    return NextResponse.json({ bet });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

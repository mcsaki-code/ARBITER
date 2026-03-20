import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET — list bets
export async function GET() {
  const supabase = getSupabaseAdmin();

  const { data: bets, error } = await supabase
    .from('bets')
    .select('*')
    .order('placed_at', { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch bets' }, { status: 500 });
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
    bets: bets || [],
    config: configMap,
    snapshots: snapshots || [],
    lastUpdated: new Date().toISOString(),
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
  } catch (err) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

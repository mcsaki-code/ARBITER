import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabaseAdmin();

  // Fetch active crypto markets from Polymarket
  const { data: cryptoMarkets, error: marketsErr } = await supabase
    .from('markets')
    .select('*')
    .eq('category', 'crypto')
    .eq('is_active', true)
    .order('volume_usd', { ascending: false })
    .limit(100);

  // Fetch latest crypto signals (last 2 hours)
  const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
  const { data: signals, error: signalsErr } = await supabase
    .from('crypto_signals')
    .select('*')
    .gte('fetched_at', twoHoursAgo)
    .order('fetched_at', { ascending: false })
    .limit(20);

  // Fetch recent crypto analyses
  const { data: analyses, error: analysesErr } = await supabase
    .from('crypto_analyses')
    .select('*')
    .order('analyzed_at', { ascending: false })
    .limit(20);

  if (marketsErr || signalsErr) {
    return NextResponse.json({
      error: marketsErr?.message || signalsErr?.message
    }, { status: 500 });
  }

  // Latest signal per asset
  const latestSignals: Record<string, unknown> = {};
  for (const sig of signals || []) {
    if (!latestSignals[sig.asset]) {
      latestSignals[sig.asset] = sig;
    }
  }

  // Asset breakdown
  const assetBreakdown: Record<string, { markets: number; volume: number }> = {};
  for (const m of cryptoMarkets || []) {
    const q = m.question.toLowerCase();
    let asset = 'Other';
    if (/bitcoin|btc/.test(q)) asset = 'BTC';
    else if (/ethereum|eth/.test(q)) asset = 'ETH';
    else if (/solana|sol/.test(q)) asset = 'SOL';

    if (!assetBreakdown[asset]) assetBreakdown[asset] = { markets: 0, volume: 0 };
    assetBreakdown[asset].markets += 1;
    assetBreakdown[asset].volume += m.volume_usd || 0;
  }

  return NextResponse.json({
    summary: {
      total_markets: cryptoMarkets?.length || 0,
      total_volume: cryptoMarkets?.reduce((s: number, m: { volume_usd: number }) => s + (m.volume_usd || 0), 0) || 0,
      total_signals: signals?.length || 0,
      total_analyses: analyses?.length || 0,
      asset_breakdown: assetBreakdown,
    },
    latest_signals: latestSignals,
    markets: cryptoMarkets,
    analyses: analyses,
  });
}

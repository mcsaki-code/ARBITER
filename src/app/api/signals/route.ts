import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ============================================================
// Signals API — returns the 3 most recent near-miss opportunities
// (considered but not taken) plus per-city probability snapshots
// ============================================================

interface CitySignal {
  city_name: string;
  city_id: string;
  market_id: string | null;
  market_active: boolean;
  consensus_high_f: number | null;
  model_spread_f: number | null;
  agreement: string | null;
  market_question: string | null;
  market_outcomes: string[] | null;
  market_prices: number[] | null;
  best_outcome_label: string | null;
  edge: number | null;
  true_prob: number | null;
  market_price: number | null;
  direction: string | null;
  confidence: string | null;
  reasoning: string | null;
  rec_bet_usd: number | null;
  analyzed_at: string | null;
  // Per-model forecasts
  nws_high: number | null;
  gfs_high: number | null;
  ecmwf_high: number | null;
  icon_high: number | null;
  signal_type: 'edge' | 'near_miss' | 'pass' | 'no_market';
}

export async function GET() {
  const supabase = getSupabaseAdmin();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  // Get all cities
  const { data: cities } = await supabase
    .from('weather_cities')
    .select('*')
    .eq('is_active', true)
    .order('name');

  if (!cities) {
    return NextResponse.json({ signals: [], citySnapshots: [] });
  }

  // Get latest consensus
  const { data: consensusAll } = await supabase
    .from('weather_consensus')
    .select('*')
    .in('valid_date', [todayStr, tomorrowStr])
    .order('calculated_at', { ascending: false });

  // Get latest forecasts
  const { data: forecastsAll } = await supabase
    .from('weather_forecasts')
    .select('*')
    .in('valid_date', [todayStr, tomorrowStr])
    .order('fetched_at', { ascending: false })
    .limit(200);

  // Get active markets (used to determine if a market is still tradeable)
  const { data: marketsAll } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true);

  // Also get ALL markets with city_id so we can resolve market_id from stale analyses
  const { data: allMarketsWithCity } = await supabase
    .from('markets')
    .select('id, city_id, is_active')
    .not('city_id', 'is', null);

  // Get recent analyses (last 24h)
  const { data: analysesAll } = await supabase
    .from('weather_analyses')
    .select('*')
    .gte('analyzed_at', new Date(Date.now() - 86400000).toISOString())
    .order('analyzed_at', { ascending: false });

  // Build per-city signals
  const citySnapshots: CitySignal[] = [];

  for (const city of cities) {
    const consensus = consensusAll?.find((c) => c.city_id === city.id) || null;
    const market = marketsAll?.find((m) => m.city_id === city.id) || null;
    const analysis = analysesAll?.find((a) => a.city_id === city.id) || null;
    const cityForecasts = forecastsAll?.filter((f) => f.city_id === city.id) || [];

    const nws = cityForecasts.find((f) => f.source === 'nws');
    const gfs = cityForecasts.find((f) => f.source === 'gfs');
    const ecmwf = cityForecasts.find((f) => f.source === 'ecmwf');
    const icon = cityForecasts.find((f) => f.source === 'icon');

    // Check if the SPECIFIC market the analysis was done for is still active
    // (not just any active market for this city)
    const analysisMarketIsLive = analysis
      ? !!marketsAll?.find((m) => m.id === analysis.market_id)
      : false;
    const marketIsLive = analysisMarketIsLive;

    let signalType: CitySignal['signal_type'] = 'no_market';
    if (analysis && marketIsLive && analysis.edge !== null && analysis.edge > 0.05) {
      signalType = 'edge';
    } else if (analysis && marketIsLive && analysis.edge !== null && analysis.edge > 0) {
      signalType = 'near_miss';
    } else if (analysis) {
      signalType = 'pass';
    } else if (!market) {
      signalType = 'no_market';
    }

    citySnapshots.push({
      city_name: city.name,
      city_id: city.id,
      market_id: analysis?.market_id ?? market?.id ?? null,
      market_active: analysisMarketIsLive,
      consensus_high_f: consensus?.consensus_high_f ?? null,
      model_spread_f: consensus?.model_spread_f ?? null,
      agreement: consensus?.agreement ?? null,
      market_question: market?.question ?? null,
      market_outcomes: market?.outcomes ?? null,
      market_prices: market?.outcome_prices ?? null,
      best_outcome_label: analysis?.best_outcome_label ?? null,
      edge: analysis?.edge ?? null,
      true_prob: analysis?.true_prob ?? null,
      market_price: analysis?.market_price ?? null,
      direction: analysis?.direction ?? null,
      confidence: analysis?.confidence ?? null,
      reasoning: analysis?.reasoning ?? null,
      rec_bet_usd: analysis?.rec_bet_usd ?? null,
      analyzed_at: analysis?.analyzed_at ?? null,
      nws_high: nws?.temp_high_f ?? null,
      gfs_high: gfs?.temp_high_f ?? null,
      ecmwf_high: ecmwf?.temp_high_f ?? null,
      icon_high: icon?.temp_high_f ?? null,
      signal_type: signalType,
    });
  }

  // Sort: edges first, then near_misses, then passes, then no_market
  const priority: Record<string, number> = { edge: 0, near_miss: 1, pass: 2, no_market: 3 };
  citySnapshots.sort((a, b) => {
    const pa = priority[a.signal_type] ?? 9;
    const pb = priority[b.signal_type] ?? 9;
    if (pa !== pb) return pa - pb;
    // Within same type, sort by edge magnitude descending
    return (b.edge ?? -1) - (a.edge ?? -1);
  });

  // Top 3 "recent signals" — the closest near-misses or strongest edges
  const recentSignals = citySnapshots
    .filter((s) => s.signal_type === 'edge' || s.signal_type === 'near_miss' || s.signal_type === 'pass')
    .slice(0, 3);

  return NextResponse.json({
    signals: recentSignals,
    citySnapshots,
    lastUpdated: new Date().toISOString(),
  });
}

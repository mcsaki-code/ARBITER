import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    // 1. Get learning insights and summary from system_config
    const { data: configRows } = await supabase
      .from('system_config')
      .select('key, value, updated_at')
      .in('key', [
        'learning_insights',
        'learning_summary',
        'v3_start_date',
        'paper_bankroll',
        // V2 expert dimensions
        'kelly_boost_high_high',
        'kelly_boost_medium_high',
        'kelly_boost_low_high',
        'learning_sigma_accuracy',
        'forecast_next_cycle',
        'sigma_adjustments',
      ]);

    const config: Record<string, { value: string; updated_at: string }> = {};
    configRows?.forEach((r) => {
      config[r.key] = { value: r.value, updated_at: r.updated_at };
    });

    // 2. Get all calibration_ keys (dynamic city multipliers)
    const { data: calRows } = await supabase
      .from('system_config')
      .select('key, value, updated_at')
      .like('key', 'calibration_%');

    const calibrations: { city: string; multiplier: number; updated_at: string }[] = [];
    calRows?.forEach((r) => {
      const cityName = r.key.replace('calibration_', '').replace(/_/g, ' ');
      calibrations.push({
        city: cityName,
        multiplier: parseFloat(r.value) || 1.0,
        updated_at: r.updated_at,
      });
    });

    // 3. Parse learning insights
    let insights = null;
    if (config.learning_insights?.value) {
      try {
        insights = JSON.parse(config.learning_insights.value);
      } catch { /* ignore parse errors */ }
    }

    let summary = null;
    if (config.learning_summary?.value) {
      try {
        summary = JSON.parse(config.learning_summary.value);
      } catch { /* ignore parse errors */ }
    }

    // 4. Get recent resolved bets for live stats (in case learning hasn't run yet)
    const v3Start = config.v3_start_date?.value || '2026-04-04T00:00:00Z';
    const { data: resolvedBets } = await supabase
      .from('bets')
      .select('direction, status, pnl, entry_price, confidence, placed_at, amount_usd, category, markets!inner(resolution_date, question)')
      .in('status', ['WON', 'LOST'])
      .gte('placed_at', v3Start)
      .order('placed_at', { ascending: false });

    const { data: openBets } = await supabase
      .from('bets')
      .select('direction, status, entry_price, confidence, placed_at, amount_usd, category, markets!inner(resolution_date, question)')
      .eq('status', 'OPEN')
      .gte('placed_at', v3Start)
      .order('placed_at', { ascending: false });

    // 5. Compute live stats from bets directly
    const resolved = resolvedBets || [];
    const open = openBets || [];
    const wins = resolved.filter((b) => b.status === 'WON');
    const losses = resolved.filter((b) => b.status === 'LOST');
    const totalPnl = resolved.reduce((s, b) => s + (b.pnl || 0), 0);

    // Direction breakdown
    const directionBreakdown: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const b of resolved) {
      const dir = b.direction || 'UNKNOWN';
      if (!directionBreakdown[dir]) directionBreakdown[dir] = { wins: 0, losses: 0, pnl: 0 };
      if (b.status === 'WON') directionBreakdown[dir].wins++;
      else directionBreakdown[dir].losses++;
      directionBreakdown[dir].pnl += b.pnl || 0;
    }

    // Confidence breakdown
    const confBreakdown: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const b of resolved) {
      const conf = b.confidence || 'UNKNOWN';
      if (!confBreakdown[conf]) confBreakdown[conf] = { wins: 0, losses: 0, pnl: 0 };
      if (b.status === 'WON') confBreakdown[conf].wins++;
      else confBreakdown[conf].losses++;
      confBreakdown[conf].pnl += b.pnl || 0;
    }

    // Entry price buckets
    const priceBuckets = [
      { name: '0-5¢', min: 0, max: 0.05 },
      { name: '5-10¢', min: 0.05, max: 0.10 },
      { name: '10-15¢', min: 0.10, max: 0.15 },
      { name: '15-25¢', min: 0.15, max: 0.25 },
      { name: '25-40¢', min: 0.25, max: 0.40 },
      { name: '40¢+', min: 0.40, max: 1.0 },
    ];

    const priceAnalysis = priceBuckets.map((bucket) => {
      const inBucket = resolved.filter(
        (b) => (b.entry_price || 0) >= bucket.min && (b.entry_price || 0) < bucket.max
      );
      const bWins = inBucket.filter((b) => b.status === 'WON').length;
      const bPnl = inBucket.reduce((s, b) => s + (b.pnl || 0), 0);
      const wagered = inBucket.reduce((s, b) => s + (b.amount_usd || 0), 0);
      return {
        bucket: bucket.name,
        count: inBucket.length,
        wins: bWins,
        losses: inBucket.length - bWins,
        winRate: inBucket.length > 0 ? bWins / inBucket.length : 0,
        totalPnl: bPnl,
        roi: wagered > 0 ? bPnl / wagered : 0,
      };
    }).filter((b) => b.count > 0);

    // Timing analysis
    const timingBuckets = [
      { name: '<12h', min: 0, max: 12 },
      { name: '12-24h', min: 12, max: 24 },
      { name: '24-48h', min: 24, max: 48 },
      { name: '48-72h', min: 48, max: 72 },
      { name: '72h+', min: 72, max: Infinity },
    ];

    const timingAnalysis = timingBuckets.map((bucket) => {
      const inBucket = resolved.filter((b) => {
        const resDate = (b.markets as any)?.resolution_date;
        if (!resDate || !b.placed_at) return false;
        const hours = (new Date(resDate).getTime() - new Date(b.placed_at).getTime()) / 3600000;
        return hours >= bucket.min && hours < bucket.max;
      });
      const bWins = inBucket.filter((b) => b.status === 'WON').length;
      const bPnl = inBucket.reduce((s, b) => s + (b.pnl || 0), 0);
      return {
        bucket: bucket.name,
        count: inBucket.length,
        wins: bWins,
        losses: inBucket.length - bWins,
        winRate: inBucket.length > 0 ? bWins / inBucket.length : 0,
        totalPnl: bPnl,
      };
    }).filter((b) => b.count > 0);

    // Recent bets for the activity feed
    const recentBets = resolved.slice(0, 10).map((b) => ({
      direction: b.direction,
      status: b.status,
      pnl: b.pnl,
      entry_price: b.entry_price,
      confidence: b.confidence,
      placed_at: b.placed_at,
      amount_usd: b.amount_usd,
      question: (b.markets as any)?.question || 'Unknown market',
    }));

    // Parse V2 expert fields
    let sigmaAccuracy: Record<string, { multiplier: number; win_rate: number; n: number }> | null = null;
    if (config.learning_sigma_accuracy?.value) {
      try { sigmaAccuracy = JSON.parse(config.learning_sigma_accuracy.value); } catch { /* ignore */ }
    }

    let forecastNextCycle: string[] | null = null;
    if (config.forecast_next_cycle?.value) {
      try { forecastNextCycle = JSON.parse(config.forecast_next_cycle.value); } catch { /* ignore */ }
    }

    let sigmaAdjustments: string[] | null = null;
    if (config.sigma_adjustments?.value) {
      try { sigmaAdjustments = JSON.parse(config.sigma_adjustments.value); } catch { /* ignore */ }
    }

    const kellyBoosts = {
      high_high: parseFloat(config.kelly_boost_high_high?.value || '1.0'),
      medium_high: parseFloat(config.kelly_boost_medium_high?.value || '1.0'),
      low_high: parseFloat(config.kelly_boost_low_high?.value || '1.0'),
    };

    return NextResponse.json({
      // Learning agent outputs
      insights,
      summary,
      calibrations,
      lastLearningRun: config.learning_insights?.updated_at || null,
      // V2 expert outputs
      sigmaAccuracy,
      forecastNextCycle,
      sigmaAdjustments,
      kellyBoosts,

      // Live computed stats
      liveStats: {
        totalResolved: resolved.length,
        totalOpen: open.length,
        wins: wins.length,
        losses: losses.length,
        winRate: resolved.length > 0 ? wins.length / resolved.length : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
        totalWagered: Math.round(resolved.reduce((s, b) => s + (b.amount_usd || 0), 0) * 100) / 100,
      },
      directionBreakdown,
      confBreakdown,
      priceAnalysis,
      timingAnalysis,
      recentBets,

      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[api/learning] Error:', err);
    return NextResponse.json({ error: 'Failed to load learning data' }, { status: 500 });
  }
}

// ============================================================
// Netlify Scheduled Function: Learn From Results
// Runs daily at 6 AM UTC — the self-improving brain of ARBITER.
//
// After resolve-bets settles outcomes, this function analyzes
// what worked and what didn't, then updates the system's
// parameters to improve future bets.
//
// LEARNING LOOPS:
// 1. Per-city accuracy tracking — update calibration weights
// 2. Direction performance — track BUY_YES vs BUY_NO win rates
// 3. Confidence calibration — are HIGH/MEDIUM/LOW labels accurate?
// 4. Edge threshold optimization — what min edge actually profits?
// 5. Entry price sweet spot — which price ranges have best ROI?
// 6. Timing analysis — what hours-to-resolution produces wins?
//
// Outputs to: system_config (live params) + learning_log table
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface LearningInsight {
  category: string;
  dimension: string;
  key: string;
  sample_size: number;
  win_rate: number;
  avg_pnl: number;
  total_pnl: number;
  recommendation: string;
  action_taken: string | null;
}

export const handler = schedule('0 6 * * *', async () => {
  console.log('[learn] Starting daily learning cycle');
  const insights: LearningInsight[] = [];

  // Get v3 start date
  const { data: v3Row } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'v3_start_date')
    .single();
  const v3Start = v3Row?.value || '2026-04-04T00:00:00Z';

  // ============================================================
  // LESSON 1: Direction Performance (BUY_YES vs BUY_NO)
  // ============================================================
  const { data: directionStats } = await supabase
    .from('bets')
    .select('direction, status, pnl, entry_price')
    .in('status', ['WON', 'LOST'])
    .gte('placed_at', v3Start);

  if (directionStats && directionStats.length > 0) {
    const dirGroups: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const b of directionStats) {
      if (!dirGroups[b.direction]) dirGroups[b.direction] = { wins: 0, losses: 0, pnl: 0 };
      if (b.status === 'WON') dirGroups[b.direction].wins++;
      else dirGroups[b.direction].losses++;
      dirGroups[b.direction].pnl += b.pnl || 0;
    }

    for (const [dir, stats] of Object.entries(dirGroups)) {
      const total = stats.wins + stats.losses;
      const winRate = total > 0 ? stats.wins / total : 0;
      insights.push({
        category: 'direction',
        dimension: 'bet_direction',
        key: dir,
        sample_size: total,
        win_rate: winRate,
        avg_pnl: total > 0 ? stats.pnl / total : 0,
        total_pnl: stats.pnl,
        recommendation: winRate < 0.3 && total >= 5
          ? `DISABLE ${dir} — win rate ${(winRate * 100).toFixed(0)}% across ${total} bets`
          : winRate > 0.7 && total >= 5
            ? `BOOST ${dir} — win rate ${(winRate * 100).toFixed(0)}% is strong`
            : `MONITOR ${dir} — need more data (${total} bets)`,
        action_taken: null,
      });
    }
  }

  // ============================================================
  // LESSON 2: Per-City Performance
  // ============================================================
  const { data: cityBets } = await supabase
    .from('bets')
    .select('market_id, status, pnl, entry_price, markets!inner(city_id, weather_cities(name))')
    .in('status', ['WON', 'LOST'])
    .gte('placed_at', v3Start);

  if (cityBets && cityBets.length > 0) {
    const cityGroups: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const b of cityBets) {
      const city = (b.markets as any)?.weather_cities?.name || 'unknown';
      if (!cityGroups[city]) cityGroups[city] = { wins: 0, losses: 0, pnl: 0 };
      if (b.status === 'WON') cityGroups[city].wins++;
      else cityGroups[city].losses++;
      cityGroups[city].pnl += b.pnl || 0;
    }

    for (const [city, stats] of Object.entries(cityGroups)) {
      const total = stats.wins + stats.losses;
      const winRate = total > 0 ? stats.wins / total : 0;

      let action = null;
      // Auto-adjust calibration weights based on actual results
      if (total >= 5 && winRate < 0.3) {
        // City is performing terribly — reduce edge multiplier
        action = `DOWNGRADE: ${city} win rate ${(winRate * 100).toFixed(0)}% — reducing edge multiplier`;
        await updateCityMultiplier(city, 'downgrade');
      } else if (total >= 5 && winRate > 0.8) {
        // City is performing great — increase edge multiplier
        action = `UPGRADE: ${city} win rate ${(winRate * 100).toFixed(0)}% — increasing edge multiplier`;
        await updateCityMultiplier(city, 'upgrade');
      }

      insights.push({
        category: 'city',
        dimension: 'city_performance',
        key: city,
        sample_size: total,
        win_rate: winRate,
        avg_pnl: total > 0 ? stats.pnl / total : 0,
        total_pnl: stats.pnl,
        recommendation: winRate < 0.3 ? `AVOID ${city}` : winRate > 0.7 ? `TARGET ${city}` : `NEUTRAL ${city}`,
        action_taken: action,
      });
    }
  }

  // ============================================================
  // LESSON 3: Confidence Calibration
  // ============================================================
  const { data: confBets } = await supabase
    .from('bets')
    .select('confidence, status, pnl')
    .in('status', ['WON', 'LOST'])
    .gte('placed_at', v3Start)
    .not('confidence', 'is', null);

  if (confBets && confBets.length > 0) {
    const confGroups: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const b of confBets) {
      const conf = b.confidence || 'UNKNOWN';
      if (!confGroups[conf]) confGroups[conf] = { wins: 0, losses: 0, pnl: 0 };
      if (b.status === 'WON') confGroups[conf].wins++;
      else confGroups[conf].losses++;
      confGroups[conf].pnl += b.pnl || 0;
    }

    for (const [conf, stats] of Object.entries(confGroups)) {
      const total = stats.wins + stats.losses;
      const winRate = total > 0 ? stats.wins / total : 0;
      insights.push({
        category: 'confidence',
        dimension: 'confidence_calibration',
        key: conf,
        sample_size: total,
        win_rate: winRate,
        avg_pnl: total > 0 ? stats.pnl / total : 0,
        total_pnl: stats.pnl,
        recommendation: conf === 'HIGH' && winRate < 0.6
          ? 'HIGH confidence is miscalibrated — Claude is overconfident'
          : conf === 'LOW' && winRate > 0.5
            ? 'LOW confidence is underrated — consider betting on LOW picks'
            : 'Calibration OK',
        action_taken: null,
      });
    }
  }

  // ============================================================
  // LESSON 4: Entry Price Sweet Spot
  // ============================================================
  const { data: priceBets } = await supabase
    .from('bets')
    .select('entry_price, status, pnl, amount_usd')
    .in('status', ['WON', 'LOST'])
    .gte('placed_at', v3Start);

  if (priceBets && priceBets.length > 0) {
    const buckets = [
      { name: '0-5¢ (deep tail)', min: 0, max: 0.05 },
      { name: '5-10¢ (tail)', min: 0.05, max: 0.10 },
      { name: '10-15¢ (sweet spot)', min: 0.10, max: 0.15 },
      { name: '15-25¢ (moderate)', min: 0.15, max: 0.25 },
      { name: '25-40¢ (expensive)', min: 0.25, max: 0.40 },
    ];

    for (const bucket of buckets) {
      const inBucket = priceBets.filter(
        (b) => b.entry_price >= bucket.min && b.entry_price < bucket.max
      );
      if (inBucket.length === 0) continue;

      const wins = inBucket.filter((b) => b.status === 'WON').length;
      const totalPnl = inBucket.reduce((s, b) => s + (b.pnl || 0), 0);
      const roi = inBucket.reduce((s, b) => s + (b.amount_usd || 0), 0);

      insights.push({
        category: 'entry_price',
        dimension: 'price_bucket',
        key: bucket.name,
        sample_size: inBucket.length,
        win_rate: wins / inBucket.length,
        avg_pnl: totalPnl / inBucket.length,
        total_pnl: totalPnl,
        recommendation: roi > 0
          ? `ROI: ${((totalPnl / roi) * 100).toFixed(0)}%`
          : 'Negative ROI',
        action_taken: null,
      });
    }
  }

  // ============================================================
  // LESSON 5: Timing Analysis (hours to resolution)
  // ============================================================
  const { data: timingBets } = await supabase
    .from('bets')
    .select('placed_at, status, pnl, markets!inner(resolution_date)')
    .in('status', ['WON', 'LOST'])
    .gte('placed_at', v3Start);

  if (timingBets && timingBets.length > 0) {
    const timeBuckets = [
      { name: '<12h (late)', min: 0, max: 12 },
      { name: '12-24h (optimal-late)', min: 12, max: 24 },
      { name: '24-48h (optimal)', min: 24, max: 48 },
      { name: '48-72h (early)', min: 48, max: 72 },
      { name: '72h+ (speculative)', min: 72, max: Infinity },
    ];

    for (const bucket of timeBuckets) {
      const inBucket = timingBets.filter((b) => {
        const resDate = (b.markets as any)?.resolution_date;
        if (!resDate || !b.placed_at) return false;
        const hours = (new Date(resDate).getTime() - new Date(b.placed_at).getTime()) / 3600000;
        return hours >= bucket.min && hours < bucket.max;
      });
      if (inBucket.length === 0) continue;

      const wins = inBucket.filter((b) => b.status === 'WON').length;
      const totalPnl = inBucket.reduce((s, b) => s + (b.pnl || 0), 0);

      insights.push({
        category: 'timing',
        dimension: 'hours_to_resolution',
        key: bucket.name,
        sample_size: inBucket.length,
        win_rate: wins / inBucket.length,
        avg_pnl: totalPnl / inBucket.length,
        total_pnl: totalPnl,
        recommendation: wins / inBucket.length > 0.6
          ? `STRONG — ${bucket.name} is profitable`
          : `WEAK — consider avoiding ${bucket.name}`,
        action_taken: null,
      });
    }
  }

  // ============================================================
  // Store insights in learning_log
  // ============================================================
  if (insights.length > 0) {
    // Store in system_config as JSON for dashboard consumption
    await supabase.from('system_config').upsert({
      key: 'learning_insights',
      value: JSON.stringify({
        generated_at: new Date().toISOString(),
        total_insights: insights.length,
        insights,
      }),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    // Also store latest aggregate stats for quick dashboard access
    const totalBets = directionStats?.length || 0;
    const totalWins = directionStats?.filter((b) => b.status === 'WON').length || 0;
    const totalPnl = directionStats?.reduce((s, b) => s + (b.pnl || 0), 0) || 0;

    await supabase.from('system_config').upsert({
      key: 'learning_summary',
      value: JSON.stringify({
        updated_at: new Date().toISOString(),
        total_resolved: totalBets,
        win_rate: totalBets > 0 ? totalWins / totalBets : 0,
        total_pnl: Math.round(totalPnl * 100) / 100,
        lessons_learned: insights.filter((i) => i.action_taken).length,
        key_findings: insights
          .filter((i) => i.sample_size >= 5)
          .sort((a, b) => Math.abs(b.total_pnl) - Math.abs(a.total_pnl))
          .slice(0, 5)
          .map((i) => `${i.key}: ${(i.win_rate * 100).toFixed(0)}% win rate, $${i.total_pnl.toFixed(2)} P&L (n=${i.sample_size})`),
      }),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    console.log(`[learn] Generated ${insights.length} insights:`);
    for (const i of insights.filter((i) => i.action_taken)) {
      console.log(`  [ACTION] ${i.action_taken}`);
    }
  }

  console.log('[learn] Daily learning cycle complete');
  return { statusCode: 200 };
});

// ============================================================
// Dynamic calibration weight adjustment
// Modifies the edge multiplier stored in system_config based
// on actual betting performance per city.
// ============================================================
async function updateCityMultiplier(
  cityName: string,
  action: 'upgrade' | 'downgrade'
): Promise<void> {
  const key = `calibration_${cityName.toLowerCase().replace(/\s+/g, '_')}`;

  const { data: existing } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', key)
    .single();

  const current = existing ? parseFloat(existing.value) : 1.0;

  // Adjust by 10% per cycle, bounded [0.3, 1.3]
  const newValue = action === 'upgrade'
    ? Math.min(1.3, current * 1.1)
    : Math.max(0.3, current * 0.9);

  await supabase.from('system_config').upsert({
    key,
    value: newValue.toFixed(4),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });

  console.log(`[learn] ${cityName} calibration: ${current.toFixed(4)} -> ${newValue.toFixed(4)} (${action})`);
}

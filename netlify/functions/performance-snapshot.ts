// ============================================================
// Netlify Scheduled Function: Performance Snapshot
// Runs nightly at midnight — captures daily P&L snapshot
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const handler = schedule('0 0 * * *', async () => {
  console.log('[performance-snapshot] Running nightly snapshot');

  // Fetch v3_start_date to only count bets under current weather-only system
  const { data: v3Row } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'v3_start_date')
    .single();

  const v3StartDate = v3Row?.value || null;

  // Get bets — filtered to v3 period if set
  let betsQuery = supabase
    .from('bets')
    .select('status, pnl, amount_usd, category, confidence, predicted_prob, brier_score, entry_price, direction, edge');

  if (v3StartDate) {
    betsQuery = betsQuery.gte('placed_at', v3StartDate);
  }

  const { data: bets } = await betsQuery;

  if (!bets) return { statusCode: 200 };

  const totalBets = bets.length;
  const openBets  = bets.filter((b) => b.status === 'OPEN').length;
  const wins      = bets.filter((b) => b.status === 'WON').length;
  const losses    = bets.filter((b) => b.status === 'LOST').length;
  // win_rate: only consider resolved bets (won + lost), not open
  const winRate   = (wins + losses) > 0 ? wins / (wins + losses) : 0;
  const totalPnl  = bets.reduce((sum, b) => sum + (b.pnl || 0), 0);
  const totalWagered = bets.reduce((sum, b) => sum + (b.amount_usd || 0), 0);

  // Get config for bankroll
  const { data: configRows } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['paper_bankroll', 'real_bankroll', 'v3_bankroll']);

  const config: Record<string, string> = {};
  configRows?.forEach((r: { key: string; value: string }) => {
    config[r.key] = r.value;
  });

  const paperBankroll = parseFloat(config.paper_bankroll || '5000');
  const roi = totalWagered > 0 ? (totalPnl / totalWagered) * 100 : 0;
  const todayStr = new Date().toISOString().split('T')[0];

  // Upsert snapshot (idempotent — safe to run multiple times per day)
  await supabase.from('performance_snapshots').upsert({
    snapshot_date: todayStr,
    total_bets: totalBets,
    wins,
    losses,
    win_rate: winRate,
    total_pnl: totalPnl,
    paper_bankroll: paperBankroll,
    real_bankroll: parseFloat(config.real_bankroll || '0'),
  }, { onConflict: 'snapshot_date' });

  // Keep system_config live stats fresh — dashboard reads from here
  await supabase
    .from('system_config')
    .upsert([
      { key: 'total_paper_bets',   value: totalBets.toString(),       updated_at: new Date().toISOString() },
      { key: 'open_paper_bets',    value: openBets.toString(),        updated_at: new Date().toISOString() },
      { key: 'paper_win_rate',     value: winRate.toFixed(4),         updated_at: new Date().toISOString() },
      { key: 'total_paper_pnl',    value: totalPnl.toFixed(2),        updated_at: new Date().toISOString() },
      { key: 'total_paper_wagered',value: totalWagered.toFixed(2),    updated_at: new Date().toISOString() },
      { key: 'paper_roi_pct',      value: roi.toFixed(2),             updated_at: new Date().toISOString() },
    ]);

  // ─── Calibration rollup per category × confidence tier ───────────────────
  // Tracks how well our predicted probabilities match actual outcomes (Brier score).
  // This is the #1 metric that separates professional forecasters from noise.
  const categories = ['weather', 'sports', 'crypto', 'politics', 'sentiment', 'opportunity', 'whale_copy', 'high_prob_bond'];
  const tiers = ['LOW', 'MEDIUM', 'HIGH'];
  const resolvedBets = bets.filter((b) => b.status === 'WON' || b.status === 'LOST');

  for (const cat of categories) {
    for (const tier of tiers) {
      const cohort = resolvedBets.filter(
        (b) => b.category === cat && (b.confidence || 'MEDIUM') === tier
      );
      if (cohort.length === 0) continue;

      const cohortWins   = cohort.filter((b) => b.status === 'WON').length;
      const cohortLosses = cohort.length - cohortWins;
      const avgBrier     = cohort.reduce((s, b) => s + (b.brier_score || 0), 0) / cohort.length;
      // Now edge IS stored on bets table (from analysis at bet insertion time)
      const avgEdge      = cohort.reduce((s, b) => s + (b.edge || 0), 0) / cohort.length;
      const avgPnl       = cohort.reduce((s, b) => s + (b.pnl || 0), 0) / cohort.length;
      const predictedWR  = cohort.reduce((s, b) => {
        const pp = b.predicted_prob ?? (b.direction === 'BUY_YES' ? (b.entry_price ?? 0.5) : 1 - (b.entry_price ?? 0.5));
        return s + pp;
      }, 0) / cohort.length;

      await supabase.from('calibration_snapshots').upsert({
        snapshot_date: todayStr,
        category: cat,
        confidence_tier: tier,
        total_bets: cohort.length,
        wins: cohortWins,
        losses: cohortLosses,
        predicted_win_rate: Math.round(predictedWR * 10000) / 10000,
        actual_win_rate: cohort.length > 0 ? Math.round(cohortWins / cohort.length * 10000) / 10000 : null,
        avg_brier_score: Math.round(avgBrier * 10000) / 10000,
        avg_edge: avgEdge,
        avg_pnl: Math.round(avgPnl * 100) / 100,
      }, { onConflict: 'snapshot_date,category,confidence_tier' });
    }
  }

  console.log(`[performance-snapshot] Done: ${totalBets} total (${openBets} open, ${wins}W/${losses}L), ROI=${roi.toFixed(1)}%, PnL=$${totalPnl.toFixed(2)}`);
  return { statusCode: 200 };
});

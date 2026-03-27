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

  // Get ALL bets (paper and live) — no is_paper filter so we count everything
  const { data: bets } = await supabase
    .from('bets')
    .select('status, pnl, amount_usd, category');

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
    .in('key', ['paper_bankroll', 'real_bankroll']);

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

  console.log(`[performance-snapshot] Done: ${totalBets} total (${openBets} open, ${wins}W/${losses}L), ROI=${roi.toFixed(1)}%, PnL=$${totalPnl.toFixed(2)}`);
  return { statusCode: 200 };
});

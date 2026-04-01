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

  // Get all bets
  const { data: bets } = await supabase
    .from('bets')
    .select('status, pnl, amount_usd, is_paper');

  if (!bets) return { statusCode: 200 };

  const totalBets = bets.length;
  const wins = bets.filter((b) => b.status === 'WON').length;
  const losses = bets.filter((b) => b.status === 'LOST').length;
  const winRate = totalBets > 0 ? wins / Math.max(wins + losses, 1) : 0;
  const totalPnl = bets.reduce((sum, b) => sum + (b.pnl || 0), 0);

  // Get config for bankroll
  const { data: configRows } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['paper_bankroll', 'real_bankroll']);

  const config: Record<string, string> = {};
  configRows?.forEach((r) => {
    config[r.key] = r.value;
  });

  // Insert snapshot
  await supabase.from('performance_snapshots').insert({
    total_bets: totalBets,
    wins,
    losses,
    win_rate: winRate,
    total_pnl: totalPnl,
    paper_bankroll: parseFloat(config.paper_bankroll || '500'),
    real_bankroll: parseFloat(config.real_bankroll || '0'),
  });

  // Update config with running stats
  await supabase
    .from('system_config')
    .upsert([
      { key: 'total_paper_bets', value: totalBets.toString(), updated_at: new Date().toISOString() },
      { key: 'paper_win_rate', value: winRate.toFixed(4), updated_at: new Date().toISOString() },
    ]);

  console.log(`[performance-snapshot] Done: ${totalBets} bets, ${winRate.toFixed(2)} WR, $${totalPnl.toFixed(2)} PnL`);
  return { statusCode: 200 };
});

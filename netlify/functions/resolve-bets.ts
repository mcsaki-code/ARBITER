// ============================================================
// Netlify Scheduled Function: Resolve Bets
// Runs every hour — checks OPEN bets against resolved markets
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface GammaMarket {
  conditionId: string;
  outcomePrices: string;
  outcomes: string;
  active: boolean;
  closed: boolean;
}

function parseOutcomePrices(raw: string): number[] {
  try {
    return JSON.parse(raw).map((p: string) => parseFloat(p));
  } catch {
    return raw.split(',').map((s) => parseFloat(s.trim()));
  }
}

function parseOutcomes(raw: string): string[] {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.split(',').map((s) => s.trim());
  }
}

export const handler = schedule('0 * * * *', async () => {
  console.log('[resolve-bets] Starting bet resolution check');

  // Get all OPEN bets with their market data
  const { data: openBets, error } = await supabase
    .from('bets')
    .select('*, markets(*)')
    .eq('status', 'OPEN');

  if (error || !openBets || openBets.length === 0) {
    console.log(`[resolve-bets] ${error ? 'Error: ' + error.message : 'No open bets'}`);
    return { statusCode: 200 };
  }

  console.log(`[resolve-bets] Found ${openBets.length} open bets`);

  // Collect unique condition_ids
  const conditionIds = [
    ...new Set(openBets.map((b) => b.markets?.condition_id).filter(Boolean)),
  ] as string[];

  // Fetch current state from Gamma API for each market
  const gammaCache = new Map<string, GammaMarket | null>();

  for (const cid of conditionIds) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?condition_id=${cid}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const data = await res.json();
        gammaCache.set(cid, Array.isArray(data) && data.length > 0 ? data[0] : null);
      } else {
        gammaCache.set(cid, null);
      }
    } catch {
      gammaCache.set(cid, null);
    }
  }

  let resolved = 0;
  let totalPnl = 0;

  for (const bet of openBets) {
    const market = bet.markets;
    if (!market) continue;

    const gamma = gammaCache.get(market.condition_id);
    const resolutionDate = market.resolution_date
      ? new Date(market.resolution_date)
      : null;
    const isPast = resolutionDate && resolutionDate < new Date();

    let winningOutcome: string | null = null;

    if (gamma) {
      const prices = parseOutcomePrices(gamma.outcomePrices);
      const outcomes = parseOutcomes(gamma.outcomes);
      const maxPrice = Math.max(...prices);

      if (gamma.closed && maxPrice >= 0.95) {
        const winIdx = prices.indexOf(maxPrice);
        winningOutcome = outcomes[winIdx] || null;
      } else if (gamma.closed && isPast) {
        const winIdx = prices.indexOf(maxPrice);
        winningOutcome = outcomes[winIdx] || null;
      }
    } else if (isPast) {
      // Fallback to DB prices
      const dbPrices = market.outcome_prices || [];
      const maxP = Math.max(...dbPrices);
      if (maxP >= 0.90) {
        const winIdx = dbPrices.indexOf(maxP);
        winningOutcome = market.outcomes?.[winIdx] || null;
      }
    }

    if (!winningOutcome) continue;

    // Mark market as resolved
    await supabase
      .from('markets')
      .update({
        is_active: false,
        is_resolved: true,
        resolution_val: winningOutcome,
        updated_at: new Date().toISOString(),
      })
      .eq('id', market.id);

    // Resolve the bet
    const betWon = bet.outcome_label === winningOutcome;
    const pnl = betWon
      ? Math.round(bet.amount_usd * ((1.0 / bet.entry_price) - 1) * 100) / 100
      : -bet.amount_usd;

    await supabase
      .from('bets')
      .update({
        status: betWon ? 'WON' : 'LOST',
        exit_price: betWon ? 1.0 : 0.0,
        pnl,
        resolved_at: new Date().toISOString(),
        notes: `Auto-resolved: winner "${winningOutcome}" | ${betWon ? 'WIN' : 'LOSS'}`,
      })
      .eq('id', bet.id);

    resolved++;
    totalPnl += pnl;
    console.log(
      `[resolve-bets] ${betWon ? 'WON' : 'LOST'} bet ${bet.id.substring(0, 8)}: $${pnl.toFixed(2)}`
    );
  }

  // Update stats if any resolved
  if (resolved > 0) {
    const { data: bankrollRow } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'paper_bankroll')
      .single();

    const bankroll = parseFloat(bankrollRow?.value || '500');
    const newBankroll = Math.round((bankroll + totalPnl) * 100) / 100;

    await supabase
      .from('system_config')
      .update({ value: newBankroll.toString(), updated_at: new Date().toISOString() })
      .eq('key', 'paper_bankroll');

    // Win rate
    const { count: wins } = await supabase
      .from('bets')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'WON');

    const { count: total } = await supabase
      .from('bets')
      .select('*', { count: 'exact', head: true })
      .in('status', ['WON', 'LOST']);

    const winRate = total && total > 0 ? Math.round(((wins || 0) / total) * 1000) / 10 : 0;

    await supabase
      .from('system_config')
      .update({ value: winRate.toString(), updated_at: new Date().toISOString() })
      .eq('key', 'paper_win_rate');

    // Snapshot
    const { data: pnlRows } = await supabase
      .from('bets')
      .select('pnl')
      .in('status', ['WON', 'LOST']);

    const cumulativePnl = pnlRows?.reduce((s, r) => s + (r.pnl || 0), 0) || 0;

    await supabase.from('performance_snapshots').insert({
      total_bets: total || 0,
      wins: wins || 0,
      losses: (total || 0) - (wins || 0),
      win_rate: winRate,
      total_pnl: Math.round(cumulativePnl * 100) / 100,
      paper_bankroll: newBankroll,
    });

    console.log(
      `[resolve-bets] Updated bankroll $${bankroll} → $${newBankroll}, win rate ${winRate}%`
    );
  }

  console.log(`[resolve-bets] Done. Resolved ${resolved} bets, PnL $${totalPnl.toFixed(2)}`);
  return { statusCode: 200 };
});

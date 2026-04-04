// ============================================================
// Netlify Scheduled Function: Resolve Bets (V3 — Weather Only)
// Runs every hour — checks OPEN bets against OFFICIALLY resolved
// Polymarket markets using the UMA Optimistic Oracle resolvedBy field.
//
// CRITICAL FIX: Previous versions used `gamma.closed` to detect
// resolution, but closed != resolved on Polymarket. A market can
// stop trading (closed=true) while the UMA oracle challenge window
// is still open. The definitive signal is `resolvedBy` — an Ethereum
// address that appears only after the oracle proposal passes the
// 2-hour challenge period and the market is officially settled.
//
// Weather-only: all bets are weather bracket markets where exactly
// ONE bracket per city/date resolves Yes (the actual temperature).
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { recordOutcome } from '../../src/lib/circuit-breaker';

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
  resolvedBy: string | null;  // Ethereum address of oracle proposer — null until officially settled
  question?: string;
  description?: string;
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
  console.log('[resolve-bets] Starting bet resolution check (V3 — weather only, resolvedBy)');

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

  // Collect unique gamma_market_ids for direct API lookups.
  // IMPORTANT: The Gamma API's condition_id filter is unreliable — it returns
  // random legacy markets instead of the correct one. We MUST use the numeric
  // gamma_market_id with the /markets/{id} endpoint for reliable lookups.
  const gammaIdToBet = new Map<string, string[]>();
  for (const bet of openBets) {
    const gid = bet.markets?.gamma_market_id;
    if (gid) {
      if (!gammaIdToBet.has(gid)) gammaIdToBet.set(gid, []);
      gammaIdToBet.get(gid)!.push(bet.id);
    }
  }

  // Fetch current state from Gamma API — one request per unique market
  const gammaCache = new Map<string, GammaMarket>();

  const gammaIds = [...gammaIdToBet.keys()];
  // Batch in groups of 5 for parallel fetching within timeout
  for (let i = 0; i < gammaIds.length; i += 5) {
    const batch = gammaIds.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (gid) => {
        try {
          const res = await fetch(
            `https://gamma-api.polymarket.com/markets/${gid}`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (res.ok) {
            const data = await res.json();
            return { gid, data: data as GammaMarket };
          }
        } catch {
          // Network error — skip this market
        }
        return { gid, data: null };
      })
    );
    for (const { gid, data } of results) {
      if (data) gammaCache.set(gid, data);
    }
  }

  // Fetch v3_start_date — only v3 bets affect the bankroll.
  // Pre-v3 bets still resolve but their P&L is excluded from
  // bankroll updates to prevent contaminating the v3 fresh start.
  const { data: v3Row } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'v3_start_date')
    .single();
  const v3StartDate = v3Row?.value ? new Date(v3Row.value) : null;

  let resolved = 0;
  let totalPnl = 0;       // ALL resolved P&L (for logging)
  let v3Pnl = 0;          // Only v3 bets P&L (for bankroll updates)

  for (const bet of openBets) {
    const market = bet.markets;
    if (!market) continue;

    let winningOutcome: string | null = null;

    // Look up Gamma data by gamma_market_id (direct, reliable endpoint)
    const gammaId = market.gamma_market_id;
    if (!gammaId) {
      console.log(`[resolve-bets] Skip ${bet.id.substring(0, 8)} — no gamma_market_id (needs refresh-markets run)`);
      continue;
    }

    const gamma = gammaCache.get(gammaId) || null;
    if (!gamma) {
      console.log(`[resolve-bets] Skip ${bet.id.substring(0, 8)} — no Gamma data for gamma_market_id ${gammaId}`);
      continue;
    }

    // ── THE CRITICAL CHECK: resolvedBy !== null ──────────────────
    // This is the ONLY reliable way to know a Polymarket market has
    // officially settled. The UMA Optimistic Oracle flow is:
    //   1. Market closes (trading stops) → closed=true
    //   2. Anyone can propose an outcome → proposal pending
    //   3. 2-hour challenge window → anyone can dispute
    //   4. If unchallenged, oracle settles → resolvedBy = proposer address
    //
    // Previously we checked `gamma.closed` which fires at step 1,
    // but the actual outcome isn't known until step 4. This caused
    // 18/20 phantom wins where we locked in premature trading prices.
    if (!gamma.resolvedBy) {
      // Market not yet officially resolved by the oracle
      continue;
    }

    // Market is officially resolved — determine winner from final prices
    const prices = parseOutcomePrices(gamma.outcomePrices);
    const outcomes = parseOutcomes(gamma.outcomes);
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

    // After official resolution, prices should be 0/1 (or very close)
    // Require 0.95+ to handle any floating point edge cases
    if (prices.length === 0 || maxPrice < 0.95) {
      console.log(`[resolve-bets] Skip ${bet.id.substring(0, 8)} — resolvedBy set but maxPrice only ${maxPrice.toFixed(3)} (expected ~1.0)`);
      continue;
    }

    const winIdx = prices.indexOf(maxPrice);
    winningOutcome = outcomes[winIdx] || null;

    if (!winningOutcome) continue;

    // Validate entry_price — skip corrupt bets instead of silently defaulting
    const entryPrice = bet.entry_price;
    if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0 || entryPrice > 1) {
      console.log(`[resolve-bets] Skip ${bet.id.substring(0, 8)} — invalid entry_price ${entryPrice} (expected 0-1)`);
      continue;
    }

    // Safety check: if PnL would be > 50x bet amount, flag for manual review
    const projectedPnl = bet.amount_usd * ((1.0 / entryPrice) - 1);
    if (projectedPnl > bet.amount_usd * 50) {
      console.log(`[resolve-bets] SUSPICIOUSLY HIGH PnL: $${projectedPnl.toFixed(2)} on $${bet.amount_usd} bet (${(projectedPnl / bet.amount_usd).toFixed(0)}x) for ${bet.id.substring(0, 8)} — skipping for manual review`);
      continue;
    }

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

    // Resolve the bet — weather bets use outcome_label matching
    const betLabel = (bet.outcome_label || '').toLowerCase().trim();
    const winner = (winningOutcome || '').toLowerCase().trim();

    let betWon: boolean;
    if (bet.direction === 'BUY_NO') {
      // For BUY_NO: we win when our named outcome does NOT win
      // Exception: if outcome_label is literally "No", we win when "No" wins
      const isLiteralNo = betLabel === 'no';
      betWon = isLiteralNo ? winner === 'no' : winner !== betLabel;
    } else {
      // For BUY_YES: we win if our outcome matches the winner (case-insensitive)
      betWon = betLabel === winner;
    }

    const pnl = betWon
      ? Math.round(bet.amount_usd * ((1.0 / entryPrice) - 1) * 100) / 100
      : -bet.amount_usd;

    // Brier score = (predicted_prob - actual_outcome)^2
    // Lower is better: 0 = perfect, 1 = worst. Tracks calibration quality.
    const predictedProb = bet.direction === 'BUY_YES'
      ? (bet.entry_price ?? 0.5)
      : 1 - (bet.entry_price ?? 0.5);
    const actualOutcome = betWon ? 1.0 : 0.0;
    const brierScore = Math.pow(predictedProb - actualOutcome, 2);

    // Pull edge and confidence from the weather analysis
    let analysisEdge: number | null = null;
    let analysisConfidence: string | null = null;

    if (bet.analysis_id) {
      const { data: analysis } = await supabase
        .from('weather_analyses')
        .select('edge, confidence')
        .eq('id', bet.analysis_id)
        .single();
      if (analysis) {
        analysisEdge = analysis.edge;
        analysisConfidence = analysis.confidence;
      }
    }

    await supabase
      .from('bets')
      .update({
        status: betWon ? 'WON' : 'LOST',
        exit_price: betWon ? 1.0 : 0.0,
        pnl,
        resolved_at: new Date().toISOString(),
        notes: `V3 auto-resolved: resolvedBy=${gamma.resolvedBy.substring(0, 10)}... | winner="${winningOutcome}" | ${betWon ? 'WIN' : 'LOSS'}`,
        predicted_prob: predictedProb,
        brier_score: Math.round(brierScore * 10000) / 10000,
        edge: analysisEdge,
        confidence: analysisConfidence,
      })
      .eq('id', bet.id);

    resolved++;
    totalPnl += pnl;

    // Only count v3 bets toward bankroll updates
    const betPlacedAt = bet.placed_at ? new Date(bet.placed_at) : null;
    const isV3Bet = !v3StartDate || (betPlacedAt && betPlacedAt >= v3StartDate);
    if (isV3Bet) {
      v3Pnl += pnl;
    } else {
      console.log(`[resolve-bets] Pre-v3 bet ${bet.id.substring(0, 8)} resolved: $${pnl.toFixed(2)} — excluded from bankroll`);
    }

    // Record outcome for circuit breaker (tracks consecutive losses)
    const cbResult = await recordOutcome(supabase, betWon);
    const cbNote = cbResult.paused
      ? ` | CIRCUIT BREAKER: ${cbResult.consecutiveLosses} consecutive losses -> paused ${cbResult.pauseDuration}`
      : '';

    console.log(
      `[resolve-bets] ${betWon ? 'WON' : 'LOST'} bet ${bet.id.substring(0, 8)}: $${pnl.toFixed(2)} (entry=${entryPrice.toFixed(3)})${cbNote}`
    );
  }

  // Update stats if any resolved
  if (resolved > 0) {
    const { data: bankrollRow } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'paper_bankroll')
      .single();

    const bankroll = parseFloat(bankrollRow?.value || '1000');
    // Only apply v3 P&L to bankroll
    const newBankroll = Math.round((bankroll + v3Pnl) * 100) / 100;
    if (v3Pnl !== totalPnl) {
      console.log(`[resolve-bets] Bankroll update: $${v3Pnl.toFixed(2)} v3 P&L applied (${totalPnl.toFixed(2)} total, ${(totalPnl - v3Pnl).toFixed(2)} pre-v3 excluded)`);
    }

    await supabase
      .from('system_config')
      .update({ value: newBankroll.toString(), updated_at: new Date().toISOString() })
      .eq('key', 'paper_bankroll');

    // Win rate — v3 bets only
    let winsQuery = supabase.from('bets').select('*', { count: 'exact', head: true }).eq('status', 'WON');
    let totalQuery = supabase.from('bets').select('*', { count: 'exact', head: true }).in('status', ['WON', 'LOST']);
    if (v3StartDate) {
      winsQuery = winsQuery.gte('placed_at', v3StartDate.toISOString());
      totalQuery = totalQuery.gte('placed_at', v3StartDate.toISOString());
    }
    const { count: wins } = await winsQuery;
    const { count: total } = await totalQuery;

    const winRate = total && total > 0 ? Math.round(((wins || 0) / total) * 1000) / 10 : 0;

    await supabase
      .from('system_config')
      .update({ value: winRate.toString(), updated_at: new Date().toISOString() })
      .eq('key', 'paper_win_rate');

    // Performance snapshot — v3 bets only
    let pnlQuery = supabase.from('bets').select('pnl').in('status', ['WON', 'LOST']);
    if (v3StartDate) {
      pnlQuery = pnlQuery.gte('placed_at', v3StartDate.toISOString());
    }
    const { data: pnlRows } = await pnlQuery;

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
      `[resolve-bets] Updated bankroll $${bankroll} -> $${newBankroll}, win rate ${winRate}%`
    );
  }

  console.log(`[resolve-bets] Done. Resolved ${resolved} bets, PnL $${totalPnl.toFixed(2)}`);
  return { statusCode: 200 };
});

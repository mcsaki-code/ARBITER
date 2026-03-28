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

  // Fetch current state from Gamma API — store ALL results per condition_id
  const gammaCache = new Map<string, GammaMarket[]>();

  for (const cid of conditionIds) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?condition_id=${cid}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const data = await res.json();
        gammaCache.set(cid, Array.isArray(data) ? data : []);
      } else {
        gammaCache.set(cid, []);
      }
    } catch {
      gammaCache.set(cid, []);
    }
  }

  let resolved = 0;
  let totalPnl = 0;

  // Minimum hours after resolution_date before we auto-resolve
  // This gives Polymarket time to officially settle the market
  const MIN_HOURS_PAST_RESOLUTION = 4;

  for (const bet of openBets) {
    const market = bet.markets;
    if (!market) continue;

    const resolutionDate = market.resolution_date
      ? new Date(market.resolution_date)
      : null;
    const hoursPast = resolutionDate
      ? (Date.now() - resolutionDate.getTime()) / 3600000
      : 0;
    const isPast = resolutionDate && hoursPast > MIN_HOURS_PAST_RESOLUTION;

    let winningOutcome: string | null = null;

    // Find the matching Gamma market for this specific bet
    // Multi-bracket events return multiple sub-markets per condition_id
    // We must match by question text to avoid cross-contamination
    const gammaResults = gammaCache.get(market.condition_id) || [];
    let gamma: GammaMarket | null = null;

    if (gammaResults.length === 1) {
      // Single result — safe to use directly
      gamma = gammaResults[0];
    } else if (gammaResults.length > 1) {
      // Multiple results — match by question/description to our market
      const marketQ = (market.question || '').toLowerCase().trim();
      gamma = gammaResults.find((g) => {
        const gq = (g.question || g.description || '').toLowerCase().trim();
        return gq === marketQ || gq.includes(marketQ) || marketQ.includes(gq);
      }) || null;

      if (!gamma) {
        console.log(`[resolve-bets] Skip ${bet.id.substring(0, 8)} — ${gammaResults.length} Gamma results, none match question "${marketQ.substring(0, 50)}"`);
        continue;
      }
    }

    if (gamma) {
      const prices = parseOutcomePrices(gamma.outcomePrices);
      const outcomes = parseOutcomes(gamma.outcomes);
      const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

      // Require closed + very high confidence price (0.99+) for definitive resolution
      if (gamma.closed && prices.length > 0 && maxPrice >= 0.99) {
        const winIdx = prices.indexOf(maxPrice);
        winningOutcome = outcomes[winIdx] || null;
      } else if (gamma.closed && isPast && maxPrice >= 0.95) {
        // Lower threshold OK only if well past resolution date
        const winIdx = prices.indexOf(maxPrice);
        winningOutcome = outcomes[winIdx] || null;
      }

      // Cross-validate: Gamma winner should agree with DB price direction
      if (winningOutcome) {
        const dbPrices = market.outcome_prices || [];
        const dbOutcomes = market.outcomes || [];
        const dbWinIdx = dbOutcomes.indexOf(winningOutcome);
        if (dbWinIdx >= 0 && dbPrices[dbWinIdx] !== undefined) {
          const dbPrice = dbPrices[dbWinIdx];
          // If DB price contradicts Gamma (DB shows <10% but Gamma says winner), flag it
          if (dbPrice < 0.10 && maxPrice > 0.90) {
            console.log(`[resolve-bets] CONFLICT: Gamma says "${winningOutcome}" won (${maxPrice.toFixed(3)}) but DB price is ${dbPrice.toFixed(3)} for bet ${bet.id.substring(0, 8)} — skipping`);
            winningOutcome = null;
          }
        }
      }
    } else if (isPast) {
      // Fallback to DB prices — require very high confidence
      const dbPrices = market.outcome_prices || [];
      if (dbPrices.length > 0) {
        const maxP = Math.max(...dbPrices);
        if (maxP >= 0.95) {
          const winIdx = dbPrices.indexOf(maxP);
          winningOutcome = market.outcomes?.[winIdx] || null;
        }
      }
    }

    if (!winningOutcome) continue;

    // Safety check: if PnL would be > 50x bet amount, flag for manual review
    const entryPrice = bet.entry_price > 0 && bet.entry_price <= 1 ? bet.entry_price : 0.5;
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

    // Resolve the bet — handle BUY_NO logic correctly
    const betLabel = (bet.outcome_label || '').toLowerCase().trim();
    const winner = (winningOutcome || '').toLowerCase().trim();

    // Categories where outcome_label is descriptive text (not an outcome name).
    // For these, rely purely on direction: BUY_YES wins when "Yes" wins, BUY_NO when "No" wins.
    const DIRECTION_BASED_CATEGORIES = ['crypto_momentum', 'whale_copy', 'politics', 'arb'];
    const isDirectionBased = DIRECTION_BASED_CATEGORIES.includes(bet.category ?? '');

    let betWon: boolean;
    if (isDirectionBased) {
      // Use direction as ground truth
      betWon = bet.direction === 'BUY_YES' ? (winner === 'yes') : (winner === 'no');
    } else if (bet.direction === 'BUY_NO') {
      // For BUY_NO: we win when our named outcome does NOT win
      // Exception: if outcome_label is literally "No", we win when "No" wins
      const isLiteralNo = betLabel === 'no';
      betWon = isLiteralNo ? winner === 'no' : winner !== betLabel;
    } else {
      // For BUY_YES: we win if our outcome matches the winner
      betWon = betLabel === winner;
    }
    // entryPrice already computed above for safety check
    const pnl = betWon
      ? Math.round(bet.amount_usd * ((1.0 / entryPrice) - 1) * 100) / 100
      : -bet.amount_usd;

    // Brier score = (predicted_prob - actual_outcome)^2
    // Lower is better: 0 = perfect, 1 = worst. Tracks calibration quality over time.
    const predictedProb = bet.direction === 'BUY_YES'
      ? (bet.entry_price ?? 0.5)
      : 1 - (bet.entry_price ?? 0.5);
    const actualOutcome = betWon ? 1.0 : 0.0;
    const brierScore = Math.pow(predictedProb - actualOutcome, 2);

    await supabase
      .from('bets')
      .update({
        status: betWon ? 'WON' : 'LOST',
        exit_price: betWon ? 1.0 : 0.0,
        pnl,
        resolved_at: new Date().toISOString(),
        notes: `Auto-resolved: winner "${winningOutcome}" | ${betWon ? 'WIN' : 'LOSS'}`,
        predicted_prob: predictedProb,
        brier_score: Math.round(brierScore * 10000) / 10000,
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

    const bankroll = parseFloat(bankrollRow?.value || '5000');
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

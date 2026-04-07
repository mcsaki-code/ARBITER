import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { recordOutcome } from '@/lib/circuit-breaker';

export const dynamic = 'force-dynamic';

// ============================================================
// Bet Resolution Engine
// GET /api/resolve — checks all OPEN bets, resolves against market outcomes
// 1. Re-fetches market data from Polymarket Gamma API
// 2. Checks if market is resolved (closed + has resolution)
// 3. Updates bet status to WON/LOST with PnL calculation
// 4. Updates bankroll and performance stats
// ============================================================

interface GammaMarket {
  conditionId: string;
  question: string;
  outcomes: string;
  outcomePrices: string;
  active: boolean;
  closed: boolean;
  resolvedBy: string | null; // null until UMA oracle settles on-chain
}

async function fetchMarketFromGamma(conditionId: string): Promise<GammaMarket | null> {
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return data[0];
    return null;
  } catch {
    return null;
  }
}

function parseOutcomePrices(raw: string): number[] {
  try {
    return JSON.parse(raw).map((p: string) => parseFloat(p));
  } catch {
    return raw.split(',').map((s) => parseFloat(s.trim()));
  }
}

export async function GET() {
  const log: string[] = [];

  try {
    const supabase = getSupabaseAdmin();

    // Get all OPEN bets
    const { data: openBets, error: betsErr } = await supabase
      .from('bets')
      .select('*, markets(*)')
      .eq('status', 'OPEN');

    if (betsErr || !openBets) {
      log.push(`Error fetching open bets: ${betsErr?.message || 'no data'}`);
      return NextResponse.json({ success: false, log }, { status: 500 });
    }

    if (openBets.length === 0) {
      return NextResponse.json({
        success: true,
        resolved: 0,
        message: 'No open bets to resolve',
        log: ['No open bets found'],
      });
    }

    log.push(`Found ${openBets.length} open bets`);

    let resolved = 0;
    let won = 0;
    let lost = 0;
    let totalPnl = 0;

    // Group bets by market to avoid duplicate API calls
    const marketConditionIds = [
      ...new Set(openBets.map((b) => b.markets?.condition_id).filter(Boolean)),
    ] as string[];

    const marketResults = new Map<string, GammaMarket | null>();

    for (const conditionId of marketConditionIds) {
      const gamma = await fetchMarketFromGamma(conditionId);
      marketResults.set(conditionId, gamma);
    }

    for (const bet of openBets) {
      const market = bet.markets;
      if (!market) {
        log.push(`Bet ${bet.id.substring(0, 8)}: no linked market, skipping`);
        continue;
      }

      const gamma = marketResults.get(market.condition_id);

      // Check if market resolution date has passed
      const resolutionDate = market.resolution_date
        ? new Date(market.resolution_date)
        : null;
      const isPastResolution = resolutionDate && resolutionDate < new Date();

      // Determine if market is resolved
      let isResolved = false;
      let winningOutcomeIndex: number | null = null;

      if (gamma) {
        // ── CRITICAL FINALITY CHECK: resolvedBy must be populated ──
        // closed != resolved on Polymarket. A market can stop trading
        // (closed=true) while the UMA oracle challenge window is still
        // open, OR briefly flip closed=true around endDate with intraday
        // price pins. The only safe finality signal is `resolvedBy` —
        // the Ethereum address of the oracle proposer, populated only
        // after UMA settlement. On 2026-04-07, a Seattle weather bet was
        // prematurely resolved via the old closed+price branch when
        // intraday prices pinned to the wrong outcome; the market later
        // repriced and the bet actually lost. DO NOT re-introduce a
        // closed-only branch here.
        if (!gamma.resolvedBy) {
          // Not yet finalized on-chain — leave bet open
          const hoursLeft = resolutionDate
            ? Math.round((resolutionDate.getTime() - Date.now()) / 3600000)
            : '?';
          log.push(
            `Bet ${bet.id.substring(0, 8)}: resolvedBy not set (closed=${gamma.closed}, ${hoursLeft}h past endDate) — awaiting UMA finality`
          );
          continue;
        }

        const prices = parseOutcomePrices(gamma.outcomePrices);
        const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
        if (prices.length === 0 || maxPrice < 0.97) {
          log.push(
            `Bet ${bet.id.substring(0, 8)}: resolvedBy=${gamma.resolvedBy.substring(0, 10)}... but maxPrice ${maxPrice.toFixed(3)} < 0.97 — skipping as ambiguous`
          );
          continue;
        }

        isResolved = true;
        winningOutcomeIndex = prices.indexOf(maxPrice);
        log.push(
          `Market ${market.condition_id.substring(0, 12)}: RESOLVED via UMA oracle (resolvedBy=${gamma.resolvedBy.substring(0, 10)}..., winner idx=${winningOutcomeIndex}, price=${maxPrice.toFixed(3)})`
        );
      } else {
        // Gamma unreachable — do NOT fall back to DB prices. DB prices
        // are refreshed from Gamma and can be stale/intraday. Wait for
        // Gamma to recover; the V3 resolver will also catch this bet.
        log.push(
          `Bet ${bet.id.substring(0, 8)}: Gamma unreachable — skipping (V3 resolver will retry)`
        );
      }

      if (!isResolved) {
        const hoursLeft = resolutionDate
          ? Math.round(
              (resolutionDate.getTime() - Date.now()) / 3600000
            )
          : '?';
        log.push(
          `Bet ${bet.id.substring(0, 8)}: market not yet resolved (${hoursLeft}h remaining)`
        );
        continue;
      }

      // Update market as resolved in DB
      const winningOutcome =
        winningOutcomeIndex !== null
          ? market.outcomes?.[winningOutcomeIndex] || null
          : null;

      await supabase
        .from('markets')
        .update({
          is_active: false,
          is_resolved: true,
          resolution_val: winningOutcome,
          updated_at: new Date().toISOString(),
        })
        .eq('id', market.id);

      // Determine if this bet won or lost
      // Case-insensitive comparison for safety
      const betLabel = (bet.outcome_label || '').toLowerCase().trim();
      const winner = (winningOutcome || '').toLowerCase().trim();

      let betWon: boolean;
      if (bet.direction === 'BUY_NO') {
        // For BUY_NO bets:
        // If outcome_label is "No"/"no" → we win when "No" wins (labelMatch = true → won)
        // If outcome_label is a specific outcome (e.g., "Team A") → we bet AGAINST it,
        //   so we win when that outcome does NOT win (labelMatch = false → won)
        const isLiteralNo = betLabel === 'no';
        betWon = isLiteralNo ? winner === 'no' : winner !== betLabel;
      } else {
        // For BUY_YES: we win if our outcome matches the winner
        betWon = betLabel === winner;
      }

      // Calculate PnL
      // If we bought YES at entry_price and won: payout = amount / entry_price, pnl = payout - amount
      // If we lost: pnl = -amount
      let pnl: number;
      let exitPrice: number;
      const entryPrice = bet.entry_price > 0 && bet.entry_price <= 1 ? bet.entry_price : 0.5;

      if (betWon) {
        exitPrice = 1.0; // Won = shares worth $1 each
        pnl = bet.amount_usd * ((1.0 / entryPrice) - 1);
      } else {
        exitPrice = 0.0; // Lost = shares worth $0
        pnl = -bet.amount_usd;
      }

      // Round PnL
      pnl = Math.round(pnl * 100) / 100;

      // Pull edge, confidence, and TRUE_PROB from the weather analysis.
      // CRITICAL: predicted_prob must be our model's true_prob, not entry_price.
      // Without this, Brier scoring measures market calibration instead of ours
      // and the learning agent gets garbage signal.
      let analysisEdge: number | null = null;
      let analysisConfidence: string | null = null;
      let analysisTrueProb: number | null = null;
      if (bet.analysis_id) {
        const { data: analysis } = await supabase
          .from('weather_analyses')
          .select('edge, confidence, true_prob')
          .eq('id', bet.analysis_id)
          .single();
        if (analysis) {
          analysisEdge = analysis.edge;
          analysisConfidence = analysis.confidence;
          analysisTrueProb = analysis.true_prob;
        }
      }

      const ourYesProb = analysisTrueProb != null && analysisTrueProb > 0 && analysisTrueProb < 1
        ? analysisTrueProb
        : (bet.entry_price ?? 0.5);
      const predictedProb = bet.direction === 'BUY_YES' ? ourYesProb : 1 - ourYesProb;
      const actualOutcome = betWon ? 1.0 : 0.0;
      const brierScore = Math.pow(predictedProb - actualOutcome, 2);

      // Update bet
      const { error: updateErr } = await supabase
        .from('bets')
        .update({
          status: betWon ? 'WON' : 'LOST',
          exit_price: exitPrice,
          pnl,
          resolved_at: new Date().toISOString(),
          notes: `Resolved (api/resolve): winning outcome "${winningOutcome}" | Bet on "${bet.outcome_label}" | ${betWon ? 'WIN' : 'LOSS'}`,
          predicted_prob: predictedProb,
          brier_score: Math.round(brierScore * 10000) / 10000,
          edge: analysisEdge,
          confidence: analysisConfidence,
        })
        .eq('id', bet.id);

      if (updateErr) {
        log.push(`Error updating bet ${bet.id.substring(0, 8)}: ${updateErr.message}`);
        continue;
      }

      // Keep circuit-breaker streak counter in sync (V3 path also calls this)
      try {
        await recordOutcome(supabase, betWon);
      } catch (e) {
        log.push(`Bet ${bet.id.substring(0, 8)}: recordOutcome failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      resolved++;
      if (betWon) won++;
      else lost++;
      totalPnl += pnl;

      log.push(
        `Bet ${bet.id.substring(0, 8)}: ${betWon ? 'WON' : 'LOST'} | PnL: $${pnl.toFixed(2)} | Bet "${bet.outcome_label}" vs winner "${winningOutcome}"`
      );
    }

    // Update bankroll and stats if any bets resolved
    if (resolved > 0) {
      // Update paper bankroll
      const { data: bankrollConfig } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', 'paper_bankroll')
        .single();

      const currentBankroll = parseFloat(bankrollConfig?.value || '500');
      const newBankroll = Math.round((currentBankroll + totalPnl) * 100) / 100;

      await supabase
        .from('system_config')
        .update({
          value: newBankroll.toString(),
          updated_at: new Date().toISOString(),
        })
        .eq('key', 'paper_bankroll');

      // Calculate overall win rate
      const { count: totalWins } = await supabase
        .from('bets')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'WON');

      const { count: totalResolved } = await supabase
        .from('bets')
        .select('*', { count: 'exact', head: true })
        .in('status', ['WON', 'LOST']);

      const winRate =
        totalResolved && totalResolved > 0
          ? Math.round(((totalWins || 0) / totalResolved) * 1000) / 10
          : 0;

      await supabase
        .from('system_config')
        .update({
          value: winRate.toString(),
          updated_at: new Date().toISOString(),
        })
        .eq('key', 'paper_win_rate');

      log.push(
        `Stats updated: bankroll $${currentBankroll} → $${newBankroll}, win rate ${winRate}%`
      );

      // Insert performance snapshot
      const { count: allWins } = await supabase
        .from('bets')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'WON');

      const { count: allLosses } = await supabase
        .from('bets')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'LOST');

      const { data: allBetsPnl } = await supabase
        .from('bets')
        .select('pnl')
        .in('status', ['WON', 'LOST']);

      const cumulativePnl = allBetsPnl?.reduce((sum, b) => sum + (b.pnl || 0), 0) || 0;

      await supabase.from('performance_snapshots').insert({
        total_bets: (totalResolved || 0),
        wins: allWins || 0,
        losses: allLosses || 0,
        win_rate: winRate,
        total_pnl: Math.round(cumulativePnl * 100) / 100,
        paper_bankroll: newBankroll,
      });
    }

    log.push(`Done. Resolved ${resolved} bets: ${won} won, ${lost} lost, PnL $${totalPnl.toFixed(2)}`);

    return NextResponse.json({
      success: true,
      resolved,
      won,
      lost,
      totalPnl: Math.round(totalPnl * 100) / 100,
      log,
    });
  } catch (err) {
    log.push(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { success: false, log, error: String(err) },
      { status: 500 }
    );
  }
}

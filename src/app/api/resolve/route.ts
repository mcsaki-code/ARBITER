import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

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
  resolvedBy: string;
  // Gamma returns resolution as the winning outcome index or resolved price array
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
        // Check Gamma API: if closed and prices show clear winner (one at ~1.0)
        const prices = parseOutcomePrices(gamma.outcomePrices);
        const maxPrice = Math.max(...prices);

        if (gamma.closed && maxPrice >= 0.95) {
          isResolved = true;
          winningOutcomeIndex = prices.indexOf(maxPrice);
          log.push(
            `Market ${market.condition_id.substring(0, 12)}: RESOLVED via Gamma (winner idx=${winningOutcomeIndex}, price=${maxPrice.toFixed(2)})`
          );
        } else if (gamma.closed && isPastResolution) {
          // Market closed + past resolution but no clear winner in prices
          // Check if all prices are near 0 (voided) or still ambiguous
          isResolved = true;
          winningOutcomeIndex = prices.indexOf(maxPrice);
          log.push(
            `Market ${market.condition_id.substring(0, 12)}: RESOLVED (closed + past resolution date)`
          );
        }
      } else if (isPastResolution) {
        // Can't reach Gamma but past resolution — check DB market prices
        const dbPrices = market.outcome_prices || [];
        const maxDbPrice = Math.max(...dbPrices);
        if (maxDbPrice >= 0.90) {
          isResolved = true;
          winningOutcomeIndex = dbPrices.indexOf(maxDbPrice);
          log.push(
            `Market ${market.condition_id.substring(0, 12)}: RESOLVED via DB prices (past resolution)`
          );
        }
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
      // bet.outcome_label is what we bet on, winningOutcome is what actually won
      const betWon = bet.outcome_label === winningOutcome;

      // Calculate PnL
      // If we bought YES at entry_price and won: payout = amount / entry_price, pnl = payout - amount
      // If we lost: pnl = -amount
      let pnl: number;
      let exitPrice: number;

      if (betWon) {
        exitPrice = 1.0; // Won = shares worth $1 each
        pnl = bet.amount_usd * ((1.0 / bet.entry_price) - 1);
      } else {
        exitPrice = 0.0; // Lost = shares worth $0
        pnl = -bet.amount_usd;
      }

      // Round PnL
      pnl = Math.round(pnl * 100) / 100;

      // Update bet
      const { error: updateErr } = await supabase
        .from('bets')
        .update({
          status: betWon ? 'WON' : 'LOST',
          exit_price: exitPrice,
          pnl,
          resolved_at: new Date().toISOString(),
          notes: `Resolved: winning outcome "${winningOutcome}" | Bet on "${bet.outcome_label}" | ${betWon ? 'WIN' : 'LOSS'}`,
        })
        .eq('id', bet.id);

      if (updateErr) {
        log.push(`Error updating bet ${bet.id.substring(0, 8)}: ${updateErr.message}`);
        continue;
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

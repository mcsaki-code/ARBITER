import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ============================================================
// Manual Bet Placement Trigger
// GET /api/trigger/bets — scans recent analyses and places paper bets
// Mirrors place-bets.ts scheduled function but runs on-demand
// ============================================================

const MAX_SINGLE_BET_PCT = 0.05;
const MAX_DAILY_EXPOSURE_PCT = 0.25;
const MAX_DAILY_BETS = 20;
const MIN_EDGE = 0.05;

export async function GET() {
  const supabase = getSupabaseAdmin();
  const log: string[] = [];

  try {
    // Load config
    const { data: configRows } = await supabase
      .from('system_config')
      .select('key, value')
      .in('key', ['paper_bankroll', 'paper_trade_start_date', 'total_paper_bets']);

    const config: Record<string, string> = {};
    configRows?.forEach((r) => { config[r.key] = r.value; });

    const bankroll = parseFloat(config.paper_bankroll || '500');
    const maxSingleBet = bankroll * MAX_SINGLE_BET_PCT;
    const maxDailyExposure = bankroll * MAX_DAILY_EXPOSURE_PCT;

    // Today's bets
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: todaysBets } = await supabase
      .from('bets')
      .select('id, amount_usd, market_id')
      .gte('placed_at', todayStart.toISOString());

    const todayBetCount = todaysBets?.length || 0;
    const todayExposure = todaysBets?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;

    log.push(`Bankroll: $${bankroll} | Today: ${todayBetCount} bets, $${todayExposure.toFixed(2)} deployed`);

    if (todayBetCount >= MAX_DAILY_BETS) {
      log.push('Daily bet limit reached');
      return NextResponse.json({ success: true, placed: 0, log });
    }

    // Get all open bet market IDs
    const { data: openBets } = await supabase
      .from('bets')
      .select('market_id')
      .eq('status', 'OPEN');
    const openMarketIds = new Set(openBets?.map((b) => b.market_id) || []);

    // Collect analyses from last 6 hours (wider window for manual trigger)
    const cutoff = new Date(Date.now() - 6 * 3600000).toISOString();

    // Weather analyses
    const { data: weatherAnalyses } = await supabase
      .from('weather_analyses')
      .select('*')
      .gte('analyzed_at', cutoff)
      .neq('direction', 'PASS')
      .gt('edge', MIN_EDGE)
      .order('edge', { ascending: false });

    // Sports analyses
    const { data: sportsAnalyses } = await supabase
      .from('sports_analyses')
      .select('*')
      .gte('analyzed_at', cutoff)
      .neq('direction', 'PASS')
      .gt('edge', MIN_EDGE)
      .order('edge', { ascending: false });

    // Crypto analyses
    const { data: cryptoAnalyses } = await supabase
      .from('crypto_analyses')
      .select('*')
      .gte('analyzed_at', cutoff)
      .neq('direction', 'PASS')
      .gt('edge', MIN_EDGE)
      .order('edge', { ascending: false });

    interface AnalysisCandidate {
      id: string;
      market_id: string;
      direction: string;
      confidence: string;
      edge: number | null;
      kelly_fraction: number | null;
      rec_bet_usd: number | null;
      auto_eligible: boolean;
      category: string;
      // Various label fields
      best_outcome_label?: string | null;
      market_price?: number | null;
      event_description?: string | null;
      polymarket_price?: number | null;
      target_bracket?: string | null;
      asset?: string | null;
    }

    const candidates: AnalysisCandidate[] = [
      ...(weatherAnalyses || []).map((a) => ({ ...a, category: 'weather' })),
      ...(sportsAnalyses || []).map((a) => ({ ...a, category: 'sports' })),
      ...(cryptoAnalyses || []).map((a) => ({ ...a, category: 'crypto' })),
    ];

    candidates.sort((a, b) => (b.edge || 0) - (a.edge || 0));

    log.push(`Candidates: ${weatherAnalyses?.length || 0} weather, ${sportsAnalyses?.length || 0} sports, ${cryptoAnalyses?.length || 0} crypto`);

    let placed = 0;
    let totalDeployed = todayExposure;

    for (const analysis of candidates) {
      if (placed + todayBetCount >= MAX_DAILY_BETS) break;
      if (totalDeployed >= maxDailyExposure) break;

      // Skip duplicate positions
      if (openMarketIds.has(analysis.market_id)) continue;

      // Must have at least MEDIUM confidence
      const isMediumEligible =
        (analysis.confidence === 'HIGH' || analysis.confidence === 'MEDIUM') &&
        (analysis.edge || 0) >= MIN_EDGE;

      if (!analysis.auto_eligible && !isMediumEligible) continue;

      // Calculate bet size
      let betAmount = analysis.rec_bet_usd || 0;
      if (betAmount <= 0 && analysis.kelly_fraction && analysis.kelly_fraction > 0) {
        betAmount = Math.max(1, Math.round(bankroll * analysis.kelly_fraction * 100) / 100);
      }
      if (betAmount <= 0) betAmount = 1;
      betAmount = Math.min(betAmount, maxSingleBet, maxDailyExposure - totalDeployed);
      if (betAmount < 1) break;

      // Determine outcome label and entry price
      let outcomeLabel: string | null = null;
      let entryPrice: number | null = null;

      if (analysis.category === 'weather') {
        outcomeLabel = analysis.best_outcome_label || null;
        entryPrice = analysis.market_price || null;
      } else if (analysis.category === 'sports') {
        outcomeLabel = analysis.event_description || null;
        entryPrice = analysis.polymarket_price || analysis.market_price || null;
      } else if (analysis.category === 'crypto') {
        outcomeLabel = analysis.target_bracket || analysis.asset || null;
        entryPrice = analysis.market_price || null;
      }

      if (!entryPrice || entryPrice <= 0 || entryPrice >= 1) continue;

      const { error } = await supabase.from('bets').insert({
        market_id: analysis.market_id,
        analysis_id: analysis.id,
        category: analysis.category,
        direction: analysis.direction,
        outcome_label: outcomeLabel,
        entry_price: entryPrice,
        amount_usd: betAmount,
        is_paper: true,
        status: 'OPEN',
      });

      if (error) {
        log.push(`Error placing ${analysis.category} bet: ${error.message}`);
        continue;
      }

      placed++;
      totalDeployed += betAmount;
      openMarketIds.add(analysis.market_id);
      log.push(`Placed ${analysis.category} $${betAmount.toFixed(2)} @ ${entryPrice.toFixed(3)} | edge=${(analysis.edge || 0).toFixed(3)} ${analysis.confidence}`);
    }

    // Update paper_trade_start_date on first ever bet
    if (placed > 0 && !config.paper_trade_start_date) {
      await supabase
        .from('system_config')
        .update({ value: new Date().toISOString().split('T')[0], updated_at: new Date().toISOString() })
        .eq('key', 'paper_trade_start_date');
      log.push('Started paper trading clock');
    }

    // Update total bet count
    if (placed > 0) {
      const { count } = await supabase
        .from('bets')
        .select('*', { count: 'exact', head: true });
      await supabase
        .from('system_config')
        .update({ value: (count || 0).toString(), updated_at: new Date().toISOString() })
        .eq('key', 'total_paper_bets');
    }

    return NextResponse.json({
      success: true,
      placed,
      totalDeployed: totalDeployed.toFixed(2),
      candidates: candidates.length,
      log,
    });
  } catch (err) {
    log.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, placed: 0, log }, { status: 500 });
  }
}

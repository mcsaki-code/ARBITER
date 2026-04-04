import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { executeBet } from '@/lib/execute-bet';
import { getMultiModelConsensus, isMultiModelEnabled } from '@/lib/multi-model';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for analysis + placement

// ============================================================
// Full Pipeline: Analyze + Place Bets (Manual Trigger)
// GET /api/trigger/bets
//
// This is the COMPLETE pipeline that:
// 1. Checks for existing analyses (last 6 hours)
// 2. If none exist, runs inline Claude analysis on best markets
// 3. Places paper bets from all eligible analyses
//
// This fixes the race condition where market discovery runs but
// no analyses exist yet because the cron hasn't fired.
// ============================================================

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_SINGLE_BET_PCT = 0.03;     // 3% max per bet (down from 5%)
const MAX_DAILY_EXPOSURE_PCT = 0.20;  // 20% max daily (down from 25%)
// No daily bet COUNT cap — risk filters (edge, entry price, kelly, circuit breaker)
// do the gatekeeping. The exposure cap prevents overextending.
const MIN_EDGE = 0.05;               // 5% minimum edge (up from 2% — the #1 fix)
const MIN_EDGE_WEATHER = 0.08;       // 8% for weather (matching successful bots)
const MIN_LIQUIDITY = 5000;          // Skip thin markets
const MAX_ANALYSIS_AGE_MS = 2 * 3600000; // 2 hours max staleness (down from 6)
const KELLY_FRACTION = 0.125;        // 1/8th Kelly (half Kelly is aggressive, 1/8 is professional)

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
  best_outcome_label?: string | null;
  market_price?: number | null;
  event_description?: string | null;
  polymarket_price?: number | null;
  target_bracket?: string | null;
  asset?: string | null;
}

export async function GET() {
  const supabase = getSupabaseAdmin();
  const log: string[] = [];
  const startTime = Date.now();

  try {
    // ============================================================
    // STEP 0: Load system config
    // ============================================================
    const { data: configRows } = await supabase
      .from('system_config')
      .select('key, value')
      .in('key', ['paper_bankroll', 'paper_trade_start_date', 'total_paper_bets', 'paper_win_rate', 'live_trading_enabled', 'live_kill_switch', 'live_max_single_bet_usd', 'live_max_daily_usd', 'v3_start_date']);

    const config: Record<string, string> = {};
    configRows?.forEach((r) => { config[r.key] = r.value; });

    const bankroll = parseFloat(config.paper_bankroll || '5000');
    const maxSingleBet = bankroll * MAX_SINGLE_BET_PCT;
    const maxDailyExposure = bankroll * MAX_DAILY_EXPOSURE_PCT;

    // Today's existing bets — use v3_start_date as floor so pre-v3 bets
    // don't count against today's limits (only matters on day 1 of v3)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const v3Start = config.v3_start_date ? new Date(config.v3_start_date) : null;
    const effectiveTodayStart = v3Start && v3Start > todayStart ? v3Start : todayStart;

    const { data: todaysBets } = await supabase
      .from('bets')
      .select('id, amount_usd, market_id')
      .gte('placed_at', effectiveTodayStart.toISOString());

    const todayBetCount = todaysBets?.length || 0;
    const todayExposure = todaysBets?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;

    log.push(`Bankroll: $${bankroll} | Today: ${todayBetCount} bets, $${todayExposure.toFixed(2)} deployed`);

    // All open bet market IDs (prevent duplicates)
    const { data: openBets } = await supabase
      .from('bets')
      .select('market_id')
      .eq('status', 'OPEN');
    const openMarketIds = new Set(openBets?.map((b) => b.market_id) || []);

    // ============================================================
    // STEP 1: Check for existing analyses (last 6 hours)
    // ============================================================
    const cutoff = new Date(Date.now() - MAX_ANALYSIS_AGE_MS).toISOString();

    const weatherRes = await supabase.from('weather_analyses').select('*').gte('analyzed_at', cutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE_WEATHER).order('edge', { ascending: false });

    // Deduplicate: keep only the latest analysis per market_id.
    // The analyze cron writes a new row every cycle (~6 min), so a 2h window
    // can produce 20+ rows for ONE market, crowding out other markets entirely.
    function dedup(rows: AnalysisCandidate[]): AnalysisCandidate[] {
      const seen = new Map<string, AnalysisCandidate>();
      for (const row of rows) {
        const existing = seen.get(row.market_id);
        if (!existing || row.id > existing.id) {
          seen.set(row.market_id, row);
        }
      }
      return Array.from(seen.values());
    }

    let candidates: AnalysisCandidate[] = dedup([
      ...(weatherRes.data || []).map((a) => ({ ...a, category: 'weather' as const })),
    ]);

    log.push(`Existing analyses (weather-only): ${weatherRes.data?.length || 0} weather (${candidates.length} unique markets after dedup)`);

    // ============================================================
    // STEP 2: If no analyses exist, run inline weather analysis only
    // This is the KEY FIX — instead of waiting for cron, we analyze now
    // ============================================================
    if (candidates.length === 0 && process.env.ANTHROPIC_API_KEY) {
      log.push('No existing analyses — running inline weather analysis...');

      // Try weather markets
      if (Date.now() - startTime < 50000) {
        const { data: weatherMarkets } = await supabase
          .from('markets')
          .select('*, weather_cities(*)')
          .eq('is_active', true)
          .not('city_id', 'is', null)
          .order('volume_usd', { ascending: false })
          .limit(5);

        if (weatherMarkets && weatherMarkets.length > 0) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowStr = tomorrow.toISOString().split('T')[0];

          for (const market of weatherMarkets.slice(0, 2)) {
            if (Date.now() - startTime > 55000) break;
            const city = market.weather_cities;
            if (!city) continue;

            const { data: consensusArr } = await supabase
              .from('weather_consensus')
              .select('*')
              .eq('city_id', city.id)
              .eq('valid_date', tomorrowStr)
              .order('calculated_at', { ascending: false })
              .limit(1);

            const consensus = consensusArr?.[0];
            if (!consensus || consensus.agreement === 'LOW') continue;

            const newWeatherAnalyses = await runInlineWeatherAnalysis(
              supabase, market, city, consensus, bankroll, log
            );
            candidates.push(...newWeatherAnalyses);
          }
        }
      }

      log.push(`Inline weather analysis produced ${candidates.length} candidates`);
    }

    // ============================================================
    // STEP 3: Place bets from all candidates
    // ============================================================
    candidates.sort((a, b) => (b.edge || 0) - (a.edge || 0));

    let placed = 0;
    let totalDeployed = todayExposure;

    for (const analysis of candidates) {
      if (totalDeployed >= maxDailyExposure) break;
      if (Date.now() - startTime > 55000) break;

      // Skip duplicate positions
      if (openMarketIds.has(analysis.market_id)) {
        log.push(`Skip ${analysis.market_id.substring(0, 8)} — already open`);
        continue;
      }

      // Must have at least MEDIUM confidence
      const isMediumEligible =
        (analysis.confidence === 'HIGH' || analysis.confidence === 'MEDIUM') &&
        (analysis.edge || 0) >= MIN_EDGE;

      if (!analysis.auto_eligible && !isMediumEligible) continue;

      // Calculate bet size using fractional Kelly
      // Professional bettors use 1/8th Kelly or less when probability estimates are uncertain
      let betAmount = 0;
      if (analysis.kelly_fraction && analysis.kelly_fraction > 0) {
        // Re-calculate with our conservative KELLY_FRACTION (1/8th)
        const confMult = analysis.confidence === 'HIGH' ? 0.8 : analysis.confidence === 'MEDIUM' ? 0.5 : 0.2;
        const adjustedKelly = Math.min(analysis.kelly_fraction * KELLY_FRACTION / 0.25 * confMult, 0.03);
        betAmount = Math.max(1, Math.round(bankroll * adjustedKelly * 100) / 100);
      }
      if (betAmount <= 0) betAmount = Math.min(3, bankroll * 0.006); // Default ~$3 for paper (0.6% of bankroll)
      betAmount = Math.min(betAmount, maxSingleBet, maxDailyExposure - totalDeployed);
      if (betAmount < 1) break;

      // Fetch current market data for validation and question text
      const { data: currentMarket } = await supabase
        .from('markets')
        .select('question, liquidity_usd, is_active, outcome_prices, resolution_date')
        .eq('id', analysis.market_id)
        .single();

      // Pre-bet validation: market must still be active with enough liquidity
      if (!currentMarket || !currentMarket.is_active) {
        log.push(`Skip ${analysis.market_id.substring(0, 8)} — market no longer active`);
        continue;
      }

      // Weather temperature markets have $400-$2K liquidity — allow a lower floor
      const liquidityFloor = analysis.category === 'weather' ? 400 : MIN_LIQUIDITY;
      if (currentMarket.liquidity_usd < liquidityFloor) {
        log.push(`Skip ${analysis.market_id.substring(0, 8)} — liquidity $${currentMarket.liquidity_usd} < $${liquidityFloor}`);
        continue;
      }

      // Check time remaining — don't bet on markets resolving within 1 hour
      if (currentMarket.resolution_date) {
        const hoursLeft = (new Date(currentMarket.resolution_date).getTime() - Date.now()) / 3600000;
        if (hoursLeft < 1) {
          log.push(`Skip ${analysis.market_id.substring(0, 8)} — resolves in ${hoursLeft.toFixed(1)}h`);
          continue;
        }
      }

      // Estimate spread based on liquidity (thinner markets = wider spread = need more edge)
      const estimatedSpread = currentMarket.liquidity_usd > 50000 ? 0.005 :
        currentMarket.liquidity_usd > 20000 ? 0.01 :
        currentMarket.liquidity_usd > 10000 ? 0.015 : 0.025;

      // Edge must be at least 2x the estimated spread to be profitable after friction
      if ((analysis.edge || 0) < estimatedSpread * 2) {
        log.push(`Skip ${analysis.market_id.substring(0, 8)} — edge ${((analysis.edge || 0) * 100).toFixed(1)}% < 2x spread ${(estimatedSpread * 200).toFixed(1)}%`);
        continue;
      }

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

      // Normalize entry price — handle percentages (e.g., 90 → 0.90)
      if (entryPrice && entryPrice > 1) {
        entryPrice = entryPrice / 100;
      }

      // For BUY_NO bets, market_price = YES price. Our cost = 1 - YES price.
      // Always flip for BUY_NO (old code only flipped when < 0.5, blocking most NO bets)
      if (analysis.direction === 'BUY_NO' && entryPrice !== null) {
        entryPrice = 1 - entryPrice;
      }

      // Validate entry price: floor at 2%, cap at 40% (matching place-bets.ts risk rules)
      // ALL historical bets with entry > 40% have lost; low-entry tail bets are where the edge is
      const MIN_ENTRY_PRICE = 0.02;
      const MAX_ENTRY_PRICE = 0.40;
      if (!entryPrice || entryPrice < MIN_ENTRY_PRICE || entryPrice >= 0.997) {
        log.push(`Skip ${analysis.market_id.substring(0, 8)} — price ${entryPrice?.toFixed(4)} below ${MIN_ENTRY_PRICE} floor`);
        continue;
      }
      if (entryPrice > MAX_ENTRY_PRICE) {
        log.push(`Skip ${analysis.market_id.substring(0, 8)} — price ${entryPrice.toFixed(4)} exceeds ${MAX_ENTRY_PRICE} cap`);
        continue;
      }

      // Execute bet through the paper/live bridge
      const analysisId = analysis.category === 'weather' ? analysis.id : null;

      const execResult = await executeBet(
        supabase,
        {
          market_id: analysis.market_id,
          analysis_id: analysisId,
          category: analysis.category,
          direction: analysis.direction,
          outcome_label: outcomeLabel,
          entry_price: entryPrice,
          amount_usd: betAmount,
        },
        config,
        0, // todayLiveExposure
        log
      );

      if (!execResult.success && !execResult.bet_id) {
        log.push(`Error: ${execResult.error}`);
        continue;
      }

      if (!execResult.is_paper) {
        log.push(`LIVE ORDER: ${execResult.clob_order_id} status=${execResult.order_status}`);
      }

      placed++;
      totalDeployed += betAmount;
      openMarketIds.add(analysis.market_id);
      log.push(`BET: ${analysis.category} ${analysis.direction} $${betAmount.toFixed(2)} @ ${entryPrice.toFixed(3)} | edge=${((analysis.edge || 0) * 100).toFixed(1)}% ${analysis.confidence}`);
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

    const elapsed = Date.now() - startTime;
    log.push(`Done in ${elapsed}ms — placed ${placed} bets, $${totalDeployed.toFixed(2)} total deployed`);

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

// ============================================================
// Inline Analysis Functions
// These replicate the scheduled function logic but run on-demand
// ============================================================

async function runInlineWeatherAnalysis(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  market: { id: string; question: string; outcomes: string[]; outcome_prices: number[]; volume_usd: number; liquidity_usd: number; resolution_date: string | null },
  city: { id: string; name: string },
  consensus: { id: string; consensus_high_f: number; model_spread_f: number; agreement: string },
  bankroll: number,
  log: string[]
): Promise<AnalysisCandidate[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  try {
    const outcomesList = market.outcomes
      .map((o: string, i: number) => `${o} → $${(market.outcome_prices[i] || 0).toFixed(3)}`)
      .join('\n');

    const prompt = `You are ARBITER's weather analyst. Compare forecast consensus to Polymarket brackets.

CITY: ${city.name}
CONSENSUS HIGH: ${consensus.consensus_high_f}°F (spread: ${consensus.model_spread_f}°F, agreement: ${consensus.agreement})

POLYMARKET BRACKETS:
${outcomesList}

TASK: Identify the bracket the consensus falls in, estimate true probability, and find edge.

Respond ONLY in JSON:
{
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number (0-1),
    "true_prob": number (0-1),
    "edge": number,
    "direction": "BUY_YES"|"BUY_NO"|"PASS",
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "reasoning": string
  },
  "auto_eligible": boolean
}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const text = data.content?.[0]?.text;
    if (!text) return [];

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const analysis = JSON.parse(jsonMatch[0]);
    const bet = analysis.best_bet;
    if (!bet || bet.direction === 'PASS' || !bet.edge || bet.edge < MIN_EDGE) return [];

    const p = bet.true_prob || 0.5;
    const c = bet.market_price || 0.5;
    let kellyFraction = 0;
    let recBetUsd = 0;

    if (c > 0 && c < 1) {
      const b = (1 - c) / c;
      const fullKelly = (p * b - (1 - p)) / b;
      if (fullKelly > 0) {
        const confMult = { HIGH: 0.8, MEDIUM: 0.5, LOW: 0.2 }[bet.confidence as string] || 0.2;
        kellyFraction = Math.min(fullKelly * KELLY_FRACTION * confMult, 0.03);
        recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
      }
    }

    const { data: inserted, error } = await supabase
      .from('weather_analyses')
      .insert({
        market_id: market.id,
        city_id: city.id,
        consensus_id: consensus.id,
        model_high_f: consensus.consensus_high_f,
        model_spread_f: consensus.model_spread_f,
        model_agreement: consensus.agreement,
        best_outcome_idx: bet.outcome_index ?? null,
        best_outcome_label: bet.outcome_label ?? null,
        market_price: bet.market_price ?? null,
        true_prob: bet.true_prob ?? null,
        edge: bet.edge ?? null,
        direction: bet.direction,
        confidence: bet.confidence || 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: bet.reasoning || '',
        auto_eligible: analysis.auto_eligible || false,
        flags: [],
        analyzed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      log.push(`Weather DB error: ${error.message}`);
      return [];
    }

    if (inserted) {
      log.push(`Analyzed weather: ${city.name} edge=${(bet.edge * 100).toFixed(1)}%`);
      return [{ ...inserted, category: 'weather' }];
    }
  } catch (err) {
    log.push(`Weather analysis error: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  return [];
}

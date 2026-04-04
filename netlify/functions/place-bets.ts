// ============================================================
// Netlify Scheduled Function: Place Bets (V3 — Weather Only)
// Runs every 15 minutes — takes weather analyses and creates
// paper bets in the bets table.
//
// V3 REBUILD: Stripped to weather-only. Incorporates whale
// strategy insights from gopfan2 ($2M+ profit):
//   - Focus on tail bets: entry <15¢ with massive asymmetric upside
//   - Optimal entry window: 24-48h before resolution
//   - Temperature ladder strategy: adjacent bracket coverage
//   - Fractional Kelly (1/8th) with confidence scaling
//   - Min $400 liquidity (weather brackets are naturally thin)
//
// Pipeline: analyze-weather → place-bets → resolve-bets → P&L
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { executeBet } from '../../src/lib/execute-bet';
import { notifyBetPlaced } from '../../src/lib/notify';
import { shouldTrade } from '../../src/lib/circuit-breaker';
import { getOrderbookDepth, computeSpread, estimateSlippage } from '../../src/lib/ws-price-feed';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Risk limits — calibrated for weather bracket markets
const MAX_SINGLE_BET_PCT = 0.03;       // 3% of bankroll max per bet
const MAX_DAILY_EXPOSURE_PCT = 0.20;   // 20% of bankroll deployed per day
const MAX_BETS_PER_MARKET = 1;         // one bet per market
const MIN_EDGE_WEATHER = 0.08;         // 8% minimum edge for weather
const MIN_LIQUIDITY = 400;             // Weather brackets have $400-$2K liquidity
const MAX_ANALYSIS_AGE = 2 * 3600000;  // 2 hours — weather forecasts update frequently

// Entry price bounds — derived from empirical data:
//   - ALL bets with entry > 0.40 have lost (100% loss rate)
//   - Best wins come from tail entries <15¢ (10x-27x payout)
//   - Below 2% is adverse selection territory
const MIN_ENTRY_PRICE = 0.02;
const MAX_ENTRY_PRICE = 0.40;

// Whale insight: optimal entry window is 24-48h before resolution.
// Too early = forecast uncertainty too high. Too late = market already priced in.
const MIN_HOURS_BEFORE_RESOLUTION = 4;   // absolute minimum
const OPTIMAL_HOURS_MIN = 12;            // sweet spot lower bound
const OPTIMAL_HOURS_MAX = 72;            // sweet spot upper bound

/** Normalize edge values — Claude sometimes returns 849 instead of 0.849 */
function normalizeEdge(raw: number | null): number {
  if (raw === null) return 0;
  if (raw > 100) return raw / 1000;
  if (raw > 1) return raw / 100;
  return raw;
}

/** Normalize probability/price values (0–1 range) */
function normalizeProb(raw: number | null): number {
  if (raw === null) return 0;
  if (raw > 1) return raw / 100;
  return raw;
}

interface AnalysisRow {
  id: string;
  market_id: string;
  direction: string;
  confidence: string;
  edge: number | null;
  kelly_fraction: number | null;
  rec_bet_usd: number | null;
  auto_eligible: boolean;
  analyzed_at: string;
  best_outcome_idx?: number | null;
  best_outcome_label?: string | null;
  market_price?: number | null;
  model_agreement?: string | null;
}

export const handler = schedule('*/15 * * * *', async () => {
  console.log('[place-bets] Starting automated weather bet placement (V3)');
  const startTime = Date.now();

  // Load system config
  const { data: configRows } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', [
      'paper_bankroll',
      'paper_trade_start_date',
      'total_paper_bets',
      'paper_win_rate',
      'live_trading_enabled',
      'live_kill_switch',
      'live_max_single_bet_usd',
      'live_max_daily_usd',
      'v3_start_date',
    ]);

  const config: Record<string, string> = {};
  configRows?.forEach((r: { key: string; value: string }) => {
    config[r.key] = r.value;
  });

  const bankroll = parseFloat(config.paper_bankroll || '1000');
  const maxSingleBet = bankroll * MAX_SINGLE_BET_PCT;
  const maxDailyExposure = bankroll * MAX_DAILY_EXPOSURE_PCT;

  // ── Circuit Breaker Check ─────────────────────────────────
  const cbState = await shouldTrade(supabase);
  if (!cbState.canTrade) {
    console.log(`[place-bets] CIRCUIT BREAKER ACTIVE: ${cbState.reason}`);
    return { statusCode: 200, body: JSON.stringify({ circuitBreaker: cbState.reason }) };
  }
  console.log(`[place-bets] Circuit breaker OK — streak: ${cbState.consecutiveLosses} losses, daily P&L: $${cbState.dailyPnl.toFixed(2)}, drawdown: ${(cbState.currentDrawdown * 100).toFixed(1)}%`);

  // Check today's existing bets to enforce daily limits.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const v3Start = config.v3_start_date ? new Date(config.v3_start_date) : null;
  const effectiveTodayStart = v3Start && v3Start > todayStart ? v3Start : todayStart;

  const { data: todaysBets } = await supabase
    .from('bets')
    .select('id, amount_usd, market_id, category')
    .gte('placed_at', effectiveTodayStart.toISOString());

  const todayExposure = todaysBets?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;
  const existingMarketIds = new Set(todaysBets?.map((b) => b.market_id) || []);

  console.log(`[place-bets] Today: ${todaysBets?.length || 0} bets, $${todayExposure.toFixed(2)} deployed, bankroll $${bankroll}`);

  if (todayExposure >= maxDailyExposure) {
    console.log('[place-bets] Daily exposure limit reached');
    return { statusCode: 200 };
  }

  // Get ALL open bet market IDs to avoid duplicate positions
  const { data: openBets } = await supabase
    .from('bets')
    .select('market_id')
    .eq('status', 'OPEN');

  const openMarketIds = new Set(openBets?.map((b) => b.market_id) || []);

  // Fetch eligible weather analyses — only category we trade now
  const weatherCutoff = new Date(Date.now() - MAX_ANALYSIS_AGE).toISOString();

  const { data: weatherAnalysesRaw } = await supabase
    .from('weather_analyses')
    .select('*')
    .gte('analyzed_at', weatherCutoff)
    .neq('direction', 'PASS')
    .gt('edge', MIN_EDGE_WEATHER)
    .order('edge', { ascending: false })
    .limit(50);

  // Deduplicate: keep only the latest analysis per market_id
  function dedup(rows: AnalysisRow[]): AnalysisRow[] {
    const seen = new Map<string, AnalysisRow>();
    for (const row of rows) {
      const existing = seen.get(row.market_id);
      if (!existing || new Date(row.analyzed_at) > new Date(existing.analyzed_at)) {
        seen.set(row.market_id, row);
      }
    }
    return Array.from(seen.values());
  }

  const candidates = dedup(weatherAnalysesRaw || []);
  // Sort by edge descending — best opportunities first
  candidates.sort((a, b) => (normalizeEdge(b.edge) - normalizeEdge(a.edge)));

  console.log(`[place-bets] Found ${candidates.length} eligible weather analyses`);

  let placed = 0;
  let totalDeployed = todayExposure;
  let orderbookChecks = 0;
  const MAX_ORDERBOOK_CHECKS = 8;

  for (const analysis of candidates) {
    // Stop conditions
    if (totalDeployed >= maxDailyExposure) break;
    if (Date.now() - startTime > 20000) break;

    // Skip if we already have an open bet on this market
    if (openMarketIds.has(analysis.market_id)) {
      console.log(`[place-bets] Skipping ${String(analysis.market_id).substring(0, 8)} — already have open position`);
      continue;
    }

    // Skip if already bet on this market today
    if (existingMarketIds.has(analysis.market_id)) continue;

    const edgeNorm = normalizeEdge(analysis.edge);
    if (analysis.market_price) analysis.market_price = normalizeProb(analysis.market_price);

    // Eligibility: confidence >= MEDIUM AND edge >= MIN_EDGE_WEATHER
    const isEligible =
      (analysis.confidence === 'HIGH' || analysis.confidence === 'MEDIUM') &&
      edgeNorm >= MIN_EDGE_WEATHER;

    if (!isEligible) continue;

    // Fetch current market data for pre-bet validation
    const { data: currentMarket } = await supabase
      .from('markets')
      .select('question, liquidity_usd, is_active, resolution_date')
      .eq('id', analysis.market_id)
      .single();

    if (!currentMarket || !currentMarket.is_active) {
      console.log(`[place-bets] Skip ${analysis.market_id.substring(0, 8)} — market inactive`);
      continue;
    }

    if (currentMarket.liquidity_usd < MIN_LIQUIDITY) {
      console.log(`[place-bets] Skip ${analysis.market_id.substring(0, 8)} — low liquidity $${currentMarket.liquidity_usd} (floor $${MIN_LIQUIDITY})`);
      continue;
    }

    // ── Timing Validation (Whale Insight) ─────────────────────
    // Optimal entry is 24-48h before resolution. Too early = uncertainty.
    // Too late = market has converged on the right answer.
    if (currentMarket.resolution_date) {
      const hoursLeft = (new Date(currentMarket.resolution_date).getTime() - Date.now()) / 3600000;

      if (hoursLeft < MIN_HOURS_BEFORE_RESOLUTION) {
        console.log(`[place-bets] Skip ${analysis.market_id.substring(0, 8)} — only ${hoursLeft.toFixed(1)}h left (min ${MIN_HOURS_BEFORE_RESOLUTION}h)`);
        continue;
      }

      // Log timing quality for analytics
      const timingQuality = (hoursLeft >= OPTIMAL_HOURS_MIN && hoursLeft <= OPTIMAL_HOURS_MAX)
        ? 'OPTIMAL' : hoursLeft < OPTIMAL_HOURS_MIN ? 'LATE' : 'EARLY';
      if (timingQuality !== 'OPTIMAL') {
        console.log(`[place-bets] Timing ${timingQuality} for ${analysis.market_id.substring(0, 8)}: ${hoursLeft.toFixed(1)}h left (sweet spot: ${OPTIMAL_HOURS_MIN}-${OPTIMAL_HOURS_MAX}h)`);
      }
    }

    // ── Tail Bet Detection (Whale Strategy) ───────────────────
    // The #1 edge on Polymarket weather: buy Yes at <15¢ when
    // ensemble forecasts show 8%+ higher probability than market.
    // gopfan2 made $2M+ mostly from these. Math: true prob 12%,
    // market at 4% = 25x payout with 3x edge.
    const isTailBet = (analysis.market_price ?? 0) > 0 && (analysis.market_price ?? 0) < 0.15;

    // ── Kelly Sizing ──────────────────────────────────────────
    // 1/8th Kelly with confidence scaling. Tail bets get 1.5x boost
    // because asymmetric payout justifies slightly larger positions.
    let betAmount = 0;
    if (analysis.kelly_fraction && analysis.kelly_fraction > 0) {
      const confMult = analysis.confidence === 'HIGH' ? 0.8 : 0.5; // MEDIUM
      const tailBoost = isTailBet ? 1.5 : 1.0;
      const cappedKelly = Math.min(analysis.kelly_fraction, 0.035);
      const adjustedKelly = Math.min(cappedKelly * confMult * tailBoost, 0.03);
      betAmount = Math.max(1, Math.round(bankroll * adjustedKelly * 100) / 100);
    }

    // Fallback sizing
    if (betAmount <= 0) {
      betAmount = isTailBet
        ? Math.max(5, Math.round(bankroll * 0.003))  // 0.3% for tail bets
        : Math.max(5, Math.round(bankroll * 0.002));  // 0.2% standard
    }

    // Cap at max single bet and remaining daily exposure
    betAmount = Math.min(betAmount, maxSingleBet, maxDailyExposure - totalDeployed);
    if (betAmount < 1) break;

    // Liquidity cap: never deploy more than 5% of market's liquidity
    const maxByLiquidity = Math.max(1, (currentMarket.liquidity_usd || 0) * 0.05);
    if (betAmount > maxByLiquidity) {
      console.log(`[place-bets] Capping ${analysis.market_id.substring(0, 8)} bet from $${betAmount.toFixed(0)} to $${maxByLiquidity.toFixed(0)} (5% of $${currentMarket.liquidity_usd} liquidity)`);
      betAmount = Math.round(maxByLiquidity * 100) / 100;
    }
    if (betAmount < 1) continue;

    // Determine outcome label and entry price
    const outcomeLabel = analysis.best_outcome_label || null;
    let entryPrice: number | null = analysis.market_price || null;

    // For BUY_NO: our cost = 1 - YES_price
    if (analysis.direction === 'BUY_NO' && entryPrice !== null) {
      entryPrice = 1 - entryPrice;
    }

    // Validate entry price bounds
    if (!entryPrice || entryPrice < MIN_ENTRY_PRICE || entryPrice >= 0.997) {
      console.log(`[place-bets] Skipping ${String(analysis.id).substring(0, 8)} — entry price ${entryPrice?.toFixed(4)} outside bounds`);
      continue;
    }
    if (entryPrice > MAX_ENTRY_PRICE) {
      console.log(`[place-bets] Skipping ${String(analysis.id).substring(0, 8)} — entry price ${entryPrice.toFixed(4)} exceeds ${MAX_ENTRY_PRICE} cap`);
      continue;
    }

    // Real-time orderbook validation (advisory — fails silently)
    if (orderbookChecks < MAX_ORDERBOOK_CHECKS) {
      try {
        const { data: marketData } = await supabase
          .from('markets')
          .select('condition_id')
          .eq('id', analysis.market_id)
          .single();

        if (marketData?.condition_id) {
          const book = await getOrderbookDepth(marketData.condition_id);
          if (book) {
            const spreadPct = computeSpread(book);
            const isBuyOrder = true;
            const slippagePct = estimateSlippage(book, betAmount, isBuyOrder);

            // Skip if spread eats more than 40% of our edge
            if (spreadPct > edgeNorm * 100 * 0.4) {
              console.log(`[place-bets] Skip ${String(analysis.id).substring(0, 8)} — spread ${spreadPct.toFixed(1)}% eats ${((spreadPct / (edgeNorm * 100)) * 100).toFixed(0)}% of edge`);
              orderbookChecks++;
              continue;
            }

            // Skip if slippage > 20% of bet amount
            const slippageDollar = (slippagePct / 100) * betAmount;
            if (slippageDollar > betAmount * 0.20) {
              console.log(`[place-bets] Skip ${String(analysis.id).substring(0, 8)} — slippage $${slippageDollar.toFixed(2)} on $${betAmount.toFixed(2)} bet`);
              orderbookChecks++;
              continue;
            }

            // Use real-time best price if significantly different
            const realPrice = analysis.direction === 'BUY_YES'
              ? book.bestAsk
              : 1 - book.bestBid;

            if (realPrice && Math.abs(realPrice - entryPrice) > 0.03) {
              console.log(`[place-bets] Price moved: analysis=${entryPrice.toFixed(3)}, live=${realPrice.toFixed(3)} — using live price`);
              entryPrice = realPrice;
            }

            orderbookChecks++;
          }
        }
      } catch (e) {
        console.log(`[place-bets] Orderbook check failed (non-blocking): ${e}`);
      }
    }

    // Execute the bet
    const execResult = await executeBet(
      supabase,
      {
        market_id: analysis.market_id,
        analysis_id: analysis.id,
        category: 'weather',
        direction: analysis.direction,
        outcome_label: outcomeLabel,
        entry_price: entryPrice,
        amount_usd: betAmount,
        edge: analysis.edge || null,
        confidence: analysis.confidence || null,
      },
      config,
      0
    );

    if (!execResult.success && !execResult.bet_id) {
      console.error(`[place-bets] Execution error for ${String(analysis.id).substring(0, 8)}:`, execResult.error);
      continue;
    }

    if (!execResult.is_paper) {
      console.log(`[place-bets] LIVE order placed: ${execResult.clob_order_id} status=${execResult.order_status}`);
    }

    placed++;
    totalDeployed += betAmount;
    openMarketIds.add(analysis.market_id);
    existingMarketIds.add(analysis.market_id);

    const tailTag = isTailBet ? ' [TAIL]' : '';
    console.log(
      `[place-bets] Placed weather bet${tailTag}: $${betAmount.toFixed(2)} on "${(outcomeLabel || '').substring(0, 60)}" @ ${entryPrice.toFixed(3)} | edge=${edgeNorm.toFixed(3)} conf=${analysis.confidence}`
    );

    // Send email notification (non-blocking)
    notifyBetPlaced({
      category: 'weather',
      direction: analysis.direction,
      outcomeLabel,
      entryPrice,
      amountUsd: betAmount,
      marketQuestion: currentMarket?.question || null,
      isPaper: execResult.is_paper,
      edge: analysis.edge,
      confidence: analysis.confidence,
    }).catch(() => {});
  }

  // Update paper_trade_start_date if first-ever bet
  if (placed > 0 && !config.paper_trade_start_date) {
    await supabase
      .from('system_config')
      .update({
        value: new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      })
      .eq('key', 'paper_trade_start_date');
    console.log('[place-bets] Started paper trading clock');
  }

  // Update total bet count
  if (placed > 0) {
    const { count } = await supabase
      .from('bets')
      .select('*', { count: 'exact', head: true });

    await supabase
      .from('system_config')
      .update({
        value: (count || 0).toString(),
        updated_at: new Date().toISOString(),
      })
      .eq('key', 'total_paper_bets');
  }

  const elapsed = Date.now() - startTime;
  console.log(`[place-bets] Done in ${elapsed}ms. Placed ${placed} weather bets, total deployed today: $${totalDeployed.toFixed(2)}`);

  return { statusCode: 200 };
});

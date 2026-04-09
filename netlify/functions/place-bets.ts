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
// Phase 2.1: raised from 15 → 22 to accommodate temperature laddering.
// With the Railway v2 forecast-ensemble math finding more edges (tighter
// sigma → previously missed bets now qualify) + 4-bracket ladders per
// city, 15 was hitting its ceiling on 2026-04-08 (16 placed, 1 rejected).
// 22 = 4 cities × 4 ladder rungs + 6 non-ladder singletons. Still well
// under the 20% daily exposure cap which remains the real risk limit.
const MAX_BETS_PER_DAY = 22;
// Phase 2: multiple adjacent brackets for the same city can now produce
// bets. Cap per-city so a single city's ladder can't eat the entire
// daily budget. Calibrated against current candidate distribution: the
// top city typically has 4 qualifying brackets.
const MAX_BETS_PER_CITY_PER_DAY = 4;
const MIN_EDGE_WEATHER = 0.08;         // 8% minimum edge for weather
const MIN_LIQUIDITY = 400;             // Weather brackets have $400-$2K liquidity
const MAX_ANALYSIS_AGE = 2 * 3600000;  // 2 hours — weather forecasts update frequently

// Entry price bounds — derived from empirical data:
//   - ALL bets with entry > 0.40 have lost (100% loss rate)
//   - Best wins come from tail entries <15¢ (10x-27x payout)
//   - Sub-5¢ zone is empirically 0/16 through 2026-04-07 (P=5% random,
//     -$261 P&L) → model systematically overconfident on extreme tails.
//     MIN raised 0.02 → 0.05 on 2026-04-07. Reassess at n=35.
const MIN_ENTRY_PRICE = 0.05;
const MAX_ENTRY_PRICE = 0.40;

// Whale insight: optimal entry window is 24-48h before resolution.
// Too early = forecast uncertainty too high. Too late = market already priced in.
const MIN_HOURS_BEFORE_RESOLUTION = 4;   // absolute minimum
const OPTIMAL_HOURS_MIN = 12;            // sweet spot lower bound
const OPTIMAL_HOURS_MAX = 72;            // sweet spot upper bound

/** Normalize edge values — Claude sometimes returns 849 instead of 0.849 */
function normalizeEdge(raw: number | null): number {
  if (raw === null || isNaN(raw)) return 0;
  if (raw < 0) return 0;  // Negative edges are invalid
  if (raw > 100) return raw / 1000;
  if (raw > 1) return raw / 100;
  return raw;
}

/** Normalize probability/price values (0–1 range) */
function normalizeProb(raw: number | null): number {
  if (raw === null || isNaN(raw)) return 0;
  if (raw < 0) return 0;  // Negative probabilities are invalid
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
  ensemble_agreement_score?: number | null;
}

/** Dynamic sigma scaling — must match analyze-weather.ts getDynamicSigma() */
function getDynamicSigma(hoursRemaining: number): number {
  if (hoursRemaining <= 6) return 0.8;
  if (hoursRemaining <= 12) return 1.2;
  if (hoursRemaining <= 24) return 1.8;
  if (hoursRemaining <= 48) return 2.5;
  if (hoursRemaining <= 72) return 3.2;
  if (hoursRemaining <= 120) return 4.0;
  if (hoursRemaining <= 168) return 4.8;
  return 5.5;
}

/**
 * Ensemble-driven Kelly multiplier.
 * - Model agreement HIGH + short lead time → boost (up to 1.3x)
 * - Model agreement LOW or long lead time → reduce (down to 0.6x)
 * - Tighter sigma = more certainty = larger position justified
 */
function getEnsembleKellyMultiplier(
  modelAgreement: string | null | undefined,
  hoursRemaining: number
): number {
  const sigma = getDynamicSigma(hoursRemaining);

  // Base multiplier from model agreement
  let agreementMult = 1.0;
  if (modelAgreement === 'HIGH') agreementMult = 1.2;
  else if (modelAgreement === 'LOW') agreementMult = 0.7;
  // MEDIUM stays at 1.0

  // Sigma-based scaling: tighter sigma → boost, wider → reduce
  // sigma ≤ 1.5°F (strong agreement, short lead) → 1.3x
  // sigma 1.5-3.0°F → 1.0x (neutral)
  // sigma > 3.5°F → 0.7x (wide uncertainty, shrink position)
  let sigmaMult = 1.0;
  if (sigma <= 1.5) sigmaMult = 1.3;
  else if (sigma <= 2.0) sigmaMult = 1.15;
  else if (sigma <= 3.0) sigmaMult = 1.0;
  else if (sigma <= 4.0) sigmaMult = 0.85;
  else sigmaMult = 0.7;

  // Combine: agreement × sigma, capped at [0.6, 1.4]
  const combined = agreementMult * sigmaMult;
  return Math.max(0.6, Math.min(1.4, combined));
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
      // Learned boosts written by learn-from-results
      'kelly_boost_high_high',
      'kelly_boost_medium_high',
      'kelly_boost_low_high',
      'blocked_directions',
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

  // Phase 2: build a per-city bet count for today.
  // IMPORTANT: markets.city_id column exists but is never populated
  // (refresh-markets doesn't write it). weather_analyses.city_id IS
  // populated, so we join today's bets through that table instead.
  // We take the MOST RECENT weather_analyses row per market_id so a
  // later re-analysis can't double-count.
  const betsPerCity = new Map<string, number>();
  const todayMarketIds = Array.from(existingMarketIds).filter(Boolean) as string[];
  if (todayMarketIds.length > 0) {
    const { data: cityRows } = await supabase
      .from('weather_analyses')
      .select('market_id, city_id, analyzed_at')
      .in('market_id', todayMarketIds)
      .order('analyzed_at', { ascending: false });
    const marketToCity = new Map<string, string>();
    for (const row of cityRows || []) {
      const mid = String(row.market_id);
      if (!marketToCity.has(mid) && row.city_id) {
        marketToCity.set(mid, String(row.city_id));
      }
    }
    for (const cid of marketToCity.values()) {
      betsPerCity.set(cid, (betsPerCity.get(cid) || 0) + 1);
    }
  }
  console.log(
    `[place-bets] Phase2 per-city counts: ${JSON.stringify(Object.fromEntries(betsPerCity))}`
  );

  console.log(`[place-bets] Today: ${todaysBets?.length || 0} bets, $${todayExposure.toFixed(2)} deployed, bankroll $${bankroll}`);

  const todayBetCount = todaysBets?.length || 0;
  if (todayExposure >= maxDailyExposure) {
    console.log('[place-bets] Daily exposure limit reached');
    return { statusCode: 200 };
  }
  if (todayBetCount >= MAX_BETS_PER_DAY) {
    console.log(`[place-bets] Daily bet count limit reached (${todayBetCount}/${MAX_BETS_PER_DAY})`);
    return { statusCode: 200 };
  }

  // Get ALL open bet market IDs to avoid duplicate positions
  const { data: openBets } = await supabase
    .from('bets')
    .select('market_id')
    .eq('status', 'OPEN');

  const openMarketIds = new Set(openBets?.map((b) => b.market_id) || []);

  // Track today's LIVE exposure separately for guardrails validation.
  // This was previously hardcoded to 0, which bypassed the daily live limit.
  let todayLiveExposure = 0;
  if (config.live_trading_enabled === 'true') {
    const { data: todayLiveBets } = await supabase
      .from('bets')
      .select('amount_usd')
      .eq('is_paper', false)
      .gte('placed_at', effectiveTodayStart.toISOString());
    todayLiveExposure = todayLiveBets?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;
    if (todayLiveExposure > 0) {
      console.log(`[place-bets] Live exposure today: $${todayLiveExposure.toFixed(2)}`);
    }
  }

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
  // NOTE: Netlify scheduled functions have a 15-minute timeout.
  // 55s guard leaves buffer while allowing full candidate processing.
  const LOOP_TIMEOUT_MS = 55000;

  for (const analysis of candidates) {
    const elapsed = Date.now() - startTime;
    // Stop conditions
    if (totalDeployed >= maxDailyExposure) { console.log(`[place-bets] Daily exposure limit reached ($${totalDeployed.toFixed(2)}/$${maxDailyExposure.toFixed(2)})`); break; }
    if (todayBetCount + placed >= MAX_BETS_PER_DAY) { console.log(`[place-bets] Daily bet count limit reached (${todayBetCount + placed}/${MAX_BETS_PER_DAY})`); break; }
    if (elapsed > LOOP_TIMEOUT_MS) { console.log(`[place-bets] Loop timeout after ${elapsed}ms — stopping`); break; }

    const shortId = String(analysis.market_id).substring(0, 8);
    const edgeNorm = normalizeEdge(analysis.edge);
    console.log(`[place-bets] Evaluating ${shortId} dir=${analysis.direction} conf=${analysis.confidence} edge=${edgeNorm.toFixed(3)} price=${analysis.market_price}`);

    // Skip if we already have an open bet on this market
    if (openMarketIds.has(analysis.market_id)) {
      console.log(`[place-bets] SKIP ${shortId} — already have open position`);
      continue;
    }

    // Skip if already bet on this market today
    if (existingMarketIds.has(analysis.market_id)) {
      console.log(`[place-bets] SKIP ${shortId} — already bet today`);
      continue;
    }

    // Phase 2: per-city daily cap. Prevents a single city's temperature
    // ladder from consuming the entire daily bet budget.
    const analysisCityId = (analysis as { city_id?: string | null }).city_id;
    if (analysisCityId) {
      const cityBetCount = betsPerCity.get(String(analysisCityId)) || 0;
      if (cityBetCount >= MAX_BETS_PER_CITY_PER_DAY) {
        console.log(
          `[place-bets] SKIP ${shortId} — city ${analysisCityId} already at ` +
            `${cityBetCount}/${MAX_BETS_PER_CITY_PER_DAY} bets today`
        );
        continue;
      }
    }

    if (analysis.market_price) analysis.market_price = normalizeProb(analysis.market_price);

    // ── BUY_NO BLOCK (learned from backtest: 0/11 win rate) ────
    if (analysis.direction === 'BUY_NO') {
      console.log(`[place-bets] SKIP ${shortId} — BUY_NO disabled (0% historical win rate)`);
      continue;
    }

    // ── Learned dynamic direction block ──────────────────────
    // learn-from-results can append directions to `blocked_directions`
    // (comma-separated) when WR < 30% over 5+ bets. Keeps the learning
    // loop end-to-end.
    const blockedDirs = (config.blocked_directions || '').split(',').map(s => s.trim()).filter(Boolean);
    if (blockedDirs.includes(analysis.direction)) {
      console.log(`[place-bets] SKIP ${shortId} — ${analysis.direction} in blocked_directions (learned)`);
      continue;
    }

    // Eligibility: confidence >= MEDIUM AND edge >= MIN_EDGE_WEATHER
    const isEligible =
      (analysis.confidence === 'HIGH' || analysis.confidence === 'MEDIUM') &&
      edgeNorm >= MIN_EDGE_WEATHER;

    if (!isEligible) {
      console.log(`[place-bets] SKIP ${shortId} — not eligible: conf=${analysis.confidence} edge=${edgeNorm.toFixed(3)}`);
      continue;
    }

    // Fetch current market data for pre-bet validation
    const { data: currentMarket } = await supabase
      .from('markets')
      .select('question, liquidity_usd, is_active, resolution_date')
      .eq('id', analysis.market_id)
      .single();

    if (!currentMarket || !currentMarket.is_active) {
      console.log(`[place-bets] SKIP ${shortId} — market not found or inactive (found=${!!currentMarket} active=${currentMarket?.is_active})`);
      continue;
    }

    if (currentMarket.liquidity_usd < MIN_LIQUIDITY) {
      console.log(`[place-bets] SKIP ${shortId} — low liquidity $${currentMarket.liquidity_usd} (floor $${MIN_LIQUIDITY})`);
      continue;
    }

    // ── Timing Validation (Whale Insight) ─────────────────────
    // Optimal entry is 24-48h before resolution. Too early = uncertainty.
    // Too late = market has converged on the right answer.
    // Weather bets MUST have a resolution_date — without it we can't
    // validate timing or know when the market settles.
    if (!currentMarket.resolution_date) {
      console.log(`[place-bets] SKIP ${shortId} — no resolution_date`);
      continue;
    }

    const hoursLeft = (new Date(currentMarket.resolution_date).getTime() - Date.now()) / 3600000;

    if (hoursLeft < MIN_HOURS_BEFORE_RESOLUTION) {
      console.log(`[place-bets] SKIP ${shortId} — only ${hoursLeft.toFixed(1)}h left (min ${MIN_HOURS_BEFORE_RESOLUTION}h)`);
      continue;
    }

    // Log timing quality for analytics
    const timingQuality = (hoursLeft >= OPTIMAL_HOURS_MIN && hoursLeft <= OPTIMAL_HOURS_MAX)
      ? 'OPTIMAL' : hoursLeft < OPTIMAL_HOURS_MIN ? 'LATE' : 'EARLY';
    if (timingQuality !== 'OPTIMAL') {
      console.log(`[place-bets] Timing ${timingQuality} for ${analysis.market_id.substring(0, 8)}: ${hoursLeft.toFixed(1)}h left (sweet spot: ${OPTIMAL_HOURS_MIN}-${OPTIMAL_HOURS_MAX}h)`);
    }

    // ── Tail Bet Detection (Whale Strategy) ───────────────────
    // The #1 edge on Polymarket weather: buy Yes at <15¢ when
    // ensemble forecasts show 8%+ higher probability than market.
    // gopfan2 made $2M+ mostly from these. Math: true prob 12%,
    // market at 4% = 25x payout with 3x edge.
    const isTailBet = (analysis.market_price ?? 0) > 0 && (analysis.market_price ?? 0) < 0.15;

    // ── Kelly Sizing ──────────────────────────────────────────
    // V3.2 (2026-04-07): HALVED sizing for new MIN_ENTRY_PRICE=0.05
    //   regime. After Seattle false-WIN correction, true bankroll is
    //   $783.12 (-21.7% DD) and true streak is 9. Carving out the
    //   sub-5¢ zone is a regime change — restart at half size for the
    //   first 20 bets in the new regime to stretch the learning budget,
    //   then reassess and restore full sizing if Brier and win-rate hold.
    //   Caps: 0.0175 input (was 0.035), 0.015 final (was 0.03).
    // Tail bets still get 1.5x boost because asymmetric payout justifies it.
    // Ensemble-driven multiplier (model agreement × hours-left sigma) still applies.
    let betAmount = 0;
    if (analysis.kelly_fraction && analysis.kelly_fraction > 0) {
      // NOTE: analysis.kelly_fraction from computeKelly() already includes
      // confidence multiplier (HIGH=0.8, MEDIUM=0.5, LOW=0.2), calibration
      // discount, and weather subtype scaling. Do NOT re-apply confMult here.
      const tailBoost = isTailBet ? 1.5 : 1.0;
      const ensembleMult = getEnsembleKellyMultiplier(analysis.model_agreement, hoursLeft);

      // ── Learned Kelly boost from learn-from-results ──────────
      // Bounded [0.5, 1.5] to prevent runaway sizing from small-sample noise.
      let learnedBoost = 1.0;
      const confKey = analysis.confidence === 'HIGH' ? 'kelly_boost_high_high'
        : analysis.confidence === 'MEDIUM' ? 'kelly_boost_medium_high'
        : 'kelly_boost_low_high';
      if (analysis.model_agreement === 'HIGH' && config[confKey]) {
        const raw = parseFloat(config[confKey]);
        if (!isNaN(raw)) learnedBoost = Math.max(0.5, Math.min(1.5, raw));
      }

      const cappedKelly = Math.min(analysis.kelly_fraction, 0.0175);
      const adjustedKelly = Math.min(
        cappedKelly * tailBoost * ensembleMult * learnedBoost,
        0.015
      );
      betAmount = Math.max(1, Math.round(bankroll * adjustedKelly * 100) / 100);

      if (ensembleMult !== 1.0 || learnedBoost !== 1.0) {
        console.log(`[place-bets] Kelly mults: agreement=${analysis.model_agreement} sigma=${getDynamicSigma(hoursLeft).toFixed(1)}°F ensMult=${ensembleMult.toFixed(2)} learnedBoost=${learnedBoost.toFixed(2)}`);
      }
    }

    // Fallback sizing
    if (betAmount <= 0) {
      betAmount = isTailBet
        ? Math.max(5, Math.round(bankroll * 0.003))  // 0.3% for tail bets
        : Math.max(5, Math.round(bankroll * 0.002));  // 0.2% standard
    }

    // Cap at max single bet and remaining daily exposure
    betAmount = Math.min(betAmount, maxSingleBet, maxDailyExposure - totalDeployed);
    if (betAmount < 1) { console.log(`[place-bets] BREAK ${shortId} — betAmount ${betAmount.toFixed(2)} < $1 (maxSingle=${maxSingleBet.toFixed(2)} remaining=${(maxDailyExposure - totalDeployed).toFixed(2)})`); break; }

    // ── gopfan2-style micro-bet caps for sub-10¢ tail zone ───────
    // The $2M+ Polymarket weather winner's rule set: "buy Yes below
    // 15¢, never risk more than $1-$2 per position." Tail bets are
    // high-variance by design — size them to survive long cold streaks
    // so one 10-20x winner pays for 15+ losers. Kelly fractional sizing
    // is too aggressive on binary bets with 5-10% implied prob; cap
    // hard by entry zone.
    //   entry < 0.05  → max $1   (deep tail, expected 1-in-20+)
    //   entry 0.05-0.10 → max $2 (standard tail, expected 1-in-10-20)
    //   entry 0.10-0.15 → max $5 (shallow tail)
    const mktPriceForCap = analysis.market_price ?? 0;
    let microCap = Infinity;
    if (mktPriceForCap > 0 && mktPriceForCap < 0.05) microCap = 1;
    else if (mktPriceForCap >= 0.05 && mktPriceForCap < 0.10) microCap = 2;
    else if (mktPriceForCap >= 0.10 && mktPriceForCap < 0.15) microCap = 5;
    if (betAmount > microCap) {
      console.log(`[place-bets] MICRO-CAP ${shortId}: $${betAmount.toFixed(2)} → $${microCap} (entry=${mktPriceForCap.toFixed(3)}, gopfan2 rule)`);
      betAmount = microCap;
    }

    // Liquidity cap: never deploy more than 5% of market's liquidity
    const maxByLiquidity = Math.max(1, (currentMarket.liquidity_usd || 0) * 0.05);
    if (betAmount > maxByLiquidity) {
      console.log(`[place-bets] Capping ${shortId} bet from $${betAmount.toFixed(0)} to $${maxByLiquidity.toFixed(0)} (5% of $${currentMarket.liquidity_usd} liquidity)`);
      betAmount = Math.round(maxByLiquidity * 100) / 100;
    }
    if (betAmount < 1) { console.log(`[place-bets] SKIP ${shortId} — betAmount ${betAmount.toFixed(2)} < $1 after liquidity cap`); continue; }

    // Determine outcome label and entry price
    const outcomeLabel = analysis.best_outcome_label || null;
    let entryPrice: number | null = analysis.market_price || null;

    // For BUY_NO: our cost = 1 - YES_price
    if (analysis.direction === 'BUY_NO' && entryPrice !== null) {
      entryPrice = 1 - entryPrice;
    }

    // Validate entry price bounds
    if (!entryPrice || entryPrice < MIN_ENTRY_PRICE || entryPrice >= 0.997) {
      console.log(`[place-bets] SKIP ${shortId} — entry price ${entryPrice?.toFixed(4)} outside [${MIN_ENTRY_PRICE}, 0.997) bounds (market_price=${analysis.market_price})`);
      continue;
    }
    if (entryPrice > MAX_ENTRY_PRICE) {
      console.log(`[place-bets] SKIP ${shortId} — entry price ${entryPrice.toFixed(4)} exceeds ${MAX_ENTRY_PRICE} cap`);
      continue;
    }
    console.log(`[place-bets] PRE-EXECUTE ${shortId}: $${betAmount.toFixed(2)} @ ${entryPrice.toFixed(3)}, ${hoursLeft.toFixed(1)}h left, conf=${analysis.confidence}`);

    // Real-time orderbook validation (advisory — only applied when CLOB returns real data)
    // BUG FIX: getOrderbookDepth() never returns null — on API failure it returns
    // {bestBid: 0, bestAsk: 1, spread: 1.0} as a fallback. computeSpread() turns
    // that into 200%, which caused the spread check to block EVERY bet.
    // Fix: only apply spread/slippage gates when bestBid > 0 (real data received).
    // When CLOB API fails, skip the check and proceed to execute the bet.
    if (orderbookChecks < MAX_ORDERBOOK_CHECKS) {
      try {
        const { data: marketData } = await supabase
          .from('markets')
          .select('condition_id')
          .eq('id', analysis.market_id)
          .single();

        if (marketData?.condition_id) {
          const book = await getOrderbookDepth(marketData.condition_id);
          orderbookChecks++;

          // Only apply spread/slippage gates when API returned real data (bestBid > 0).
          // bestBid == 0 means API failed and returned the fallback sentinel values —
          // applying spread checks against fake 100% spread would block valid bets.
          if (book && book.bestBid > 0) {
            const spreadPct = computeSpread(book);
            const isBuyOrder = true;
            const slippagePct = estimateSlippage(book, betAmount, isBuyOrder);

            // Skip if spread eats more than 40% of our edge
            if (spreadPct > edgeNorm * 100 * 0.4) {
              console.log(`[place-bets] Skip ${String(analysis.id).substring(0, 8)} — spread ${spreadPct.toFixed(1)}% eats ${((spreadPct / (edgeNorm * 100)) * 100).toFixed(0)}% of edge`);
              continue;
            }

            // Skip if slippage > 20% of bet amount
            const slippageDollar = (slippagePct / 100) * betAmount;
            if (slippageDollar > betAmount * 0.20) {
              console.log(`[place-bets] Skip ${String(analysis.id).substring(0, 8)} — slippage $${slippageDollar.toFixed(2)} on $${betAmount.toFixed(2)} bet`);
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
          } else if (book) {
            console.log(`[place-bets] Orderbook API returned no data for ${String(analysis.market_id).substring(0, 8)} — skipping spread check, proceeding to execute`);
          }
        }
      } catch (e) {
        console.log(`[place-bets] Orderbook check failed (non-blocking): ${e}`);
      }
    }

    // Execute the bet — wrapped in try-catch so a single failure
    // doesn't crash the function and orphan remaining analyses.
    let execResult;
    try {
      execResult = await executeBet(
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
        todayLiveExposure
      );
    } catch (err) {
      console.error(`[place-bets] Exception during executeBet for ${String(analysis.id).substring(0, 8)}:`, err);
      continue;
    }

    if (!execResult.success && !execResult.bet_id) {
      console.error(`[place-bets] Execution error for ${String(analysis.id).substring(0, 8)}:`, execResult.error);
      continue;
    }

    if (!execResult.is_paper) {
      console.log(`[place-bets] LIVE order placed: ${execResult.clob_order_id} status=${execResult.order_status}`);
      todayLiveExposure += betAmount;
    }

    placed++;
    totalDeployed += betAmount;
    openMarketIds.add(analysis.market_id);
    existingMarketIds.add(analysis.market_id);
    // Phase 2: track per-city count so subsequent ladder rungs for the
    // same city get gated by MAX_BETS_PER_CITY_PER_DAY.
    {
      const cid = (analysis as { city_id?: string | null }).city_id;
      if (cid) {
        const k = String(cid);
        betsPerCity.set(k, (betsPerCity.get(k) || 0) + 1);
      }
    }

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

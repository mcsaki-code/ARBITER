// ============================================================
// Netlify Scheduled Function: Place Bets
// Runs every 30 minutes — takes analyses from weather, sports,
// and crypto pipelines and creates paper bets in the bets table.
// THIS IS THE CRITICAL GLUE that closes the paper trading loop:
// analyze → place-bet → resolve-bet → track P&L → pass guardrails
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { executeBet } from '../../src/lib/execute-bet';
import { notifyBetPlaced } from '../../src/lib/notify';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Risk limits — calibrated to professional prediction market standards
const MAX_SINGLE_BET_PCT = 0.03;       // 3% of bankroll max per bet
const MAX_DAILY_EXPOSURE_PCT = 0.20;   // 20% of bankroll deployed per day
const MAX_DAILY_BETS_AUTO = 20;        // increased from 15
const MAX_BETS_PER_MARKET = 1;         // one bet per market
const MIN_EDGE = 0.05;                 // 5% minimum edge
const MIN_EDGE_WEATHER = 0.08;         // 8% for weather
const MIN_LIQUIDITY = 5000;            // Skip thin markets
const KELLY_FRACTION = 0.125;          // 1/8th Kelly (professional standard)
// Per-category staleness windows — sports/crypto ingest runs hourly now
const MAX_ANALYSIS_AGE_WEATHER  = 2 * 3600000;  // 2h
const MAX_ANALYSIS_AGE_SPORTS   = 6 * 3600000;  // 6h (matches hourly ingest rhythm)
const MAX_ANALYSIS_AGE_CRYPTO   = 4 * 3600000;  // 4h
const MAX_ANALYSIS_AGE_POLITICS = 6 * 3600000;  // 6h
const MAX_ANALYSIS_AGE_MS = 6 * 3600000;         // default fallback

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
  // Weather-specific
  best_outcome_idx?: number | null;
  best_outcome_label?: string | null;
  market_price?: number | null;
  model_agreement?: string | null;
  // Sports-specific
  polymarket_price?: number | null;
  event_description?: string | null;
  // Crypto-specific
  target_bracket?: string | null;
  asset?: string | null;
}

export const handler = schedule('*/15 * * * *', async () => {
  console.log('[place-bets] Starting automated bet placement');
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
    ]);

  const config: Record<string, string> = {};
  configRows?.forEach((r: { key: string; value: string }) => {
    config[r.key] = r.value;
  });

  const bankroll = parseFloat(config.paper_bankroll || '500');
  const maxSingleBet = bankroll * MAX_SINGLE_BET_PCT;
  const maxDailyExposure = bankroll * MAX_DAILY_EXPOSURE_PCT;

  // Check today's existing bets to enforce daily limits
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: todaysBets } = await supabase
    .from('bets')
    .select('id, amount_usd, market_id')
    .gte('placed_at', todayStart.toISOString());

  const todayBetCount = todaysBets?.length || 0;
  const todayExposure = todaysBets?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;
  const existingMarketIds = new Set(todaysBets?.map((b) => b.market_id) || []);

  console.log(`[place-bets] Today: ${todayBetCount} bets, $${todayExposure.toFixed(2)} deployed, bankroll $${bankroll}`);

  if (todayBetCount >= MAX_DAILY_BETS_AUTO) {
    console.log('[place-bets] Daily bet limit reached');
    return { statusCode: 200 };
  }

  if (todayExposure >= maxDailyExposure) {
    console.log('[place-bets] Daily exposure limit reached');
    return { statusCode: 200 };
  }

  // Also get ALL open bet market IDs to avoid duplicate positions
  const { data: openBets } = await supabase
    .from('bets')
    .select('market_id')
    .eq('status', 'OPEN');

  const openMarketIds = new Set(openBets?.map((b) => b.market_id) || []);

  // Collect eligible analyses using per-category staleness windows (all in parallel)
  const weatherCutoff  = new Date(Date.now() - MAX_ANALYSIS_AGE_WEATHER).toISOString();
  const sportsCutoff   = new Date(Date.now() - MAX_ANALYSIS_AGE_SPORTS).toISOString();
  const cryptoCutoff   = new Date(Date.now() - MAX_ANALYSIS_AGE_CRYPTO).toISOString();
  const politicsCutoff = new Date(Date.now() - MAX_ANALYSIS_AGE_POLITICS).toISOString();

  const [weatherAnalyses, sportsAnalyses, cryptoAnalyses, politicsAnalyses] = await Promise.all([
    supabase.from('weather_analyses').select('*')
      .gte('analyzed_at', weatherCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE_WEATHER)
      .order('edge', { ascending: false }).limit(20).then(r => r.data ?? []),
    supabase.from('sports_analyses').select('*')
      .gte('analyzed_at', sportsCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE)
      .order('edge', { ascending: false }).limit(20).then(r => r.data ?? []),
    supabase.from('crypto_analyses').select('*')
      .gte('analyzed_at', cryptoCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE)
      .order('edge', { ascending: false }).limit(20).then(r => r.data ?? []),
    supabase.from('politics_analyses').select('*')
      .gte('analyzed_at', politicsCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE)
      .order('edge', { ascending: false }).limit(20)
      .then(r => r.data ?? []).catch(() => [] as unknown[]),
  ]);

  const candidates: (AnalysisRow & { category: string; source_table: string })[] = [
    ...weatherAnalyses.map((a: AnalysisRow)  => ({ ...a, category: 'weather',  source_table: 'weather_analyses'  })),
    ...sportsAnalyses.map((a: AnalysisRow)   => ({ ...a, category: 'sports',   source_table: 'sports_analyses'   })),
    ...cryptoAnalyses.map((a: AnalysisRow)   => ({ ...a, category: 'crypto',   source_table: 'crypto_analyses'   })),
    ...(politicsAnalyses as AnalysisRow[]).map(a => ({ ...a, category: 'politics', source_table: 'politics_analyses' })),
  ];

  console.log(`[place-bets] Found ${candidates.length} eligible analyses (weather: ${weatherAnalyses.length}, sports: ${sportsAnalyses.length}, crypto: ${cryptoAnalyses.length}, politics: ${(politicsAnalyses as unknown[]).length})`);

  // Sort all candidates by edge descending (best opportunities first)
  candidates.sort((a, b) => (b.edge || 0) - (a.edge || 0));

  let placed = 0;
  let totalDeployed = todayExposure;

  for (const analysis of candidates) {
    // Stop conditions
    if (placed + todayBetCount >= MAX_DAILY_BETS_AUTO) break;
    if (totalDeployed >= maxDailyExposure) break;
    if (Date.now() - startTime > 20000) break;

    // Skip if we already have an open bet on this market
    if (openMarketIds.has(analysis.market_id)) {
      console.log(`[place-bets] Skipping ${analysis.market_id.substring(0, 8)} — already have open position`);
      continue;
    }

    // Skip if already bet on this market today
    if (existingMarketIds.has(analysis.market_id)) continue;

    // Normalize edge and price values (handle Claude returning 849 instead of 0.849)
    const edgeNorm = normalizeEdge(analysis.edge);
    if (analysis.market_price) analysis.market_price = normalizeProb(analysis.market_price);
    if (analysis.polymarket_price) analysis.polymarket_price = normalizeProb(analysis.polymarket_price);

    // Must be auto-eligible (HIGH confidence, HIGH agreement, edge >= 0.08)
    // OR at minimum: confidence >= MEDIUM, edge >= 0.05
    const isAutoEligible = analysis.auto_eligible;
    const isMediumEligible =
      (analysis.confidence === 'HIGH' || analysis.confidence === 'MEDIUM') &&
      edgeNorm >= MIN_EDGE;

    if (!isAutoEligible && !isMediumEligible) continue;

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
      console.log(`[place-bets] Skip ${analysis.market_id.substring(0, 8)} — low liquidity $${currentMarket.liquidity_usd}`);
      continue;
    }

    // Check time remaining
    if (currentMarket.resolution_date) {
      const hoursLeft = (new Date(currentMarket.resolution_date).getTime() - Date.now()) / 3600000;
      if (hoursLeft < 1) continue;
    }

    // Spread-aware edge filter: edge must be 2x estimated spread
    const estimatedSpread = currentMarket.liquidity_usd > 50000 ? 0.005 :
      currentMarket.liquidity_usd > 20000 ? 0.01 :
      currentMarket.liquidity_usd > 10000 ? 0.015 : 0.025;

    if (edgeNorm < estimatedSpread * 2) {
      console.log(`[place-bets] Skip ${analysis.market_id.substring(0, 8)} — edge < 2x spread`);
      continue;
    }

    // Calculate bet size using 1/8th Kelly (professional standard)
    let betAmount = 0;
    if (analysis.kelly_fraction && analysis.kelly_fraction > 0) {
      const confMult = analysis.confidence === 'HIGH' ? 0.8 : analysis.confidence === 'MEDIUM' ? 0.5 : 0.2;
      const adjustedKelly = Math.min(analysis.kelly_fraction * KELLY_FRACTION / 0.25 * confMult, 0.03);
      betAmount = Math.max(1, Math.round(bankroll * adjustedKelly * 100) / 100);
    }

    // Fallback: ~$3 for paper trading (0.6% of bankroll)
    if (betAmount <= 0) betAmount = Math.min(3, bankroll * 0.006);

    // Cap at max single bet and remaining daily exposure
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

    // Entry price is already normalized above via normalizeProb
    // For BUY_NO bets, entry price is what we pay for the NO side = 1 - YES price
    // If the YES price is near 0, the NO price is near 1 (cheap to bet against)
    if (analysis.direction === 'BUY_NO' && entryPrice !== null && entryPrice < 0.5) {
      entryPrice = 1 - entryPrice;
    }

    // Need a valid entry price between 0.5% and 99.5%
    // Weather brackets can legitimately be 1-5¢ — allow them through
    if (!entryPrice || entryPrice <= 0.005 || entryPrice >= 0.995) {
      console.log(`[place-bets] Skipping analysis ${analysis.id.substring(0, 8)} — invalid entry price ${entryPrice}`);
      continue;
    }

    // Execute the bet — paper or live depending on config/guardrails
    // executeBet handles the paper/live decision internally
    const execResult = await executeBet(
      supabase,
      {
        market_id: analysis.market_id,
        analysis_id: analysis.source_table === 'weather_analyses' ? analysis.id : null,
        category: analysis.category,
        direction: analysis.direction,
        outcome_label: outcomeLabel,
        entry_price: entryPrice,
        amount_usd: betAmount,
      },
      config,
      // Only count live exposure for live order validation
      0 // todayLiveExposure — TODO: track separately when live trading is active
    );

    if (!execResult.success && !execResult.bet_id) {
      console.error(`[place-bets] Execution error for ${analysis.id.substring(0, 8)}:`, execResult.error);
      continue;
    }

    if (!execResult.is_paper) {
      console.log(`[place-bets] LIVE order placed: ${execResult.clob_order_id} status=${execResult.order_status}`);
    }

    placed++;
    totalDeployed += betAmount;
    openMarketIds.add(analysis.market_id);
    existingMarketIds.add(analysis.market_id);

    console.log(
      `[place-bets] Placed ${analysis.category} bet: $${betAmount.toFixed(2)} on "${(outcomeLabel || '').substring(0, 60)}" @ ${entryPrice.toFixed(3)} | edge=${edgeNorm.toFixed(3)} conf=${analysis.confidence}`
    );

    // Send email notification (non-blocking, fails silently)
    notifyBetPlaced({
      category: analysis.category,
      direction: analysis.direction,
      outcomeLabel,
      entryPrice,
      amountUsd: betAmount,
      marketQuestion: currentMarket?.question || null,
      isPaper: execResult.is_paper,
      edge: analysis.edge,
      confidence: analysis.confidence,
    }).catch(() => {}); // fire-and-forget
  }

  // Update paper_trade_start_date if this is the first-ever bet
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
  console.log(`[place-bets] Done in ${elapsed}ms. Placed ${placed} new bets, total deployed today: $${totalDeployed.toFixed(2)}`);

  return { statusCode: 200 };
});

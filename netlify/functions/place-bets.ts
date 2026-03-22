// ============================================================
// Netlify Scheduled Function: Place Bets
// Runs every 30 minutes — takes analyses from weather, sports,
// and crypto pipelines and creates paper bets in the bets table.
// THIS IS THE CRITICAL GLUE that closes the paper trading loop:
// analyze → place-bet → resolve-bet → track P&L → pass guardrails
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Risk limits — calibrated to professional prediction market standards
const MAX_SINGLE_BET_PCT = 0.03;       // 3% of bankroll max per bet
const MAX_DAILY_EXPOSURE_PCT = 0.20;   // 20% of bankroll deployed per day
const MAX_DAILY_BETS_AUTO = 15;
const MAX_BETS_PER_MARKET = 1;         // one bet per market
const MIN_EDGE = 0.05;                 // 5% minimum edge (up from 2%)
const MIN_EDGE_WEATHER = 0.08;         // 8% for weather (matching top bots)
const MIN_LIQUIDITY = 5000;            // Skip thin markets
const KELLY_FRACTION = 0.125;          // 1/8th Kelly (professional standard)
const MAX_ANALYSIS_AGE_MS = 2 * 3600000; // 2h max staleness

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

export const handler = schedule('*/30 * * * *', async () => {
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

  // Collect eligible analyses from the last 2 hours across all verticals
  const cutoff = new Date(Date.now() - MAX_ANALYSIS_AGE_MS).toISOString();
  const candidates: (AnalysisRow & { category: string; source_table: string })[] = [];

  // 1. Weather analyses — higher edge threshold (8%)
  const { data: weatherAnalyses } = await supabase
    .from('weather_analyses')
    .select('*')
    .gte('analyzed_at', cutoff)
    .neq('direction', 'PASS')
    .gt('edge', MIN_EDGE_WEATHER)
    .order('edge', { ascending: false });

  if (weatherAnalyses) {
    for (const a of weatherAnalyses) {
      candidates.push({ ...a, category: 'weather', source_table: 'weather_analyses' });
    }
  }

  // 2. Sports analyses
  const { data: sportsAnalyses } = await supabase
    .from('sports_analyses')
    .select('*')
    .gte('analyzed_at', cutoff)
    .neq('direction', 'PASS')
    .gt('edge', MIN_EDGE)
    .order('edge', { ascending: false });

  if (sportsAnalyses) {
    for (const a of sportsAnalyses) {
      candidates.push({ ...a, category: 'sports', source_table: 'sports_analyses' });
    }
  }

  // 3. Crypto analyses
  const { data: cryptoAnalyses } = await supabase
    .from('crypto_analyses')
    .select('*')
    .gte('analyzed_at', cutoff)
    .neq('direction', 'PASS')
    .gt('edge', MIN_EDGE)
    .order('edge', { ascending: false });

  if (cryptoAnalyses) {
    for (const a of cryptoAnalyses) {
      candidates.push({ ...a, category: 'crypto', source_table: 'crypto_analyses' });
    }
  }

  console.log(`[place-bets] Found ${candidates.length} eligible analyses (weather: ${weatherAnalyses?.length || 0}, sports: ${sportsAnalyses?.length || 0}, crypto: ${cryptoAnalyses?.length || 0})`);

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

    // Must be auto-eligible (HIGH confidence, HIGH agreement, edge >= 0.08)
    // OR at minimum: confidence >= MEDIUM, edge >= 0.05
    const isAutoEligible = analysis.auto_eligible;
    const isMediumEligible =
      (analysis.confidence === 'HIGH' || analysis.confidence === 'MEDIUM') &&
      (analysis.edge || 0) >= MIN_EDGE;

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

    if ((analysis.edge || 0) < estimatedSpread * 2) {
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

    // Normalize entry price — handle percentages (e.g., 90 → 0.90)
    if (entryPrice && entryPrice > 1) {
      entryPrice = entryPrice / 100;
    }

    // For BUY_NO bets, entry price is what we pay for the NO side = 1 - YES price
    // If the YES price is near 0, the NO price is near 1 (cheap to bet against)
    if (analysis.direction === 'BUY_NO' && entryPrice !== null && entryPrice < 0.5) {
      entryPrice = 1 - entryPrice;
    }

    // Need a valid entry price between 0.1% and 99.9%
    // Low-priced markets (like "will X happen" at 0.3%) are valid bets
    if (!entryPrice || entryPrice <= 0.001 || entryPrice >= 0.999) {
      console.log(`[place-bets] Skipping analysis ${analysis.id.substring(0, 8)} — invalid entry price ${entryPrice}`);
      continue;
    }

    // Insert the bet — use analysis_id only for weather (FK constraint)
    // Sports and crypto analyses live in separate tables
    const { error } = await supabase.from('bets').insert({
      market_id: analysis.market_id,
      analysis_id: analysis.source_table === 'weather_analyses' ? analysis.id : null,
      category: analysis.category,
      direction: analysis.direction,
      outcome_label: outcomeLabel,
      entry_price: entryPrice,
      amount_usd: betAmount,
      is_paper: true,
      status: 'OPEN',
      placed_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`[place-bets] Insert error for ${analysis.id.substring(0, 8)}:`, error.message);
      continue;
    }

    placed++;
    totalDeployed += betAmount;
    openMarketIds.add(analysis.market_id);
    existingMarketIds.add(analysis.market_id);

    console.log(
      `[place-bets] Placed ${analysis.category} bet: $${betAmount.toFixed(2)} on "${(outcomeLabel || '').substring(0, 60)}" @ ${entryPrice.toFixed(3)} | edge=${(analysis.edge || 0).toFixed(3)} conf=${analysis.confidence}`
    );
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

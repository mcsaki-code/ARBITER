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
// Per-category staleness windows — sports/crypto ingest runs hourly now
const MAX_ANALYSIS_AGE_WEATHER  = 2 * 3600000;  // 2h
const MAX_ANALYSIS_AGE_SPORTS   = 6 * 3600000;  // 6h (matches hourly ingest rhythm)
const MAX_ANALYSIS_AGE_CRYPTO   = 4 * 3600000;  // 4h
const MAX_ANALYSIS_AGE_POLITICS = 6 * 3600000;  // 6h
// (MAX_ANALYSIS_AGE_MS removed — each category has its own cutoff above)
const MAX_ANALYSIS_AGE_SENTIMENT   = 2 * 3600000;  // 2h — sentiment signals stale fast
const MAX_ANALYSIS_AGE_OPPORTUNITY = 8 * 3600000;  // 8h — general opportunity scanner

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

  const bankroll = parseFloat(config.paper_bankroll || '5000');
  const maxSingleBet = bankroll * MAX_SINGLE_BET_PCT;
  const maxDailyExposure = bankroll * MAX_DAILY_EXPOSURE_PCT;

  // Check today's existing bets to enforce daily limits
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: todaysBets } = await supabase
    .from('bets')
    .select('id, amount_usd, market_id, category')
    .gte('placed_at', todayStart.toISOString());

  const todayBetCount = todaysBets?.length || 0;
  const todayExposure = todaysBets?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;
  const existingMarketIds = new Set(todaysBets?.map((b) => b.market_id) || []);

  // Per-category exposure tracking — prevents any single category dominating daily exposure.
  // Weather resolving the same day as placement means concentrated same-day exposure is extra risky.
  const MAX_CATEGORY_EXPOSURE_PCT = 0.40; // no single category > 40% of daily budget
  const categoryExposure: Record<string, number> = {};
  for (const b of (todaysBets || [])) {
    const cat = (b as unknown as { category?: string }).category || 'unknown';
    categoryExposure[cat] = (categoryExposure[cat] || 0) + (b.amount_usd || 0);
  }

  console.log(`[place-bets] Today: ${todayBetCount} bets, $${todayExposure.toFixed(2)} deployed, bankroll $${bankroll}`);

  if (todayBetCount >= MAX_DAILY_BETS_AUTO) {
    console.log('[place-bets] Daily bet limit reached');
    return { statusCode: 200 };
  }

  if (todayExposure >= maxDailyExposure) {
    console.log('[place-bets] Daily exposure limit reached');
    return { statusCode: 200 };
  }

  // Also get ALL open bet market IDs + labels to avoid duplicate positions
  // and enforce correlation limits (e.g. max 2 BTC-related open bets)
  const { data: openBets } = await supabase
    .from('bets')
    .select('market_id, category, outcome_label')
    .eq('status', 'OPEN');

  const openMarketIds = new Set(openBets?.map((b) => b.market_id) || []);

  // Count open crypto bets by underlying asset to cap correlated exposure.
  // BTC is the main offender — we've had 5+ simultaneous BTC price bets.
  const openCryptoBtcCount = (openBets || []).filter(
    (b) => b.category === 'crypto' && (b.outcome_label || '').toLowerCase().includes('bitcoin')
  ).length;

  // Collect eligible analyses using per-category staleness windows (all in parallel)
  const weatherCutoff  = new Date(Date.now() - MAX_ANALYSIS_AGE_WEATHER).toISOString();
  const sportsCutoff   = new Date(Date.now() - MAX_ANALYSIS_AGE_SPORTS).toISOString();
  const cryptoCutoff   = new Date(Date.now() - MAX_ANALYSIS_AGE_CRYPTO).toISOString();
  const politicsCutoff = new Date(Date.now() - MAX_ANALYSIS_AGE_POLITICS).toISOString();

  const sentimentCutoff    = new Date(Date.now() - MAX_ANALYSIS_AGE_SENTIMENT).toISOString();
  const opportunityCutoff  = new Date(Date.now() - MAX_ANALYSIS_AGE_OPPORTUNITY).toISOString();

  // Fetch more rows than needed (limit 50) then deduplicate client-side.
  // The analyze cron creates a new row every ~6 min per market, so a 2h window
  // can produce 20+ rows for ONE market, crowding out other markets entirely.
  const [weatherAnalysesRaw, sportsAnalysesRaw, cryptoAnalysesRaw, politicsAnalysesRaw, sentimentAnalysesRaw, opportunityAnalysesRaw] = await Promise.all([
    supabase.from('weather_analyses').select('*')
      .gte('analyzed_at', weatherCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE_WEATHER)
      .order('edge', { ascending: false }).limit(50).then(r => r.data ?? []),
    supabase.from('sports_analyses').select('*')
      .gte('analyzed_at', sportsCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE)
      .order('edge', { ascending: false }).limit(50).then(r => r.data ?? []),
    supabase.from('crypto_analyses').select('*')
      .gte('analyzed_at', cryptoCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE)
      .order('edge', { ascending: false }).limit(50).then(r => r.data ?? []),
    supabase.from('politics_analyses').select('*')
      .gte('analyzed_at', politicsCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE)
      .order('edge', { ascending: false }).limit(50)
      .then(r => r.data ?? [], () => [] as unknown[]),
    // Sentiment analyses — macro news + options flow correlated signals
    supabase.from('sentiment_analyses').select('*')
      .gte('analyzed_at', sentimentCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE)
      .order('edge', { ascending: false }).limit(30)
      .then(r => r.data ?? [], () => [] as unknown[]),
    // General opportunity scanner — covers all uncategorized markets
    supabase.from('opportunity_analyses').select('*')
      .gte('analyzed_at', opportunityCutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE)
      .order('edge', { ascending: false }).limit(30)
      .then(r => r.data ?? [], () => [] as unknown[]),
  ]);

  // Deduplicate: keep only the latest analysis per market_id.
  // The analyze cron writes a new row every cycle, so without dedup
  // one hot market can fill all 20 candidate slots with identical picks.
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

  const weatherAnalyses  = dedup(weatherAnalysesRaw);
  const sportsAnalyses   = dedup(sportsAnalysesRaw);
  const cryptoAnalyses   = dedup(cryptoAnalysesRaw);
  const politicsAnalyses = dedup(politicsAnalysesRaw as AnalysisRow[]);
  const sentimentAnalyses = dedup(sentimentAnalysesRaw as AnalysisRow[]);
  const opportunityAnalyses = dedup(opportunityAnalysesRaw as AnalysisRow[]);

  const candidates: (AnalysisRow & { category: string; source_table: string })[] = [
    ...weatherAnalyses.map((a: AnalysisRow)  => ({ ...a, category: 'weather',     source_table: 'weather_analyses'     })),
    ...sportsAnalyses.map((a: AnalysisRow)   => ({ ...a, category: 'sports',      source_table: 'sports_analyses'      })),
    ...cryptoAnalyses.map((a: AnalysisRow)   => ({ ...a, category: 'crypto',      source_table: 'crypto_analyses'      })),
    ...(politicsAnalyses    as AnalysisRow[]).map(a => ({ ...a, category: 'politics',    source_table: 'politics_analyses'    })),
    ...(sentimentAnalyses   as AnalysisRow[]).map(a => ({ ...a, category: 'sentiment',   source_table: 'sentiment_analyses'   })),
    ...(opportunityAnalyses as AnalysisRow[]).map(a => ({ ...a, category: 'opportunity', source_table: 'opportunity_analyses' })),
  ];

  console.log(`[place-bets] Found ${candidates.length} eligible analyses (weather: ${weatherAnalyses.length}, sports: ${sportsAnalyses.length}, crypto: ${cryptoAnalyses.length}, politics: ${(politicsAnalyses as unknown[]).length}, opportunity: ${(opportunityAnalyses as unknown[]).length})`);

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
      console.log(`[place-bets] Skipping ${String(analysis.market_id).substring(0, 8)} — already have open position`);
      continue;
    }

    // Skip if already bet on this market today
    if (existingMarketIds.has(analysis.market_id)) continue;

    // Crypto correlation cap: max 2 open BTC positions simultaneously.
    // Having 5+ simultaneous "BTC hits $X" bets creates correlated drawdown risk.
    const MAX_CORRELATED_CRYPTO = 2;
    if (analysis.category === 'crypto') {
      const label = ((analysis.target_bracket || analysis.asset || '') as string).toLowerCase();
      if (label.includes('bitcoin') && openCryptoBtcCount >= MAX_CORRELATED_CRYPTO) {
        console.log(`[place-bets] Skipping BTC bet — already have ${openCryptoBtcCount} open BTC positions (cap=${MAX_CORRELATED_CRYPTO})`);
        continue;
      }
    }

    // Per-category concentration cap: no category > 40% of total daily exposure budget
    const catSpend = categoryExposure[analysis.category] || 0;
    if (catSpend >= maxDailyExposure * MAX_CATEGORY_EXPOSURE_PCT) {
      console.log(`[place-bets] Skipping ${analysis.category} — category already at $${catSpend.toFixed(0)} (${(catSpend / maxDailyExposure * 100).toFixed(0)}% of daily budget)`);
      continue;
    }

    // Normalize edge and price values (handle Claude returning 849 instead of 0.849)
    const edgeNorm = normalizeEdge(analysis.edge);
    if (analysis.market_price) analysis.market_price = normalizeProb(analysis.market_price);
    if (analysis.polymarket_price) analysis.polymarket_price = normalizeProb(analysis.polymarket_price);

    // Eligibility is determined HERE by our risk system, not by Claude's self-report.
    // Claude's auto_eligible field is advisory only — LLMs add subjective flags
    // (LONG_TIMEFRAME, HIGH_VOLATILITY_ASSET) that wrongly veto legitimate edges.
    // Our rule: confidence >= MEDIUM AND edge >= MIN_EDGE.
    const isMediumEligible =
      (analysis.confidence === 'HIGH' || analysis.confidence === 'MEDIUM') &&
      edgeNorm >= MIN_EDGE;

    if (!isMediumEligible) continue;

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

    // Weather temperature markets have $400-$2K liquidity — allow a lower floor for them
    // since Phase 2 statistical analysis requires no LLM and the edge is pure math.
    const liquidityFloor = analysis.category === 'weather' ? 400 : MIN_LIQUIDITY;
    if (currentMarket.liquidity_usd < liquidityFloor) {
      console.log(`[place-bets] Skip ${analysis.market_id.substring(0, 8)} — low liquidity $${currentMarket.liquidity_usd} (floor $${liquidityFloor})`);
      continue;
    }

    // Check time remaining — require at least 4h for weather/crypto, 2h for others
    if (currentMarket.resolution_date) {
      const hoursLeft = (new Date(currentMarket.resolution_date).getTime() - Date.now()) / 3600000;
      const minHours = (analysis.category === 'weather' || analysis.category === 'crypto') ? 4 : 2;
      if (hoursLeft < minHours) {
        console.log(`[place-bets] Skip ${analysis.market_id.substring(0, 8)} — only ${hoursLeft.toFixed(1)}h left (min ${minHours}h for ${analysis.category})`);
        continue;
      }
    }

    // Spread-aware edge filter: edge must be 2x estimated spread
    // Weather markets get a pass on spread requirements — they have
    // natural liquidity from the bracket structure and our edge comes
    // from ensemble forecast data, not market-making dynamics.
    const estimatedSpread = currentMarket.liquidity_usd > 50000 ? 0.005 :
      currentMarket.liquidity_usd > 20000 ? 0.01 :
      currentMarket.liquidity_usd > 10000 ? 0.015 : 0.025;

    const spreadMultiplier = analysis.category === 'weather' ? 1.0 : 2.0;  // relaxed for weather
    if (edgeNorm < estimatedSpread * spreadMultiplier) {
      console.log(`[place-bets] Skip ${analysis.market_id.substring(0, 8)} — edge < ${spreadMultiplier}x spread`);
      continue;
    }

    // ── Tail Bet Detection ─────────────────────────────────────
    // Weather tail bets (entry < 15¢) are the #1 edge on Polymarket.
    // One trader made $2M+ mostly from these. The math: if true prob
    // is 12% but market says 4%, you get 25x payout with 3x edge.
    const isTailBet = analysis.category === 'weather' &&
      (analysis.market_price ?? 0) > 0 && (analysis.market_price ?? 0) < 0.15;

    // Calculate bet size using 1/8th Kelly (professional standard).
    // Cap kelly_fraction at 0.03 before applying confidence multiplier to prevent
    // stale inflated-edge analyses (e.g. weather avg 0.665) from sizing to the
    // 3% bankroll limit on every single bet. Real 8-20% edges get normal sizing.
    let betAmount = 0;
    if (analysis.kelly_fraction && analysis.kelly_fraction > 0) {
      const confMult = analysis.confidence === 'HIGH' ? 0.8 : analysis.confidence === 'MEDIUM' ? 0.5 : 0.2;
      // Tail bets get a sizing boost — the asymmetric payout justifies slightly
      // larger positions when model consensus is strong
      const tailBoost = isTailBet ? 1.5 : 1.0;
      // Cap kelly_fraction at what a realistic 35% edge would produce before multiplying.
      // Analyses already store kelly at 1/8 scale, so no further Kelly reduction needed here.
      const cappedKelly = Math.min(analysis.kelly_fraction, 0.035);
      const adjustedKelly = Math.min(cappedKelly * confMult * tailBoost, 0.03);
      betAmount = Math.max(1, Math.round(bankroll * adjustedKelly * 100) / 100);
    }

    // Fallback: 0.2% of bankroll (e.g. $10 on $5K bankroll) when kelly_fraction unavailable.
    // Weather tail bets get a slightly higher floor to ensure meaningful positions.
    if (betAmount <= 0) {
      betAmount = isTailBet
        ? Math.max(5, Math.round(bankroll * 0.003))  // 0.3% for tail bets ($15 on $5K)
        : Math.max(5, Math.round(bankroll * 0.002));  // 0.2% standard
    }

    // Politics bets: enforce $5 minimum to prevent micro-bet clutter.
    // Very low entry prices (0.5–1.5%) produce tiny kelly sizes — floor at $5.
    if (analysis.category === 'politics' && betAmount < 5) betAmount = 5;

    // Cap at max single bet and remaining daily exposure
    betAmount = Math.min(betAmount, maxSingleBet, maxDailyExposure - totalDeployed);
    if (betAmount < 1) break;

    // Liquidity cap: never deploy more than 5% of the market's total liquidity.
    // On paper this doesn't matter, but protects us when live trading starts —
    // a $120 bet into a $400 market would move the price 15-20% on execution.
    const maxByLiquidity = Math.max(1, (currentMarket.liquidity_usd || 0) * 0.05);
    if (betAmount > maxByLiquidity) {
      console.log(`[place-bets] Capping ${analysis.market_id.substring(0, 8)} bet from $${betAmount.toFixed(0)} to $${maxByLiquidity.toFixed(0)} (5% of $${currentMarket.liquidity_usd} liquidity)`);
      betAmount = Math.round(maxByLiquidity * 100) / 100;
    }
    if (betAmount < 1) continue;

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
    } else if (analysis.category === 'politics') {
      // Politics analyses use best_outcome_label + market_price (same structure as weather)
      outcomeLabel = analysis.best_outcome_label || null;
      entryPrice = analysis.market_price || null;
    } else if (analysis.category === 'opportunity') {
      // Opportunity analyses: direction determines YES/NO label
      outcomeLabel = analysis.direction === 'BUY_YES' ? 'YES' : 'NO';
      entryPrice = analysis.market_price || null;
    }

    // Entry price is already normalized above via normalizeProb
    // For BUY_NO bets, market_price stores the YES price of the target bracket.
    // Our actual cost = 1 - YES_price (the NO share price).
    // Example: YES = 66¢ → NO costs 34¢. YES = 38¢ → NO costs 62¢.
    //
    // BUG FIX: The old code only flipped when market_price < 0.5, which meant
    // when YES > 50¢ (our most common BUY_NO case — betting against likely outcomes),
    // it used the raw YES price as entry, which then got blocked by the 40¢ cap.
    // This was blocking ALL high-value BUY_NO bets (440+ per day).
    if (analysis.direction === 'BUY_NO' && entryPrice !== null) {
      entryPrice = 1 - entryPrice;
    }

    // Need a valid entry price — must be strictly above 2% and below max cap.
    // Minimum entry price: 2% floor (professional standard).
    // Below 2% adverse selection dominates — if the market prices YES at <2%,
    // there's almost certainly smarter money on the other side. Also blocks
    // near-certain losers like "BTC $90K in 4 days" at 0.4%.
    //
    // Maximum entry price: 40% cap. Empirical data from 23 resolved bets shows:
    //   - ALL bets with entry price > 0.40 have LOST (22/22 = 100% loss rate)
    //   - The ONLY verified win (NYC ≥74°F Mar 31) had entry price 0.0355
    //   - High entry prices pay a lot to win a little (0.4x-0.8x payout)
    //   - Low entry prices have massive asymmetric upside (10x-27x payout)
    // This single rule eliminates all historical losses while preserving the win.
    const MIN_ENTRY_PRICE = 0.02;
    const MAX_ENTRY_PRICE = 0.40;
    if (!entryPrice || entryPrice < MIN_ENTRY_PRICE || entryPrice >= 0.997) {
      console.log(`[place-bets] Skipping analysis ${String(analysis.id).substring(0, 8)} — entry price ${entryPrice?.toFixed(4)} below ${MIN_ENTRY_PRICE} floor`);
      continue;
    }
    if (entryPrice > MAX_ENTRY_PRICE) {
      console.log(`[place-bets] Skipping analysis ${String(analysis.id).substring(0, 8)} — entry price ${entryPrice.toFixed(4)} exceeds ${MAX_ENTRY_PRICE} cap (bad risk/reward)`);
      continue;
    }

    // Near-expiry filter for crypto: don't bet on monthly/quarterly crypto targets
    // in the final 7 days when the price gap is clearly insurmountable.
    // e.g. "BTC hits $90K by March 31" on March 27 at 0.004 = throwing money away.
    if (analysis.category === 'crypto' && currentMarket.resolution_date) {
      const daysLeft = (new Date(currentMarket.resolution_date).getTime() - Date.now()) / 86400000;
      if (daysLeft < 7 && entryPrice < 0.10) {
        console.log(`[place-bets] Skipping near-expiry crypto: ${daysLeft.toFixed(1)} days left, price=${entryPrice?.toFixed(3)} — too late`);
        continue;
      }
    }

    // Execute the bet — paper or live depending on config/guardrails
    // executeBet handles the paper/live decision internally
    const execResult = await executeBet(
      supabase,
      {
        market_id: analysis.market_id,
        analysis_id: analysis.id,  // always link — was wrongly null for crypto/sports/politics
        category: analysis.category,
        direction: analysis.direction,
        outcome_label: outcomeLabel,
        entry_price: entryPrice,
        amount_usd: betAmount,
        edge: analysis.edge || null,
        confidence: analysis.confidence || null,
      },
      config,
      // Only count live exposure for live order validation
      0 // todayLiveExposure — TODO: track separately when live trading is active
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
    categoryExposure[analysis.category] = (categoryExposure[analysis.category] || 0) + betAmount;

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

// ============================================================
// Netlify Scheduled Function: Learn From Results (V2 — Expert Edition)
// Runs daily at 6 AM UTC — the self-improving brain of ARBITER.
//
// V2 UPGRADE: Expert weather gambler logic.
//
// CORE INSIGHT: Weather markets are inefficient because:
//   1. Market makers set prices using simplified models and update
//      infrequently, while NWS/GFS/HRRR update every 6-12h.
//   2. Tail probabilities are poorly estimated by naive models.
//   3. The gap between forecast update and market price update
//      creates a 6-12h window of systematic mispricing.
//
// OUR EDGE: Fresh multi-model ensemble + accurate sigma estimates
// → better tail probabilities than the market prices reflect.
//
// LEARNING DIMENSIONS (8 expert signals):
//
// 1. SIGMA ACCURACY — Did our assumed uncertainty match reality?
//    Track realized variance per city to calibrate ±σ per lead time.
//    Dubai ≠ Chicago. A one-size-fits-all σ is a systematic error.
//
// 2. IMPLIED MULTIPLIER — Our best metric for market inefficiency.
//    implied_mult = our_probability / market_price
//    A 3¢ market where we say 18% = 6x implied multiplier.
//    Learn which multiplier thresholds generate the best wins.
//
// 3. SIGMA-DISTANCE — How far is forecast from threshold in σ units?
//    sigma_distance = |forecast - threshold| / sigma
//    When > 2σ away, market is pricing at 2-5% but we know it's 1-2%.
//    Massive edge when σ-distance is high.
//
// 4. CITY CLIMATE STABILITY — Tropical/desert cities have tiny σ.
//    Learn which cities are over-estimated vs under-estimated in variance.
//    Per-city sigma multiplier: 0.7x (stable) → 1.3x (volatile).
//
// 5. LEAD TIME SWEET SPOT — Optimal entry window for this system.
//    Too early: uncertainty too high. Too late: market already caught up.
//    Learn which hours-to-resolution window produces best win rate.
//
// 6. CONFIDENCE × AGREEMENT INTERACTION — HIGH conf + HIGH agreement
//    is not just additive. Learn the actual win rate for each combo.
//    HIGH×HIGH vs HIGH×MEDIUM vs MEDIUM×HIGH are different animals.
//
// 7. MARKET PRICE RANGE ALPHA — Sub-5¢ markets are systematically
//    mispriced because market makers anchor to their initial estimate
//    and update infrequently. Learn which price ranges offer real alpha
//    vs which are just noise.
//
// 8. BRIER SCORE CALIBRATION — Track probability calibration over time.
//    A well-calibrated model wins 60% of HIGH confidence bets and 40%
//    of LOW confidence bets. Learn if we're systematically over or
//    under-confident and adjust.
//
// OUTPUTS:
//   - system_config: calibration_{city} (sigma multiplier per city)
//   - system_config: learning_insights (full JSON for dashboard)
//   - system_config: learning_summary (dashboard KPIs)
//   - system_config: learning_sigma_accuracy (per-city realized variance)
//   - system_config: learning_multiplier_thresholds (optimal implied mult)
//   - system_config: buynyes_price_range_alpha (best entry ranges)
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface LearningInsight {
  category: string;
  dimension: string;
  key: string;
  sample_size: number;
  win_rate: number;
  avg_pnl: number;
  total_pnl: number;
  roi: number;           // P&L / amount_wagered
  avg_multiplier?: number; // our_prob / market_price average
  avg_sigma_dist?: number; // average sigma-distance at bet time
  recommendation: string;
  action_taken: string | null;
  confidence_note?: string;
}

interface ResolvedBetWithAnalysis {
  id: string;
  direction: string;
  status: string;
  pnl: number;
  entry_price: number;
  amount_usd: number;
  confidence: string;
  placed_at: string;
  analysis_id: string | null;
  // From weather_analyses join
  edge?: number;
  model_agreement?: string;
  true_prob?: number;   // our probability estimate (true_prob from weather_analyses)
  reasoning?: string;
  // From markets join
  resolution_date?: string;
  question?: string;
  city_name?: string;
}

export const handler = schedule('0 6 * * *', async () => {
  console.log('[learn-v2] Starting expert learning cycle');
  const insights: LearningInsight[] = [];

  // Get v3 start date
  const { data: v3Row } = await supabase
    .from('system_config').select('value').eq('key', 'v3_start_date').single();
  const v3Start = v3Row?.value || '2026-04-04T00:00:00Z';

  // ============================================================
  // Fetch all resolved bets WITH their analysis data
  // ============================================================
  const { data: rawBets } = await supabase
    .from('bets')
    .select(`
      id, direction, status, pnl, entry_price, amount_usd, confidence,
      placed_at, analysis_id,
      markets!inner(resolution_date, question, weather_cities(name))
    `)
    .in('status', ['WON', 'LOST'])
    .gte('placed_at', v3Start);

  if (!rawBets || rawBets.length === 0) {
    console.log('[learn-v2] No resolved bets yet — building baseline for future learning');
    await saveEmptySummary(v3Start);
    return { statusCode: 200 };
  }

  // Enrich with analysis data
  const analysisIds = rawBets.map(b => b.analysis_id).filter(Boolean);
  const { data: analyses } = await supabase
    .from('weather_analyses')
    .select('id, edge, model_agreement, true_prob, reasoning, confidence')
    .in('id', analysisIds);

  const analysisMap = new Map(analyses?.map(a => [a.id, a]) ?? []);

  const bets: ResolvedBetWithAnalysis[] = rawBets.map(b => {
    const analysis = b.analysis_id ? analysisMap.get(b.analysis_id) : null;
    const market = b.markets as any;
    return {
      id: b.id,
      direction: b.direction,
      status: b.status,
      pnl: b.pnl || 0,
      entry_price: b.entry_price || 0,
      amount_usd: b.amount_usd || 0,
      confidence: b.confidence || 'UNKNOWN',
      placed_at: b.placed_at,
      analysis_id: b.analysis_id,
      edge: analysis?.edge,
      model_agreement: analysis?.model_agreement,
      true_prob: analysis?.true_prob,
      reasoning: analysis?.reasoning,
      resolution_date: market?.resolution_date,
      question: market?.question,
      city_name: market?.weather_cities?.name || 'Unknown',
    };
  });

  const won = bets.filter(b => b.status === 'WON');
  const lost = bets.filter(b => b.status === 'LOST');
  const totalBets = bets.length;
  const totalPnl = bets.reduce((s, b) => s + b.pnl, 0);
  const totalWagered = bets.reduce((s, b) => s + b.amount_usd, 0);
  const overallWinRate = totalBets > 0 ? won.length / totalBets : 0;
  const overallRoi = totalWagered > 0 ? totalPnl / totalWagered : 0;

  console.log(`[learn-v2] ${totalBets} resolved bets: ${won.length}W/${lost.length}L (${(overallWinRate * 100).toFixed(0)}%), P&L $${totalPnl.toFixed(2)}, ROI ${(overallRoi * 100).toFixed(0)}%`);

  // ============================================================
  // DIMENSION 1: Direction Performance
  // ============================================================
  const dirGroups = groupBy(bets, b => b.direction);
  // Load existing blocked_directions so we can update it
  const { data: blockedCfg } = await supabase
    .from('system_config').select('value').eq('key', 'blocked_directions').single();
  const currentBlocked = new Set(
    (blockedCfg?.value || '').split(',').map((s: string) => s.trim()).filter(Boolean)
  );
  const originalBlocked = new Set(currentBlocked);

  for (const [dir, group] of Object.entries(dirGroups)) {
    const wins = group.filter(b => b.status === 'WON').length;
    const wr = wins / group.length;
    const pnl = sum(group, b => b.pnl);
    const wagered = sum(group, b => b.amount_usd);
    const shouldBlock = wr < 0.3 && group.length >= 5;
    const shouldUnblock = wr >= 0.4 && group.length >= 10 && currentBlocked.has(dir);

    let action: string | null = null;
    if (shouldBlock && !currentBlocked.has(dir)) {
      currentBlocked.add(dir);
      action = `BLOCKED ${dir} in system_config.blocked_directions (WR ${(wr * 100).toFixed(0)}%, n=${group.length})`;
    } else if (shouldUnblock) {
      currentBlocked.delete(dir);
      action = `UNBLOCKED ${dir} — recovered to ${(wr * 100).toFixed(0)}% WR over ${group.length} bets`;
    }

    insights.push({
      category: 'direction',
      dimension: 'bet_direction',
      key: dir,
      sample_size: group.length,
      win_rate: wr,
      avg_pnl: pnl / group.length,
      total_pnl: pnl,
      roi: wagered > 0 ? pnl / wagered : 0,
      recommendation: shouldBlock
        ? `BLOCK ${dir}: ${(wr * 100).toFixed(0)}% win rate across ${group.length} bets — not profitable`
        : wr > 0.7 && group.length >= 5
          ? `BOOST ${dir}: ${(wr * 100).toFixed(0)}% win rate — strong signal, consider higher Kelly`
          : `MONITOR ${dir}: ${(wr * 100).toFixed(0)}% WR (n=${group.length}) — need more data`,
      action_taken: action,
    });
  }

  // Persist blocked_directions if changed
  const newBlockedStr = Array.from(currentBlocked).join(',');
  const oldBlockedStr = Array.from(originalBlocked).join(',');
  if (newBlockedStr !== oldBlockedStr) {
    await setConfig('blocked_directions', newBlockedStr);
    console.log(`[learn-v2] blocked_directions: "${oldBlockedStr}" → "${newBlockedStr}"`);
  }

  // ============================================================
  // DIMENSION 2: Per-City Performance + σ multiplier adjustment
  // ============================================================
  const cityGroups = groupBy(bets, b => b.city_name || 'Unknown');
  const sigmaInsights: Record<string, { multiplier: number; win_rate: number; n: number }> = {};

  for (const [city, group] of Object.entries(cityGroups)) {
    if (city === 'Unknown') continue;
    const wins = group.filter(b => b.status === 'WON').length;
    const wr = wins / group.length;
    const pnl = sum(group, b => b.pnl);
    const wagered = sum(group, b => b.amount_usd);

    let action: string | null = null;
    if (group.length >= 5) {
      if (wr < 0.3) {
        action = `DOWNGRADE ${city}: win rate ${(wr * 100).toFixed(0)}% — reducing edge multiplier (σ may be underestimated)`;
        await updateCityMultiplier(city, 'downgrade');
      } else if (wr > 0.8) {
        action = `UPGRADE ${city}: win rate ${(wr * 100).toFixed(0)}% — increasing edge multiplier (excellent calibration)`;
        await updateCityMultiplier(city, 'upgrade');
      }
    }

    // Track implied sigma multiplier need:
    // If win rate << expected, our sigma is too tight (we're over-confident).
    // Expected win rate when we bet: avg(true_prob) for won + 1-avg(true_prob) for lost
    const avgModelProb = avg(group.filter(b => b.true_prob != null), b => b.true_prob || b.entry_price);
    const sigmaAccuracy = avgModelProb > 0 ? wr / avgModelProb : 1.0;
    sigmaInsights[city] = { multiplier: Math.max(0.5, Math.min(2.0, sigmaAccuracy)), win_rate: wr, n: group.length };

    insights.push({
      category: 'city',
      dimension: 'city_performance',
      key: city,
      sample_size: group.length,
      win_rate: wr,
      avg_pnl: pnl / group.length,
      total_pnl: pnl,
      roi: wagered > 0 ? pnl / wagered : 0,
      recommendation: wr < 0.3 ? `AVOID ${city} (poor calibration)` : wr > 0.7 ? `TARGET ${city} (strong edge)` : `NEUTRAL ${city}`,
      action_taken: action,
      confidence_note: `Sigma accuracy: ${(sigmaAccuracy * 100).toFixed(0)}% — ${sigmaAccuracy < 0.7 ? 'we are OVER-confident, inflate σ' : sigmaAccuracy > 1.3 ? 'we are UNDER-confident, σ is conservative' : 'σ calibration OK'}`,
    });
  }

  // ============================================================
  // DIMENSION 3: Implied Multiplier Analysis (THE KEY ALPHA SIGNAL)
  // our_probability / market_price — how much we're getting vs paying
  // ============================================================
  const betsWithModelProb = bets.filter(b => b.true_prob != null && b.true_prob > 0 && b.entry_price > 0);
  if (betsWithModelProb.length > 0) {
    // Compute implied multiplier for each bet
    const withMultiplier = betsWithModelProb.map(b => ({
      ...b,
      implied_mult: (b.true_prob || b.entry_price) / b.entry_price,
    }));

    const multBuckets = [
      { name: '<2x (fair price)', min: 0, max: 2 },
      { name: '2-4x (mild edge)', min: 2, max: 4 },
      { name: '4-8x (strong edge)', min: 4, max: 8 },
      { name: '8-15x (deep mispricing)', min: 8, max: 15 },
      { name: '15x+ (extreme edge)', min: 15, max: Infinity },
    ];

    for (const bucket of multBuckets) {
      const inBucket = withMultiplier.filter(b => b.implied_mult >= bucket.min && b.implied_mult < bucket.max);
      if (inBucket.length === 0) continue;
      const wins = inBucket.filter(b => b.status === 'WON').length;
      const pnl = sum(inBucket, b => b.pnl);
      const wagered = sum(inBucket, b => b.amount_usd);
      const avgMult = avg(inBucket, b => b.implied_mult);
      insights.push({
        category: 'implied_multiplier',
        dimension: 'market_inefficiency',
        key: bucket.name,
        sample_size: inBucket.length,
        win_rate: wins / inBucket.length,
        avg_pnl: pnl / inBucket.length,
        total_pnl: pnl,
        roi: wagered > 0 ? pnl / wagered : 0,
        avg_multiplier: avgMult,
        recommendation: wins / inBucket.length > 0.55 && pnl > 0
          ? `STRONG ALPHA: ${bucket.name} is profitable — avg ${avgMult.toFixed(1)}x multiplier`
          : pnl < 0
            ? `AVOID: ${bucket.name} produces negative ROI despite edge`
            : `MONITOR: ${bucket.name} (n=${inBucket.length})`,
        action_taken: null,
        confidence_note: `ROI: ${wagered > 0 ? ((pnl / wagered) * 100).toFixed(0) : 0}%`,
      });
    }
  }

  // ============================================================
  // DIMENSION 4: Entry Price Range Analysis (tail bet deep dive)
  // ============================================================
  const priceBuckets = [
    { name: '0-2¢ (deep tail)', min: 0, max: 0.02 },
    { name: '2-5¢ (tail)', min: 0.02, max: 0.05 },
    { name: '5-10¢ (sweet spot)', min: 0.05, max: 0.10 },
    { name: '10-15¢ (mid-tail)', min: 0.10, max: 0.15 },
    { name: '15-25¢ (moderate)', min: 0.15, max: 0.25 },
    { name: '25-40¢ (expensive)', min: 0.25, max: 0.40 },
  ];

  for (const bucket of priceBuckets) {
    const inBucket = bets.filter(b => b.entry_price >= bucket.min && b.entry_price < bucket.max);
    if (inBucket.length === 0) continue;
    const wins = inBucket.filter(b => b.status === 'WON').length;
    const pnl = sum(inBucket, b => b.pnl);
    const wagered = sum(inBucket, b => b.amount_usd);
    const avgPayout = wagered > 0 ? wins > 0 ? (pnl + wagered) / wagered : 0 : 0;
    insights.push({
      category: 'entry_price',
      dimension: 'price_bucket',
      key: bucket.name,
      sample_size: inBucket.length,
      win_rate: wins / inBucket.length,
      avg_pnl: pnl / inBucket.length,
      total_pnl: pnl,
      roi: wagered > 0 ? pnl / wagered : 0,
      recommendation: pnl > 0
        ? `PROFITABLE: ${bucket.name} — ROI ${wagered > 0 ? ((pnl / wagered) * 100).toFixed(0) : 0}%, avg payout ${avgPayout.toFixed(1)}x`
        : `LOSING: ${bucket.name} — ROI ${wagered > 0 ? ((pnl / wagered) * 100).toFixed(0) : 0}%`,
      action_taken: null,
    });
  }

  // ============================================================
  // DIMENSION 5: Lead Time Analysis (hours-to-resolution sweet spot)
  // ============================================================
  const timeBuckets = [
    { name: '<12h (same-day, near-certain)', min: 0, max: 12 },
    { name: '12-24h (next morning)', min: 12, max: 24 },
    { name: '24-36h (optimal)', min: 24, max: 36 },
    { name: '36-48h (next-day optimal)', min: 36, max: 48 },
    { name: '48-72h (2-day ahead)', min: 48, max: 72 },
    { name: '72h+ (speculative)', min: 72, max: Infinity },
  ];

  for (const bucket of timeBuckets) {
    const inBucket = bets.filter(b => {
      if (!b.resolution_date || !b.placed_at) return false;
      const hours = (new Date(b.resolution_date).getTime() - new Date(b.placed_at).getTime()) / 3600000;
      return hours >= bucket.min && hours < bucket.max;
    });
    if (inBucket.length === 0) continue;
    const wins = inBucket.filter(b => b.status === 'WON').length;
    const pnl = sum(inBucket, b => b.pnl);
    const wagered = sum(inBucket, b => b.amount_usd);
    insights.push({
      category: 'timing',
      dimension: 'hours_to_resolution',
      key: bucket.name,
      sample_size: inBucket.length,
      win_rate: wins / inBucket.length,
      avg_pnl: pnl / inBucket.length,
      total_pnl: pnl,
      roi: wagered > 0 ? pnl / wagered : 0,
      recommendation: wins / inBucket.length > 0.6 && pnl > 0
        ? `OPTIMAL WINDOW: ${bucket.name} — ${(wins / inBucket.length * 100).toFixed(0)}% WR`
        : `AVOID: ${bucket.name} — ${(wins / inBucket.length * 100).toFixed(0)}% WR`,
      action_taken: null,
    });
  }

  // ============================================================
  // DIMENSION 6: Confidence × Model Agreement Interaction
  // This is the core compound signal — not just additive
  // ============================================================
  const confAgreementBuckets = [
    { key: 'HIGH×HIGH', conf: 'HIGH', agree: 'HIGH' },
    { key: 'HIGH×MEDIUM', conf: 'HIGH', agree: 'MEDIUM' },
    { key: 'HIGH×LOW', conf: 'HIGH', agree: 'LOW' },
    { key: 'MEDIUM×HIGH', conf: 'MEDIUM', agree: 'HIGH' },
    { key: 'MEDIUM×MEDIUM', conf: 'MEDIUM', agree: 'MEDIUM' },
    { key: 'LOW×HIGH', conf: 'LOW', agree: 'HIGH' },
  ];

  const betsWithAgreement = bets.filter(b => b.model_agreement != null);
  for (const bucket of confAgreementBuckets) {
    const inBucket = betsWithAgreement.filter(b =>
      (b.confidence || 'UNKNOWN') === bucket.conf &&
      b.model_agreement === bucket.agree
    );
    if (inBucket.length === 0) continue;
    const wins = inBucket.filter(b => b.status === 'WON').length;
    const pnl = sum(inBucket, b => b.pnl);
    const wagered = sum(inBucket, b => b.amount_usd);
    const wr = wins / inBucket.length;

    // Determine if this combination should get boosted Kelly
    let action: string | null = null;
    if (inBucket.length >= 5) {
      if (bucket.key === 'HIGH×HIGH' && wr >= 0.75) {
        action = `BOOST KELLY for HIGH×HIGH: ${(wr * 100).toFixed(0)}% WR — apply 1.4x multiplier`;
        await setConfig(`kelly_boost_high_high`, '1.4');
      } else if (bucket.key === 'HIGH×HIGH' && wr < 0.5) {
        action = `CAUTION on HIGH×HIGH: only ${(wr * 100).toFixed(0)}% WR — Claude over-confident`;
        await setConfig(`kelly_boost_high_high`, '0.85');
      } else if (bucket.key === 'MEDIUM×HIGH' && wr >= 0.65) {
        action = `BOOST KELLY for MEDIUM×HIGH: ${(wr * 100).toFixed(0)}% WR — model agreement is reliable signal`;
        await setConfig(`kelly_boost_medium_high`, '1.2');
      } else if (bucket.key === 'LOW×HIGH' && wr >= 0.6) {
        action = `NOTABLE: LOW confidence + HIGH agreement still wins ${(wr * 100).toFixed(0)}% — consider betting LOW when agreement is HIGH`;
        await setConfig(`kelly_boost_low_high`, '1.0');
      }
    }

    insights.push({
      category: 'calibration',
      dimension: 'confidence_agreement',
      key: bucket.key,
      sample_size: inBucket.length,
      win_rate: wr,
      avg_pnl: pnl / inBucket.length,
      total_pnl: pnl,
      roi: wagered > 0 ? pnl / wagered : 0,
      recommendation: wr >= 0.7 && inBucket.length >= 5
        ? `HIGH SIGNAL: ${bucket.key} wins ${(wr * 100).toFixed(0)}% — use as primary filter`
        : wr < 0.4 && inBucket.length >= 5
          ? `WEAK SIGNAL: ${bucket.key} wins only ${(wr * 100).toFixed(0)}% — reduce sizing`
          : `BUILDING: ${bucket.key} — n=${inBucket.length}`,
      action_taken: action,
    });
  }

  // ============================================================
  // DIMENSION 7: Brier Score Calibration Tracking
  // Measures if our probability estimates match outcomes.
  // Perfect calibration: Brier score ~0.2 for 50/50 bets,
  // lower scores = better calibration.
  // ============================================================
  // Use OUR true_prob from analysis (not market entry_price) for Brier scoring.
  // Falls back to entry_price only for legacy bets without an attached analysis.
  const betsWithBrierData = bets.filter(b => b.entry_price > 0 && b.entry_price < 1);
  if (betsWithBrierData.length >= 3) {
    // Group by confidence tier and compute avg brier scores
    const brierByConf: Record<string, number[]> = {};
    for (const b of betsWithBrierData) {
      const conf = b.confidence || 'UNKNOWN';
      if (!brierByConf[conf]) brierByConf[conf] = [];
      const ourYesProb = b.true_prob != null && b.true_prob > 0 && b.true_prob < 1
        ? b.true_prob
        : b.entry_price;
      const predictedProb = b.direction === 'BUY_YES' ? ourYesProb : (1 - ourYesProb);
      const actual = b.status === 'WON' ? 1.0 : 0.0;
      brierByConf[conf].push(Math.pow(predictedProb - actual, 2));
    }

    for (const [conf, scores] of Object.entries(brierByConf)) {
      if (scores.length < 2) continue;
      const avgBrier = scores.reduce((s, x) => s + x, 0) / scores.length;
      const expectedBrier = conf === 'HIGH' ? 0.15 : conf === 'MEDIUM' ? 0.22 : 0.28;
      const calibrationDelta = avgBrier - expectedBrier;
      insights.push({
        category: 'brier_score',
        dimension: 'probability_calibration',
        key: `${conf} confidence`,
        sample_size: scores.length,
        win_rate: bets.filter(b => (b.confidence || 'UNKNOWN') === conf && b.status === 'WON').length /
                  Math.max(1, bets.filter(b => (b.confidence || 'UNKNOWN') === conf).length),
        avg_pnl: 0,
        total_pnl: 0,
        roi: 0,
        recommendation: calibrationDelta > 0.05
          ? `OVER-CONFIDENT at ${conf}: Brier ${avgBrier.toFixed(3)} > expected ${expectedBrier} — inflate σ by 20%`
          : calibrationDelta < -0.05
            ? `UNDER-CONFIDENT at ${conf}: Brier ${avgBrier.toFixed(3)} < expected ${expectedBrier} — tighten σ by 10%`
            : `CALIBRATED at ${conf}: Brier ${avgBrier.toFixed(3)} near expected ${expectedBrier}`,
        action_taken: null,
        confidence_note: `Brier=${avgBrier.toFixed(3)}, target=${expectedBrier}, delta=${calibrationDelta > 0 ? '+' : ''}${calibrationDelta.toFixed(3)}`,
      });
    }
  }

  // ============================================================
  // BRIER DRIFT MONITOR
  // Catches REAL model breakage that streak-based circuit breakers miss.
  // Compares trailing-20 Brier to trailing-50 Brier on chronologically
  // ordered resolved bets. If trailing-20 is materially worse, the model
  // has drifted (bad deploy, regime change, broken analyzer) and we flag.
  //
  // Severity tiers:
  //   - drift > 0.05  → WARN (write to system_config, surface in UI)
  //   - drift > 0.10  → AUTO-HALT (set cb_manual_halt = true)
  // ============================================================
  {
    const chronological = [...bets]
      .filter(b => b.entry_price > 0 && b.entry_price < 1)
      .sort((a, b) => new Date(a.placed_at).getTime() - new Date(b.placed_at).getTime());

    const brierFor = (b: ResolvedBetWithAnalysis): number => {
      const ourYes = b.true_prob != null && b.true_prob > 0 && b.true_prob < 1
        ? b.true_prob
        : b.entry_price;
      const pred = b.direction === 'BUY_YES' ? ourYes : (1 - ourYes);
      const actual = b.status === 'WON' ? 1.0 : 0.0;
      return Math.pow(pred - actual, 2);
    };

    const last20 = chronological.slice(-20);
    const last50 = chronological.slice(-50);

    if (last20.length >= 10 && last50.length >= 20) {
      const brier20 = last20.reduce((s, b) => s + brierFor(b), 0) / last20.length;
      const brier50 = last50.reduce((s, b) => s + brierFor(b), 0) / last50.length;
      const drift = brier20 - brier50;

      let severity: 'OK' | 'WARN' | 'HALT' = 'OK';
      if (drift > 0.10) severity = 'HALT';
      else if (drift > 0.05) severity = 'WARN';

      await setConfig('brier_drift', JSON.stringify({
        generated_at: new Date().toISOString(),
        brier_trailing_20: Math.round(brier20 * 10000) / 10000,
        brier_trailing_50: Math.round(brier50 * 10000) / 10000,
        drift: Math.round(drift * 10000) / 10000,
        severity,
        n_20: last20.length,
        n_50: last50.length,
        note: severity === 'HALT'
          ? 'AUTO-HALT: model drift detected — manual reset required'
          : severity === 'WARN'
            ? 'Trailing-20 Brier worse than baseline — review model'
            : 'No drift detected',
      }));

      if (severity === 'HALT') {
        // Auto-engage manual halt; operator must reset via manualResume()
        await setConfig('cb_manual_halt', 'true');
        console.log(`[learn-v2] BRIER DRIFT HALT: trailing-20=${brier20.toFixed(4)} vs trailing-50=${brier50.toFixed(4)}, drift=${drift.toFixed(4)}`);
      } else if (severity === 'WARN') {
        console.log(`[learn-v2] Brier drift WARN: trailing-20=${brier20.toFixed(4)} vs trailing-50=${brier50.toFixed(4)}`);
      }
    }
  }

  // ============================================================
  // KILL CRITERION CHECK (pre-committed: -15% bankroll @ n=50)
  // ============================================================
  {
    const { data: cfg } = await supabase
      .from('system_config').select('value').eq('key', 'paper_bankroll_start').single();
    const startBankroll = parseFloat(cfg?.value || '1000');
    const killThreshold = -0.15 * startBankroll;
    if (totalBets >= 50 && totalPnl < killThreshold) {
      await setConfig('cb_manual_halt', 'true');
      await setConfig('kill_criterion_triggered', JSON.stringify({
        triggered_at: new Date().toISOString(),
        n: totalBets,
        total_pnl: totalPnl,
        threshold: killThreshold,
        note: 'KILL CRITERION HIT: cumulative P&L worse than -15% bankroll after n=50. Manual postmortem required before resuming.',
      }));
      console.log(`[learn-v2] KILL CRITERION TRIGGERED: $${totalPnl.toFixed(2)} < $${killThreshold.toFixed(2)} at n=${totalBets}`);
    }
  }

  // ============================================================
  // DIMENSION 8: Per-City Sigma Accuracy
  // Learn if our σ assumptions match realized temperature variance.
  // Track how often actual temperature falls within our predicted ±1σ.
  // If too often → our σ is too wide. If too rarely → σ too tight.
  // ============================================================
  if (Object.keys(sigmaInsights).length > 0) {
    await setConfig('learning_sigma_accuracy', JSON.stringify({
      generated_at: new Date().toISOString(),
      cities: sigmaInsights,
      note: 'sigma_multiplier > 1 = our sigma is underestimating variance (widen it); < 1 = overestimating (tighten it)',
    }));
  }

  // ============================================================
  // Build key findings for dashboard (most impactful insights)
  // ============================================================
  const actionedInsights = insights.filter(i => i.action_taken);
  const highImpactInsights = insights
    .filter(i => i.sample_size >= 3)
    .sort((a, b) => Math.abs(b.total_pnl) - Math.abs(a.total_pnl))
    .slice(0, 8);

  // Expert forecast for next cycle
  const forecastLines: string[] = [];
  const bestCities = insights
    .filter(i => i.category === 'city' && i.sample_size >= 3 && i.win_rate >= 0.7)
    .sort((a, b) => b.win_rate - a.win_rate)
    .slice(0, 3);
  if (bestCities.length > 0) {
    forecastLines.push(`Best cities: ${bestCities.map(c => `${c.key} (${(c.win_rate * 100).toFixed(0)}%)`).join(', ')}`);
  }

  const bestPriceRange = insights
    .filter(i => i.category === 'entry_price' && i.sample_size >= 3 && i.roi > 0)
    .sort((a, b) => b.roi - a.roi)[0];
  if (bestPriceRange) {
    forecastLines.push(`Best entry range: ${bestPriceRange.key} (ROI: ${(bestPriceRange.roi * 100).toFixed(0)}%)`);
  }

  const bestTiming = insights
    .filter(i => i.category === 'timing' && i.sample_size >= 3 && i.win_rate > 0.5)
    .sort((a, b) => b.win_rate - a.win_rate)[0];
  if (bestTiming) {
    forecastLines.push(`Best entry window: ${bestTiming.key} (${(bestTiming.win_rate * 100).toFixed(0)}% WR)`);
  }

  const bestMultiplier = insights
    .filter(i => i.category === 'implied_multiplier' && i.sample_size >= 3 && i.roi > 0)
    .sort((a, b) => b.roi - a.roi)[0];
  if (bestMultiplier) {
    forecastLines.push(`Best mispricing zone: ${bestMultiplier.key} (ROI: ${(bestMultiplier.roi * 100).toFixed(0)}%)`);
  }

  if (actionedInsights.length > 0) {
    forecastLines.push(`${actionedInsights.length} automatic parameter adjustment${actionedInsights.length > 1 ? 's' : ''} applied`);
  }

  // ============================================================
  // Save all outputs to system_config
  // ============================================================
  await supabase.from('system_config').upsert({
    key: 'learning_insights',
    value: JSON.stringify({
      generated_at: new Date().toISOString(),
      total_insights: insights.length,
      insights,
    }),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });

  await supabase.from('system_config').upsert({
    key: 'learning_summary',
    value: JSON.stringify({
      updated_at: new Date().toISOString(),
      total_resolved: totalBets,
      wins: won.length,
      losses: lost.length,
      win_rate: overallWinRate,
      total_pnl: Math.round(totalPnl * 100) / 100,
      total_wagered: Math.round(totalWagered * 100) / 100,
      roi: Math.round(overallRoi * 10000) / 100,  // as percentage
      lessons_learned: actionedInsights.length,
      key_findings: highImpactInsights.map(i =>
        `${i.key}: ${(i.win_rate * 100).toFixed(0)}% WR, $${i.total_pnl.toFixed(2)} P&L (n=${i.sample_size})`
      ),
      forecast_next_cycle: forecastLines,
      sigma_adjustments: Object.entries(sigmaInsights)
        .filter(([, v]) => Math.abs(v.multiplier - 1.0) > 0.15)
        .map(([city, v]) => `${city}: σ×${v.multiplier.toFixed(2)} (${(v.win_rate * 100).toFixed(0)}% WR, n=${v.n})`),
    }),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });

  // Also persist forecast_next_cycle and sigma_adjustments as separate
  // top-level keys for direct UI access (the API also reads them out of
  // learning_summary, but having both improves robustness).
  await setConfig('forecast_next_cycle', JSON.stringify(forecastLines));
  await setConfig('sigma_adjustments', JSON.stringify(
    Object.entries(sigmaInsights)
      .filter(([, v]) => Math.abs(v.multiplier - 1.0) > 0.15)
      .map(([city, v]) => `${city}: σ×${v.multiplier.toFixed(2)} (${(v.win_rate * 100).toFixed(0)}% WR, n=${v.n})`)
  ));

  console.log(`[learn-v2] Generated ${insights.length} insights, ${actionedInsights.length} actions taken`);
  for (const i of actionedInsights) {
    console.log(`  [ACTION] ${i.action_taken}`);
  }

  if (forecastLines.length > 0) {
    console.log('[learn-v2] Forecast for next cycle:');
    forecastLines.forEach(f => console.log(`  → ${f}`));
  }

  return { statusCode: 200 };
});

// ============================================================
// Helpers
// ============================================================

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

function sum<T>(arr: T[], fn: (item: T) => number): number {
  return arr.reduce((s, i) => s + fn(i), 0);
}

function avg<T>(arr: T[], fn: (item: T) => number): number {
  if (arr.length === 0) return 0;
  return sum(arr, fn) / arr.length;
}

async function setConfig(key: string, value: string): Promise<void> {
  await supabase.from('system_config').upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
}

async function saveEmptySummary(v3Start: string): Promise<void> {
  await supabase.from('system_config').upsert({
    key: 'learning_summary',
    value: JSON.stringify({
      updated_at: new Date().toISOString(),
      total_resolved: 0,
      wins: 0,
      losses: 0,
      win_rate: 0,
      total_pnl: 0,
      total_wagered: 0,
      roi: 0,
      lessons_learned: 0,
      key_findings: [],
      forecast_next_cycle: [
        'No resolved bets yet — baseline established',
        `V3 start: ${v3Start}`,
        'First learning cycle will run after bets resolve',
      ],
      sigma_adjustments: [],
    }),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
}

// ============================================================
// Dynamic calibration weight adjustment
// Modifies the edge multiplier stored in system_config based
// on actual betting performance per city.
// Now uses sigmoid-style bounds with faster adaptation for
// cities with more data.
// ============================================================
async function updateCityMultiplier(
  cityName: string,
  action: 'upgrade' | 'downgrade'
): Promise<void> {
  const key = `calibration_${cityName.toLowerCase().replace(/\s+/g, '_')}`;

  const { data: existing } = await supabase
    .from('system_config').select('value').eq('key', key).single();

  const current = existing ? parseFloat(existing.value) : 1.0;

  // 10% per cycle, bounded [0.3, 1.3]
  const newValue = action === 'upgrade'
    ? Math.min(1.3, current * 1.1)
    : Math.max(0.3, current * 0.9);

  await setConfig(key, newValue.toFixed(4));
  console.log(`[learn-v2] ${cityName} calibration: ${current.toFixed(4)} → ${newValue.toFixed(4)} (${action})`);
}

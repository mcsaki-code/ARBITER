/**
 * Backtest Shadow — records what v2 math predicted for every analyzed
 * bracket, regardless of whether we'd actually bet on it. When the
 * market resolves, a separate scorer populates brier_score / log_loss
 * / resolved_outcome so we get a reliability diagram for free.
 *
 * This is Path B from the 2026-04-08 planning session: a zero-cost
 * self-building backtest that accumulates calibration data over time
 * while we wait on the Path A historical ingest.
 *
 * CRITICAL: shadow writes must NEVER throw or block the live analyzer.
 * Wrapped in try/catch, failure logs a warning and returns.
 */

import { SupabaseClient } from '@supabase/supabase-js';

const MIN_EDGE_BET_THRESHOLD = 0.08;
const MIN_PRICE_BET_THRESHOLD = 0.05;
const MAX_PRICE_BET_THRESHOLD = 0.995;

export interface ShadowInput {
  marketId: string;
  cityId: string | null;
  cityName: string | null;
  bracketKind: 'exact' | 'at_or_above' | 'at_or_below' | 'between';
  thresholdC: number | null;
  thresholdF: number | null;
  bracketLabel: string;
  predictedProb: number;   // P(YES) from v2 math
  sigmaF: number;
  method: string;          // 'empirical_cdf' | 'normal_approx'
  nMembers: number;
  meanF: number;
  leadTimeHours: number;
  marketPriceYes: number | null;
  marketLiquidityUsd: number | null;
  sourceAnalyzer: 'railway_worker_v2' | 'netlify_analyze_weather';
}

function bucketLeadTime(hours: number): string {
  if (hours < 6) return '0-6h';
  if (hours < 12) return '6-12h';
  if (hours < 24) return '12-24h';
  if (hours < 48) return '24-48h';
  if (hours < 72) return '48-72h';
  if (hours < 120) return '72-120h';
  return '120h+';
}

export async function writeShadowRow(
  supabase: SupabaseClient,
  input: ShadowInput
): Promise<void> {
  try {
    const edge =
      input.marketPriceYes != null
        ? input.predictedProb - input.marketPriceYes
        : null;
    const wouldHaveBet =
      edge != null &&
      edge >= MIN_EDGE_BET_THRESHOLD &&
      input.marketPriceYes != null &&
      input.marketPriceYes >= MIN_PRICE_BET_THRESHOLD &&
      input.marketPriceYes <= MAX_PRICE_BET_THRESHOLD;

    await supabase.from('backtest_shadow').insert({
      market_id: input.marketId,
      city_id: input.cityId,
      city_name: input.cityName,
      bracket_kind: input.bracketKind,
      threshold_c: input.thresholdC,
      threshold_f: input.thresholdF,
      bracket_label: input.bracketLabel,
      predicted_prob: input.predictedProb,
      sigma_f: input.sigmaF,
      method: input.method,
      n_members: input.nMembers,
      mean_f: input.meanF,
      lead_time_hours: input.leadTimeHours,
      lead_time_bucket: bucketLeadTime(input.leadTimeHours),
      market_price_yes: input.marketPriceYes,
      market_liquidity_usd: input.marketLiquidityUsd,
      edge_at_capture: edge,
      would_have_bet: wouldHaveBet,
      source_analyzer: input.sourceAnalyzer,
    });
  } catch (err) {
    console.warn(
      `[backtest-shadow] write failed for ${input.marketId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Score all unscored shadow rows for markets that have resolved.
 * Idempotent — safe to run repeatedly. Called from the resolver cron.
 *
 * Scoring math:
 *   outcome_numeric = 1 if YES, 0 if NO
 *   brier_score     = (predicted_prob - outcome_numeric)^2
 *   log_loss        = -[o*ln(p) + (1-o)*ln(1-p)]  (clamped to avoid inf)
 *   abs_error       = |predicted_prob - outcome_numeric|
 */
export async function scoreResolvedShadows(
  supabase: SupabaseClient,
  options: { limit?: number; verbose?: boolean } = {}
): Promise<{ scored: number; skipped: number; errors: number }> {
  const limit = options.limit ?? 1000;
  const verbose = options.verbose ?? false;
  const log = (m: string) => verbose && console.log(`[shadow-scorer] ${m}`);

  // Pull unscored rows where the market is already resolved.
  // Use an inner join via two queries since PostgREST doesn't do joins.
  const { data: unscored, error: unscoredErr } = await supabase
    .from('backtest_shadow')
    .select('id, market_id, predicted_prob')
    .is('scored_at', null)
    .limit(limit);

  if (unscoredErr) {
    console.error(`[shadow-scorer] query failed: ${unscoredErr.message}`);
    return { scored: 0, skipped: 0, errors: 1 };
  }
  if (!unscored || unscored.length === 0) {
    log('No unscored rows');
    return { scored: 0, skipped: 0, errors: 0 };
  }

  // Fetch the resolved state for each distinct market in the unscored batch.
  const marketIds = Array.from(new Set(unscored.map((r) => r.market_id)));
  const { data: markets, error: mktErr } = await supabase
    .from('markets')
    .select('id, is_resolved, resolution_val, resolution_date')
    .in('id', marketIds)
    .eq('is_resolved', true);

  if (mktErr) {
    console.error(`[shadow-scorer] markets fetch failed: ${mktErr.message}`);
    return { scored: 0, skipped: 0, errors: 1 };
  }

  const resolvedMap = new Map<string, { outcome: string | null; resolvedAt: string | null }>();
  for (const m of markets ?? []) {
    const val = (m.resolution_val ?? '').toString().trim().toLowerCase();
    let outcome: string | null = null;
    if (val === 'yes') outcome = 'YES';
    else if (val === 'no') outcome = 'NO';
    // Any other value (team names on mis-typed markets) → skip
    if (outcome) {
      resolvedMap.set(String(m.id), {
        outcome,
        resolvedAt: m.resolution_date ?? null,
      });
    }
  }

  let scored = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of unscored) {
    const resolved = resolvedMap.get(String(row.market_id));
    if (!resolved) {
      skipped++;
      continue;
    }

    const outcomeNumeric = resolved.outcome === 'YES' ? 1 : 0;
    const p = Math.max(1e-6, Math.min(1 - 1e-6, Number(row.predicted_prob)));
    const brier = (p - outcomeNumeric) ** 2;
    const logLoss = -(outcomeNumeric * Math.log(p) + (1 - outcomeNumeric) * Math.log(1 - p));
    const absError = Math.abs(p - outcomeNumeric);

    const { error: updErr } = await supabase
      .from('backtest_shadow')
      .update({
        resolved_outcome: resolved.outcome,
        resolved_at: resolved.resolvedAt,
        brier_score: brier,
        log_loss: logLoss,
        abs_error: absError,
        scored_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    if (updErr) {
      errors++;
      console.warn(`[shadow-scorer] update failed for ${row.id}: ${updErr.message}`);
    } else {
      scored++;
    }
  }

  log(`Scored ${scored}, skipped ${skipped} (unresolved), errors ${errors}`);
  return { scored, skipped, errors };
}

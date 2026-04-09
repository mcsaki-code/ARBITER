import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET /api/backtest
// Returns reliability/calibration data from the backtest_shadow table.
//
// Response shape:
// {
//   summary: {
//     total_captured: number,
//     total_scored: number,
//     avg_brier: number,          // closer to 0 = better
//     avg_log_loss: number,
//     avg_abs_error: number,
//     would_have_bet_count: number,
//     would_have_bet_win_rate: number | null,  // among scored
//     perfect_calibration_brier: 0.25,          // max-uncertainty reference
//   },
//   reliability: [
//     { bucket_low: 0.0, bucket_high: 0.1, n: 12, mean_predicted: 0.05, observed_yes_rate: 0.08 },
//     ...
//   ],
//   by_lead_time: [
//     { lead_time_bucket: '0-6h', n: 30, avg_brier: 0.09, ... },
//     ...
//   ],
//   by_city: [
//     { city_name: 'Seattle', n: 18, avg_brier: 0.12, ... },
//     ...
//   ],
//   recent_scored: [ ...last 20 scored rows ]
// }
export async function GET() {
  const supabase = getSupabaseAdmin();

  const { data: allRows, error } = await supabase
    .from('backtest_shadow')
    .select(
      'id, market_id, city_name, predicted_prob, market_price_yes, would_have_bet, lead_time_bucket, method, n_members, sigma_f, resolved_outcome, brier_score, log_loss, abs_error, scored_at, captured_at'
    )
    .order('captured_at', { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = allRows ?? [];
  const scored = rows.filter((r) => r.scored_at != null && r.brier_score != null);

  // ── Summary ─────────────────────────────────────────────
  const totalCaptured = rows.length;
  const totalScored = scored.length;
  const avgBrier = totalScored > 0
    ? scored.reduce((s, r) => s + Number(r.brier_score), 0) / totalScored
    : null;
  const avgLogLoss = totalScored > 0
    ? scored.reduce((s, r) => s + Number(r.log_loss ?? 0), 0) / totalScored
    : null;
  const avgAbsError = totalScored > 0
    ? scored.reduce((s, r) => s + Number(r.abs_error ?? 0), 0) / totalScored
    : null;

  const wouldHaveBet = rows.filter((r) => r.would_have_bet === true);
  const wouldHaveBetScored = wouldHaveBet.filter((r) => r.scored_at != null);
  const wouldHaveBetWins = wouldHaveBetScored.filter((r) => {
    const pred = Number(r.predicted_prob);
    const correctDirection = pred > 0.5 ? r.resolved_outcome === 'YES' : r.resolved_outcome === 'NO';
    return correctDirection;
  }).length;
  const wouldHaveBetWinRate = wouldHaveBetScored.length > 0
    ? wouldHaveBetWins / wouldHaveBetScored.length
    : null;

  // ── Reliability diagram (10 buckets of predicted prob) ──
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    bucket_low: i / 10,
    bucket_high: (i + 1) / 10,
    n: 0,
    sum_predicted: 0,
    sum_observed: 0,
  }));
  for (const r of scored) {
    const p = Number(r.predicted_prob);
    const idx = Math.min(9, Math.floor(p * 10));
    buckets[idx].n += 1;
    buckets[idx].sum_predicted += p;
    buckets[idx].sum_observed += r.resolved_outcome === 'YES' ? 1 : 0;
  }
  const reliability = buckets.map((b) => ({
    bucket_low: b.bucket_low,
    bucket_high: b.bucket_high,
    n: b.n,
    mean_predicted: b.n > 0 ? b.sum_predicted / b.n : null,
    observed_yes_rate: b.n > 0 ? b.sum_observed / b.n : null,
  }));

  // ── Group by lead time bucket ───────────────────────────
  const leadGroups = new Map<string, { n: number; brier: number; logLoss: number; absErr: number }>();
  for (const r of scored) {
    const k = r.lead_time_bucket ?? 'unknown';
    const g = leadGroups.get(k) ?? { n: 0, brier: 0, logLoss: 0, absErr: 0 };
    g.n += 1;
    g.brier += Number(r.brier_score);
    g.logLoss += Number(r.log_loss ?? 0);
    g.absErr += Number(r.abs_error ?? 0);
    leadGroups.set(k, g);
  }
  const byLeadTime = Array.from(leadGroups.entries())
    .map(([k, g]) => ({
      lead_time_bucket: k,
      n: g.n,
      avg_brier: g.brier / g.n,
      avg_log_loss: g.logLoss / g.n,
      avg_abs_error: g.absErr / g.n,
    }))
    .sort((a, b) => a.lead_time_bucket.localeCompare(b.lead_time_bucket));

  // ── Group by city ───────────────────────────────────────
  const cityGroups = new Map<string, { n: number; brier: number; logLoss: number; absErr: number }>();
  for (const r of scored) {
    const k = r.city_name ?? 'unknown';
    const g = cityGroups.get(k) ?? { n: 0, brier: 0, logLoss: 0, absErr: 0 };
    g.n += 1;
    g.brier += Number(r.brier_score);
    g.logLoss += Number(r.log_loss ?? 0);
    g.absErr += Number(r.abs_error ?? 0);
    cityGroups.set(k, g);
  }
  const byCity = Array.from(cityGroups.entries())
    .map(([k, g]) => ({
      city_name: k,
      n: g.n,
      avg_brier: g.brier / g.n,
      avg_log_loss: g.logLoss / g.n,
      avg_abs_error: g.absErr / g.n,
    }))
    .sort((a, b) => b.n - a.n);

  return NextResponse.json({
    summary: {
      total_captured: totalCaptured,
      total_scored: totalScored,
      avg_brier: avgBrier,
      avg_log_loss: avgLogLoss,
      avg_abs_error: avgAbsError,
      would_have_bet_count: wouldHaveBet.length,
      would_have_bet_scored_count: wouldHaveBetScored.length,
      would_have_bet_win_rate: wouldHaveBetWinRate,
      perfect_calibration_brier_reference: 0.25,
    },
    reliability,
    by_lead_time: byLeadTime,
    by_city: byCity,
    recent_scored: scored.slice(0, 20),
  });
}

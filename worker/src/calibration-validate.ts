/**
 * Phase A.5 — Calibration Validation Script
 *
 * Compares what calibrated vs uncalibrated probability math would produce
 * on resolved shadow data, to validate whether calibration improves accuracy
 * before enabling it in production.
 *
 * Loads calibration tables DIRECTLY (bypasses the calibration_enabled flag)
 * so we can simulate what would happen with calibration turned on.
 *
 * Usage:  npm run validate:calibration
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { blendSigma } from './calibration-lookup';

// ── Supabase setup ─────────────────────────────────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('[validate] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key);

// ── Types ──────────────────────────────────────────────────────────────
interface ShadowRow {
  id: string;
  market_id: string;
  city_id: string | null;
  predicted_prob: number;
  sigma_f: number | null;
  mean_f: number | null;
  n_members: number | null;
  method: string | null;
  lead_time_hours: number | null;
  market_price_yes: number | null;
  resolved_outcome: string | null;
  captured_at: string;
}

interface SigmaEntry {
  sigma_f: number;
  n: number;
}

// ── Helpers ────────────────────────────────────────────────────────────
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function clampLead(leadDays: number): number {
  const buckets = [0, 1, 2, 3, 5, 7];
  let best = buckets[0];
  let bestDiff = Math.abs(leadDays - best);
  for (const b of buckets) {
    const d = Math.abs(leadDays - b);
    if (d < bestDiff) { best = b; bestDiff = d; }
  }
  return best;
}

function sigmaFloorForHours(h: number): number {
  if (h <= 6) return 0.8;
  if (h <= 12) return 1.2;
  if (h <= 24) return 1.8;
  if (h <= 48) return 2.5;
  if (h <= 72) return 3.2;
  return 4.0;
}

// ── Load sigma table directly (bypass feature flag) ────────────────────
async function loadSigmaMap(sb: SupabaseClient): Promise<Map<string, SigmaEntry>> {
  const map = new Map<string, SigmaEntry>();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('weather_calibration_sigma')
      .select('city_id, lead_days, month, empirical_sigma_f, n')
      .range(from, from + PAGE - 1);
    if (error) { console.warn('[validate] sigma load error:', error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data) {
      map.set(`${r.city_id}|${r.lead_days}|${r.month}`, {
        sigma_f: Number(r.empirical_sigma_f),
        n: Number(r.n),
      });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// ── Compute calibrated probability ─────────────────────────────────────
function calibrateProb(
  uncalProb: number,
  sampleSigma: number,
  leadHours: number,
  cityId: string,
  month: number,
  sigmaMap: Map<string, SigmaEntry>
): { prob: number; hadCalData: boolean } {
  const leadDays = clampLead(Math.round(leadHours / 24));
  const key = `${cityId}|${leadDays}|${month}`;
  const entry = sigmaMap.get(key);

  if (!entry || entry.n < 20) {
    return { prob: uncalProb, hadCalData: false };
  }

  const floor = sigmaFloorForHours(leadHours);
  const baseline = Math.max(sampleSigma, floor);
  const { sigma: blended } = blendSigma(sampleSigma, floor, entry.sigma_f, entry.n);

  // Ratio adjustment: if empirical spread is wider than what we assumed,
  // pull toward 0.5 (less confident). If narrower, push away (more confident).
  const factor = baseline / blended;
  const calProb = 0.5 + (uncalProb - 0.5) * factor;
  return { prob: clamp(calProb, 0.01, 0.99), hadCalData: true };
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('[validate] Loading calibration sigma table…');
  const sigmaMap = await loadSigmaMap(supabase);
  console.log(`[validate] Loaded ${sigmaMap.size} sigma entries`);

  // Fetch resolved shadow rows
  const { data: rows, error } = await supabase
    .from('backtest_shadow')
    .select(
      'id, market_id, city_id, predicted_prob, sigma_f, mean_f, n_members, ' +
      'method, lead_time_hours, market_price_yes, resolved_outcome, captured_at'
    )
    .not('resolved_outcome', 'is', null)
    .order('captured_at', { ascending: false });

  if (error) {
    console.error('[validate] Query error:', error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log('[validate] No resolved shadow rows yet. Run again later.');
    process.exit(0);
  }

  console.log(`[validate] Found ${rows.length} resolved shadow rows`);

  if (rows.length < 5) {
    console.log(`[validate] Need at least 5 resolved rows (have ${rows.length}). Run again later.`);
    process.exit(0);
  }
  if (rows.length < 30) {
    console.log(`[validate] NOTE: ${rows.length} rows is directional only (need 30+ for statistical confidence)`);
  }

  // Score each row
  let nWithCal = 0;
  const uncalBriers: number[] = [];
  const calBriers: number[] = [];
  const mktBriers: number[] = [];
  const naiveBriers: number[] = [];

  for (const row of (rows as unknown as ShadowRow[])) {
    const outcome = row.resolved_outcome === 'YES' ? 1 : 0;
    const uncalProb = clamp(row.predicted_prob, 0.01, 0.99);

    // Uncalibrated Brier
    uncalBriers.push((uncalProb - outcome) ** 2);

    // Market price Brier
    if (row.market_price_yes != null) {
      const mp = clamp(Number(row.market_price_yes), 0.01, 0.99);
      mktBriers.push((mp - outcome) ** 2);
    }

    // Naive 0.5 baseline
    naiveBriers.push(0.25);

    // Calibrated Brier
    if (row.city_id && row.lead_time_hours != null && row.sigma_f != null) {
      const month = new Date(row.captured_at).getUTCMonth() + 1;
      const { prob: calProb, hadCalData } = calibrateProb(
        uncalProb,
        Number(row.sigma_f),
        Number(row.lead_time_hours),
        row.city_id,
        month,
        sigmaMap
      );
      calBriers.push((calProb - outcome) ** 2);
      if (hadCalData) nWithCal++;
    } else {
      // No metadata to calibrate — fall through to uncalibrated
      calBriers.push((uncalProb - outcome) ** 2);
    }
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const meanUncal = avg(uncalBriers);
  const meanCal = avg(calBriers);
  const meanMkt = mktBriers.length > 0 ? avg(mktBriers) : NaN;
  const improvement = meanUncal > 0 ? ((meanUncal - meanCal) / meanUncal) * 100 : 0;

  const verdict = meanCal <= meanUncal
    ? 'PASS — calibration does not harm accuracy'
    : 'FAIL — calibration worsens accuracy';

  // ── Report ─────────────────────────────────────────────────────────
  console.log('');
  console.log('═'.repeat(65));
  console.log('  CALIBRATION VALIDATION RESULTS');
  console.log('═'.repeat(65));
  console.log(`  Resolved rows:          ${rows.length}`);
  console.log(`  Rows with cal data:     ${nWithCal} / ${rows.length}`);
  console.log('─'.repeat(65));
  console.log(`  Brier (naive 0.5):      ${(0.25).toFixed(4)}`);
  if (!isNaN(meanMkt)) {
    console.log(`  Brier (market price):   ${meanMkt.toFixed(4)}`);
  }
  console.log(`  Brier (uncalibrated):   ${meanUncal.toFixed(4)}`);
  console.log(`  Brier (calibrated):     ${meanCal.toFixed(4)}`);
  console.log('─'.repeat(65));
  console.log(`  Improvement:            ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}%`);
  console.log(`  Verdict:                ${verdict}`);
  console.log('═'.repeat(65));
  console.log('');

  process.exit(0);
}

main().catch((err) => {
  console.error('[validate] FATAL:', err);
  process.exit(1);
});

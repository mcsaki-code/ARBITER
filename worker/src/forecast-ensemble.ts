// ============================================================
// ARBITER — Forecast Ensemble Probability Library
// ============================================================
// Computes bracket probability DIRECTLY from a forecast member
// distribution — the math that gopfan2, suislanchez, and every
// profitable Polymarket weather bot actually use.
//
// Core idea: the LLM is a probability GENERATOR (creative,
// hallucinates). A forecast ensemble is a probability MEASUREMENT
// (what fraction of credible models put the high in this bucket).
// For tail bets at 5-15¢ entries, a 2% error in true_prob flips
// EV from positive to negative — so we need measurement, not
// generation.
//
// Two modes:
//   1. Empirical CDF (n ≥ 5 members): Laplace-smoothed count
//   2. Normal approximation (n < 5): Φ((H-μ)/σ) - Φ((L-μ)/σ)
//      with σ floored by climatology-derived minimum (lead-time
//      adjusted, mirrors getDynamicSigma in analyze-weather.ts).
//
// Sources for the methodology:
//   - https://github.com/suislanchez/polymarket-kalshi-weather-bot
//     (31-member GFS ensemble, count fraction in bucket)
//   - https://dev.to/cryptodeploy/how-polymarket-weather-markets-actually-work-50nb
//     (timing: mispricings live in post-model-release windows)
// ============================================================

export interface ForecastMember {
  source: string;              // 'nws' | 'gfs' | 'ecmwf' | 'icon' | 'hrrr' | 'ensemble' | ...
  temp_high_f: number;
}

export interface BracketRange {
  low_f: number | null;   // inclusive lower bound; null = -∞
  high_f: number | null;  // exclusive upper bound; null = +∞
  kind: 'exact' | 'at_or_above' | 'at_or_below' | 'between';
  label: string;
}

export interface ForecastProbabilityResult {
  probability: number;         // 0-1, Laplace-smoothed
  method: 'empirical' | 'normal' | 'degenerate';
  n_members: number;
  mean_f: number;
  sigma_f: number;             // effective sigma used
  members_in_bracket: number;  // for empirical mode
  sigma_source: 'sample' | 'floor' | 'blend';
}

// ── Normal CDF (Abramowitz & Stegun 26.2.17, ~7.5e-8 accuracy) ──
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// ── Climatological sigma floor, lead-time aware ────────────────
// Short lead times have tighter forecasts but small n inflates
// sample-std noise. Use this as a floor so a lucky 3-member
// agreement doesn't produce an artificially confident prob.
// Matches getDynamicSigma() in analyze-weather.ts for consistency.
export function getDynamicSigmaFloor(hoursRemaining: number): number {
  if (hoursRemaining <= 6) return 0.8;
  if (hoursRemaining <= 12) return 1.2;
  if (hoursRemaining <= 24) return 1.8;
  if (hoursRemaining <= 48) return 2.5;
  if (hoursRemaining <= 72) return 3.2;
  return 4.0;
}

// ── Sample statistics ─────────────────────────────────────────
function sampleStats(values: number[]): { mean: number; std: number } {
  const n = values.length;
  if (n === 0) return { mean: NaN, std: NaN };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, std: 0 };
  // Bessel-corrected sample std
  const sq = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const std = Math.sqrt(sq / (n - 1));
  return { mean, std };
}

// ── Main entrypoint ───────────────────────────────────────────
export function computeBracketProbability(
  members: ForecastMember[],
  bracket: BracketRange,
  hoursRemaining: number
): ForecastProbabilityResult {
  const values = members.map((m) => m.temp_high_f).filter((v) => Number.isFinite(v));
  const n = values.length;

  if (n === 0) {
    return {
      probability: 0.5,
      method: 'degenerate',
      n_members: 0,
      mean_f: NaN,
      sigma_f: NaN,
      members_in_bracket: 0,
      sigma_source: 'floor',
    };
  }

  const { mean, std: sampleStd } = sampleStats(values);
  const sigmaFloor = getDynamicSigmaFloor(hoursRemaining);

  // Empirical CDF with Laplace smoothing — only used with ≥5 distinct models.
  // Count is smoothed as (k + 1) / (n + 2) to prevent 0 or 1 extremes that
  // would make Kelly sizing blow up on tiny samples.
  if (n >= 5) {
    const hits = values.filter((v) => inBracket(v, bracket)).length;
    const smoothed = (hits + 1) / (n + 2);
    return {
      probability: clamp(smoothed, 0.01, 0.99),
      method: 'empirical',
      n_members: n,
      mean_f: mean,
      sigma_f: Math.max(sampleStd, sigmaFloor),
      members_in_bracket: hits,
      sigma_source: sampleStd >= sigmaFloor ? 'sample' : 'floor',
    };
  }

  // Normal approximation: use the mean as center, blend sample std with
  // floor. For 2-4 members, sample std is too noisy to trust on its own;
  // but if models strongly disagree we want to respect that, so use max.
  const sigma = Math.max(sampleStd, sigmaFloor);
  const sigmaSource: 'sample' | 'floor' | 'blend' =
    sampleStd >= sigmaFloor ? 'sample' : 'floor';

  const prob = normalBracketProb(mean, sigma, bracket);

  return {
    probability: clamp(prob, 0.01, 0.99),
    method: 'normal',
    n_members: n,
    mean_f: mean,
    sigma_f: sigma,
    members_in_bracket: values.filter((v) => inBracket(v, bracket)).length,
    sigma_source: sigmaSource,
  };
}

// ── Bracket membership (inclusive low, exclusive high) ──────────
function inBracket(v: number, b: BracketRange): boolean {
  if (b.low_f !== null && v < b.low_f) return false;
  if (b.high_f !== null && v >= b.high_f) return false;
  return true;
}

// ── Normal approximation: P(low ≤ T < high) ────────────────────
function normalBracketProb(mean: number, sigma: number, b: BracketRange): number {
  if (sigma <= 0) return inBracket(mean, b) ? 0.99 : 0.01;
  const lowCdf = b.low_f === null ? 0 : normalCdf((b.low_f - mean) / sigma);
  const highCdf = b.high_f === null ? 1 : normalCdf((b.high_f - mean) / sigma);
  return Math.max(0, highCdf - lowCdf);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ============================================================
// Question-text → BracketRange parser
// ============================================================
// Polymarket weather questions follow a handful of templates.
// This parser handles the most common forms used in US and
// international temperature markets. Returns null when the
// question shape isn't recognized — caller should fall back to
// Claude's true_prob in that case.
//
// Recognized forms (case-insensitive, whitespace-tolerant):
//   "highest temperature in CITY be N°C/°F on DATE"
//   "highest temperature in CITY be N°C/°F or higher on DATE"
//   "highest temperature in CITY be N°C/°F or lower on DATE"
//   "highest temperature in CITY reach N°C/°F on DATE"
//   "lowest temperature in CITY be N°C/°F on DATE"
//   "CITY be NN°C/°F or higher on DATE"
//   "will it be above/below N°C/°F in CITY"
// ============================================================

const C_TO_F_OFFSET = 32;
const C_TO_F_SCALE = 9 / 5;

function cToF(c: number): number {
  return c * C_TO_F_SCALE + C_TO_F_OFFSET;
}

export function parseBracketFromQuestion(question: string): BracketRange | null {
  if (!question) return null;
  const q = question.toLowerCase().trim();

  // Pattern: number + degree unit. Accept "34°c", "34°f", "34 c", "34 degrees f"
  const tempRe = /(-?\d+(?:\.\d+)?)\s*(?:°\s*|degrees?\s+)?([cf])\b/i;
  const tempMatch = q.match(tempRe);
  if (!tempMatch) return null;
  const value = parseFloat(tempMatch[1]);
  const unit = tempMatch[2].toLowerCase();
  if (!Number.isFinite(value)) return null;

  const valueF = unit === 'c' ? cToF(value) : value;

  // Kind: at_or_above / at_or_below / exact
  // Keywords we look for near the temperature:
  const hasOrHigher = /or\s+higher|or\s+more|or\s+above|\bat\s+least\b|≥|>=/.test(q);
  const hasOrLower = /or\s+lower|or\s+less|or\s+below|\bat\s+most\b|≤|<=/.test(q);
  const hasAbove = /\b(above|exceed|greater\s+than|more\s+than|over)\b/.test(q);
  const hasBelow = /\b(below|less\s+than|under)\b/.test(q);

  // Note: Polymarket weather resolution rules typically round to the
  // nearest whole degree in the market's unit. "exactly 34°C" means
  // actual ∈ [33.5, 34.5) in °C, i.e. [92.3, 93.2) in °F.
  // "or higher" means actual ≥ 33.5°C when unit is °C (accounts for
  // rounding from 33.5 up to 34). Practitioners argue about the
  // rounding boundary; using 0.5-unit inclusive gives the fairest
  // representation of how UMA resolves these.
  const halfUnitF = unit === 'c' ? 0.5 * C_TO_F_SCALE : 0.5;

  if (hasOrHigher || hasAbove) {
    // strict above = (value, ∞); at_or_above = [value - 0.5unit, ∞)
    const low = hasAbove && !hasOrHigher ? valueF + halfUnitF : valueF - halfUnitF;
    return {
      low_f: low,
      high_f: null,
      kind: 'at_or_above',
      label: `≥ ${value}°${unit.toUpperCase()} (${low.toFixed(1)}°F)`,
    };
  }

  if (hasOrLower || hasBelow) {
    const high = hasBelow && !hasOrLower ? valueF - halfUnitF : valueF + halfUnitF;
    return {
      low_f: null,
      high_f: high,
      kind: 'at_or_below',
      label: `≤ ${value}°${unit.toUpperCase()} (${high.toFixed(1)}°F)`,
    };
  }

  // Default: exact bracket (rounding window)
  return {
    low_f: valueF - halfUnitF,
    high_f: valueF + halfUnitF,
    kind: 'exact',
    label: `= ${value}°${unit.toUpperCase()} (${(valueF - halfUnitF).toFixed(1)}-${(valueF + halfUnitF).toFixed(1)}°F)`,
  };
}

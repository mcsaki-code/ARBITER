// ============================================================
// ARBITER — Centralized Trading Mathematics
// ============================================================
// Single source of truth for Kelly sizing, fee adjustment,
// vig removal, and calibration discounting. Every analyzer
// must use these functions instead of inline math.
// ============================================================

// ── Constants ────────────────────────────────────────────────

/** Polymarket winner fee rate (~2%). Applied to profit, not principal. */
export const POLYMARKET_FEE_RATE = 0.02;

/** Professional standard: 1/8th Kelly. Conservative enough to survive
 *  estimation error in edge, aggressive enough to compound. */
export const KELLY_FRACTION = 0.125;

/** Absolute max fraction of bankroll on any single bet. */
export const MAX_KELLY_CAP = 0.03;

/** Unified confidence multipliers. HIGH doesn't mean "bet the farm" —
 *  it means "model and data alignment is strong." */
export const CONFIDENCE_MULTIPLIERS: Record<string, number> = {
  HIGH: 0.8,
  MEDIUM: 0.5,
  LOW: 0.2,
};

/** Weather sub-type multipliers. Precipitation and snowfall models
 *  have higher variance than temperature. */
export const WEATHER_TYPE_MULTIPLIERS: Record<string, number> = {
  temperature: 1.0,
  precipitation: 0.6,
  snowfall: 0.5,
};

/** Edge caps by category. Anything above these is almost certainly
 *  a normalization error or hallucination. */
export const EDGE_CAPS: Record<string, number> = {
  crypto: 0.50,
  sports: 0.50,
  politics: 0.50,
  weather: 0.35,
  sentiment: 0.50,
  opportunity: 0.50,
  default: 0.50,
};

/** Minimum edge thresholds. Below these, the edge is likely noise. */
export const MIN_EDGES: Record<string, number> = {
  crypto: 0.02,
  sports: 0.02,
  politics: 0.05,
  weather: 0.08,
  sentiment: 0.06,
  opportunity: 0.05,
  default: 0.05,
};

// ── Fee-Adjusted Edge ────────────────────────────────────────

/**
 * Subtracts Polymarket's winner fee from raw edge.
 *
 * The fee is charged on *profit* (not principal). For a BUY_YES bet
 * at price c that wins, profit per share = (1 - c), fee = 0.02 * (1 - c).
 * The fee effectively reduces your edge by feeRate * (1 - c) for BUY_YES,
 * or feeRate * c for BUY_NO.
 *
 * If the fee-adjusted edge is negative, the bet is unprofitable.
 */
export function feeAdjustedEdge(
  rawEdge: number,
  direction: string,
  marketPrice: number,
): number {
  if (direction === 'PASS' || rawEdge <= 0) return 0;
  if (marketPrice <= 0 || marketPrice >= 1) return 0;

  let feeImpact: number;
  if (direction === 'BUY_YES') {
    // Fee on profit: feeRate * (1 - marketPrice)
    feeImpact = POLYMARKET_FEE_RATE * (1 - marketPrice);
  } else if (direction === 'BUY_NO') {
    // BUY_NO pays (1 - marketPrice), profits marketPrice if NO wins
    feeImpact = POLYMARKET_FEE_RATE * marketPrice;
  } else {
    return 0;
  }

  const netEdge = rawEdge - feeImpact;
  return Math.max(netEdge, 0);
}

// ── Unified Kelly Sizing ─────────────────────────────────────

/**
 * Computes fee-adjusted, confidence-weighted, capped Kelly fraction.
 *
 * This is the ONLY function that should compute bet sizes. All analyzers
 * call this instead of implementing their own Kelly math.
 *
 * @returns Kelly fraction in [0, MAX_KELLY_CAP] — multiply by bankroll for bet size.
 */
export function computeKelly(params: {
  trueProb: number;
  marketPrice: number;
  direction: string;
  confidence: string;
  category: string;
  weatherSubtype?: string;
  liquidityUsd?: number;
  bankroll?: number;
  calibrationDiscount?: number;
}): { kellyFraction: number; recBetUsd: number; feeAdjEdge: number } {
  const {
    trueProb, marketPrice, direction, confidence, category,
    weatherSubtype, liquidityUsd, bankroll = 5000, calibrationDiscount = 1.0,
  } = params;

  const zero = { kellyFraction: 0, recBetUsd: 0, feeAdjEdge: 0 };

  if (direction === 'PASS') return zero;
  if (trueProb <= 0 || trueProb >= 1) return zero;
  if (marketPrice <= 0 || marketPrice >= 1) return zero;

  // Flip probabilities for BUY_NO
  const isBuyNo = direction === 'BUY_NO';
  let p = isBuyNo ? 1 - trueProb : trueProb;
  let c = isBuyNo ? 1 - marketPrice : marketPrice;

  // If Claude reported the wrong side (p < c when it shouldn't be), flip
  if (isBuyNo && trueProb < marketPrice) {
    p = 1 - trueProb;
    c = 1 - marketPrice;
  }

  if (p <= 0 || c <= 0 || c >= 1) return zero;

  // Raw edge
  const rawEdge = Math.abs(p - c);

  // Fee-adjusted edge
  const feeAdj = feeAdjustedEdge(rawEdge, direction, marketPrice);

  // Check against minimum edge for this category
  const minEdge = MIN_EDGES[category] ?? MIN_EDGES['default'];
  if (feeAdj < minEdge) return { ...zero, feeAdjEdge: feeAdj };

  // Cap edge (hallucination guard)
  const edgeCap = EDGE_CAPS[category] ?? EDGE_CAPS['default'];
  const cappedEdge = Math.min(feeAdj, edgeCap);

  // Full Kelly
  const b = (1 - c) / c;
  const fullKelly = (p * b - (1 - p)) / b;
  if (fullKelly <= 0) return { ...zero, feeAdjEdge: cappedEdge };

  // Apply 1/8th Kelly
  let sized = fullKelly * KELLY_FRACTION;

  // Confidence multiplier
  const confMult = CONFIDENCE_MULTIPLIERS[confidence] ?? 0.2;
  sized *= confMult;

  // Calibration discount
  sized *= calibrationDiscount;

  // Weather sub-type multiplier
  if (category === 'weather' && weatherSubtype) {
    const typeMult = WEATHER_TYPE_MULTIPLIERS[weatherSubtype] ?? 0.5;
    sized *= typeMult;
  }

  // Liquidity cap: don't take more than 2% of market liquidity
  if (liquidityUsd && liquidityUsd > 0 && bankroll > 0) {
    const liquidityCap = (liquidityUsd * 0.02) / bankroll;
    sized = Math.min(sized, liquidityCap);
  }

  // Hard cap
  const kellyFraction = Math.min(sized, MAX_KELLY_CAP);

  // Recommended bet in USD
  const recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);

  return { kellyFraction, recBetUsd, feeAdjEdge: cappedEdge };
}

// ── Shin's Vig Removal ───────────────────────────────────────

/**
 * Removes bookmaker vig using Shin's method.
 *
 * Shin (1991, 1993) models a fraction z of bettors as insiders.
 * The true probability of outcome i is:
 *
 *   π_i = (√(z² + 4(1-z)·q_i/S) - z) / (2(1-z))
 *
 * where q_i is the implied probability and S = Σq_i (the overround).
 * z is solved iteratively so that Σπ_i = 1.
 *
 * For binary markets, this reduces to a closed-form solution.
 * For 3+ outcomes, we use Newton's method (converges in 3-5 iterations).
 *
 * @param impliedProbs Array of implied probabilities (sum > 1 due to vig)
 * @returns Array of true probabilities (sum ≈ 1)
 */
export function shinDevig(impliedProbs: number[]): number[] {
  const n = impliedProbs.length;
  if (n === 0) return [];
  if (n === 1) return [1.0];

  const S = impliedProbs.reduce((a, b) => a + b, 0);

  // If no overround (or underround), return as-is normalized
  if (S <= 1.0001) {
    return impliedProbs.map(p => p / S);
  }

  // Binary market closed-form solution
  if (n === 2) {
    const [q1, q2] = impliedProbs;
    // z = 1 - 1/S for binary
    const z = 1 - 1 / S;
    if (z <= 0 || z >= 1) {
      // Fallback to naive if Shin's doesn't converge
      return impliedProbs.map(p => p / S);
    }
    const shinProb = (q: number) =>
      (Math.sqrt(z * z + 4 * (1 - z) * q / S) - z) / (2 * (1 - z));

    const p1 = shinProb(q1);
    const p2 = shinProb(q2);
    const total = p1 + p2;
    return [p1 / total, p2 / total];
  }

  // Multi-outcome: iterative Newton's method
  let z = S - 1; // Initial guess: overround

  for (let iter = 0; iter < 30; iter++) {
    const shinProbs = impliedProbs.map(q =>
      (Math.sqrt(z * z + 4 * (1 - z) * q / S) - z) / (2 * (1 - z))
    );
    const sumShin = shinProbs.reduce((a, b) => a + b, 0);

    if (Math.abs(sumShin - 1.0) < 0.0001) {
      return shinProbs;
    }

    // Bisection-style adjustment
    z = z * (sumShin);
    if (z <= 0) z = 0.001;
    if (z >= 1) z = 0.999;
  }

  // Fallback: if Shin's didn't converge, naive normalization
  return impliedProbs.map(p => p / S);
}

// ── Calibration Discount ─────────────────────────────────────

/**
 * Returns a discount factor [0.5, 1.0] based on historical calibration.
 *
 * If the system's predicted win rate for a category+confidence tier
 * significantly exceeds the actual win rate, this reduces bet sizing
 * proportionally. Requires ≥20 resolved bets in the tier to activate.
 *
 * @param calibrationData Row from calibration_snapshots (most recent)
 * @returns Multiplier to apply to Kelly fraction
 */
export function getCalibrationDiscount(calibrationData: {
  total_bets: number;
  predicted_win_rate: number | null;
  actual_win_rate: number | null;
} | null): number {
  if (!calibrationData) return 1.0;
  if (calibrationData.total_bets < 20) return 1.0;

  const predicted = calibrationData.predicted_win_rate ?? 0.5;
  const actual = calibrationData.actual_win_rate ?? 0.5;

  if (actual <= 0.01) return 0.5; // Near-zero actual win rate = heavily discount

  const overconfidenceRatio = predicted / actual;

  if (overconfidenceRatio > 1.5) return 0.5;   // 50%+ overconfident → halve sizing
  if (overconfidenceRatio > 1.2) return 0.75;  // 20%+ overconfident → reduce 25%
  return 1.0;
}

// ── Brier Score ──────────────────────────────────────────────

/**
 * Brier score: (predicted_prob - actual_outcome)²
 * Range [0, 1]. 0 = perfect calibration, 1 = worst possible.
 */
export function brierScore(predictedProb: number, won: boolean): number {
  const actual = won ? 1.0 : 0.0;
  return Math.pow(predictedProb - actual, 2);
}

// ── P&L Calculation ──────────────────────────────────────────

/**
 * Calculates profit/loss for a resolved bet.
 * Matches the formula in resolve-bets.ts.
 */
export function calculatePnL(
  amountUsd: number,
  entryPrice: number,
  won: boolean,
): number {
  if (won) {
    return amountUsd * ((1.0 / entryPrice) - 1);
  }
  return -amountUsd;
}

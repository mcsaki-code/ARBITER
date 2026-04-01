import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  feeAdjustedEdge,
  computeKelly,
  shinDevig,
  getCalibrationDiscount,
  brierScore,
  calculatePnL,
  POLYMARKET_FEE_RATE,
  KELLY_FRACTION,
  MAX_KELLY_CAP,
  CONFIDENCE_MULTIPLIERS,
  EDGE_CAPS,
  MIN_EDGES,
} from '../src/lib/trading-math.ts';

// ── Fee-Adjusted Edge ────────────────────────────────────────

describe('feeAdjustedEdge', () => {
  it('subtracts fee for BUY_YES at 50% market price', () => {
    // Fee impact = 0.02 * (1 - 0.50) = 0.01
    const result = feeAdjustedEdge(0.10, 'BUY_YES', 0.50);
    assert.equal(result, 0.10 - 0.01);  // 0.09
  });

  it('subtracts fee for BUY_YES at 20% market price', () => {
    // Fee impact = 0.02 * (1 - 0.20) = 0.016
    const result = feeAdjustedEdge(0.10, 'BUY_YES', 0.20);
    assert.ok(Math.abs(result - 0.084) < 0.001);
  });

  it('subtracts fee for BUY_YES at 90% market price', () => {
    // Fee impact = 0.02 * (1 - 0.90) = 0.002
    const result = feeAdjustedEdge(0.05, 'BUY_YES', 0.90);
    assert.ok(Math.abs(result - 0.048) < 0.001);
  });

  it('subtracts fee for BUY_NO', () => {
    // Fee impact = 0.02 * 0.70 = 0.014
    const result = feeAdjustedEdge(0.10, 'BUY_NO', 0.70);
    assert.ok(Math.abs(result - 0.086) < 0.001);
  });

  it('returns 0 when fee eats entire edge', () => {
    // Fee impact = 0.02 * (1 - 0.02) = 0.0196
    const result = feeAdjustedEdge(0.015, 'BUY_YES', 0.02);
    assert.equal(result, 0);  // 0.015 - 0.0196 < 0 → clamped to 0
  });

  it('returns 0 for PASS direction', () => {
    assert.equal(feeAdjustedEdge(0.10, 'PASS', 0.50), 0);
  });

  it('returns 0 for zero edge', () => {
    assert.equal(feeAdjustedEdge(0, 'BUY_YES', 0.50), 0);
  });

  it('returns 0 for invalid market price', () => {
    assert.equal(feeAdjustedEdge(0.10, 'BUY_YES', 0), 0);
    assert.equal(feeAdjustedEdge(0.10, 'BUY_YES', 1), 0);
    assert.equal(feeAdjustedEdge(0.10, 'BUY_YES', -0.5), 0);
  });

  it('fee impact is higher for cheap BUY_YES bets (more profit at risk)', () => {
    const cheapFee = feeAdjustedEdge(0.10, 'BUY_YES', 0.10);  // fee = 0.02 * 0.90 = 0.018
    const expensiveFee = feeAdjustedEdge(0.10, 'BUY_YES', 0.90);  // fee = 0.02 * 0.10 = 0.002
    assert.ok(cheapFee < expensiveFee, 'Cheap BUY_YES should lose more to fees');
  });
});

// ── Unified Kelly ────────────────────────────────────────────

describe('computeKelly', () => {
  const base = {
    trueProb: 0.60,
    marketPrice: 0.50,
    direction: 'BUY_YES',
    confidence: 'HIGH',
    category: 'crypto',
    bankroll: 5000,
  };

  it('returns positive kelly for genuine edge', () => {
    const result = computeKelly(base);
    assert.ok(result.kellyFraction > 0);
    assert.ok(result.recBetUsd >= 1);
    assert.ok(result.feeAdjEdge > 0);
  });

  it('returns zero for PASS direction', () => {
    const result = computeKelly({ ...base, direction: 'PASS' });
    assert.equal(result.kellyFraction, 0);
    assert.equal(result.recBetUsd, 0);
  });

  it('returns zero when edge is below category minimum', () => {
    // Crypto MIN_EDGE = 0.02, so a 1% raw edge after fees should be filtered
    const result = computeKelly({ ...base, trueProb: 0.51, marketPrice: 0.50 });
    assert.equal(result.kellyFraction, 0);
  });

  it('caps kelly at MAX_KELLY_CAP (3%)', () => {
    // Huge edge should still cap at 3%
    const result = computeKelly({ ...base, trueProb: 0.95, marketPrice: 0.50 });
    assert.ok(result.kellyFraction <= MAX_KELLY_CAP);
  });

  it('applies 1/8th Kelly (not 1/4)', () => {
    // With HIGH confidence (0.8x), kelly = fullKelly * 0.125 * 0.8
    const result = computeKelly(base);
    // Full Kelly for p=0.60, c=0.50: (0.60*1 - 0.40)/1 = 0.20
    // 1/8 * 0.8 = 0.10, so kelly ≈ 0.20 * 0.10 = 0.02
    assert.ok(result.kellyFraction <= MAX_KELLY_CAP, 'Should be at or below 3% cap');
    assert.ok(result.kellyFraction <= 0.025, 'Should be modest with 1/8 Kelly');
  });

  it('LOW confidence produces smallest bets', () => {
    const high = computeKelly({ ...base, confidence: 'HIGH' });
    const med = computeKelly({ ...base, confidence: 'MEDIUM' });
    const low = computeKelly({ ...base, confidence: 'LOW' });
    assert.ok(high.kellyFraction > med.kellyFraction);
    assert.ok(med.kellyFraction > low.kellyFraction);
  });

  it('handles BUY_NO correctly', () => {
    // YES overpriced: trueProb=0.40 (YES), marketPrice=0.60 (YES)
    // → NO prob = 0.60, NO price = 0.40 → positive edge on NO side
    const result = computeKelly({
      ...base,
      direction: 'BUY_NO',
      trueProb: 0.40,
      marketPrice: 0.60,
    });
    assert.ok(result.kellyFraction > 0, 'Should bet on NO when YES is overpriced');
  });

  it('weather gets sub-type multiplier', () => {
    const temp = computeKelly({
      ...base, category: 'weather', weatherSubtype: 'temperature',
      trueProb: 0.70, marketPrice: 0.50,
    });
    const precip = computeKelly({
      ...base, category: 'weather', weatherSubtype: 'precipitation',
      trueProb: 0.70, marketPrice: 0.50,
    });
    const snow = computeKelly({
      ...base, category: 'weather', weatherSubtype: 'snowfall',
      trueProb: 0.70, marketPrice: 0.50,
    });
    // temp (1.0) > precip (0.6) > snow (0.5)
    assert.ok(temp.kellyFraction > precip.kellyFraction);
    assert.ok(precip.kellyFraction > snow.kellyFraction);
  });

  it('respects liquidity cap', () => {
    const result = computeKelly({
      ...base,
      trueProb: 0.90,
      liquidityUsd: 100,  // tiny liquidity
      bankroll: 10000,
    });
    // Liquidity cap = 100 * 0.02 / 10000 = 0.0002 (0.02%)
    assert.ok(result.kellyFraction <= 0.001, 'Should be capped by tiny liquidity');
  });

  it('applies calibration discount', () => {
    const full = computeKelly(base);
    const discounted = computeKelly({ ...base, calibrationDiscount: 0.5 });
    assert.ok(Math.abs(discounted.kellyFraction - full.kellyFraction * 0.5) < 0.0001);
  });

  it('returns $1 minimum bet', () => {
    const result = computeKelly({ ...base, bankroll: 10 });
    if (result.kellyFraction > 0) {
      assert.ok(result.recBetUsd >= 1);
    }
  });

  it('rejects invalid inputs', () => {
    assert.equal(computeKelly({ ...base, trueProb: 0 }).kellyFraction, 0);
    assert.equal(computeKelly({ ...base, trueProb: 1 }).kellyFraction, 0);
    assert.equal(computeKelly({ ...base, marketPrice: 0 }).kellyFraction, 0);
    assert.equal(computeKelly({ ...base, marketPrice: 1 }).kellyFraction, 0);
  });

  it('weather MIN_EDGE is 8% (higher threshold)', () => {
    // 5% edge on weather should be rejected
    const result = computeKelly({
      ...base,
      category: 'weather',
      weatherSubtype: 'temperature',
      trueProb: 0.55,
      marketPrice: 0.50,
    });
    // Raw edge ~5%, fee-adjusted ~4%, below 8% threshold
    assert.equal(result.kellyFraction, 0);
  });

  it('fee-adjusted edge returned even when kelly is 0', () => {
    // Edge exists but below min threshold
    const result = computeKelly({
      ...base,
      category: 'weather',
      trueProb: 0.55,
      marketPrice: 0.50,
    });
    assert.ok(result.feeAdjEdge >= 0);
  });
});

// ── Shin's Vig Removal ───────────────────────────────────────

describe('shinDevig', () => {
  it('handles empty array', () => {
    assert.deepEqual(shinDevig([]), []);
  });

  it('handles single outcome', () => {
    assert.deepEqual(shinDevig([1.2]), [1.0]);
  });

  it('returns equal probs for -110/-110 market', () => {
    // -110/-110: implied prob = 110/210 = 0.5238 each
    const result = shinDevig([0.5238, 0.5238]);
    assert.ok(Math.abs(result[0] - 0.50) < 0.01);
    assert.ok(Math.abs(result[1] - 0.50) < 0.01);
  });

  it('sums to 1.0', () => {
    const result = shinDevig([0.60, 0.55]);
    const sum = result.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001);
  });

  it('adjusts lopsided markets (favorite/underdog)', () => {
    // -300/+250: implied probs ≈ 0.75, 0.2857
    // Naive: 0.7241, 0.2759
    // Shin's should give the underdog slightly better odds than naive
    const naive = [0.75 / 1.0357, 0.2857 / 1.0357];
    const shin = shinDevig([0.75, 0.2857]);
    // Shin's should shift probability toward the longshot vs naive
    assert.ok(shin[1] > naive[1] - 0.01, 'Shin should favor longshot slightly more than naive');
    const sum = shin.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001);
  });

  it('handles 3-outcome markets (draw)', () => {
    // Soccer: home 0.45, draw 0.30, away 0.35 (sum = 1.10)
    const result = shinDevig([0.45, 0.30, 0.35]);
    assert.equal(result.length, 3);
    const sum = result.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.01);
    // All probs should be less than their implied equivalents
    assert.ok(result[0] < 0.45);
    assert.ok(result[1] < 0.30);
    assert.ok(result[2] < 0.35);
  });

  it('handles no-vig market (sum = 1)', () => {
    const result = shinDevig([0.60, 0.40]);
    assert.ok(Math.abs(result[0] - 0.60) < 0.01);
    assert.ok(Math.abs(result[1] - 0.40) < 0.01);
  });

  it('handles high-vig market (sum = 1.15)', () => {
    const result = shinDevig([0.60, 0.55]);
    const sum = result.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.01);
  });
});

// ── Calibration Discount ─────────────────────────────────────

describe('getCalibrationDiscount', () => {
  it('returns 1.0 for null data', () => {
    assert.equal(getCalibrationDiscount(null), 1.0);
  });

  it('returns 1.0 for insufficient data (<20 bets)', () => {
    assert.equal(getCalibrationDiscount({
      total_bets: 10, predicted_win_rate: 0.80, actual_win_rate: 0.40,
    }), 1.0);
  });

  it('returns 1.0 for well-calibrated system', () => {
    assert.equal(getCalibrationDiscount({
      total_bets: 50, predicted_win_rate: 0.60, actual_win_rate: 0.58,
    }), 1.0);
  });

  it('returns 0.75 for 30% overconfident', () => {
    assert.equal(getCalibrationDiscount({
      total_bets: 50, predicted_win_rate: 0.65, actual_win_rate: 0.50,
    }), 0.75);
  });

  it('returns 0.5 for 60% overconfident', () => {
    assert.equal(getCalibrationDiscount({
      total_bets: 50, predicted_win_rate: 0.80, actual_win_rate: 0.50,
    }), 0.5);
  });

  it('returns 0.5 for near-zero actual win rate', () => {
    assert.equal(getCalibrationDiscount({
      total_bets: 30, predicted_win_rate: 0.70, actual_win_rate: 0.005,
    }), 0.5);
  });
});

// ── Brier Score ──────────────────────────────────────────────

describe('brierScore', () => {
  it('perfect prediction (win at 100%)', () => {
    assert.equal(brierScore(1.0, true), 0);
  });

  it('perfect prediction (loss at 0%)', () => {
    assert.equal(brierScore(0.0, false), 0);
  });

  it('worst prediction (win at 0%)', () => {
    assert.equal(brierScore(0.0, true), 1.0);
  });

  it('worst prediction (loss at 100%)', () => {
    assert.equal(brierScore(1.0, false), 1.0);
  });

  it('50/50 prediction', () => {
    assert.equal(brierScore(0.5, true), 0.25);
    assert.equal(brierScore(0.5, false), 0.25);
  });
});

// ── P&L Calculation ──────────────────────────────────────────

describe('calculatePnL', () => {
  it('winning BUY_YES at 25%: 3x profit', () => {
    const pnl = calculatePnL(100, 0.25, true);
    assert.equal(pnl, 300);  // 100 * ((1/0.25) - 1) = 100 * 3 = 300
  });

  it('losing bet: -amount', () => {
    const pnl = calculatePnL(100, 0.25, false);
    assert.equal(pnl, -100);
  });

  it('winning at 50%: 1x profit', () => {
    const pnl = calculatePnL(100, 0.50, true);
    assert.equal(pnl, 100);
  });

  it('winning at 90%: small profit', () => {
    const pnl = calculatePnL(100, 0.90, true);
    assert.ok(Math.abs(pnl - 11.11) < 0.1);  // 100 * (1/0.9 - 1) ≈ 11.11
  });
});

// ── Constants validation ─────────────────────────────────────

describe('Constants', () => {
  it('POLYMARKET_FEE_RATE is 2%', () => {
    assert.equal(POLYMARKET_FEE_RATE, 0.02);
  });

  it('KELLY_FRACTION is 1/8', () => {
    assert.equal(KELLY_FRACTION, 0.125);
  });

  it('MAX_KELLY_CAP is 3%', () => {
    assert.equal(MAX_KELLY_CAP, 0.03);
  });

  it('all confidence multipliers present', () => {
    assert.ok(CONFIDENCE_MULTIPLIERS['HIGH'] > 0);
    assert.ok(CONFIDENCE_MULTIPLIERS['MEDIUM'] > 0);
    assert.ok(CONFIDENCE_MULTIPLIERS['LOW'] > 0);
    assert.ok(CONFIDENCE_MULTIPLIERS['HIGH'] > CONFIDENCE_MULTIPLIERS['MEDIUM']);
    assert.ok(CONFIDENCE_MULTIPLIERS['MEDIUM'] > CONFIDENCE_MULTIPLIERS['LOW']);
  });

  it('weather edge cap is lower than other categories', () => {
    assert.ok(EDGE_CAPS['weather'] < EDGE_CAPS['crypto']);
    assert.ok(EDGE_CAPS['weather'] < EDGE_CAPS['sports']);
  });

  it('weather MIN_EDGE is highest (most conservative)', () => {
    assert.ok(MIN_EDGES['weather'] > MIN_EDGES['crypto']);
    assert.ok(MIN_EDGES['weather'] > MIN_EDGES['sports']);
  });
});

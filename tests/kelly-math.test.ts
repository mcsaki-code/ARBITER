// ============================================================
// Tests: Kelly Criterion Math & Bet Sizing Logic
// Verifies the exact math used across all analyzers
// Run: npx tsx --test tests/kelly-math.test.ts
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Replicate the exact Kelly formula from the codebase ──────

/**
 * Standard Kelly: f* = (p*b - q) / b
 * Where: p = true prob, q = 1-p, b = payout ratio = (1-c)/c, c = market price
 */
function fullKelly(trueProb: number, marketPrice: number): number {
  if (marketPrice <= 0 || marketPrice >= 1 || trueProb <= 0) return 0;
  const b = (1 - marketPrice) / marketPrice;
  const f = (trueProb * b - (1 - trueProb)) / b;
  return f;
}

/** 1/8th Kelly (professional standard) as used in weather/crypto analyzers */
function eighthKelly(trueProb: number, marketPrice: number): number {
  const f = fullKelly(trueProb, marketPrice);
  return f > 0 ? f * 0.125 : 0;
}

/** BUY_NO Kelly: flip probs to NO side, then standard Kelly */
function buyNoKelly(trueYesProb: number, yesMarketPrice: number): number {
  // If YES is overpriced (trueProb < marketPrice), flip to NO side
  const p = 1 - trueYesProb;
  const c = 1 - yesMarketPrice;
  return fullKelly(p, c);
}

/** Place-bets.ts bet sizing: cappedKelly * confMult, max 3% */
function placeBetsSizing(kellyFraction: number, confidence: 'HIGH' | 'MEDIUM' | 'LOW', bankroll: number): number {
  const confMult = confidence === 'HIGH' ? 0.8 : confidence === 'MEDIUM' ? 0.5 : 0.2;
  const cappedKelly = Math.min(kellyFraction, 0.035);
  const adjustedKelly = Math.min(cappedKelly * confMult, 0.03);
  return Math.max(1, Math.round(bankroll * adjustedKelly * 100) / 100);
}

// ── Full Kelly tests ────────────────────────────────────────

describe('fullKelly', () => {
  it('returns positive for true positive edge', () => {
    // True prob 60%, market 50% → positive edge
    const f = fullKelly(0.60, 0.50);
    assert.ok(f > 0, `Expected positive, got ${f}`);
    // Expected: (0.6*1 - 0.4)/1 = 0.2
    assert.ok(Math.abs(f - 0.2) < 0.001, `Expected ~0.2, got ${f}`);
  });

  it('returns zero for no edge', () => {
    const f = fullKelly(0.50, 0.50);
    assert.ok(Math.abs(f) < 0.001, `Expected ~0, got ${f}`);
  });

  it('returns negative for negative edge (do not bet)', () => {
    // True prob 40%, market 50% → negative edge
    const f = fullKelly(0.40, 0.50);
    assert.ok(f < 0, `Expected negative, got ${f}`);
  });

  it('handles extreme market prices', () => {
    // Market at 1% (cheap long shot)
    const f = fullKelly(0.05, 0.01);
    assert.ok(f > 0);
    // Market at 99%
    const f2 = fullKelly(0.99, 0.99);
    assert.ok(Math.abs(f2) < 0.01, `Expected ~0, got ${f2}`);
  });

  it('returns 0 for invalid inputs', () => {
    assert.equal(fullKelly(0.5, 0), 0);
    assert.equal(fullKelly(0.5, 1), 0);
    assert.equal(fullKelly(0, 0.5), 0);
    assert.equal(fullKelly(-1, 0.5), 0);
  });

  it('known values: 8% edge case from crypto', () => {
    // bracket_prob=0.45, market_price=0.37, edge=0.08
    const f = fullKelly(0.45, 0.37);
    // b = 0.63/0.37 = 1.7027
    // f = (0.45 * 1.7027 - 0.55) / 1.7027 = (0.7662 - 0.55) / 1.7027 = 0.127
    assert.ok(f > 0.12 && f < 0.14, `Expected ~0.127, got ${f}`);
  });
});

// ── 1/8th Kelly ─────────────────────────────────────────────

describe('eighthKelly', () => {
  it('is 1/8 of full Kelly', () => {
    const full = fullKelly(0.60, 0.50);
    const eighth = eighthKelly(0.60, 0.50);
    assert.ok(Math.abs(eighth - full / 8) < 0.0001);
  });

  it('returns 0 for negative edge', () => {
    assert.equal(eighthKelly(0.40, 0.50), 0);
  });
});

// ── BUY_NO Kelly ────────────────────────────────────────────

describe('buyNoKelly', () => {
  it('is positive when YES is overpriced', () => {
    // True YES prob = 30%, market = 50% → YES is overpriced
    // NO side: true_no=70%, no_price=50% → positive edge
    const f = buyNoKelly(0.30, 0.50);
    assert.ok(f > 0, `Expected positive, got ${f}`);
    // Same as fullKelly(0.70, 0.50)
    assert.ok(Math.abs(f - fullKelly(0.70, 0.50)) < 0.001);
  });

  it('is negative when YES is fairly priced or underpriced', () => {
    const f = buyNoKelly(0.60, 0.50);
    // true_no=40%, no_price=50% → negative edge on NO side
    assert.ok(f < 0);
  });

  it('handles near-zero YES prices (BUY_NO expensive)', () => {
    // YES at 2%, true prob 1% → NO side: true_no=99%, no_price=98%
    const f = buyNoKelly(0.01, 0.02);
    // b = 0.02/0.98 = 0.0204, f = (0.99*0.0204 - 0.01)/0.0204 = ...
    // This is the "paying 98¢ to win 2¢" scenario
    assert.ok(f > 0, 'Should be barely positive');
    assert.ok(f <= 0.51, 'Should be a modest Kelly fraction');
  });
});

// ── Place-bets sizing ───────────────────────────────────────

describe('placeBetsSizing', () => {
  const bankroll = 5000;

  it('scales by confidence multiplier', () => {
    const high = placeBetsSizing(0.02, 'HIGH', bankroll);
    const med = placeBetsSizing(0.02, 'MEDIUM', bankroll);
    const low = placeBetsSizing(0.02, 'LOW', bankroll);
    assert.ok(high > med, `HIGH ($${high}) should be > MEDIUM ($${med})`);
    assert.ok(med > low, `MEDIUM ($${med}) should be > LOW ($${low})`);
  });

  it('caps kelly at 0.035 before confidence multiplier', () => {
    // kelly_fraction=0.10 (inflated) should be capped at 0.035
    const bet = placeBetsSizing(0.10, 'HIGH', bankroll);
    // 0.035 * 0.8 = 0.028 → $5000 * 0.028 = $140
    assert.equal(bet, 140);
  });

  it('caps total adjusted Kelly at 0.03 (3%)', () => {
    const bet = placeBetsSizing(0.035, 'HIGH', bankroll);
    // 0.035 * 0.8 = 0.028 → $5000 * 0.028 = $140
    assert.equal(bet, 140);

    // But if kelly is extreme and confMult is HIGH:
    const bet2 = placeBetsSizing(0.05, 'HIGH', bankroll);
    // 0.035 (capped) * 0.8 = 0.028, still under 0.03 cap
    assert.equal(bet2, 140);
  });

  it('enforces $1 minimum', () => {
    const bet = placeBetsSizing(0.0001, 'LOW', bankroll);
    assert.ok(bet >= 1, `Should be at least $1, got $${bet}`);
  });

  it('gives reasonable sizes for typical edges', () => {
    // 8% edge → kelly ~0.015 at 1/8th → 0.015 * 0.5 = 0.0075 → $37.50
    const bet = placeBetsSizing(0.015, 'MEDIUM', bankroll);
    assert.ok(bet >= 30 && bet <= 40, `Expected ~$37.50, got $${bet}`);
  });
});

// ── Edge case: Kelly with inflated edges from weather ───────

describe('Kelly with inflated edges', () => {
  it('weather avg edge 0.665 gets capped properly', () => {
    // Weather analyses had an avg kelly_fraction of 0.665
    // Without capping, this sizes to 3% bankroll on every bet
    const bet = placeBetsSizing(0.665, 'MEDIUM', 5000);
    // Should be: min(0.035, 0.665) * 0.5 = 0.0175 → $87.50
    assert.equal(bet, 87.5);
    // NOT: 0.665 * 0.5 = 0.3325 → $1662.50 (catastrophic)
    assert.ok(bet < 150, `Bet should be reasonable, got $${bet}`);
  });
});

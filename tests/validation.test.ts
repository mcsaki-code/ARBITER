// ============================================================
// Tests: Runtime Validation for Claude Analysis Responses
// Uses Node built-in test runner (node:test + node:assert)
// Run: npx tsx --test tests/validation.test.ts
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProb,
  normalizeEdge,
  validateCryptoAnalysis,
  validateSportsAnalysis,
  validateWeatherAnalysis,
  validatePoliticsAnalysis,
} from '../src/lib/validate-analysis.ts';

// ── normalizeProb ───────────────────────────────────────────

describe('normalizeProb', () => {
  it('passes through values already in 0-1', () => {
    assert.equal(normalizeProb(0.5), 0.5);
    assert.equal(normalizeProb(0.0), 0.0);
    assert.equal(normalizeProb(1.0), 1.0);
    assert.equal(normalizeProb(0.003), 0.003);
  });

  it('normalizes percentage values (1-100) to 0-1', () => {
    assert.equal(normalizeProb(50), 0.5);
    assert.equal(normalizeProb(85), 0.85);
    assert.equal(normalizeProb(3), 0.03);
    assert.equal(normalizeProb(99.7), 0.997);
  });

  it('returns null for invalid inputs', () => {
    assert.equal(normalizeProb(null), null);
    assert.equal(normalizeProb(undefined), null);
    assert.equal(normalizeProb('hello'), null);
    assert.equal(normalizeProb(NaN), null);
    assert.equal(normalizeProb(Infinity), null);
  });

  it('rejects negative values', () => {
    assert.equal(normalizeProb(-0.5), null);
  });
});

// ── normalizeEdge ───────────────────────────────────────────

describe('normalizeEdge', () => {
  it('passes through values already in 0-1', () => {
    assert.equal(normalizeEdge(0.08), 0.08);
    assert.equal(normalizeEdge(0.15), 0.15);
    assert.equal(normalizeEdge(0.5), 0.5);
  });

  it('normalizes percentage values (1-100) to 0-1', () => {
    assert.equal(normalizeEdge(8.5), 0.085);
    assert.equal(normalizeEdge(15), 0.15);
    assert.equal(normalizeEdge(50), 0.5);
  });

  it('normalizes the infamous 849 bug (>100) to 0-1', () => {
    assert.equal(normalizeEdge(849), 0.849);
    assert.equal(normalizeEdge(150), 0.15);
    assert.equal(normalizeEdge(998), 0.998);
  });

  it('normalizes negative edges (BUY_NO) to positive magnitude', () => {
    // -8.5% edge from BUY_NO → 0.085
    assert.equal(normalizeEdge(-8.5), 0.085);
    assert.equal(normalizeEdge(-15), 0.15);
  });

  it('returns null for invalid inputs', () => {
    assert.equal(normalizeEdge(null), null);
    assert.equal(normalizeEdge(undefined), null);
    assert.equal(normalizeEdge('bad'), null);
    assert.equal(normalizeEdge(NaN), null);
  });
});

// ── validateCryptoAnalysis ──────────────────────────────────

describe('validateCryptoAnalysis', () => {
  const validInput = {
    asset: 'BTC',
    spot_at_analysis: 84500,
    target_bracket: '$84K-$86K',
    bracket_prob: 0.45,
    market_price: 0.38,
    edge: 0.07,
    direction: 'BUY_YES',
    confidence: 'MEDIUM',
    kelly_fraction: 0.012,
    rec_bet_usd: 60,
    reasoning: 'Technical indicators suggest upward momentum',
    auto_eligible: true,
    flags: [],
  };

  it('accepts valid input', () => {
    const result = validateCryptoAnalysis(validInput);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.asset, 'BTC');
      assert.equal(result.data.bracket_prob, 0.45);
      assert.equal(result.data.edge, 0.07);
    }
  });

  it('normalizes percentage edge values', () => {
    const result = validateCryptoAnalysis({ ...validInput, edge: 7 }); // 7% → 0.07
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.edge, 0.07);
    }
  });

  it('normalizes 849-style edge values', () => {
    const result = validateCryptoAnalysis({ ...validInput, edge: 849 });
    assert.equal(result.valid, true);
    if (result.valid) {
      // 849 → 0.849, but capped at 0.50
      assert.equal(result.data.edge, 0.50);
    }
  });

  it('normalizes percentage bracket_prob', () => {
    const result = validateCryptoAnalysis({ ...validInput, bracket_prob: 45 }); // 45% → 0.45
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.bracket_prob, 0.45);
    }
  });

  it('rejects missing direction', () => {
    const result = validateCryptoAnalysis({ ...validInput, direction: 'YOLO' });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('direction')));
    }
  });

  it('rejects missing confidence', () => {
    const result = validateCryptoAnalysis({ ...validInput, confidence: 'VERY_HIGH' });
    assert.equal(result.valid, false);
  });

  it('rejects non-numeric edge', () => {
    const result = validateCryptoAnalysis({ ...validInput, edge: 'strong' });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('edge')));
    }
  });

  it('rejects suspiciously high edge (>95%)', () => {
    const result = validateCryptoAnalysis({ ...validInput, edge: 0.98 });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('suspiciously high')));
    }
  });

  it('rejects null input', () => {
    const result = validateCryptoAnalysis(null);
    assert.equal(result.valid, false);
  });

  it('defaults missing optional fields', () => {
    const result = validateCryptoAnalysis({
      ...validInput,
      kelly_fraction: undefined,
      rec_bet_usd: undefined,
      auto_eligible: undefined,
      flags: undefined,
    });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.kelly_fraction, 0);
      assert.equal(result.data.rec_bet_usd, 0);
      assert.equal(result.data.auto_eligible, false);
      assert.deepEqual(result.data.flags, []);
    }
  });

  it('caps edge at 0.50', () => {
    const result = validateCryptoAnalysis({ ...validInput, edge: 0.65 });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.edge, 0.50);
    }
  });
});

// ── validateSportsAnalysis ──────────────────────────────────

describe('validateSportsAnalysis', () => {
  const validInput = {
    event_description: 'Lakers vs Celtics',
    sport: 'basketball',
    sportsbook_consensus: 0.62,
    polymarket_price: 0.55,
    edge: 0.07,
    direction: 'BUY_YES',
    confidence: 'HIGH',
    reasoning: 'Line movement favors home team',
    auto_eligible: true,
    flags: [],
  };

  it('accepts valid input', () => {
    const result = validateSportsAnalysis(validInput);
    assert.equal(result.valid, true);
  });

  it('normalizes percentage values', () => {
    const result = validateSportsAnalysis({
      ...validInput,
      sportsbook_consensus: 62, // 62% → 0.62
      polymarket_price: 55,
      edge: 7,
    });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.sportsbook_consensus, 0.62);
      assert.equal(result.data.polymarket_price, 0.55);
      assert.equal(result.data.edge, 0.07);
    }
  });

  it('rejects invalid direction', () => {
    const result = validateSportsAnalysis({ ...validInput, direction: 'HOLD' });
    assert.equal(result.valid, false);
  });
});

// ── validateWeatherAnalysis ─────────────────────────────────

describe('validateWeatherAnalysis', () => {
  const validInput = {
    best_bet: {
      outcome_idx: 2,
      outcome_label: '75-79°F',
      model_prob: 0.42,
      market_price: 0.30,
      edge: 0.12,
      direction: 'BUY_YES',
      confidence: 'HIGH',
      reasoning: 'All models agree on 77°F high',
    },
    all_outcomes: [
      { label: '70-74°F', model_prob: 0.25, market_price: 0.30, edge: -0.05 },
      { label: '75-79°F', model_prob: 0.42, market_price: 0.30, edge: 0.12 },
    ],
    auto_eligible: true,
    flags: [],
  };

  it('accepts valid input', () => {
    const result = validateWeatherAnalysis(validInput);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.best_bet.model_prob, 0.42);
      assert.equal(result.data.best_bet.edge, 0.12);
    }
  });

  it('caps weather edge at 35%', () => {
    const input = {
      ...validInput,
      best_bet: { ...validInput.best_bet, edge: 0.65 },
    };
    const result = validateWeatherAnalysis(input);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.best_bet.edge, 0.35);
    }
  });

  it('normalizes percentage model_prob', () => {
    const input = {
      ...validInput,
      best_bet: { ...validInput.best_bet, model_prob: 42 }, // 42% → 0.42
    };
    const result = validateWeatherAnalysis(input);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.best_bet.model_prob, 0.42);
    }
  });

  it('rejects missing best_bet', () => {
    const result = validateWeatherAnalysis({ all_outcomes: [], auto_eligible: true, flags: [] });
    assert.equal(result.valid, false);
  });
});

// ── validatePoliticsAnalysis ────────────────────────────────

describe('validatePoliticsAnalysis', () => {
  const validInput = {
    question_summary: 'Will tariffs be imposed by April?',
    category: 'tariff',
    best_outcome_idx: 0,
    best_outcome_label: 'Yes',
    market_price: 0.65,
    true_prob: 0.78,
    edge: 0.13,
    direction: 'BUY_YES',
    confidence: 'MEDIUM',
    reasoning: 'Executive order timeline suggests likely',
    auto_eligible: true,
    flags: ['cross_market_confirmed'],
  };

  it('accepts valid input', () => {
    const result = validatePoliticsAnalysis(validInput);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.edge, 0.13);
      assert.equal(result.data.direction, 'BUY_YES');
    }
  });

  it('rejects bad direction', () => {
    const result = validatePoliticsAnalysis({ ...validInput, direction: 'SELL' });
    assert.equal(result.valid, false);
  });
});

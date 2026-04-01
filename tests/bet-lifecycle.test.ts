// ============================================================
// Tests: Bet Lifecycle Integration
// Tests the full flow without a live DB:
//   analyze → validate → size → place → resolve → P&L
// Uses mock objects that mirror the exact Supabase row shapes.
// Run: npx tsx --test tests/bet-lifecycle.test.ts
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCryptoAnalysis, normalizeEdge, normalizeProb } from '../src/lib/validate-analysis.ts';

// ── Mock the exact data shapes from the codebase ────────────

interface MockBet {
  id: string;
  market_id: string;
  direction: string;
  outcome_label: string;
  entry_price: number;
  amount_usd: number;
  status: string;
  category: string;
  pnl?: number;
  brier_score?: number;
}

interface MockMarket {
  id: string;
  question: string;
  liquidity_usd: number;
  is_active: boolean;
  resolution_date: string;
  outcome_prices: number[];
}

/** Replicate resolve-bets.ts P&L calculation exactly */
function calculatePnL(bet: MockBet, betWon: boolean): number {
  if (betWon) {
    return Math.round(bet.amount_usd * ((1.0 / bet.entry_price) - 1) * 100) / 100;
  }
  return -bet.amount_usd;
}

/** Replicate resolve-bets.ts Brier score calculation exactly */
function calculateBrier(bet: MockBet, betWon: boolean): number {
  const predictedProb = bet.direction === 'BUY_YES'
    ? bet.entry_price
    : 1 - bet.entry_price;
  const actualOutcome = betWon ? 1.0 : 0.0;
  return Math.pow(predictedProb - actualOutcome, 2);
}

/** Replicate resolve-bets.ts resolution logic for direction-based categories */
function resolveDirectionBased(bet: MockBet, winningOutcome: string): boolean {
  const winner = winningOutcome.toLowerCase().trim();
  return bet.direction === 'BUY_YES' ? (winner === 'yes') : (winner === 'no');
}

/** Replicate resolve-bets.ts resolution logic for label-based categories */
function resolveLabelBased(bet: MockBet, winningOutcome: string): boolean {
  const betLabel = (bet.outcome_label || '').toLowerCase().trim();
  const winner = winningOutcome.toLowerCase().trim();

  if (bet.direction === 'BUY_NO') {
    const isLiteralNo = betLabel === 'no';
    return isLiteralNo ? winner === 'no' : winner !== betLabel;
  }
  return betLabel === winner;
}

/** Replicate place-bets.ts entry price adjustment for BUY_NO */
function adjustEntryPriceForBuyNo(yesPrice: number, direction: string): number {
  if (direction === 'BUY_NO' && yesPrice < 0.5) {
    return 1 - yesPrice;
  }
  return yesPrice;
}

// ── Tests ───────────────────────────────────────────────────

describe('Bet Lifecycle: Crypto BUY_YES', () => {
  // Scenario: BTC $84K-$86K bracket, true prob 45%, market 37%
  const claudeResponse = {
    asset: 'BTC',
    spot_at_analysis: 84500,
    target_bracket: '$84K-$86K',
    bracket_prob: 0.45,
    market_price: 0.37,
    edge: 0.08,
    direction: 'BUY_YES' as const,
    confidence: 'MEDIUM' as const,
    kelly_fraction: 0.016,
    rec_bet_usd: 80,
    reasoning: 'Technical indicators align with target bracket',
    auto_eligible: true,
    flags: [],
  };

  it('validates Claude response', () => {
    const result = validateCryptoAnalysis(claudeResponse);
    assert.equal(result.valid, true);
  });

  it('entry price is the YES price', () => {
    const entryPrice = adjustEntryPriceForBuyNo(0.37, 'BUY_YES');
    assert.equal(entryPrice, 0.37);
  });

  it('calculates correct P&L on WIN', () => {
    const bet: MockBet = {
      id: 'test-1', market_id: 'mkt-1', direction: 'BUY_YES',
      outcome_label: '$84K-$86K', entry_price: 0.37,
      amount_usd: 80, status: 'OPEN', category: 'crypto',
    };
    const pnl = calculatePnL(bet, true);
    // Win: $80 * (1/0.37 - 1) = $80 * 1.7027 = $136.22
    assert.ok(pnl > 136 && pnl < 137, `Expected ~$136.22, got $${pnl}`);
  });

  it('calculates correct P&L on LOSS', () => {
    const bet: MockBet = {
      id: 'test-1', market_id: 'mkt-1', direction: 'BUY_YES',
      outcome_label: '$84K-$86K', entry_price: 0.37,
      amount_usd: 80, status: 'OPEN', category: 'crypto',
    };
    const pnl = calculatePnL(bet, false);
    assert.equal(pnl, -80);
  });

  it('Brier score is good on confident correct prediction', () => {
    const bet: MockBet = {
      id: 'test-1', market_id: 'mkt-1', direction: 'BUY_YES',
      outcome_label: '$84K-$86K', entry_price: 0.37,
      amount_usd: 80, status: 'OPEN', category: 'crypto',
    };
    const brier = calculateBrier(bet, true);
    // predicted=0.37, actual=1 → (0.37-1)^2 = 0.3969
    assert.ok(Math.abs(brier - 0.3969) < 0.001, `Expected ~0.397, got ${brier}`);
  });

  it('Brier score is worse on confident wrong prediction', () => {
    const bet: MockBet = {
      id: 'test-1', market_id: 'mkt-1', direction: 'BUY_YES',
      outcome_label: '$84K-$86K', entry_price: 0.85,
      amount_usd: 80, status: 'OPEN', category: 'crypto',
    };
    const brier = calculateBrier(bet, false);
    // predicted=0.85, actual=0 → (0.85-0)^2 = 0.7225
    assert.ok(Math.abs(brier - 0.7225) < 0.001, `Expected ~0.7225, got ${brier}`);
  });
});

describe('Bet Lifecycle: Crypto BUY_NO', () => {
  // Scenario: BTC won't hit $150K this month, market YES at 2%
  it('entry price flips for BUY_NO when YES price < 50%', () => {
    // YES at 2% → NO costs 98¢
    const entryPrice = adjustEntryPriceForBuyNo(0.02, 'BUY_NO');
    assert.equal(entryPrice, 0.98);
  });

  it('entry price stays for BUY_NO when YES price > 50%', () => {
    // YES at 60% → entry is 0.60 (we're buying NO at 40¢ effective)
    const entryPrice = adjustEntryPriceForBuyNo(0.60, 'BUY_NO');
    assert.equal(entryPrice, 0.60);
  });

  it('P&L is tiny when buying expensive NO (98¢)', () => {
    const bet: MockBet = {
      id: 'test-2', market_id: 'mkt-2', direction: 'BUY_NO',
      outcome_label: 'BTC $150K', entry_price: 0.98,
      amount_usd: 50, status: 'OPEN', category: 'crypto',
    };
    const pnl = calculatePnL(bet, true);
    // Win: $50 * (1/0.98 - 1) = $50 * 0.0204 = $1.02
    assert.ok(pnl > 0.9 && pnl < 1.1, `Expected ~$1.02, got $${pnl}`);
  });

  it('P&L is full loss when buying expensive NO and losing', () => {
    const bet: MockBet = {
      id: 'test-2', market_id: 'mkt-2', direction: 'BUY_NO',
      outcome_label: 'BTC $150K', entry_price: 0.98,
      amount_usd: 50, status: 'OPEN', category: 'crypto',
    };
    const pnl = calculatePnL(bet, false);
    assert.equal(pnl, -50);
  });

  it('Brier score for BUY_NO uses inverted probability', () => {
    const bet: MockBet = {
      id: 'test-2', market_id: 'mkt-2', direction: 'BUY_NO',
      outcome_label: 'BTC $150K', entry_price: 0.98,
      amount_usd: 50, status: 'OPEN', category: 'crypto',
    };
    const brier = calculateBrier(bet, true);
    // For BUY_NO: predictedProb = 1 - 0.98 = 0.02, actual = 1
    // (0.02 - 1)^2 = 0.9604
    assert.ok(Math.abs(brier - 0.9604) < 0.001, `Expected ~0.9604, got ${brier}`);
  });
});

describe('Bet Resolution: Direction-Based Categories', () => {
  it('crypto_momentum BUY_YES wins when Yes wins', () => {
    const bet: MockBet = {
      id: 'test-3', market_id: 'mkt-3', direction: 'BUY_YES',
      outcome_label: 'BTC Price Movement', entry_price: 0.6,
      amount_usd: 50, status: 'OPEN', category: 'crypto_momentum',
    };
    assert.equal(resolveDirectionBased(bet, 'Yes'), true);
    assert.equal(resolveDirectionBased(bet, 'No'), false);
  });

  it('politics BUY_NO wins when No wins', () => {
    const bet: MockBet = {
      id: 'test-4', market_id: 'mkt-4', direction: 'BUY_NO',
      outcome_label: 'Executive Order', entry_price: 0.7,
      amount_usd: 30, status: 'OPEN', category: 'politics',
    };
    assert.equal(resolveDirectionBased(bet, 'No'), true);
    assert.equal(resolveDirectionBased(bet, 'Yes'), false);
  });
});

describe('Bet Resolution: Label-Based Categories', () => {
  it('weather BUY_YES wins when outcome matches', () => {
    const bet: MockBet = {
      id: 'test-5', market_id: 'mkt-5', direction: 'BUY_YES',
      outcome_label: '75-79°F', entry_price: 0.30,
      amount_usd: 20, status: 'OPEN', category: 'weather',
    };
    assert.equal(resolveLabelBased(bet, '75-79°F'), true);
    assert.equal(resolveLabelBased(bet, '70-74°F'), false);
  });

  it('weather BUY_NO wins when outcome does NOT match', () => {
    const bet: MockBet = {
      id: 'test-6', market_id: 'mkt-6', direction: 'BUY_NO',
      outcome_label: '75-79°F', entry_price: 0.70,
      amount_usd: 20, status: 'OPEN', category: 'weather',
    };
    // We bet AGAINST 75-79°F. If winner is 70-74°F, we win.
    assert.equal(resolveLabelBased(bet, '70-74°F'), true);
    // If winner IS 75-79°F, we lose.
    assert.equal(resolveLabelBased(bet, '75-79°F'), false);
  });

  it('BUY_NO with literal "No" outcome wins when No wins', () => {
    const bet: MockBet = {
      id: 'test-7', market_id: 'mkt-7', direction: 'BUY_NO',
      outcome_label: 'No', entry_price: 0.60,
      amount_usd: 25, status: 'OPEN', category: 'sports',
    };
    assert.equal(resolveLabelBased(bet, 'No'), true);
    assert.equal(resolveLabelBased(bet, 'Yes'), false);
  });
});

describe('Edge Normalization End-to-End', () => {
  it('Claude returns 849 → stored as 0.50 (capped)', () => {
    const result = validateCryptoAnalysis({
      asset: 'BTC', spot_at_analysis: 84500, target_bracket: '$84K-$86K',
      bracket_prob: 0.99, market_price: 0.01,
      edge: 849, // bug: Claude returned 849 instead of 0.849
      direction: 'BUY_NO', confidence: 'HIGH',
      kelly_fraction: 0, rec_bet_usd: 0,
      reasoning: 'test', auto_eligible: false, flags: [],
    });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.edge, 0.50); // capped at 50%
    }
  });

  it('Claude returns 8.5 → stored as 0.085', () => {
    const edge = normalizeEdge(8.5);
    assert.equal(edge, 0.085);
  });

  it('Claude returns 0.085 → stored as 0.085', () => {
    const edge = normalizeEdge(0.085);
    assert.equal(edge, 0.085);
  });
});

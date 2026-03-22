// ============================================================
// Kelly Criterion Calculator
// ============================================================
// Correct implementation per build brief

import { Confidence, KellyParams, KellyResult } from './types';

const CONFIDENCE_MULTIPLIER: Record<Confidence, number> = {
  HIGH: 1.0,
  MEDIUM: 0.6,
  LOW: 0.2,
};

export function calculateBetSize(params: KellyParams): KellyResult {
  const { trueProb: p, marketPrice: c, confidence, liquidity, bankroll } = params;
  const edge = p - c;

  if (edge < 0.02) return { fraction: 0, amountUsd: 0, eligible: false };

  // Payout ratio: win $(1-c) for every $c risked
  const b = (1 - c) / c;

  // Full Kelly formula
  const fullKelly = (p * b - (1 - p)) / b;
  if (fullKelly <= 0) return { fraction: 0, amountUsd: 0, eligible: false };

  // Apply fractional Kelly (25%) + confidence multiplier
  const confMult = CONFIDENCE_MULTIPLIER[confidence];
  const adjusted = fullKelly * 0.25 * confMult;

  // Hard caps
  const liquidityCap = (liquidity * 0.02) / bankroll; // Max 2% of market liquidity
  const hardCap = 0.05; // Max 5% of bankroll
  const finalFraction = Math.min(adjusted, hardCap, liquidityCap);
  const amountUsd = Math.max(1, Math.round(bankroll * finalFraction * 100) / 100);

  return {
    fraction: finalFraction,
    amountUsd,
    eligible: confidence !== 'LOW',
  };
}

// ============================================================
// Auto-Execution Guardrails & Paper Trading Gate
// ============================================================

import { WeatherAnalysis } from './types';

interface SystemConfigMap {
  [key: string]: string;
}

export function checkRealMoneyEligibility(config: SystemConfigMap): {
  eligible: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];

  if (!config.paper_trade_start_date) {
    blockers.push('Paper trading has not started yet — place your first bet to begin the 30-day clock');
    return { eligible: false, blockers };
  }

  const startDate = new Date(config.paper_trade_start_date);
  const daysElapsed = Math.floor((Date.now() - startDate.getTime()) / 86400000);

  if (daysElapsed < 30) blockers.push(`${30 - daysElapsed} more days of paper trading required`);
  if (parseInt(config.total_paper_bets || '0') < 50)
    blockers.push(`${50 - parseInt(config.total_paper_bets || '0')} more bets needed`);
  if (parseFloat(config.paper_win_rate || '0') < 0.58)
    blockers.push(
      `Win rate ${(parseFloat(config.paper_win_rate || '0') * 100).toFixed(1)}% must reach 58%`
    );

  return { eligible: blockers.length === 0, blockers };
}

export function isAutoEligible(
  analysis: Partial<WeatherAnalysis> & {
    market_liquidity?: number;
    hours_remaining?: number;
    bankroll?: number;
  },
  config: SystemConfigMap
): boolean {
  return (
    (analysis.edge ?? 0) >= 0.04 &&
    analysis.confidence === 'HIGH' &&
    (analysis.model_agreement === 'HIGH' || analysis.model_agreement === 'MEDIUM') &&
    (analysis.market_liquidity ?? 0) >= 10000 &&
    (analysis.hours_remaining ?? 0) >= 2 &&
    (analysis.rec_bet_usd ?? 0) <=
      parseFloat(config.paper_bankroll || '500') * 0.05 &&
    !(analysis.flags || []).includes('data_stale')
  );
}

// Daily risk limits
export const RISK_LIMITS = {
  maxSingleBetPct: 0.05,        // 5% of bankroll
  maxDailyExposurePct: 0.25,    // 25% of bankroll deployed
  maxDailyBetsAuto: 20,
  dailyLossCapPct: -0.10,       // -10% → pause
  consecutiveLossLimit: 5,      // pause after 5 in a row
  maxBetsPerCityPerDay: 2,
};

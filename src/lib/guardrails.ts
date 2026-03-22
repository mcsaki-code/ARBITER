// ============================================================
// Auto-Execution Guardrails & Paper Trading Gate
// ============================================================
// Controls when ARBITER is allowed to place real money orders.
// Paper trading must prove profitability before live trading
// is unlocked. Even after unlocking, kill switch and per-order
// safety checks apply.
// ============================================================

import { WeatherAnalysis } from './types';

interface SystemConfigMap {
  [key: string]: string;
}

// ============================================================
// Paper Trading Gate
// Must pass ALL three criteria before real money is allowed:
//   1. 30+ days of paper trading
//   2. 50+ paper bets placed
//   3. 58%+ win rate
// ============================================================

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

// ============================================================
// Live Trading Authorization
// Full check: paper gate + kill switch + config enabled
// ============================================================

export function isLiveTradingAuthorized(config: SystemConfigMap): {
  authorized: boolean;
  reason: string;
} {
  // Kill switch takes absolute priority
  if (config.live_kill_switch === 'true') {
    return { authorized: false, reason: 'Kill switch is active — all live trading halted' };
  }

  // Must be explicitly enabled in config
  if (config.live_trading_enabled !== 'true') {
    return { authorized: false, reason: 'Live trading is not enabled in system config' };
  }

  // Must have env var set
  if (process.env.LIVE_TRADING_ENABLED !== 'true') {
    return { authorized: false, reason: 'LIVE_TRADING_ENABLED env var is not set to true' };
  }

  // Must have private key configured
  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    return { authorized: false, reason: 'POLYMARKET_PRIVATE_KEY is not configured' };
  }

  // Must pass paper trading gate
  const paperGate = checkRealMoneyEligibility(config);
  if (!paperGate.eligible) {
    return {
      authorized: false,
      reason: `Paper trading gate not passed: ${paperGate.blockers.join('; ')}`,
    };
  }

  return { authorized: true, reason: 'All checks passed' };
}

// ============================================================
// Per-Order Safety Check
// Validates a single order before it hits the CLOB
// ============================================================

export function validateLiveOrder(params: {
  amountUsd: number;
  todayExposureUsd: number;
  config: SystemConfigMap;
}): {
  allowed: boolean;
  reason?: string;
} {
  const { amountUsd, todayExposureUsd, config } = params;

  // Check kill switch (redundant but belt-and-suspenders)
  if (config.live_kill_switch === 'true') {
    return { allowed: false, reason: 'Kill switch active' };
  }

  // Per-order size limit
  const maxSingleBet = parseFloat(config.live_max_single_bet_usd || '10');
  if (amountUsd > maxSingleBet) {
    return {
      allowed: false,
      reason: `Order $${amountUsd.toFixed(2)} exceeds max single bet $${maxSingleBet}`,
    };
  }

  // Daily exposure limit
  const maxDailyUsd = parseFloat(config.live_max_daily_usd || '50');
  if (todayExposureUsd + amountUsd > maxDailyUsd) {
    return {
      allowed: false,
      reason: `Would exceed daily limit: $${(todayExposureUsd + amountUsd).toFixed(2)} > $${maxDailyUsd}`,
    };
  }

  // Minimum bet size (avoid dust orders)
  if (amountUsd < 1) {
    return { allowed: false, reason: 'Order too small (minimum $1)' };
  }

  return { allowed: true };
}

// ============================================================
// Auto-Eligibility (unchanged from Phase 1)
// ============================================================

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

// Daily risk limits (paper trading)
export const RISK_LIMITS = {
  maxSingleBetPct: 0.05,        // 5% of bankroll
  maxDailyExposurePct: 0.25,    // 25% of bankroll deployed
  maxDailyBetsAuto: 20,
  dailyLossCapPct: -0.10,       // -10% → pause
  consecutiveLossLimit: 5,      // pause after 5 in a row
  maxBetsPerCityPerDay: 2,
};

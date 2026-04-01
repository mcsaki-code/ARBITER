// ============================================================
// Circuit Breaker — Automated Risk Kill Switch
//
// Top prediction market bots ALL have circuit breakers.
// One Polymarket trader lost $2.36M in 8 days from lack of
// automated shutdowns. This module prevents catastrophic
// loss spirals by pausing trading when things go wrong.
//
// Rules:
// 1. 3 consecutive losses → pause 2 hours
// 2. 5 consecutive losses → pause 12 hours
// 3. 15% daily drawdown → halt for rest of day
// 4. 25% weekly drawdown → halt for rest of week
// 5. Max 30% peak drawdown → full shutdown until manual reset
//
// Usage: import { shouldTrade, recordOutcome } from './circuit-breaker';
//        if (!(await shouldTrade(supabase))) return; // skip betting
// ============================================================

import { SupabaseClient } from '@supabase/supabase-js';

export interface CircuitBreakerState {
  canTrade: boolean;
  reason: string | null;
  consecutiveLosses: number;
  dailyPnl: number;
  weeklyPnl: number;
  peakBankroll: number;
  currentDrawdown: number;
  pausedUntil: string | null;
}

// ── Config keys in system_config ──────────────────────────
const CONFIG_KEYS = {
  CONSECUTIVE_LOSSES: 'cb_consecutive_losses',
  PAUSED_UNTIL: 'cb_paused_until',
  PEAK_BANKROLL: 'cb_peak_bankroll',
  MANUAL_HALT: 'cb_manual_halt',
};

// ── Thresholds ────────────────────────────────────────────
const CONSECUTIVE_LOSS_PAUSE_1 = 3;   // 3 losses → 2h pause
const CONSECUTIVE_LOSS_PAUSE_2 = 5;   // 5 losses → 12h pause
const PAUSE_DURATION_1_MS = 2 * 3600000;   // 2 hours
const PAUSE_DURATION_2_MS = 12 * 3600000;  // 12 hours
const MAX_DAILY_DRAWDOWN_PCT = 0.15;       // 15% of bankroll
const MAX_WEEKLY_DRAWDOWN_PCT = 0.25;      // 25% of bankroll
const MAX_PEAK_DRAWDOWN_PCT = 0.30;        // 30% from peak → full halt

// ── Helper: get or create config value ────────────────────
async function getConfig(supabase: SupabaseClient, key: string, defaultVal: string): Promise<string> {
  const { data } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', key)
    .single();

  if (data?.value) return data.value;

  // Create if not exists
  await supabase.from('system_config').upsert({
    key,
    value: defaultVal,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });

  return defaultVal;
}

async function setConfig(supabase: SupabaseClient, key: string, value: string): Promise<void> {
  await supabase.from('system_config').upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
}

// ── Main: Should we trade right now? ──────────────────────
export async function shouldTrade(supabase: SupabaseClient): Promise<CircuitBreakerState> {
  // 1. Check manual halt
  const manualHalt = await getConfig(supabase, CONFIG_KEYS.MANUAL_HALT, 'false');
  if (manualHalt === 'true') {
    return {
      canTrade: false,
      reason: 'MANUAL_HALT: Trading manually paused via system_config',
      consecutiveLosses: 0, dailyPnl: 0, weeklyPnl: 0,
      peakBankroll: 0, currentDrawdown: 0, pausedUntil: null,
    };
  }

  // 2. Check time-based pause (from consecutive losses)
  const pausedUntilStr = await getConfig(supabase, CONFIG_KEYS.PAUSED_UNTIL, '');
  if (pausedUntilStr) {
    const pausedUntil = new Date(pausedUntilStr);
    if (pausedUntil > new Date()) {
      const consecutiveLosses = parseInt(await getConfig(supabase, CONFIG_KEYS.CONSECUTIVE_LOSSES, '0'));
      return {
        canTrade: false,
        reason: `CONSECUTIVE_LOSS_PAUSE: ${consecutiveLosses} consecutive losses, paused until ${pausedUntil.toISOString()}`,
        consecutiveLosses,
        dailyPnl: 0, weeklyPnl: 0, peakBankroll: 0, currentDrawdown: 0,
        pausedUntil: pausedUntilStr,
      };
    }
    // Pause expired — clear it
    await setConfig(supabase, CONFIG_KEYS.PAUSED_UNTIL, '');
  }

  // 3. Get current bankroll
  const { data: bankrollConfig } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'paper_bankroll')
    .single();
  const currentBankroll = parseFloat(bankrollConfig?.value || '5000');

  // 4. Track peak bankroll for max drawdown calculation
  const peakBankroll = parseFloat(await getConfig(supabase, CONFIG_KEYS.PEAK_BANKROLL, '5000'));
  if (currentBankroll > peakBankroll) {
    await setConfig(supabase, CONFIG_KEYS.PEAK_BANKROLL, currentBankroll.toString());
  }
  const effectivePeak = Math.max(peakBankroll, currentBankroll);
  const currentDrawdown = effectivePeak > 0 ? (effectivePeak - currentBankroll) / effectivePeak : 0;

  // 5. Check max peak drawdown (30% → full halt)
  if (currentDrawdown >= MAX_PEAK_DRAWDOWN_PCT) {
    return {
      canTrade: false,
      reason: `PEAK_DRAWDOWN_HALT: ${(currentDrawdown * 100).toFixed(1)}% drawdown from peak $${effectivePeak.toFixed(0)} (current $${currentBankroll.toFixed(0)}). Manual reset required.`,
      consecutiveLosses: 0, dailyPnl: 0, weeklyPnl: 0,
      peakBankroll: effectivePeak, currentDrawdown,
      pausedUntil: null,
    };
  }

  // 6. Calculate daily P&L from resolved bets
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data: todayBets } = await supabase
    .from('bets')
    .select('pnl, status')
    .gte('resolved_at', todayStart.toISOString())
    .in('status', ['WON', 'LOST']);

  const dailyPnl = todayBets?.reduce((sum, b) => sum + (b.pnl || 0), 0) || 0;

  // 7. Check daily drawdown (15%)
  if (dailyPnl < 0 && Math.abs(dailyPnl) >= currentBankroll * MAX_DAILY_DRAWDOWN_PCT) {
    return {
      canTrade: false,
      reason: `DAILY_DRAWDOWN_HALT: Daily P&L $${dailyPnl.toFixed(2)} exceeds ${(MAX_DAILY_DRAWDOWN_PCT * 100)}% of $${currentBankroll.toFixed(0)} bankroll`,
      consecutiveLosses: 0, dailyPnl, weeklyPnl: 0,
      peakBankroll: effectivePeak, currentDrawdown,
      pausedUntil: null,
    };
  }

  // 8. Calculate weekly P&L
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay()); // Sunday
  weekStart.setUTCHours(0, 0, 0, 0);

  const { data: weekBets } = await supabase
    .from('bets')
    .select('pnl, status')
    .gte('resolved_at', weekStart.toISOString())
    .in('status', ['WON', 'LOST']);

  const weeklyPnl = weekBets?.reduce((sum, b) => sum + (b.pnl || 0), 0) || 0;

  // 9. Check weekly drawdown (25%)
  if (weeklyPnl < 0 && Math.abs(weeklyPnl) >= currentBankroll * MAX_WEEKLY_DRAWDOWN_PCT) {
    return {
      canTrade: false,
      reason: `WEEKLY_DRAWDOWN_HALT: Weekly P&L $${weeklyPnl.toFixed(2)} exceeds ${(MAX_WEEKLY_DRAWDOWN_PCT * 100)}% of $${currentBankroll.toFixed(0)} bankroll`,
      consecutiveLosses: 0, dailyPnl, weeklyPnl,
      peakBankroll: effectivePeak, currentDrawdown,
      pausedUntil: null,
    };
  }

  // 10. Check consecutive losses
  const consecutiveLosses = parseInt(await getConfig(supabase, CONFIG_KEYS.CONSECUTIVE_LOSSES, '0'));

  return {
    canTrade: true,
    reason: null,
    consecutiveLosses,
    dailyPnl,
    weeklyPnl,
    peakBankroll: effectivePeak,
    currentDrawdown,
    pausedUntil: null,
  };
}

// ── Record a bet outcome (call after resolution) ──────────
export async function recordOutcome(
  supabase: SupabaseClient,
  won: boolean
): Promise<{ consecutiveLosses: number; paused: boolean; pauseDuration?: string }> {
  if (won) {
    // Win resets the streak
    await setConfig(supabase, CONFIG_KEYS.CONSECUTIVE_LOSSES, '0');
    return { consecutiveLosses: 0, paused: false };
  }

  // Loss — increment streak
  const current = parseInt(await getConfig(supabase, CONFIG_KEYS.CONSECUTIVE_LOSSES, '0'));
  const newCount = current + 1;
  await setConfig(supabase, CONFIG_KEYS.CONSECUTIVE_LOSSES, newCount.toString());

  // Check if we need to pause
  let paused = false;
  let pauseDuration = '';

  if (newCount >= CONSECUTIVE_LOSS_PAUSE_2) {
    // 5+ consecutive losses → 12h pause
    const pauseUntil = new Date(Date.now() + PAUSE_DURATION_2_MS);
    await setConfig(supabase, CONFIG_KEYS.PAUSED_UNTIL, pauseUntil.toISOString());
    paused = true;
    pauseDuration = '12 hours';
  } else if (newCount >= CONSECUTIVE_LOSS_PAUSE_1) {
    // 3+ consecutive losses → 2h pause
    const pauseUntil = new Date(Date.now() + PAUSE_DURATION_1_MS);
    await setConfig(supabase, CONFIG_KEYS.PAUSED_UNTIL, pauseUntil.toISOString());
    paused = true;
    pauseDuration = '2 hours';
  }

  return { consecutiveLosses: newCount, paused, pauseDuration };
}

// ── Manual controls ───────────────────────────────────────
export async function manualHalt(supabase: SupabaseClient): Promise<void> {
  await setConfig(supabase, CONFIG_KEYS.MANUAL_HALT, 'true');
}

export async function manualResume(supabase: SupabaseClient): Promise<void> {
  await setConfig(supabase, CONFIG_KEYS.MANUAL_HALT, 'false');
  await setConfig(supabase, CONFIG_KEYS.PAUSED_UNTIL, '');
  await setConfig(supabase, CONFIG_KEYS.CONSECUTIVE_LOSSES, '0');
}

// ── Reset peak (after manual bankroll adjustment) ─────────
export async function resetPeak(supabase: SupabaseClient, newPeak?: number): Promise<void> {
  const { data } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'paper_bankroll')
    .single();
  const bankroll = newPeak || parseFloat(data?.value || '5000');
  await setConfig(supabase, CONFIG_KEYS.PEAK_BANKROLL, bankroll.toString());
}

// ============================================================
// ARBITER Phase 1 — Volume-Spike Exit Trigger (Dry-Run)
// Position Monitor
// ============================================================
// Pure observability. This module:
//   - reads open bets
//   - maintains a rolling 24h baseline of 10-min trade volume
//     per market (cached on `bets.volume_baseline`)
//   - inserts a `position_alerts` row when current 10-min volume
//     exceeds baseline * threshold
//   - sends a daily-cap email when alerts pile up
//
// What it does NOT do:
//   - close positions
//   - mutate bet status, exit_price, pnl, or any non-baseline field
//   - touch the resolver, the analyzer, or place-bets
//
// All errors are caught and logged. The monitor must NEVER crash
// or block — Phase 1 is observability only, and a crashed monitor
// adds zero value while consuming a Netlify cron slot.
// ============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  getRecentVolume,
  getTrailingVolumeAverage,
  getCurrentMidPrice,
} from './polymarket';
import { sendVolumeExitCapNotification } from './notify';

// ── Constants ────────────────────────────────────────────────
const ALERT_TYPE_VOLUME_SPIKE = 'VOLUME_SPIKE';
const RECENT_VOLUME_WINDOW_MIN = 10;
const BASELINE_LOOKBACK_HOURS = 24;
const DEDUPE_WINDOW_MIN = 10;

// Default config values — used when system_config has no row for a key.
// Intentionally conservative; production values live in system_config.
const DEFAULT_CONFIG = {
  enabled: false,
  threshold: 3.0,
  minBaselineAgeMinutes: 60,
  maxAlertsPerDay: 5,
};

// ── Types ────────────────────────────────────────────────────
interface MonitorConfig {
  enabled: boolean;
  threshold: number;
  minBaselineAgeMinutes: number;
  maxAlertsPerDay: number;
}

interface OpenBet {
  id: string;                       // UUID
  market_id: string;                // UUID FK
  condition_id: string | null;      // Polymarket conditionId
  direction: string;                // 'BUY_YES' | 'BUY_NO'
  entry_price: number;
  amount_usd: number;
  volume_baseline: number | null;
  volume_baseline_set_at: string | null;
  markets: {
    outcome_prices: number[] | null;
  } | null;
}

export interface MonitorRunSummary {
  enabled: boolean;
  scanned: number;
  baselineRefreshed: number;
  alerts: number;
  skippedDedupe: number;
  errors: number;
  capEmailSent: boolean;
}

// ── Helpers ──────────────────────────────────────────────────

function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase env vars missing (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(url, key);
}

async function loadConfig(supabase: SupabaseClient): Promise<MonitorConfig> {
  const { data } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', [
      'volume_exit_enabled',
      'volume_exit_threshold',
      'volume_exit_min_baseline_age_minutes',
      'volume_exit_max_alerts_per_day',
    ]);

  const map: Record<string, string> = {};
  data?.forEach((r: { key: string; value: string }) => { map[r.key] = r.value; });

  const cfg: MonitorConfig = {
    enabled: (map.volume_exit_enabled ?? String(DEFAULT_CONFIG.enabled)).toLowerCase() === 'true',
    threshold: parseFloat(map.volume_exit_threshold ?? String(DEFAULT_CONFIG.threshold)),
    minBaselineAgeMinutes: parseInt(
      map.volume_exit_min_baseline_age_minutes ?? String(DEFAULT_CONFIG.minBaselineAgeMinutes),
      10
    ),
    maxAlertsPerDay: parseInt(
      map.volume_exit_max_alerts_per_day ?? String(DEFAULT_CONFIG.maxAlertsPerDay),
      10
    ),
  };

  // Defensive: a NaN here means a typo in system_config. Fall back to default
  // rather than poisoning the monitor with broken arithmetic.
  if (!Number.isFinite(cfg.threshold) || cfg.threshold <= 0) cfg.threshold = DEFAULT_CONFIG.threshold;
  if (!Number.isFinite(cfg.minBaselineAgeMinutes) || cfg.minBaselineAgeMinutes < 0) {
    cfg.minBaselineAgeMinutes = DEFAULT_CONFIG.minBaselineAgeMinutes;
  }
  if (!Number.isFinite(cfg.maxAlertsPerDay) || cfg.maxAlertsPerDay < 1) {
    cfg.maxAlertsPerDay = DEFAULT_CONFIG.maxAlertsPerDay;
  }

  return cfg;
}

async function loadOpenBets(supabase: SupabaseClient): Promise<OpenBet[]> {
  const { data, error } = await supabase
    .from('bets')
    .select(`
      id,
      market_id,
      condition_id,
      direction,
      entry_price,
      amount_usd,
      volume_baseline,
      volume_baseline_set_at,
      markets ( outcome_prices )
    `)
    .eq('status', 'OPEN');

  if (error) {
    console.error('[monitor] failed to load open bets:', error.message);
    return [];
  }
  // Filter out bets that don't have a condition_id — we can't query the
  // Polymarket trades API without one.
  return ((data ?? []) as unknown as OpenBet[]).filter((b) => !!b.condition_id);
}

function baselineIsFresh(bet: OpenBet, minAgeMinutes: number): boolean {
  // Treat any persisted baseline as fresh until its timestamp ages out —
  // including baseline=0 ("sleepy market with no trades in 24h"). Otherwise
  // dead markets get a trades-API hit every cron pass, contradicting the
  // refreshBaseline comment about not hammering dead markets.
  // The alert check separately skips when baseline <= 0.
  if (bet.volume_baseline == null) return false;
  if (!bet.volume_baseline_set_at) return false;
  const ageMs = Date.now() - new Date(bet.volume_baseline_set_at).getTime();
  return ageMs < minAgeMinutes * 60_000;
}

async function refreshBaseline(
  supabase: SupabaseClient,
  bet: OpenBet
): Promise<number> {
  const baseline = await getTrailingVolumeAverage(
    bet.condition_id!,
    BASELINE_LOOKBACK_HOURS,
    RECENT_VOLUME_WINDOW_MIN
  );
  // Always persist, even if baseline is 0 — that prevents the monitor from
  // hammering the API on dead markets every 5 min. A 0 baseline naturally
  // skips the spike check on the next pass (see runOnce).
  const { error } = await supabase
    .from('bets')
    .update({
      volume_baseline: baseline,
      volume_baseline_set_at: new Date().toISOString(),
    })
    .eq('id', bet.id);
  if (error) {
    console.warn(`[monitor] baseline update failed for bet ${bet.id}:`, error.message);
  }
  return baseline;
}

async function recentDuplicateExists(
  supabase: SupabaseClient,
  betId: string
): Promise<boolean> {
  const cutoff = new Date(Date.now() - DEDUPE_WINDOW_MIN * 60_000).toISOString();
  const { count, error } = await supabase
    .from('position_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('bet_id', betId)
    .eq('alert_type', ALERT_TYPE_VOLUME_SPIKE)
    .gte('alert_at', cutoff);
  if (error) {
    // On error, conservatively assume a duplicate exists — better to skip
    // a real alert than to spam duplicates.
    console.warn(`[monitor] dedupe check failed for ${betId}:`, error.message);
    return true;
  }
  return (count ?? 0) > 0;
}

async function resolveCurrentPrice(bet: OpenBet): Promise<number | null> {
  const outcomeIdx = bet.direction === 'BUY_YES' ? 0 : 1;

  // Try fresh price from Gamma first.
  const fromGamma = await getCurrentMidPrice(bet.condition_id!, outcomeIdx);
  if (fromGamma != null && Number.isFinite(fromGamma) && fromGamma > 0 && fromGamma < 1) {
    return fromGamma;
  }

  // Fall back to whatever the last refresh-markets cron stored.
  const dbPrices = bet.markets?.outcome_prices;
  if (Array.isArray(dbPrices) && dbPrices.length > outcomeIdx) {
    const dbPrice = dbPrices[outcomeIdx];
    if (Number.isFinite(dbPrice) && dbPrice > 0 && dbPrice < 1) return dbPrice;
  }

  return null;
}

async function countAlertsToday(
  supabase: SupabaseClient,
  isoDateUtc: string
): Promise<{ total: number; notified: number }> {
  // Use [today, tomorrow) bounds. Avoids the millisecond-precision edge
  // where a row at 23:59:59.9999 (microsecond) escapes a `<= .999Z` filter.
  const dayStart = `${isoDateUtc}T00:00:00.000Z`;
  const next = new Date(`${isoDateUtc}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dayEnd = next.toISOString();

  const { data, error } = await supabase
    .from('position_alerts')
    .select('notified')
    .gte('alert_at', dayStart)
    .lt('alert_at', dayEnd);
  if (error) {
    console.warn('[monitor] alert count query failed:', error.message);
    return { total: 0, notified: 0 };
  }
  const total = data?.length ?? 0;
  const notified = (data ?? []).filter((r: { notified: boolean }) => r.notified).length;
  return { total, notified };
}

async function markTodayAlertsNotified(
  supabase: SupabaseClient,
  isoDateUtc: string
): Promise<void> {
  const dayStart = `${isoDateUtc}T00:00:00.000Z`;
  const next = new Date(`${isoDateUtc}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dayEnd = next.toISOString();
  const { error } = await supabase
    .from('position_alerts')
    .update({ notified: true })
    .gte('alert_at', dayStart)
    .lt('alert_at', dayEnd);
  if (error) {
    console.warn('[monitor] mark notified failed:', error.message);
  }
}

// ── Main entry point ─────────────────────────────────────────

/**
 * Run a single monitor pass. Designed to be called from a Netlify
 * scheduled function. Always resolves; never throws.
 */
export async function runOnce(): Promise<MonitorRunSummary> {
  const summary: MonitorRunSummary = {
    enabled: false,
    scanned: 0,
    baselineRefreshed: 0,
    alerts: 0,
    skippedDedupe: 0,
    errors: 0,
    capEmailSent: false,
  };

  let supabase: SupabaseClient;
  try {
    supabase = getServiceClient();
  } catch (err) {
    console.error('[monitor] init failed:', err instanceof Error ? err.message : String(err));
    summary.errors += 1;
    return summary;
  }

  let cfg: MonitorConfig;
  try {
    cfg = await loadConfig(supabase);
  } catch (err) {
    console.error('[monitor] config load failed:', err instanceof Error ? err.message : String(err));
    summary.errors += 1;
    return summary;
  }

  summary.enabled = cfg.enabled;
  if (!cfg.enabled) {
    console.log('[monitor] volume_exit_enabled=false — skipping scan');
    return summary;
  }

  const bets = await loadOpenBets(supabase);
  console.log(`[monitor] scanning ${bets.length} open bets`);

  for (const bet of bets) {
    summary.scanned += 1;
    try {
      // Step 1: ensure a usable baseline.
      let baseline = bet.volume_baseline ?? 0;
      if (!baselineIsFresh(bet, cfg.minBaselineAgeMinutes)) {
        baseline = await refreshBaseline(supabase, bet);
        summary.baselineRefreshed += 1;
        // Skip alert check on the same pass we set the baseline — gives the
        // baseline a full window of "aged" data before we judge spikes.
        continue;
      }

      // A 0 baseline means the trailing 24h had no qualifying trades.
      // We can't divide-or-multiply our way to a meaningful spike from that;
      // skip silently and the next baseline refresh will pick up any new flow.
      if (baseline <= 0) continue;

      // Step 2: current 10-min volume.
      const current = await getRecentVolume(bet.condition_id!, RECENT_VOLUME_WINDOW_MIN);
      if (current <= baseline * cfg.threshold) continue;

      // Step 3: dedupe — don't double-alert on overlapping cron runs.
      if (await recentDuplicateExists(supabase, bet.id)) {
        summary.skippedDedupe += 1;
        continue;
      }

      // Step 4: resolve current price + write alert.
      const currentPrice = await resolveCurrentPrice(bet);
      if (currentPrice == null) {
        console.warn(`[monitor] no price available for ${bet.condition_id?.slice(0, 12)}… — skipping alert`);
        continue;
      }

      const shares = bet.entry_price > 0 ? bet.amount_usd / bet.entry_price : 0;
      const hypotheticalPnl = (currentPrice - bet.entry_price) * shares;

      const { error: insertError } = await supabase.from('position_alerts').insert({
        bet_id: bet.id,
        market_id: bet.market_id,
        condition_id: bet.condition_id,
        alert_type: ALERT_TYPE_VOLUME_SPIKE,
        entry_price: bet.entry_price,
        current_price: currentPrice,
        shares,
        hypothetical_pnl: hypotheticalPnl,
        current_volume_10min: current,
        baseline_volume: baseline,
        threshold_used: cfg.threshold,
        dry_run: true,
        notified: false,
      });

      if (insertError) {
        console.error(`[monitor] alert insert failed for bet ${bet.id}:`, insertError.message);
        summary.errors += 1;
        continue;
      }

      summary.alerts += 1;
      console.log(
        `[monitor] ALERT bet=${bet.id} cond=${bet.condition_id!.slice(0, 12)}… ` +
        `vol10=$${current.toFixed(2)} baseline=$${baseline.toFixed(2)} ` +
        `(${(current / baseline).toFixed(2)}× ≥ ${cfg.threshold}×) ` +
        `hypoPnL=$${hypotheticalPnl.toFixed(2)}`
      );
    } catch (err) {
      console.error(`[monitor] bet ${bet.id} failed:`, err instanceof Error ? err.message : String(err));
      summary.errors += 1;
    }
  }

  // Step 5: daily-cap email.
  //
  // Spec: send AT MOST one email per UTC day. The "did we email today?"
  // signal is "any of today's position_alerts has notified=true" — once
  // markTodayAlertsNotified runs, the original cap-hitting rows stay
  // notified=true forever, so future passes that find new alerts past
  // the cap will still see notified > 0 and correctly suppress the email.
  try {
    const isoDateUtc = new Date().toISOString().slice(0, 10);
    const { total, notified } = await countAlertsToday(supabase, isoDateUtc);
    if (total >= cfg.maxAlertsPerDay && notified === 0) {
      await sendVolumeExitCapNotification({
        alertCount: total,
        cap: cfg.maxAlertsPerDay,
        isoDate: isoDateUtc,
      });
      await markTodayAlertsNotified(supabase, isoDateUtc);
      summary.capEmailSent = true;
      console.log(`[monitor] cap email sent (${total}/${cfg.maxAlertsPerDay} today)`);
    }
  } catch (err) {
    console.warn('[monitor] cap email step failed:', err instanceof Error ? err.message : String(err));
  }

  console.log('[monitor] summary:', JSON.stringify(summary));
  return summary;
}

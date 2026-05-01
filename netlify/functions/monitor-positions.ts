// ============================================================
// Netlify Scheduled Function: Monitor Positions (Phase 1, Dry-Run)
// Runs every 5 minutes — detects volume spikes on open positions
// and writes a row to `position_alerts`. Pure observability.
//
// All work lives in src/lib/position-monitor.ts. This file is
// intentionally thin: cron registration + a try/catch around the
// runner so the cron never returns a non-200 status.
//
// Master flag: system_config.volume_exit_enabled (default 'false').
// When the flag is off, runOnce() short-circuits without scanning.
//
// Phase 1 has NO sell path — this function logs what would have
// happened, it does NOT close any position or mutate bet status.
// ============================================================

import { schedule } from '@netlify/functions';
import { runOnce } from '../../src/lib/position-monitor';

export const handler = schedule('*/5 * * * *', async () => {
  const startedAt = Date.now();
  console.log('[monitor-positions] starting Phase 1 dry-run scan');

  try {
    const summary = await runOnce();
    console.log(
      `[monitor-positions] done in ${Date.now() - startedAt}ms — ` +
      `enabled=${summary.enabled} scanned=${summary.scanned} ` +
      `baselineRefreshed=${summary.baselineRefreshed} alerts=${summary.alerts} ` +
      `dedup=${summary.skippedDedupe} errors=${summary.errors} ` +
      `capEmailSent=${summary.capEmailSent}`
    );
  } catch (err) {
    // runOnce() is contracted to never throw, but if it does we still want
    // a 200 — a failed monitor pass is not an incident worth retrying.
    console.error('[monitor-positions] unexpected error:', err instanceof Error ? err.message : String(err));
  }

  return { statusCode: 200 };
});

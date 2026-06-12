/**
 * ARBITER Railway Worker
 * Persistent Node.js process — runs 24/7 on Railway ($5/month Hobby plan).
 *
 * Advantages over Netlify scheduled functions:
 *   - No 30-second timeout → processes ALL markets each cycle
 *   - In-memory price cache → detects market repricing in real time
 *   - Event-driven → re-analyzes immediately when prices shift 3%+
 *   - 5-day lookahead → 3x more eligible temperature markets
 *
 * Architecture:
 *   FAST LOOP  (every 60s):  market price monitoring — detect shifts
 *   TEMP LOOP  (every 5m):   temperature statistical analysis (all markets)
 *   INGEST LOOP (every 30m): trigger Netlify ingest functions via HTTP
 *   HEALTH LOG (every 15m):  log worker health + metrics to Supabase
 */

import { createClient } from '@supabase/supabase-js';
import { analyzeTemperatureMarkets } from './temperature';
import { scanMarketPrices, getCacheSize } from './monitor';
import { ingestEnsembleForecasts } from './ensemble-ingest';
import { ingestStationActuals, backfillResolutionSources } from './station-actuals';
import { ingestKalshiSnapshots } from './kalshi-ingest';
import { runMmQuoteSim } from './mm-sim';

// ── Environment validation ───────────────────────────────────────────────────
const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[worker] FATAL: Missing env var ${key}`);
    process.exit(1);
  }
}

const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID ?? '9e4df4b0-09b1-43d7-a120-4ede5174e236';
const NETLIFY_TOKEN   = process.env.NETLIFY_ACCESS_TOKEN; // optional — for triggering build hooks

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Metrics ──────────────────────────────────────────────────────────────────
const metrics = {
  startedAt: Date.now(),
  tempCycles: 0,
  tempAnalyzed: 0,
  monitorCycles: 0,
  priceShiftsDetected: 0,
  immediateRetriggers: 0,
  errors: 0,
};

// ── Sleep helper ─────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Log worker state to Supabase (for dashboard visibility) ──────────────────
async function logHealth() {
  const uptimeHours = ((Date.now() - metrics.startedAt) / 3600000).toFixed(1);
  console.log(
    `[worker] ── Health ── uptime=${uptimeHours}h | ` +
    `tempCycles=${metrics.tempCycles} analyzed=${metrics.tempAnalyzed} | ` +
    `monitorCycles=${metrics.monitorCycles} shifts=${metrics.priceShiftsDetected} ` +
    `retriggers=${metrics.immediateRetriggers} | errors=${metrics.errors} | ` +
    `cacheSize=${getCacheSize()}`
  );

  // Write to system_config so the dashboard can show worker status
  await supabase.from('system_config').upsert([
    { key: 'railway_worker_last_heartbeat', value: new Date().toISOString() },
    { key: 'railway_worker_uptime_hours',   value: uptimeHours },
    { key: 'railway_worker_temp_analyzed',  value: metrics.tempAnalyzed.toString() },
    { key: 'railway_worker_price_shifts',   value: metrics.priceShiftsDetected.toString() },
  ], { onConflict: 'key' });
}

// ── Temperature analysis loop ─────────────────────────────────────────────────
async function runTemperatureLoop() {
  console.log('[worker] Starting temperature loop (every 5 minutes, no timeout)');
  while (true) {
    try {
      metrics.tempCycles++;
      console.log(`\n[worker] === Temperature cycle #${metrics.tempCycles} ===`);
      const result = await analyzeTemperatureMarkets(supabase, {
        daysLookahead: 5,          // Railway: 5-day lookahead (vs 3 on Netlify)
        recentWindowHours: 4,      // Skip if analyzed in last 4 hours
        verbose: true,
      });
      metrics.tempAnalyzed += result.analyzed;
      if (result.errors > 0) metrics.errors += result.errors;
    } catch (e) {
      metrics.errors++;
      console.error('[worker] Temperature loop error:', e);
    }
    await sleep(5 * 60 * 1000); // 5 minutes
  }
}

// ── Market price monitor loop ─────────────────────────────────────────────────
async function runMonitorLoop() {
  // Stagger start by 30s so first temp cycle runs clean
  await sleep(30 * 1000);
  console.log('[worker] Starting market monitor loop (every 60 seconds)');

  while (true) {
    try {
      metrics.monitorCycles++;
      const { result, changedIds } = await scanMarketPrices(supabase);
      metrics.priceShiftsDetected += result.priceShifts;

      // If temperature markets repriced significantly, trigger immediate re-analysis
      // by clearing their recent-analysis cache timestamp
      if (changedIds.length > 0) {
        const { data: changedMarkets } = await supabase
          .from('markets')
          .select('id, category')
          .in('id', changedIds);

        const tempChangedIds = (changedMarkets ?? [])
          .filter((m: { category: string }) => m.category === 'temperature')
          .map((m: { id: string }) => m.id);

        if (tempChangedIds.length > 0) {
          metrics.immediateRetriggers += tempChangedIds.length;
          console.log(`[worker] ⚡ ${tempChangedIds.length} temperature markets repriced — invalidating analysis cache`);
          // Delete recent analyses for these markets so they get re-analyzed next cycle
          await supabase
            .from('weather_analyses')
            .delete()
            .in('market_id', tempChangedIds)
            .eq('market_type', 'temperature_statistical')
            .gte('analyzed_at', new Date(Date.now() - 4 * 3600000).toISOString());
        }
      }
    } catch (e) {
      metrics.errors++;
      console.error('[worker] Monitor loop error:', e);
    }
    await sleep(60 * 1000); // 60 seconds
  }
}

// ── Phase 1 (2026-06-12): true-ensemble ingest loop ──────────────────────────
// Run-aligned: ingestEnsembleForecasts() no-ops unless a new GFS/ECMWF run
// is available, so a 10-min cadence costs almost nothing between runs.
async function runEnsembleLoop() {
  await sleep(20 * 1000);
  console.log('[worker] Starting ensemble ingest loop (checks every 10 minutes, fetches per model run)');
  while (true) {
    try {
      const r = await ingestEnsembleForecasts(supabase, { verbose: true });
      if (r.errors > 0) metrics.errors += r.errors;
    } catch (e) {
      metrics.errors++;
      console.error('[worker] Ensemble loop error:', e);
    }
    await sleep(10 * 60 * 1000);
  }
}

// ── Phase 1: station actuals (METAR) + resolution-source backfill ────────────
async function runStationLoop() {
  await sleep(60 * 1000);
  console.log('[worker] Starting station-actuals loop (every 3 hours)');
  while (true) {
    try {
      const r = await ingestStationActuals(supabase, { verbose: true });
      if (r.errors > 0) metrics.errors += r.errors;
      const b = await backfillResolutionSources(supabase, { verbose: true });
      if (b.errors > 0) metrics.errors += b.errors;
    } catch (e) {
      metrics.errors++;
      console.error('[worker] Station loop error:', e);
    }
    await sleep(3 * 60 * 60 * 1000);
  }
}

// ── Phase 1: Kalshi KXHIGH snapshots (divergence signal + arb groundwork) ────
async function runKalshiLoop() {
  await sleep(90 * 1000);
  console.log('[worker] Starting Kalshi ingest loop (every 30 minutes)');
  while (true) {
    try {
      const r = await ingestKalshiSnapshots(supabase, { verbose: true });
      if (r.errors > 0) metrics.errors += r.errors;
    } catch (e) {
      metrics.errors++;
      console.error('[worker] Kalshi loop error:', e);
    }
    await sleep(30 * 60 * 1000);
  }
}

// ── Phase 1: maker paper-quote simulator (NEVER places orders) ───────────────
async function runMmSimLoop() {
  await sleep(2 * 60 * 1000);
  console.log('[worker] Starting MM paper-quote sim loop (every 30 minutes, observe-only)');
  while (true) {
    try {
      const r = await runMmQuoteSim(supabase, { verbose: true });
      if (r.errors > 0) metrics.errors += r.errors;
    } catch (e) {
      metrics.errors++;
      console.error('[worker] MM sim loop error:', e);
    }
    await sleep(30 * 60 * 1000);
  }
}

// ── Health log loop ───────────────────────────────────────────────────────────
async function runHealthLoop() {
  await sleep(15 * 1000); // first log after 15s
  while (true) {
    try {
      await logHealth();
    } catch (e) {
      console.error('[worker] Health log error:', e);
    }
    await sleep(15 * 60 * 1000); // every 15 minutes
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('[worker] SIGTERM received — logging final state and shutting down');
  await logHealth();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[worker] SIGINT received — shutting down');
  await logHealth();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[worker] Uncaught exception:', err);
  metrics.errors++;
  // Don't exit — Railway will restart on crash anyway, but we prefer to stay up
});

process.on('unhandledRejection', (reason) => {
  console.error('[worker] Unhandled promise rejection:', reason);
  metrics.errors++;
  // Don't exit — log and continue
});

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║        ARBITER Railway Worker v1.1        ║');
  console.log('║  Persistent analysis — no timeout limits  ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');
  console.log(`[worker] Node ${process.version} | PID ${process.pid}`);
  console.log(`[worker] Supabase: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
  console.log(`[worker] Started at ${new Date().toISOString()}`);

  // Verify DB connection
  const { error: pingErr } = await supabase.from('system_config').select('key').limit(1);
  if (pingErr) {
    console.error('[worker] FATAL: Cannot reach Supabase:', pingErr.message);
    process.exit(1);
  }
  console.log('[worker] ✅ Supabase connection OK');

  // Log startup to DB
  await supabase.from('system_config').upsert([
    { key: 'railway_worker_started_at', value: new Date().toISOString() },
    { key: 'railway_worker_version',    value: '1.2.0' },
  ], { onConflict: 'key' });

  // Run all loops concurrently — they never return (infinite while loops)
  await Promise.all([
    runTemperatureLoop(),
    runMonitorLoop(),
    runHealthLoop(),
    runEnsembleLoop(),   // Phase 1: true ensemble members (run-aligned)
    runStationLoop(),    // Phase 1: METAR actuals + resolution sources
    runKalshiLoop(),     // Phase 1: KXHIGH snapshots
    runMmSimLoop(),      // Phase 1: maker paper-quote sim (observe-only)
  ]);
}

main().catch(err => {
  console.error('[worker] FATAL crash in main():', err);
  process.exit(1);
});

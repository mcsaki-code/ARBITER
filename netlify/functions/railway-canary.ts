// ============================================================
// Netlify Scheduled Function: Railway Worker Canary
// ============================================================
// The Railway worker (worker/src/temperature.ts) is the LIVE
// weather analyzer — it writes 99%+ of weather_analyses rows.
// If Railway stops deploying from main, or the worker crashes,
// we lose our edge source silently.
//
// This canary checks two things every 15 minutes:
//   1. FRESHNESS — most recent railway_worker_v2 row must be
//      younger than MAX_STALENESS_MINUTES. Analyzer runs every
//      20-30 min, so 45 min is a comfortable alert threshold.
//   2. VERSION TAG — row must carry the `railway_worker_v2`
//      flag. If it's `railway_worker` (no _v2), something
//      rolled back the forecast-ensemble math.
//
// Alert cooldown: 2 hours between alerts (via system_config
// key `last_canary_alert`) so we don't spam the inbox during
// a sustained outage.
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_STALENESS_MINUTES = 45;
const ALERT_COOLDOWN_HOURS = 2;

async function sendCanaryAlert(subject: string, body: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.NOTIFICATION_EMAIL;
  if (!apiKey || !toEmail) {
    console.warn('[railway-canary] RESEND_API_KEY or NOTIFICATION_EMAIL unset — cannot alert');
    return;
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; background: #0d0d14; color: #e0e0e8; padding: 24px; border-radius: 12px;">
      <h2 style="color: #ff4d6d; margin: 0 0 16px 0; font-size: 18px;">Railway Canary — ${subject}</h2>
      <div style="background: #1a1a2e; padding: 16px; border-radius: 8px; font-size: 14px; line-height: 1.5;">
        ${body.split('\n').map((l) => `<p style="margin: 0 0 6px 0;">${l}</p>`).join('')}
      </div>
      <p style="font-size: 12px; color: #555570; margin-top: 12px;">
        ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET ·
        <a href="https://arbit3r.netlify.app/tracker" style="color: #f0b429;">Dashboard</a>
      </p>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Arbiter Canary <onboarding@resend.dev>',
        to: [toEmail],
        subject: `[ARBITER CANARY] ${subject}`,
        html,
      }),
    });
    if (!res.ok) {
      console.warn(`[railway-canary] Resend failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`[railway-canary] Resend error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function inCooldown(): Promise<boolean> {
  const { data } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'last_canary_alert')
    .maybeSingle();
  if (!data?.value) return false;
  const last = new Date(data.value).getTime();
  if (Number.isNaN(last)) return false;
  const ageHours = (Date.now() - last) / (1000 * 60 * 60);
  return ageHours < ALERT_COOLDOWN_HOURS;
}

async function markAlerted(): Promise<void> {
  await supabase
    .from('system_config')
    .upsert({ key: 'last_canary_alert', value: new Date().toISOString() });
}

export const handler = schedule('*/15 * * * *', async () => {
  console.log('[railway-canary] Checking Railway worker freshness');

  // Pull the most recent row tagged railway_worker_v2.
  // Use ::jsonb contains for accurate flag matching.
  const { data: recent, error } = await supabase
    .from('weather_analyses')
    .select('id, analyzed_at, flags, market_id')
    .contains('flags', ['railway_worker_v2'])
    .order('analyzed_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[railway-canary] query failed', error);
    return { statusCode: 500 };
  }

  // CHECK 1 — any v2 row at all?
  if (!recent || recent.length === 0) {
    // Before alerting, check if a non-v2 railway row exists (rollback scenario).
    const { data: legacy } = await supabase
      .from('weather_analyses')
      .select('id, analyzed_at, flags')
      .contains('flags', ['railway_worker'])
      .order('analyzed_at', { ascending: false })
      .limit(1);

    if (!(await inCooldown())) {
      const body = legacy && legacy.length > 0
        ? `No railway_worker_v2 rows found, but a legacy railway_worker row exists from ${legacy[0].analyzed_at}.\nLikely rollback — forecast-ensemble math may be disabled.\nCheck Railway deploy status + worker/src/temperature.ts.`
        : `No railway_worker rows found at all in weather_analyses.\nRailway worker may be down or never deployed since last purge.\nCheck Railway dashboard + logs.`;
      await sendCanaryAlert(legacy && legacy.length > 0 ? 'VERSION ROLLBACK' : 'WORKER SILENT', body);
      await markAlerted();
    }
    return { statusCode: 200 };
  }

  // CHECK 2 — staleness
  const latest = recent[0];
  const ageMs = Date.now() - new Date(latest.analyzed_at).getTime();
  const ageMinutes = ageMs / 1000 / 60;

  console.log(`[railway-canary] Latest v2 row: ${latest.analyzed_at} (${ageMinutes.toFixed(1)} min ago)`);

  if (ageMinutes > MAX_STALENESS_MINUTES) {
    if (!(await inCooldown())) {
      const body = `Latest railway_worker_v2 analysis is ${ageMinutes.toFixed(0)} minutes old (threshold: ${MAX_STALENESS_MINUTES} min).\nLast seen: ${latest.analyzed_at}\nMarket: ${latest.market_id}\n\nAnalyzer runs every 20-30 min — it should be writing more often than this.\nCheck Railway dashboard for worker health.`;
      await sendCanaryAlert('WORKER STALE', body);
      await markAlerted();
    }
    return { statusCode: 200, body: `STALE: ${ageMinutes.toFixed(0)}min` };
  }

  // Healthy path — log and return.
  return {
    statusCode: 200,
    body: `OK: v2 row ${ageMinutes.toFixed(1)}min old`,
  };
});

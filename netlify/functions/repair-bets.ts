// ============================================================
// Netlify Scheduled Function: Repair Bets
// Runs every 15 minutes — auto-backfills missing condition_ids
// on open paper bets. This is a permanent guard against the
// intermittent Supabase lookup failures in execute-bet.ts.
//
// Root cause: execute-bet.ts does a .single() lookup for
// condition_id and silently ignores the error. When that query
// fails transiently, bets are inserted with condition_id = null,
// which breaks resolve-bets.ts (can't match outcomes).
//
// This cron finds all open bets with null condition_id and
// backfills them from the markets table. One idempotent SQL
// statement — safe to run as many times as needed.
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const handler = schedule('*/15 * * * *', async () => {
  console.log('[repair-bets] Starting condition_id backfill');
  const start = Date.now();

  try {
    // Find all open bets missing condition_id
    const { data: broken, error: fetchErr } = await supabase
      .from('bets')
      .select('id, market_id')
      .is('condition_id', null)
      .eq('status', 'OPEN');

    if (fetchErr) {
      console.error('[repair-bets] Failed to fetch broken bets:', fetchErr.message);
      return { statusCode: 500 };
    }

    if (!broken || broken.length === 0) {
      console.log('[repair-bets] No broken bets found — all condition_ids present');
      return { statusCode: 200 };
    }

    console.log(`[repair-bets] Found ${broken.length} bets with null condition_id — backfilling`);

    let fixed = 0;
    let unfixable = 0;

    for (const bet of broken) {
      // Look up condition_id from markets table
      const { data: mkt, error: mktErr } = await supabase
        .from('markets')
        .select('condition_id')
        .eq('id', bet.market_id)
        .single();

      if (mktErr || !mkt?.condition_id) {
        console.warn(`[repair-bets] No condition_id in markets for bet ${bet.id} / market ${bet.market_id}`);
        unfixable++;
        continue;
      }

      const { error: updateErr } = await supabase
        .from('bets')
        .update({ condition_id: mkt.condition_id })
        .eq('id', bet.id);

      if (updateErr) {
        console.error(`[repair-bets] Failed to update bet ${bet.id}:`, updateErr.message);
      } else {
        console.log(`[repair-bets] Fixed bet ${bet.id} → ${mkt.condition_id.substring(0, 12)}...`);
        fixed++;
      }
    }

    const elapsed = Date.now() - start;
    console.log(`[repair-bets] Done in ${elapsed}ms: fixed=${fixed} unfixable=${unfixable}`);

    if (fixed > 0 || unfixable > 0) {
      await supabase.from('system_config').upsert([
        { key: 'repair_bets_last_run', value: new Date().toISOString() },
        { key: 'repair_bets_last_fixed', value: String(fixed) },
      ], { onConflict: 'key' });
    }

    return { statusCode: 200 };
  } catch (err) {
    console.error('[repair-bets] Unexpected error:', err);
    return { statusCode: 500 };
  }
});

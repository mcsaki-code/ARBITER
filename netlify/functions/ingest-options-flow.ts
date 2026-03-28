// ============================================================
// Netlify Scheduled Function: Options Flow Anomaly Detector
// Runs every 5 minutes
//
// STRATEGY: Large unusual options volume on SPY/QQQ/TLT often
// precedes market-moving announcements (tariff tweets, Fed surprises,
// macro events) by 30–120 minutes. We detect these spikes via Z-score
// and store them so analyze-sentiment-edge can correlate with Trump posts.
//
// DATA: CBOE delayed quotes (free, no auth) → Yahoo Finance fallback
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TICKERS = ['SPY', 'QQQ', 'TLT'];
const ANOMALY_ZSCORE_THRESHOLD = 2.0;   // 2 std devs from mean = unusual
const ROLLING_WINDOW_HOURS     = 48;    // Use 48h of history for baseline
const FETCH_TIMEOUT_MS         = 8000;

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json', ...headers },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

interface OptionsSnapshot {
  ticker: string;
  callVolume: number;
  putVolume: number;
  putCallRatio: number;
  raw: unknown;
}

// ── CBOE delayed quotes (primary — free, no auth needed) ──────────────
// Returns current day's aggregated call/put volume across all expirations.
async function fetchCboeOptions(ticker: string): Promise<OptionsSnapshot | null> {
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`;
  const data = await fetchJson(url) as {
    data?: { options?: { option?: { call_put?: string; volume?: number }[] } }
  } | null;

  if (!data?.data?.options?.option?.length) return null;

  let callVol = 0, putVol = 0;
  for (const opt of data.data.options.option) {
    const v = opt.volume ?? 0;
    if (opt.call_put === 'C') callVol += v;
    else if (opt.call_put === 'P') putVol += v;
  }

  if (callVol + putVol < 1000) return null; // Too thin — market closed or no data
  const pcr = callVol > 0 ? putVol / callVol : 999;
  return { ticker, callVolume: callVol, putVolume: putVol, putCallRatio: pcr, raw: data.data };
}

// ── Yahoo Finance fallback ──────────────────────────────────────────────
async function fetchYahooOptions(ticker: string): Promise<OptionsSnapshot | null> {
  const url = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`;
  const data = await fetchJson(url, {
    'User-Agent': 'Mozilla/5.0 (compatible; ARBITER/1.0)',
  }) as {
    optionChain?: {
      result?: [{
        options?: [{
          calls?: { volume?: number }[];
          puts?:  { volume?: number }[];
        }]
      }]
    }
  } | null;

  const opts = data?.optionChain?.result?.[0]?.options?.[0];
  if (!opts) return null;

  const callVol = (opts.calls ?? []).reduce((s, c) => s + (c.volume ?? 0), 0);
  const putVol  = (opts.puts  ?? []).reduce((s, p) => s + (p.volume ?? 0), 0);
  if (callVol + putVol < 1000) return null;
  const pcr = callVol > 0 ? putVol / callVol : 999;
  return { ticker, callVolume: callVol, putVolume: putVol, putCallRatio: pcr, raw: null };
}

async function fetchOptionsSnapshot(ticker: string): Promise<OptionsSnapshot | null> {
  const cboe = await fetchCboeOptions(ticker);
  if (cboe) return cboe;
  console.log(`[options-flow] CBOE failed for ${ticker} — trying Yahoo`);
  return fetchYahooOptions(ticker);
}

export const handler = schedule('*/5 * * * *', async () => {
  console.log('[options-flow] Scanning options for anomalies');
  const startTime = Date.now();

  const rollingCutoff = new Date(Date.now() - ROLLING_WINDOW_HOURS * 3600000).toISOString();

  // Fetch all three tickers in parallel
  const snapshots = await Promise.all(TICKERS.map(t => fetchOptionsSnapshot(t)));
  let anomaliesFound = 0;

  for (let i = 0; i < TICKERS.length; i++) {
    const snap = snapshots[i];
    const ticker = TICKERS[i];

    if (!snap) {
      console.log(`[options-flow] No data for ${ticker}`);
      continue;
    }

    // Load rolling history for this ticker to compute baseline
    const { data: history } = await supabase
      .from('options_flow_signals')
      .select('put_call_ratio')
      .eq('ticker', ticker)
      .gte('detected_at', rollingCutoff)
      .order('detected_at', { ascending: false })
      .limit(576); // 48h × 12 readings/h (5-min intervals)

    const historicalPCRs = (history ?? []).map((r: { put_call_ratio: number }) => r.put_call_ratio);

    let meanPCR = 1.0, stddevPCR = 0.3, zscore = 0;
    let isAnomaly = false;
    let direction = 'NEUTRAL';

    if (historicalPCRs.length >= 10) {
      meanPCR = historicalPCRs.reduce((a, b) => a + b, 0) / historicalPCRs.length;
      const variance = historicalPCRs.reduce((s, v) => s + Math.pow(v - meanPCR, 2), 0) / historicalPCRs.length;
      stddevPCR = Math.sqrt(variance);
      if (stddevPCR > 0) zscore = (snap.putCallRatio - meanPCR) / stddevPCR;
      isAnomaly = Math.abs(zscore) >= ANOMALY_ZSCORE_THRESHOLD;
      // High PCR (lots of puts) = bearish panic. Low PCR (lots of calls) = bullish surge.
      if (isAnomaly) {
        direction = zscore > 0 ? 'BEARISH' : 'BULLISH';
      }
    }

    const logLine = `${ticker}: PCR=${snap.putCallRatio.toFixed(3)} mean=${meanPCR.toFixed(3)} Z=${zscore.toFixed(2)} ${isAnomaly ? `⚠️ ANOMALY [${direction}]` : ''}`;
    console.log(`[options-flow] ${logLine}`);

    const { error } = await supabase.from('options_flow_signals').insert({
      ticker,
      call_volume:        snap.callVolume,
      put_volume:         snap.putVolume,
      put_call_ratio:     snap.putCallRatio,
      mean_pcr:           meanPCR,
      stddev_pcr:         stddevPCR,
      zscore,
      is_anomaly:         isAnomaly,
      anomaly_direction:  direction,
      raw_snapshot:       snap.raw ?? null,
    });

    if (error) console.error(`[options-flow] Insert error for ${ticker}:`, error.message);
    if (isAnomaly) anomaliesFound++;
  }

  // Prune signals older than 7 days to keep table lean
  await supabase
    .from('options_flow_signals')
    .delete()
    .lt('detected_at', new Date(Date.now() - 7 * 86400000).toISOString());

  console.log(`[options-flow] Done in ${Date.now() - startTime}ms. Anomalies: ${anomaliesFound}`);
  return { statusCode: 200 };
});

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

// ── Robust fetch with status logging ─────────────────────────────────
async function fetchJson(url: string, headers?: Record<string, string>): Promise<{ data: unknown; status: number } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ARBITER/1.1; +https://arbit3r.netlify.app)',
        ...headers,
      },
    });
    if (!res.ok) {
      console.log(`[options-flow] HTTP ${res.status} from ${url}`);
      return null;
    }
    const data = await res.json();
    return { data, status: res.status };
  } catch (e) {
    console.log(`[options-flow] Fetch error for ${url}: ${e}`);
    return null;
  }
}

interface OptionsSnapshot {
  ticker: string;
  callVolume: number;
  putVolume: number;
  putCallRatio: number;
  raw: unknown;
}

// ── CBOE delayed quotes (primary — free, no auth needed) ──────────────
// Response shape: { data: { symbol: string, options: Array<{ option: string, type?: string, call_put?: string, volume?: number }> } }
// The OCC option symbol encodes call/put: e.g. SPY231229C00400000 → C=call, P=put (char at index len-15)
async function fetchCboeOptions(ticker: string): Promise<OptionsSnapshot | null> {
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`;
  const result = await fetchJson(url);
  if (!result) return null;

  const data = result.data as {
    data?: {
      options?: Array<{
        option?: string;
        call_put?: string;   // some endpoints use "C"/"P"
        type?: string;       // some endpoints use "call"/"put"
        volume?: number;
        total_volume?: number;
      }>;
    };
  } | null;

  // Try the nested structure first (some CBOE endpoints)
  const options = data?.data?.options;
  if (!options || !Array.isArray(options) || options.length === 0) {
    console.log(`[options-flow] CBOE: no options array for ${ticker} (keys: ${Object.keys(data?.data ?? {}).join(',')})`);
    return null;
  }

  let callVol = 0, putVol = 0;
  for (const opt of options) {
    const vol = opt.total_volume ?? opt.volume ?? 0;
    if (vol === 0) continue;

    // Determine call vs put — try multiple field names
    let isCall = false;
    let isPut  = false;

    if (opt.call_put) {
      isCall = opt.call_put.toUpperCase() === 'C';
      isPut  = opt.call_put.toUpperCase() === 'P';
    } else if (opt.type) {
      isCall = opt.type.toLowerCase() === 'call';
      isPut  = opt.type.toLowerCase() === 'put';
    } else if (opt.option) {
      // OCC symbol: e.g. SPY231229C00400000 — the letter after the date is C or P
      // Date is 6 chars (YYMMDD), so C/P is at index ticker.length + 6
      const occSymbol = opt.option;
      const cpIndex   = ticker.length + 6;
      if (cpIndex < occSymbol.length) {
        isCall = occSymbol[cpIndex] === 'C';
        isPut  = occSymbol[cpIndex] === 'P';
      }
    }

    if (isCall) callVol += vol;
    else if (isPut) putVol += vol;
  }

  const totalVol = callVol + putVol;
  console.log(`[options-flow] CBOE ${ticker}: ${options.length} contracts, calls=${callVol.toLocaleString()} puts=${putVol.toLocaleString()}`);

  // Market closed or no real data — store a zero-volume marker for baseline continuity
  if (totalVol < 100) {
    console.log(`[options-flow] CBOE ${ticker}: volume too thin (${totalVol}) — market likely closed`);
    return { ticker, callVolume: 0, putVolume: 0, putCallRatio: 1.0, raw: null };
  }

  const pcr = callVol > 0 ? putVol / callVol : 9.99;
  return { ticker, callVolume: callVol, putVolume: putVol, putCallRatio: pcr, raw: null };
}

// ── Yahoo Finance fallback ──────────────────────────────────────────────
async function fetchYahooOptions(ticker: string): Promise<OptionsSnapshot | null> {
  // v7 often 403s; try v8 first
  const urls = [
    `https://query2.finance.yahoo.com/v7/finance/options/${ticker}`,
    `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`,
  ];

  for (const url of urls) {
    const result = await fetchJson(url);
    if (!result) continue;

    const data = result.data as {
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
    if (!opts) {
      console.log(`[options-flow] Yahoo ${ticker}: no options data`);
      continue;
    }

    const callVol = (opts.calls ?? []).reduce((s, c) => s + (c.volume ?? 0), 0);
    const putVol  = (opts.puts  ?? []).reduce((s, p) => s + (p.volume ?? 0), 0);

    const totalVol = callVol + putVol;
    console.log(`[options-flow] Yahoo ${ticker}: calls=${callVol.toLocaleString()} puts=${putVol.toLocaleString()}`);

    if (totalVol < 100) {
      return { ticker, callVolume: 0, putVolume: 0, putCallRatio: 1.0, raw: null };
    }

    const pcr = callVol > 0 ? putVol / callVol : 9.99;
    return { ticker, callVolume: callVol, putVolume: putVol, putCallRatio: pcr, raw: null };
  }

  return null;
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
  let dataFound = 0;

  for (let i = 0; i < TICKERS.length; i++) {
    const snap = snapshots[i];
    const ticker = TICKERS[i];

    if (!snap) {
      console.log(`[options-flow] No data for ${ticker} — skipping insert`);
      continue;
    }

    dataFound++;

    // Load rolling history for this ticker to compute baseline
    const { data: history } = await supabase
      .from('options_flow_signals')
      .select('put_call_ratio')
      .eq('ticker', ticker)
      .gte('detected_at', rollingCutoff)
      .order('detected_at', { ascending: false })
      .limit(576); // 48h × 12 readings/h (5-min intervals)

    const historicalPCRs = (history ?? [])
      .map((r: { put_call_ratio: number }) => r.put_call_ratio)
      .filter((v: number) => v > 0 && v < 99); // exclude closed-market 1.0 sentinels from baseline

    let meanPCR = 1.0, stddevPCR = 0.3, zscore = 0;
    let isAnomaly = false;
    let direction = 'NEUTRAL';

    if (historicalPCRs.length >= 10) {
      meanPCR = historicalPCRs.reduce((a: number, b: number) => a + b, 0) / historicalPCRs.length;
      const variance = historicalPCRs.reduce((s: number, v: number) => s + Math.pow(v - meanPCR, 2), 0) / historicalPCRs.length;
      stddevPCR = Math.sqrt(variance);
      if (stddevPCR > 0.01 && snap.putCallRatio > 0) {
        zscore = (snap.putCallRatio - meanPCR) / stddevPCR;
        isAnomaly = Math.abs(zscore) >= ANOMALY_ZSCORE_THRESHOLD;
        // High PCR (lots of puts) = bearish panic. Low PCR (lots of calls) = bullish surge.
        if (isAnomaly) {
          direction = zscore > 0 ? 'BEARISH' : 'BULLISH';
        }
      }
    }

    const logLine = `${ticker}: PCR=${snap.putCallRatio.toFixed(3)} mean=${meanPCR.toFixed(3)} Z=${zscore.toFixed(2)} history=${historicalPCRs.length} ${isAnomaly ? `⚠️ ANOMALY [${direction}]` : ''}`;
    console.log(`[options-flow] ${logLine}`);

    const { error } = await supabase.from('options_flow_signals').insert({
      ticker,
      call_volume:        snap.callVolume,
      put_volume:         snap.putVolume,
      put_call_ratio:     snap.putCallRatio > 0 ? snap.putCallRatio : null,
      mean_pcr:           meanPCR,
      stddev_pcr:         stddevPCR,
      zscore,
      is_anomaly:         isAnomaly,
      anomaly_direction:  direction,
      raw_snapshot:       null,
    });

    if (error) console.error(`[options-flow] Insert error for ${ticker}:`, error.message);
    if (isAnomaly) anomaliesFound++;
  }

  // Prune signals older than 7 days to keep table lean
  await supabase
    .from('options_flow_signals')
    .delete()
    .lt('detected_at', new Date(Date.now() - 7 * 86400000).toISOString());

  console.log(`[options-flow] Done in ${Date.now() - startTime}ms. dataFound=${dataFound} anomalies=${anomaliesFound}`);
  return { statusCode: 200 };
});

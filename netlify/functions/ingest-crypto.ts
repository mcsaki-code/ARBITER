// V3 DISABLED: Weather-only rebuild. This function is not part of the active pipeline.
// ============================================================
// Netlify Scheduled Function: Ingest Crypto Signals v2
// Runs every 10 minutes — BTC/ETH/SOL price data + indicators
// FIXED: Replaced Binance (US-blocked) with CoinCap + CryptoCompare
// Both are free, no API keys, no geo restrictions
// ============================================================

// import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[ingest-crypto] HTTP ${res.status} for ${url.split('?')[0]}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[ingest-crypto] Fetch error for ${url.split('?')[0]}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Indicator Helpers ──────────────────────────────────────

function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateBB(closes: number[], period = 20) {
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  return { upper: mid + 2 * std, lower: mid - 2 * std, mid };
}

// ── CoinGecko API ──────────────────────────────────────────
// Free simple price API — no key, no US restrictions.
// Returns USD price, 24h change, 24h volume in one call.

interface CoinGeckoSimplePrice {
  [coinId: string]: {
    usd: number;
    usd_24h_change: number;
    usd_24h_vol: number;
  };
}

const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
};

// Fetch all three prices in a single API call
async function fetchCoinGeckoPrices(): Promise<CoinGeckoSimplePrice | null> {
  const ids = Object.values(COINGECKO_IDS).join(',');
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`
  );
  return (data as CoinGeckoSimplePrice | null);
}

// ── CryptoCompare API ──────────────────────────────────────
// Free public endpoints, no key required for basic use.
// US accessible. Returns OHLCV candle data.

interface CCCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeto: number;
}

interface CCResponse {
  Response: string;
  Data: { Data: CCCandle[] };
}

async function fetchHourlyCandles(symbol: string, limit = 50): Promise<CCCandle[]> {
  const data = await fetchJson(
    `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=${limit}`
  ) as CCResponse | null;
  return data?.Data?.Data ?? [];
}

async function fetchMinuteCandles(symbol: string, limit = 15): Promise<CCCandle[]> {
  const data = await fetchJson(
    `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USD&limit=${limit}`
  ) as CCResponse | null;
  return data?.Data?.Data ?? [];
}

// ── Polymarket Market Discovery ────────────────────────────

interface GammaMarket {
  conditionId: string;
  question: string;
  outcomes: string;
  outcomePrices: string;
  volume: string;
  liquidity: string;
  endDate: string;
  active: boolean;
  closed: boolean;
}

interface GammaEvent {
  id: string;
  title: string;
  markets: GammaMarket[];
}

export const handler = async () => {
  console.log('[ingest-crypto] V3 DISABLED — weather-only mode'); return { statusCode: 200 };
  console.log('[ingest-crypto] Starting crypto signal ingestion v2');
  const startTime = Date.now();

  // ── 1. Fetch spot prices and candles in parallel ───────────
  const ASSETS = ['BTC', 'ETH', 'SOL'];

  const [geckoData, btcCandles, ethCandles, solCandles, btcMinutes] =
    await Promise.all([
      fetchCoinGeckoPrices(),
      fetchHourlyCandles('BTC', 50),
      fetchHourlyCandles('ETH', 50),
      fetchHourlyCandles('SOL', 50),
      fetchMinuteCandles('BTC', 15),
    ]);

  if (!geckoData) {
    console.error('[ingest-crypto] CoinGecko API returned null — connectivity issue');
    return { statusCode: 200 };
  }

  const candleData: Record<string, CCCandle[]> = {
    BTC: btcCandles,
    ETH: ethCandles,
    SOL: solCandles,
  };

  // ── 2. Build signal rows ────────────────────────────────────
  const signalRows: {
    asset: string;
    spot_price: number;
    price_1h_ago: number | null;
    price_24h_ago: number | null;
    volume_24h: number | null;
    rsi_14: number | null;
    bb_upper: number | null;
    bb_lower: number | null;
    funding_rate: number | null;
    open_interest: number | null;
    fear_greed: number | null;
    implied_vol: number | null;
    signal_summary: string;
    // New: momentum fields for 15-min strategy
    momentum_1m: number | null;   // % change over last 3 1-min candles
    momentum_5m: number | null;   // % change over last 5 1-min candles
    candles_1m: string | null;    // JSON array of last 10 1-min closes (for momentum worker)
  }[] = [];

  for (const asset of ASSETS) {
    const geckoId = COINGECKO_IDS[asset];
    const assetInfo = geckoData[geckoId];
    if (!assetInfo?.usd) {
      console.log(`[ingest-crypto] No CoinGecko data for ${asset}, skipping`);
      continue;
    }

    const spotPrice = assetInfo.usd;
    const change24h = assetInfo.usd_24h_change ?? 0;
    const volume24h = assetInfo.usd_24h_vol ?? null;
    const price24hAgo = change24h !== 0 ? spotPrice / (1 + change24h / 100) : spotPrice;

    const candles = candleData[asset];
    let rsi14: number | null = null;
    let bbUpper: number | null = null;
    let bbLower: number | null = null;
    let price1hAgo: number | null = null;

    if (candles.length > 20) {
      const closes = candles.map(c => c.close);
      rsi14 = calculateRSI(closes);
      const bb = calculateBB(closes);
      bbUpper = bb.upper;
      bbLower = bb.lower;
      price1hAgo = closes[closes.length - 2] ?? null;
    }

    // 1-minute momentum (only computed for BTC — most liquid for 15-min markets)
    let momentum1m: number | null = null;
    let momentum5m: number | null = null;
    let candles1mJson: string | null = null;

    if (asset === 'BTC' && btcMinutes.length >= 5) {
      const minCloses = btcMinutes.map(c => c.close);
      const last = minCloses[minCloses.length - 1];
      const threeBack = minCloses[minCloses.length - 4];
      const fiveBack = minCloses[minCloses.length - 6] ?? minCloses[0];
      momentum1m = ((last - threeBack) / threeBack) * 100; // % over 3 mins
      momentum5m = ((last - fiveBack) / fiveBack) * 100;   // % over 5 mins
      candles1mJson = JSON.stringify(minCloses.slice(-10));
    }

    const signals: Record<string, string> = {};
    if (rsi14 !== null) {
      signals.rsi = rsi14 > 70 ? 'OVERBOUGHT' : rsi14 < 30 ? 'OVERSOLD' : 'NEUTRAL';
    }
    if (bbUpper !== null && bbLower !== null) {
      signals.bollinger = spotPrice > bbUpper ? 'ABOVE_UPPER'
        : spotPrice < bbLower ? 'BELOW_LOWER' : 'WITHIN_BANDS';
    }
    if (momentum1m !== null) {
      signals.momentum_3m = momentum1m > 0.3 ? 'STRONG_UP'
        : momentum1m > 0.1 ? 'UP'
        : momentum1m < -0.3 ? 'STRONG_DOWN'
        : momentum1m < -0.1 ? 'DOWN' : 'FLAT';
    }
    signals.change_24h = `${change24h.toFixed(2)}%`;

    signalRows.push({
      asset,
      spot_price: spotPrice,
      price_1h_ago: price1hAgo,
      price_24h_ago: price24hAgo,
      volume_24h: volume24h,
      rsi_14: rsi14,
      bb_upper: bbUpper,
      bb_lower: bbLower,
      funding_rate: null, // Coinglass requires auth now — skip
      open_interest: null,
      fear_greed: null,
      implied_vol: null,
      signal_summary: JSON.stringify(signals),
      momentum_1m: momentum1m,
      momentum_5m: momentum5m,
      candles_1m: candles1mJson,
    });

    console.log(
      `[ingest-crypto] ${asset}: $${spotPrice.toFixed(2)} | RSI=${rsi14?.toFixed(1) ?? 'N/A'} | 24h=${change24h.toFixed(2)}% | mom3m=${momentum1m?.toFixed(3) ?? 'N/A'}%`
    );
  }

  // ── 3. Store signals ────────────────────────────────────────
  if (signalRows.length > 0) {
    const { error } = await supabase.from('crypto_signals').insert(signalRows);
    if (error) console.error('[ingest-crypto] Insert error:', error.message);
    else console.log(`[ingest-crypto] Stored ${signalRows.length} signal snapshots`);
  } else {
    console.error('[ingest-crypto] No signal data produced — check CoinCap/CryptoCompare connectivity');
  }

  // ── 4. Discover Polymarket crypto markets (parallel) ────────
  if (Date.now() - startTime < 15000) {
    const cryptoTagSlugs = ['crypto', 'bitcoin', 'ethereum', 'solana'];

    const tagFetches = cryptoTagSlugs.map(slug =>
      fetchJson(`https://gamma-api.polymarket.com/tags/slug/${slug}`)
        .then(tag => (tag as { id?: number } | null)?.id ?? null)
    );
    const tagIds = (await Promise.all(tagFetches)).filter((id): id is number => id !== null);
    const uniqueTagIds = [...new Set(tagIds)];

    const eventFetches = uniqueTagIds.map(id =>
      fetchJson(`https://gamma-api.polymarket.com/events?tag_id=${id}&active=true&closed=false&limit=100`)
    );
    const eventPages = await Promise.all(eventFetches);

    const seenIds = new Set<string>();
    const cryptoMarketRows: object[] = [];

    for (const page of eventPages) {
      if (!Array.isArray(page)) continue;
      for (const event of page as GammaEvent[]) {
        if (!event.markets) continue;
        for (const m of event.markets) {
          if (!m.conditionId || seenIds.has(m.conditionId)) continue;
          seenIds.add(m.conditionId);

          let outcomes: string[];
          let outcomePrices: number[];
          try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = m.outcomes?.split(',').map(s => s.trim()) || []; }
          try { outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p)); } catch { outcomePrices = []; }

          cryptoMarketRows.push({
            condition_id: m.conditionId,
            question: m.question,
            category: 'crypto',
            outcomes,
            outcome_prices: outcomePrices,
            volume_usd: parseFloat(m.volume) || 0,
            liquidity_usd: parseFloat(m.liquidity) || 0,
            resolution_date: m.endDate,
            is_active: m.active && !m.closed,
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    if (cryptoMarketRows.length > 0) {
      const { error } = await supabase
        .from('markets')
        .upsert(cryptoMarketRows, { onConflict: 'condition_id' });
      if (error) console.error('[ingest-crypto] Markets upsert error:', error.message);
      else console.log(`[ingest-crypto] Upserted ${cryptoMarketRows.length} crypto markets`);
    }
  }

  // ── 5. Cleanup old signals ──────────────────────────────────
  await supabase
    .from('crypto_signals')
    .delete()
    .lt('fetched_at', new Date(Date.now() - 86400000).toISOString());

  console.log(`[ingest-crypto] Done in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

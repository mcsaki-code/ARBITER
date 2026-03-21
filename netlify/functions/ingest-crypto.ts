// ============================================================
// Netlify Scheduled Function: Ingest Crypto Signals
// Runs every 10 minutes — pulls BTC/ETH price data + indicators
// and cross-references with Polymarket price bracket markets
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  volume: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  openPrice: string;
}

interface BinanceKline {
  0: number;  // open time
  1: string;  // open
  2: string;  // high
  3: string;  // low
  4: string;  // close
  5: string;  // volume
}

interface CoinGeckoData {
  bitcoin?: {
    usd: number;
    usd_24h_vol: number;
    usd_24h_change: number;
  };
  ethereum?: {
    usd: number;
    usd_24h_vol: number;
    usd_24h_change: number;
  };
}

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

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Simple RSI calculation from price data
function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Bollinger Bands
function calculateBB(closes: number[], period = 20): { upper: number; lower: number; mid: number } {
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - mid, 2), 0) / slice.length;
  const stdDev = Math.sqrt(variance);
  return { upper: mid + 2 * stdDev, lower: mid - 2 * stdDev, mid };
}

export const handler = schedule('*/10 * * * *', async () => {
  console.log('[ingest-crypto] Starting crypto signal ingestion');
  const startTime = Date.now();

  // ======== 1. FETCH PRICE DATA ========

  // Binance 24h ticker
  const btcTicker = await fetchJson(
    'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'
  ) as BinanceTicker | null;

  const ethTicker = await fetchJson(
    'https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT'
  ) as BinanceTicker | null;

  // Binance 1h klines (last 50 candles for RSI/BB calculation)
  const btcKlines = await fetchJson(
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=50'
  ) as BinanceKline[] | null;

  const ethKlines = await fetchJson(
    'https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1h&limit=50'
  ) as BinanceKline[] | null;

  // CoinGecko for additional cross-reference
  const cgData = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true'
  ) as CoinGeckoData | null;

  // Coinglass funding rates (public endpoint)
  const fundingData = await fetchJson(
    'https://open-api.coinglass.com/public/v2/funding?symbol=BTC&time_type=h1'
  ) as { data?: { fundingRate?: number }[] } | null;

  // ======== 2. CALCULATE INDICATORS ========

  const assets: { asset: string; ticker: BinanceTicker | null; klines: BinanceKline[] | null }[] = [
    { asset: 'BTC', ticker: btcTicker, klines: btcKlines },
    { asset: 'ETH', ticker: ethTicker, klines: ethKlines },
  ];

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
  }[] = [];

  for (const { asset, ticker, klines } of assets) {
    if (!ticker) {
      console.log(`[ingest-crypto] No ticker data for ${asset}, skipping`);
      continue;
    }

    const spotPrice = parseFloat(ticker.lastPrice);
    const openPrice = parseFloat(ticker.openPrice);
    const volume24h = parseFloat(ticker.volume) * spotPrice; // Convert to USD

    // Calculate indicators from klines
    let rsi14: number | null = null;
    let bbUpper: number | null = null;
    let bbLower: number | null = null;
    let price1hAgo: number | null = null;

    if (klines && klines.length > 20) {
      const closes = klines.map((k) => parseFloat(k[4]));
      rsi14 = calculateRSI(closes);
      const bb = calculateBB(closes);
      bbUpper = bb.upper;
      bbLower = bb.lower;
      price1hAgo = closes[closes.length - 2] || null;
    }

    // Funding rate from Coinglass (only for BTC currently)
    let fundingRate: number | null = null;
    if (asset === 'BTC' && fundingData?.data?.[0]?.fundingRate !== undefined) {
      fundingRate = fundingData.data[0].fundingRate;
    }

    // Build signal summary
    const signals: Record<string, string> = {};
    if (rsi14 !== null) {
      if (rsi14 > 70) signals.rsi = 'OVERBOUGHT';
      else if (rsi14 < 30) signals.rsi = 'OVERSOLD';
      else signals.rsi = 'NEUTRAL';
    }
    if (bbUpper && bbLower) {
      if (spotPrice > bbUpper) signals.bollinger = 'ABOVE_UPPER';
      else if (spotPrice < bbLower) signals.bollinger = 'BELOW_LOWER';
      else signals.bollinger = 'WITHIN_BANDS';
    }
    if (fundingRate !== null) {
      if (fundingRate > 0.01) signals.funding = 'HIGH_LONG_PRESSURE';
      else if (fundingRate < -0.01) signals.funding = 'HIGH_SHORT_PRESSURE';
      else signals.funding = 'NEUTRAL';
    }

    const priceChange24h = ((spotPrice - openPrice) / openPrice * 100).toFixed(2);
    signals.momentum_24h = `${priceChange24h}%`;

    signalRows.push({
      asset,
      spot_price: spotPrice,
      price_1h_ago: price1hAgo,
      price_24h_ago: openPrice,
      volume_24h: volume24h,
      rsi_14: rsi14,
      bb_upper: bbUpper,
      bb_lower: bbLower,
      funding_rate: fundingRate,
      open_interest: null, // Would need authenticated API
      fear_greed: null, // Would need alternative.me API
      implied_vol: null, // Would need Deribit API
      signal_summary: JSON.stringify(signals),
    });

    console.log(`[ingest-crypto] ${asset}: $${spotPrice.toFixed(2)} | RSI=${rsi14?.toFixed(1) ?? 'N/A'} | BB=[${bbLower?.toFixed(0) ?? '?'}, ${bbUpper?.toFixed(0) ?? '?'}] | 24h=${priceChange24h}%`);
  }

  // ======== 3. STORE SIGNALS ========
  if (signalRows.length > 0) {
    const { error } = await supabase.from('crypto_signals').insert(signalRows);
    if (error) console.error('[ingest-crypto] Insert error:', error.message);
    else console.log(`[ingest-crypto] Stored ${signalRows.length} signal snapshots`);
  }

  // ======== 4. DISCOVER POLYMARKET CRYPTO MARKETS ========
  const cryptoTagSlugs = ['crypto', 'bitcoin', 'ethereum'];
  const polymarketCrypto: GammaMarket[] = [];
  const seenIds = new Set<string>();

  for (const slug of cryptoTagSlugs) {
    if (Date.now() - startTime > 18000) break;
    const tag = await fetchJson(
      `https://gamma-api.polymarket.com/tags/slug/${slug}`
    ) as { id?: number } | null;

    if (tag?.id) {
      const events = await fetchJson(
        `https://gamma-api.polymarket.com/events?tag_id=${tag.id}&active=true&closed=false&limit=100`
      );
      if (Array.isArray(events)) {
        for (const event of events as GammaEvent[]) {
          if (event.markets) {
            for (const m of event.markets) {
              if (m.conditionId && !seenIds.has(m.conditionId)) {
                seenIds.add(m.conditionId);
                polymarketCrypto.push(m);
              }
            }
          }
        }
      }
    }
  }

  console.log(`[ingest-crypto] Found ${polymarketCrypto.length} Polymarket crypto markets`);

  // Upsert crypto markets into the markets table
  if (polymarketCrypto.length > 0) {
    const cryptoMarketRows = polymarketCrypto.map((m) => {
      let outcomes: string[];
      let outcomePrices: number[];
      try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = m.outcomes?.split(',').map(s => s.trim()) || []; }
      try { outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p)); } catch { outcomePrices = []; }

      return {
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
      };
    });

    const { error } = await supabase
      .from('markets')
      .upsert(cryptoMarketRows, { onConflict: 'condition_id' });
    if (error) console.error('[ingest-crypto] Markets upsert error:', error.message);
    else console.log(`[ingest-crypto] Upserted ${cryptoMarketRows.length} crypto markets`);
  }

  // Cleanup: keep only last 24h of signal snapshots
  await supabase
    .from('crypto_signals')
    .delete()
    .lt('fetched_at', new Date(Date.now() - 86400000).toISOString());

  const elapsed = Date.now() - startTime;
  console.log(`[ingest-crypto] Done in ${elapsed}ms`);

  return { statusCode: 200 };
});

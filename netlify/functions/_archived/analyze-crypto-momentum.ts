// V3 DISABLED: Weather-only rebuild. This function is not part of the active pipeline.
// ============================================================
// Netlify Scheduled Function: Crypto 15-Minute Momentum
// Runs every 5 minutes — the strategy behind the $313→$438K bot
//
// HOW IT WORKS:
// Polymarket runs continuous 15-minute BTC/ETH/SOL "higher/lower"
// markets. When confirmed spot momentum appears on exchanges,
// Polymarket's price lags by 30-90 seconds. This function detects
// that lag and bets before the market corrects.
//
// RULE-BASED (no Claude) — speed is everything here.
// Decision happens in <200ms. Claude latency = missed window.
// ============================================================

// import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { executeBet } from '../../src/lib/execute-bet';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Signal thresholds (tuned from $313→$438K bot research) ──
const MIN_MOMENTUM_3M_PCT  = 0.25;  // % move in 3 min to trigger signal
const MIN_MOMENTUM_5M_PCT  = 0.40;  // % move in 5 min (confirmation)
const MIN_EDGE_TO_BET      = 0.05;  // 5% edge minimum
const MAX_BET_PCT_BANKROLL = 0.015; // 1.5% per 15-min bet (higher frequency)
const MIN_MINUTES_REMAINING = 3;    // Don't bet in last 3 minutes (too late)
const MAX_MINUTES_REMAINING = 13;   // Don't bet at very start (wait for signal)

async function fetchJson(url: string, timeoutMs = 6000): Promise<unknown> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface CCMinuteData {
  Response: string;
  Data: {
    Data: Array<{ time: number; open: number; high: number; low: number; close: number; volumeto: number }>;
  };
}

interface GammaMarket {
  conditionId: string;
  question: string;
  outcomePrices: string;
  outcomes: string;
  volume: string;
  liquidity: string;
  endDate: string;
  active: boolean;
  closed: boolean;
}

// ── Momentum signal calculation ─────────────────────────────
interface MomentumSignal {
  asset: string;
  direction: 'UP' | 'DOWN' | 'NONE';
  momentum3m: number;  // % change over 3 min
  momentum5m: number;  // % change over 5 min
  allConsistent: boolean;  // all candles moving in same direction
  strength: 'STRONG' | 'MODERATE' | 'WEAK';
  currentPrice: number;
}

async function getMomentumSignal(asset: string): Promise<MomentumSignal | null> {
  const symbol = asset === 'BTC' ? 'BTC' : asset === 'ETH' ? 'ETH' : 'SOL';

  const data = await fetchJson(
    `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USD&limit=8`
  ) as CCMinuteData | null;

  if (!data?.Data?.Data?.length) return null;

  const candles = data.Data.Data;
  if (candles.length < 6) return null;

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volumeto);
  const currentPrice = closes[closes.length - 1];

  // Last 3 candles vs 3 candles ago
  const price3mAgo = closes[closes.length - 4];
  const price5mAgo = closes[closes.length - 6] ?? closes[0];

  const momentum3m = ((currentPrice - price3mAgo) / price3mAgo) * 100;
  const momentum5m = ((currentPrice - price5mAgo) / price5mAgo) * 100;

  // Check if all candles are moving in the same direction
  const last4 = closes.slice(-4);
  const allUp   = last4.every((c, i) => i === 0 || c > last4[i - 1]);
  const allDown = last4.every((c, i) => i === 0 || c < last4[i - 1]);
  const allConsistent = allUp || allDown;

  // Volume confirmation: latest volume above 3-period average
  const avgVol = volumes.slice(-4, -1).reduce((a, b) => a + b, 0) / 3;
  const volConfirmed = volumes[volumes.length - 1] > avgVol * 1.1;

  let direction: 'UP' | 'DOWN' | 'NONE' = 'NONE';
  let strength: 'STRONG' | 'MODERATE' | 'WEAK' = 'WEAK';

  if (momentum3m > MIN_MOMENTUM_3M_PCT && momentum5m > MIN_MOMENTUM_5M_PCT) {
    direction = 'UP';
    strength = allConsistent && volConfirmed ? 'STRONG' : allConsistent ? 'MODERATE' : 'WEAK';
  } else if (momentum3m < -MIN_MOMENTUM_3M_PCT && momentum5m < -MIN_MOMENTUM_5M_PCT) {
    direction = 'DOWN';
    strength = allConsistent && volConfirmed ? 'STRONG' : allConsistent ? 'MODERATE' : 'WEAK';
  }

  return { asset, direction, momentum3m, momentum5m, allConsistent, strength, currentPrice };
}

// ── Market matching ──────────────────────────────────────────
function is15MinMarket(question: string): boolean {
  const q = question.toLowerCase();
  return (
    (q.includes('15') || q.includes('15-min') || q.includes('15 min')) &&
    (q.includes('higher') || q.includes('lower') || q.includes('above') || q.includes('below') ||
     q.includes('up') || q.includes('down'))
  ) || (
    // Also catch "Will BTC be above $X at HH:MM?" markets (short duration)
    (q.includes('bitcoin') || /\bbtc\b/.test(q) || q.includes('ethereum') || /\beth\b/.test(q) || q.includes('solana') || /\bsol\b/.test(q)) &&
    (q.includes(':') && (q.includes('above') || q.includes('below')))
  );
}

function marketMatchesAsset(question: string, asset: string): boolean {
  const q = question.toLowerCase();
  if (asset === 'BTC') return q.includes('bitcoin') || q.includes('btc');
  if (asset === 'ETH') return q.includes('ethereum') || /\beth\b/.test(q);
  if (asset === 'SOL') return q.includes('solana') || /\bsol\b/.test(q);
  return false;
}

// ── Edge calculation for 15-min markets ─────────────────────
// Given confirmed momentum, estimate true probability of continued movement.
// Research shows: strong momentum (>0.3% in 3min) predicts direction
// at ~68-72% accuracy in 15-min windows.
function estimateTrueProb(signal: MomentumSignal, isUpQuestion: boolean): number {
  const baseProb = signal.strength === 'STRONG' ? 0.70
    : signal.strength === 'MODERATE' ? 0.63
    : 0.57;

  const directionMatchesUp = signal.direction === 'UP' && isUpQuestion;
  const directionMatchesDown = signal.direction === 'DOWN' && !isUpQuestion;

  if (directionMatchesUp || directionMatchesDown) return baseProb;
  return 1 - baseProb; // Wrong direction
}

export const handler = async () => {
  console.log('[analyze-crypto-momentum] V3 DISABLED — weather-only mode'); return { statusCode: 200 };
  console.log('[momentum] Starting 15-min crypto momentum scan');
  const startTime = Date.now();

  // ── Load bankroll + open positions ────────────────────────
  const [configResult, openBetsResult] = await Promise.all([
    supabase.from('system_config').select('key, value')
      .in('key', ['paper_bankroll', 'total_paper_bets', 'live_trading_enabled', 'live_kill_switch']),
    supabase.from('bets').select('market_id').eq('status', 'OPEN'),
  ]);

  const config: Record<string, string> = {};
  configResult.data?.forEach((r: { key: string; value: string }) => { config[r.key] = r.value; });
  const bankroll = parseFloat(config.paper_bankroll || '500');
  const openMarketIds = new Set((openBetsResult.data ?? []).map(b => b.market_id));

  // ── Get momentum signals for BTC, ETH, SOL in parallel ────
  const [btcSignal, ethSignal] = await Promise.all([
    getMomentumSignal('BTC'),
    getMomentumSignal('ETH'),
  ]);

  const signals = [btcSignal, ethSignal].filter((s): s is MomentumSignal => s !== null && s.direction !== 'NONE');

  if (signals.length === 0) {
    console.log('[momentum] No directional momentum detected');
    return { statusCode: 200 };
  }

  for (const signal of signals) {
    console.log(`[momentum] ${signal.asset}: ${signal.direction} | 3m=${signal.momentum3m.toFixed(3)}% | 5m=${signal.momentum5m.toFixed(3)}% | strength=${signal.strength}`);
  }

  // ── Find active 15-min Polymarket markets ─────────────────
  // Fetch from Gamma API — look for markets ending in next 3-13 minutes
  const cryptoMarkets = await fetchJson(
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=endDate&ascending=true'
  ) as GammaMarket[] | null;

  if (!cryptoMarkets?.length) {
    console.log('[momentum] No markets returned from Gamma API');
    return { statusCode: 200 };
  }

  const now = Date.now();
  const activeMomentumMarkets = cryptoMarkets.filter(m => {
    if (!m.endDate || !m.active || m.closed) return false;
    const endsAt = new Date(m.endDate).getTime();
    const minutesLeft = (endsAt - now) / 60000;
    return minutesLeft >= MIN_MINUTES_REMAINING && minutesLeft <= MAX_MINUTES_REMAINING
      && is15MinMarket(m.question);
  });

  console.log(`[momentum] Found ${activeMomentumMarkets.length} active 15-min markets`);

  if (activeMomentumMarkets.length === 0) {
    console.log('[momentum] No 15-min markets currently in window');
    return { statusCode: 200 };
  }

  // ── Match signals to markets and bet ──────────────────────
  let betsPlaced = 0;
  const betSize = Math.min(bankroll * MAX_BET_PCT_BANKROLL, bankroll * 0.03);

  for (const signal of signals) {
    if (Date.now() - startTime > 120000) break; // 2 min guard (background fn has 15 min)
    if (signal.strength === 'WEAK') continue; // Only STRONG/MODERATE signals

    for (const market of activeMomentumMarkets) {
      if (!marketMatchesAsset(market.question, signal.asset)) continue;

      // Get or create market_id in DB
      const { data: dbMarket } = await supabase
        .from('markets')
        .select('id, liquidity_usd, is_active')
        .eq('condition_id', market.conditionId)
        .single();

      if (!dbMarket?.is_active) continue;
      if (dbMarket.liquidity_usd < 2000) continue; // Min $2K liquidity for momentum
      if (openMarketIds.has(dbMarket.id)) continue;

      // Parse Polymarket prices
      let prices: number[];
      try { prices = JSON.parse(market.outcomePrices).map((p: string) => parseFloat(p)); }
      catch { continue; }
      if (prices.length < 2) continue;

      const [pmYes, pmNo] = prices;

      // Determine if YES = "higher" or "lower"
      const q = market.question.toLowerCase();
      const yesIsUp = q.includes('higher') || q.includes('above') || q.includes('up');

      // Estimate true probability
      const trueProb = estimateTrueProb(signal, yesIsUp);
      const pmPrice = (signal.direction === 'UP' && yesIsUp) || (signal.direction === 'DOWN' && !yesIsUp)
        ? pmYes : pmNo;
      const edge = trueProb - pmPrice;

      console.log(`[momentum] ${signal.asset} ${market.question.substring(0, 60)} | edge=${edge.toFixed(3)} trueP=${trueProb.toFixed(2)} pmP=${pmPrice.toFixed(2)}`);

      if (edge < MIN_EDGE_TO_BET) continue;

      const direction = (signal.direction === 'UP' && yesIsUp) || (signal.direction === 'DOWN' && !yesIsUp)
        ? 'BUY_YES' : 'BUY_NO';

      const entryPrice = direction === 'BUY_YES' ? pmYes : pmNo;
      if (entryPrice <= 0.01 || entryPrice >= 0.99) continue;

      // Execute bet directly (bypass place-bets pipeline for speed)
      const result = await executeBet(
        supabase,
        {
          market_id: dbMarket.id,
          analysis_id: null,
          category: 'crypto_momentum',
          direction,
          outcome_label: `${signal.asset} ${signal.direction} momentum (${signal.momentum3m.toFixed(2)}% / 3min)`,
          entry_price: entryPrice,
          amount_usd: betSize,
        },
        config,
        0
      );

      if (result.success) {
        betsPlaced++;
        openMarketIds.add(dbMarket.id);
        console.log(
          `[momentum] ✅ Placed ${direction} $${betSize.toFixed(2)} on ${signal.asset} 15-min | edge=${(edge * 100).toFixed(1)}% | ${result.is_paper ? 'PAPER' : 'LIVE'}`
        );
      }
    }
  }

  console.log(`[momentum] Done in ${Date.now() - startTime}ms. Placed ${betsPlaced} momentum bets.`);
  return { statusCode: 200 };
});

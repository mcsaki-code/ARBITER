// ============================================================
// Kalshi Cross-Platform Integration
//
// Kalshi is a CFTC-regulated prediction market with high volume
// ($2B+/week during major events). Cross-platform support enables:
//
// 1. ARBITRAGE: Buy YES on Poly at 40¢ + Buy YES on Kalshi at
//    55¢ when the sum < $1 — guaranteed profit if either resolves
// 2. PRICE VALIDATION: If Kalshi prices a market differently,
//    it's a signal that one platform is mispriced
// 3. DIVERSIFICATION: Trade on regulated exchange with better
//    legal standing (important for larger positions)
//
// Kalshi API: https://trading-api.readme.io/reference
// Free tier: read-only market data (no trading without account)
// ============================================================

export interface KalshiMarket {
  ticker: string;
  title: string;
  subtitle: string;
  category: string;
  status: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  close_time: string;
  result?: string;
}

export interface CrossPlatformArb {
  polymarketId: string;
  polymarketQuestion: string;
  polyYesPrice: number;
  kalshiTicker: string;
  kalshiTitle: string;
  kalshiYesPrice: number;
  arbSpread: number;        // 1 - (poly_yes + kalshi_yes) — positive = free money
  priceGap: number;         // |poly - kalshi| — large gap = signal
  direction: 'POLY_CHEAP' | 'KALSHI_CHEAP' | 'NEUTRAL';
  confidence: number;
}

// ── Kalshi API client ─────────────────────────────────────
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2';

function getBaseUrl(): string {
  return process.env.KALSHI_USE_DEMO === 'true' ? KALSHI_DEMO_BASE : KALSHI_BASE;
}

async function kalshiFetch(path: string): Promise<unknown> {
  const base = getBaseUrl();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Add auth if available (needed for trading, not for public market data)
  if (process.env.KALSHI_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.KALSHI_API_KEY}`;
  }

  const res = await fetch(`${base}${path}`, {
    headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Kalshi API ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

// ── Fetch weather markets from Kalshi ─────────────────────
export async function getKalshiWeatherMarkets(): Promise<KalshiMarket[]> {
  try {
    // Kalshi weather markets use series like KXHIGH-* (temperature highs)
    const data = await kalshiFetch('/markets?series_ticker=KXHIGH&status=open&limit=100') as {
      markets?: Array<{
        ticker: string;
        title: string;
        subtitle: string;
        category: string;
        status: string;
        yes_bid: number;
        yes_ask: number;
        no_bid: number;
        no_ask: number;
        last_price: number;
        volume: number;
        open_interest: number;
        close_time: string;
        result?: string;
      }>;
    };

    return (data?.markets || []).map(m => ({
      ticker: m.ticker,
      title: m.title,
      subtitle: m.subtitle || '',
      category: m.category || 'weather',
      status: m.status,
      yes_bid: (m.yes_bid || 0) / 100,  // Kalshi uses cents
      yes_ask: (m.yes_ask || 0) / 100,
      no_bid: (m.no_bid || 0) / 100,
      no_ask: (m.no_ask || 0) / 100,
      last_price: (m.last_price || 0) / 100,
      volume: m.volume || 0,
      open_interest: m.open_interest || 0,
      close_time: m.close_time,
      result: m.result,
    }));
  } catch (err) {
    console.log(`[kalshi] Error fetching weather markets: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Fetch crypto markets from Kalshi ──────────────────────
export async function getKalshiCryptoMarkets(): Promise<KalshiMarket[]> {
  try {
    // Kalshi BTC/ETH price markets
    const [btcData, ethData] = await Promise.all([
      kalshiFetch('/markets?series_ticker=KXBTC&status=open&limit=50').catch(() => ({ markets: [] })) as Promise<{ markets?: Array<Record<string, unknown>> }>,
      kalshiFetch('/markets?series_ticker=KXETH&status=open&limit=50').catch(() => ({ markets: [] })) as Promise<{ markets?: Array<Record<string, unknown>> }>,
    ]);

    const allMarkets = [
      ...((btcData as { markets?: KalshiMarket[] })?.markets || []),
      ...((ethData as { markets?: KalshiMarket[] })?.markets || []),
    ];

    return allMarkets.map((m: Record<string, unknown>) => ({
      ticker: String(m.ticker || ''),
      title: String(m.title || ''),
      subtitle: String(m.subtitle || ''),
      category: 'crypto',
      status: String(m.status || ''),
      yes_bid: ((m.yes_bid as number) || 0) / 100,
      yes_ask: ((m.yes_ask as number) || 0) / 100,
      no_bid: ((m.no_bid as number) || 0) / 100,
      no_ask: ((m.no_ask as number) || 0) / 100,
      last_price: ((m.last_price as number) || 0) / 100,
      volume: (m.volume as number) || 0,
      open_interest: (m.open_interest as number) || 0,
      close_time: String(m.close_time || ''),
      result: m.result as string | undefined,
    }));
  } catch (err) {
    console.log(`[kalshi] Error fetching crypto markets: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Cross-platform arbitrage scanner ──────────────────────
export async function scanCrossPlatformArbs(
  polymarketMarkets: { id: string; question: string; outcome_prices: number[]; category: string }[],
): Promise<CrossPlatformArb[]> {
  const arbs: CrossPlatformArb[] = [];

  // Fetch Kalshi markets
  const [kalshiWeather, kalshiCrypto] = await Promise.all([
    getKalshiWeatherMarkets(),
    getKalshiCryptoMarkets(),
  ]);

  const kalshiMarkets = [...kalshiWeather, ...kalshiCrypto];
  if (kalshiMarkets.length === 0) {
    console.log('[kalshi] No Kalshi markets available');
    return [];
  }

  console.log(`[kalshi] Scanning ${kalshiMarkets.length} Kalshi markets against ${polymarketMarkets.length} Polymarket markets`);

  // Match by question similarity
  for (const poly of polymarketMarkets) {
    const polyQuestion = poly.question.toLowerCase();
    const polyYesPrice = poly.outcome_prices?.[0] || 0.5;

    for (const kalshi of kalshiMarkets) {
      const kalshiTitle = kalshi.title.toLowerCase();

      // Simple matching: check for city + temperature overlap
      const similarity = computeSimilarity(polyQuestion, kalshiTitle);
      if (similarity < 0.3) continue;

      const kalshiMidPrice = (kalshi.yes_bid + kalshi.yes_ask) / 2 || kalshi.last_price;

      // Arbitrage: if YES prices on both platforms sum to less than 1,
      // buying YES on both guarantees profit
      const arbSpread = 1 - (polyYesPrice + kalshiMidPrice);

      // Price gap: large divergence = one platform is wrong
      const priceGap = Math.abs(polyYesPrice - kalshiMidPrice);

      // Only report significant gaps (>5%)
      if (priceGap < 0.05 && arbSpread < 0.02) continue;

      const direction = polyYesPrice < kalshiMidPrice ? 'POLY_CHEAP' : 'KALSHI_CHEAP';

      arbs.push({
        polymarketId: poly.id,
        polymarketQuestion: poly.question,
        polyYesPrice,
        kalshiTicker: kalshi.ticker,
        kalshiTitle: kalshi.title,
        kalshiYesPrice: kalshiMidPrice,
        arbSpread: Math.round(arbSpread * 10000) / 10000,
        priceGap: Math.round(priceGap * 10000) / 10000,
        direction,
        confidence: Math.min(1, priceGap * 5), // Higher gap = more confidence
      });
    }
  }

  // Sort by price gap descending (biggest mispricings first)
  arbs.sort((a, b) => b.priceGap - a.priceGap);

  console.log(`[kalshi] Found ${arbs.length} cross-platform pricing gaps`);
  return arbs;
}

// ── String similarity (Jaccard on word tokens) ────────────
function computeSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  const setA = tokenize(a);
  const setB = tokenize(b);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── Check if Kalshi integration is configured ─────────────
export function isKalshiEnabled(): boolean {
  // Works without API key (public market data), but key needed for trading
  return true; // Always enabled for price comparison
}

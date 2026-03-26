// ============================================================
// Netlify Scheduled Function: Analyze Crypto Edge
// Runs every 30 minutes — compares technical/on-chain signals
// against Polymarket price bracket markets to find mispricings.
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_ANALYSES_PER_RUN = 8;   // increased from 3
const MIN_EDGE_PCT = 0.02;

// ── Edge/Prob normalization (fixes Claude returning 849 instead of 0.849) ──
function normalizeEdge(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  if (raw > 100) return raw / 1000;
  if (raw > 1)   return raw / 100;
  return raw;
}
function normalizeProb(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  if (raw > 1) return raw / 100;
  return raw;
}

interface SignalRow {
  id: string;
  fetched_at: string;
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
}

interface MarketRow {
  id: string;
  condition_id: string;
  question: string;
  outcomes: string[];
  outcome_prices: number[];
  volume_usd: number;
  liquidity_usd: number;
  resolution_date: string | null;
}

export const handler = schedule('*/30 * * * *', async () => {
  console.log('[analyze-crypto] Starting crypto edge analysis');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[analyze-crypto] ANTHROPIC_API_KEY not set');
    return { statusCode: 500 };
  }

  // Get latest signal snapshots for each asset
  const signals: Record<string, SignalRow> = {};

  for (const asset of ['BTC', 'ETH']) {
    const { data } = await supabase
      .from('crypto_signals')
      .select('*')
      .eq('asset', asset)
      .order('fetched_at', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      signals[asset] = data[0];
    }
  }

  if (Object.keys(signals).length === 0) {
    console.log('[analyze-crypto] No signal data available');
    return { statusCode: 200 };
  }

  // Get active crypto markets from Polymarket
  const { data: cryptoMarkets } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true)
    .eq('category', 'crypto')
    .gt('liquidity_usd', 5000)
    .order('volume_usd', { ascending: false })
    .limit(30);

  if (!cryptoMarkets || cryptoMarkets.length === 0) {
    console.log('[analyze-crypto] No active crypto markets');
    return { statusCode: 200 };
  }

  console.log(`[analyze-crypto] ${Object.keys(signals).length} assets with signals, ${cryptoMarkets.length} crypto markets`);

  // Match markets to assets and find analysis candidates
  const candidates: { market: MarketRow; signal: SignalRow; asset: string }[] = [];

  for (const market of cryptoMarkets as MarketRow[]) {
    const q = market.question.toLowerCase();

    // Determine which asset this market is about
    let matchedAsset: string | null = null;
    if (q.includes('bitcoin') || q.includes('btc')) matchedAsset = 'BTC';
    else if (q.includes('ethereum') || q.includes('eth')) matchedAsset = 'ETH';
    else if (q.includes('solana') || q.includes('sol')) continue; // No signals yet

    if (matchedAsset && signals[matchedAsset]) {
      candidates.push({
        market,
        signal: signals[matchedAsset],
        asset: matchedAsset,
      });
    }
  }

  console.log(`[analyze-crypto] ${candidates.length} markets matched to signal data`);

  // Analyze top candidates with Claude
  let analyzed = 0;

  for (const candidate of candidates.slice(0, MAX_ANALYSES_PER_RUN)) {
    if (Date.now() - startTime > 20000) break;

    const { market, signal, asset } = candidate;
    const hoursRemaining = market.resolution_date
      ? Math.max(0, (new Date(market.resolution_date).getTime() - Date.now()) / 3600000)
      : 0;

    if (hoursRemaining < 2) continue;
    if (market.liquidity_usd < 5000) continue;

    // Parse signal summary for display
    let signalDetails: Record<string, string> = {};
    try { signalDetails = JSON.parse(signal.signal_summary); } catch { /* empty */ }

    const outcomesList = market.outcomes
      .map((o: string, i: number) => `${o} → $${market.outcome_prices[i]?.toFixed(3) || '?'}`)
      .join('\n');

    const prompt = `You are ARBITER's crypto analyst. Compare technical and on-chain signals against Polymarket price bracket markets to find mispricings.

ASSET: ${asset}
CURRENT SPOT: $${signal.spot_price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
1H AGO: $${signal.price_1h_ago?.toLocaleString(undefined, { maximumFractionDigits: 2 }) || 'N/A'}
24H AGO: $${signal.price_24h_ago?.toLocaleString(undefined, { maximumFractionDigits: 2 }) || 'N/A'}

TECHNICAL INDICATORS:
- RSI(14):         ${signal.rsi_14?.toFixed(1) ?? 'N/A'}${signal.rsi_14 ? (signal.rsi_14 > 70 ? ' (OVERBOUGHT)' : signal.rsi_14 < 30 ? ' (OVERSOLD)' : ' (NEUTRAL)') : ''}
- Bollinger Upper: $${signal.bb_upper?.toFixed(0) ?? 'N/A'}
- Bollinger Lower: $${signal.bb_lower?.toFixed(0) ?? 'N/A'}
- Spot vs BB:      ${signal.bb_upper && signal.bb_lower ? (signal.spot_price > signal.bb_upper ? 'ABOVE UPPER BAND' : signal.spot_price < signal.bb_lower ? 'BELOW LOWER BAND' : 'WITHIN BANDS') : 'N/A'}
- Funding Rate:    ${signal.funding_rate?.toFixed(6) ?? 'N/A'}
- 24H Volume:      $${signal.volume_24h ? (signal.volume_24h / 1e9).toFixed(2) + 'B' : 'N/A'}

SIGNAL SUMMARY: ${JSON.stringify(signalDetails)}

POLYMARKET BRACKET MARKET:
Question: ${market.question}
${outcomesList}
- Volume: $${market.volume_usd.toLocaleString()}
- Liquidity: $${market.liquidity_usd.toLocaleString()}
- Resolves: ${Math.round(hoursRemaining)} hours from now

TASK:
1. Based on current price, momentum, and technical indicators, estimate the probability distribution across brackets
2. Compare your estimated probabilities to market prices
3. Identify the bracket(s) with the largest mispricing
4. Select the single best bet (highest edge)
5. Be conservative — crypto is volatile. Only flag high-confidence edges.

Respond ONLY in JSON:
{
  "asset": string,
  "spot_at_analysis": number,
  "target_bracket": string (the bracket label you're betting on),
  "bracket_prob": number (your estimated true probability 0-1),
  "market_price": number (Polymarket price for that bracket),
  "edge": number (bracket_prob - market_price),
  "direction": "BUY_YES"|"BUY_NO"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "kelly_fraction": number,
  "rec_bet_usd": number,
  "reasoning": string,
  "auto_eligible": boolean,
  "flags": string[]
}`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.error(`[analyze-crypto] Claude API error: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (!text) continue;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const analysis = JSON.parse(jsonMatch[0]);

      // Calculate Kelly bet size
      let kellyFraction = 0;
      let recBetUsd = 0;

      if (analysis.direction !== 'PASS' && analysis.edge >= MIN_EDGE_PCT) {
        const { data: configRows } = await supabase
          .from('system_config')
          .select('key, value')
          .in('key', ['paper_bankroll']);

        const bankroll = parseFloat(configRows?.find((r: { key: string }) => r.key === 'paper_bankroll')?.value || '500');

        const p = analysis.bracket_prob;
        const c = analysis.market_price;
        if (p > 0 && c > 0 && c < 1) {
          const b = (1 - c) / c;
          const fullKelly = (p * b - (1 - p)) / b;
          if (fullKelly > 0) {
            const confMult = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.2 }[analysis.confidence as string] || 0.2;
            const adjusted = fullKelly * 0.25 * (confMult as number);
            const liquidityCap = (market.liquidity_usd * 0.02) / bankroll;
            kellyFraction = Math.min(adjusted, 0.05, liquidityCap);
            recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
          }
        }
      }

      // ── Normalize before storing (fixes the 849 bug at source) ──
      const edgeNorm      = normalizeEdge(analysis.edge);
      const bracketNorm   = normalizeProb(analysis.bracket_prob);
      const mktPriceNorm  = normalizeProb(analysis.market_price);

      // Store analysis
      await supabase.from('crypto_analyses').insert({
        market_id: market.id,
        signal_id: signal.id,
        asset: analysis.asset || asset,
        spot_at_analysis: analysis.spot_at_analysis || signal.spot_price,
        target_bracket: analysis.target_bracket,
        bracket_prob: bracketNorm,
        market_price: mktPriceNorm,
        edge: edgeNorm,
        direction: analysis.direction || 'PASS',
        confidence: analysis.confidence || 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: analysis.reasoning,
        auto_eligible: analysis.auto_eligible || false,
        flags: analysis.flags || [],
      });

      analyzed++;
      console.log(`[analyze-crypto] ${asset} bracket "${analysis.target_bracket}": edge=${analysis.edge?.toFixed(3)} dir=${analysis.direction}`);
    } catch (err) {
      console.error(`[analyze-crypto] Analysis failed:`, err);
    }
  }

  console.log(`[analyze-crypto] Done. Analyzed ${analyzed} markets in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

// ============================================================
// Netlify Scheduled Function: Sentiment Edge Analyzer
// Runs every 10 minutes
//
// STRATEGY: When options flow anomalies AND high-impact Trump posts
// coincide within a 90-minute window, find correlated Polymarket
// markets and ask Claude if the current price is mispriced.
//
// Signal types (in order of confidence):
//   1. options_trump — Both options anomaly + Trump post (HIGHEST CONFIDENCE)
//   2. trump_only    — High-impact post alone (>0.6 score)
//   3. options_only  — Options anomaly alone (>3.0 Z-score)
//
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const SIGNAL_WINDOW_MS      = 4 * 3600000;  // 4 hours: wider window catches more signal combinations
const MIN_TRUMP_SCORE        = 0.25;          // Min impact score to act alone (was 0.35 — too strict)
const MIN_TRUMP_COMBINED     = 0.15;          // Lower bar when combined with options anomaly
const MIN_OPTIONS_ZSCORE     = 2.5;           // Options-only: still need strong signal (was 3.0)
const MIN_OPTIONS_COMBINED   = 1.5;           // Combined: lower bar (was 2.0)
const MAX_ANALYSES_PER_RUN   = 6;             // More analyses per run (was 4)
const MIN_EDGE               = 0.05;          // 5% minimum edge for sentiment bets (was 6%)
const MIN_LIQUIDITY          = 5000;

// ── Category → Polymarket search terms mapping ──────────────────────
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  tariff: ['tariff', 'trade war', 'import tax', 'china trade', 'trade deal'],
  crypto: ['bitcoin', 'crypto', 'BTC', 'ethereum', 'digital currency'],
  fed:    ['Federal Reserve', 'interest rate', 'rate cut', 'rate hike', 'Fed', 'inflation'],
  stocks: ['S&P 500', 'stock market', 'recession', 'Dow Jones', 'market crash'],
  energy: ['oil price', 'gas price', 'energy', 'OPEC'],
  geo:    ['Ukraine', 'Russia', 'NATO', 'sanctions', 'war'],
  politics: ['election', 'congress', 'legislation', 'impeach'],
};

function normalizeEdge(raw: number | null | undefined): number {
  if (raw == null) return 0;
  if (raw > 100) return raw / 1000;
  if (raw > 1)   return raw / 100;
  return raw;
}

function normalizeProb(raw: number | null | undefined): number {
  if (raw == null) return 0;
  if (raw > 1) return raw / 100;
  return raw;
}

interface SentimentSignal {
  type: 'options_trump' | 'trump_only' | 'options_only';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  optionsSignalId: string | null;
  trumpPostId: string | null;
  trumpContent: string | null;
  trumpKeywords: string[];
  categories: string[];
  optionsDirection: string | null;
  optionsZscore: number | null;
  optionsTicker: string | null;
  summary: string;
}

export const handler = schedule('*/10 * * * *', async () => {
  console.log('[sentiment] Starting sentiment edge analysis');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500 };

  const windowCutoff = new Date(Date.now() - SIGNAL_WINDOW_MS).toISOString();

  // ── 1. Check for recent options anomalies ──────────────────────────
  const { data: recentAnomalies } = await supabase
    .from('options_flow_signals')
    .select('id, ticker, zscore, anomaly_direction, detected_at')
    .eq('is_anomaly', true)
    .gte('detected_at', windowCutoff)
    .order('detected_at', { ascending: false })
    .limit(5);

  // ── 2. Check for recent high-impact Trump posts ────────────────────
  const { data: recentPosts } = await supabase
    .from('trump_posts')
    .select('id, posted_at, content, keywords, market_impact_score, categories')
    .gte('market_impact_score', MIN_TRUMP_COMBINED)
    .gte('posted_at', windowCutoff)
    .order('market_impact_score', { ascending: false })
    .limit(5);

  const hasOptions = (recentAnomalies?.length ?? 0) > 0;
  const hasTrump   = (recentPosts?.length ?? 0) > 0;

  if (!hasOptions && !hasTrump) {
    console.log('[sentiment] No signals in the last 90 minutes — sleeping');
    return { statusCode: 200 };
  }

  console.log(`[sentiment] Signals: ${recentAnomalies?.length ?? 0} options anomalies, ${recentPosts?.length ?? 0} Trump posts`);

  // ── 3. Build correlated signals ────────────────────────────────────
  const signals: SentimentSignal[] = [];

  // Case A: Combined options + Trump (highest confidence)
  if (hasOptions && hasTrump) {
    const bestPost    = recentPosts![0];
    const bestOptions = recentAnomalies![0];
    const meetsBar    = (bestPost.market_impact_score >= MIN_TRUMP_COMBINED)
                     && (Math.abs(bestOptions.zscore) >= MIN_OPTIONS_COMBINED);

    if (meetsBar) {
      signals.push({
        type: 'options_trump',
        confidence: bestPost.market_impact_score >= 0.6 && Math.abs(bestOptions.zscore) >= 2.5 ? 'HIGH' : 'MEDIUM',
        optionsSignalId:  bestOptions.id,
        trumpPostId:      bestPost.id,
        trumpContent:     bestPost.content,
        trumpKeywords:    bestPost.keywords ?? [],
        categories:       bestPost.categories ?? [],
        optionsDirection: bestOptions.anomaly_direction,
        optionsZscore:    bestOptions.zscore,
        optionsTicker:    bestOptions.ticker,
        summary: `Options ${bestOptions.ticker} ${bestOptions.anomaly_direction} (Z=${bestOptions.zscore?.toFixed(2)}) + Trump post [${(bestPost.categories ?? []).join(',')}] score=${bestPost.market_impact_score.toFixed(2)}`,
      });
    }
  }

  // Case B: Trump-only (high impact post, no options confirmation)
  if (hasTrump && !hasOptions) {
    const bestPost = recentPosts![0];
    if (bestPost.market_impact_score >= MIN_TRUMP_SCORE) {
      signals.push({
        type: 'trump_only',
        confidence: bestPost.market_impact_score >= 0.7 ? 'HIGH' : 'MEDIUM',
        optionsSignalId:  null,
        trumpPostId:      bestPost.id,
        trumpContent:     bestPost.content,
        trumpKeywords:    bestPost.keywords ?? [],
        categories:       bestPost.categories ?? [],
        optionsDirection: null,
        optionsZscore:    null,
        optionsTicker:    null,
        summary: `Trump post [${(bestPost.categories ?? []).join(',')}] score=${bestPost.market_impact_score.toFixed(2)}`,
      });
    }
  }

  // Case C: Options-only (very strong anomaly — no tweet needed)
  if (hasOptions && !hasTrump) {
    const bestOptions = recentAnomalies![0];
    if (Math.abs(bestOptions.zscore) >= MIN_OPTIONS_ZSCORE) {
      signals.push({
        type: 'options_only',
        confidence: Math.abs(bestOptions.zscore) >= 3.5 ? 'HIGH' : 'MEDIUM',
        optionsSignalId:  bestOptions.id,
        trumpPostId:      null,
        trumpContent:     null,
        trumpKeywords:    [],
        categories:       bestOptions.anomaly_direction === 'BEARISH' ? ['stocks'] : ['stocks', 'crypto'],
        optionsDirection: bestOptions.anomaly_direction,
        optionsZscore:    bestOptions.zscore,
        optionsTicker:    bestOptions.ticker,
        summary: `Options ${bestOptions.ticker} ${bestOptions.anomaly_direction} Z=${bestOptions.zscore?.toFixed(2)} (no Trump post)`,
      });
    }
  }

  if (signals.length === 0) {
    console.log('[sentiment] Signals present but below confidence thresholds');
    return { statusCode: 200 };
  }

  // ── 4. Find correlated Polymarket markets ─────────────────────────
  const config: Record<string, string> = {};
  const { data: configRows } = await supabase
    .from('system_config').select('key, value')
    .in('key', ['paper_bankroll']);
  configRows?.forEach((r: { key: string; value: string }) => { config[r.key] = r.value; });
  const bankroll = parseFloat(config.paper_bankroll || '5000');

  // Get already-analyzed markets in last 2h to avoid re-analyzing
  const recentCutoff = new Date(Date.now() - 2 * 3600000).toISOString();
  const { data: recentAnalyses } = await supabase
    .from('sentiment_analyses')
    .select('market_id')
    .gte('analyzed_at', recentCutoff);
  const recentMarketIds = new Set((recentAnalyses ?? []).map((r: { market_id: string }) => r.market_id));

  // Open bet market IDs — don't double-bet
  const { data: openBets } = await supabase.from('bets').select('market_id').eq('status', 'OPEN');
  const openMarketIds = new Set((openBets ?? []).map((b: { market_id: string }) => b.market_id));

  let analyzed = 0;

  for (const signal of signals) {
    if (analyzed >= MAX_ANALYSES_PER_RUN) break;
    if (Date.now() - startTime > 25000) break;

    console.log(`[sentiment] Processing: ${signal.summary}`);

    // Build search terms from signal categories
    const searchTerms: string[] = [];
    for (const cat of signal.categories) {
      searchTerms.push(...(CATEGORY_KEYWORDS[cat] ?? [cat]));
    }

    if (searchTerms.length === 0) {
      searchTerms.push('market', 'economy', 'price');
    }

    // Find active, liquid Polymarket markets matching the signal categories
    // Use ILIKE on question text for keyword matching
    const searchPattern = `%${searchTerms[0]}%`;
    const { data: candidateMarkets } = await supabase
      .from('markets')
      .select('id, question, outcome_prices, liquidity_usd, resolution_date, category')
      .eq('is_active', true)
      .eq('is_resolved', false)
      .gt('liquidity_usd', MIN_LIQUIDITY)
      .ilike('question', searchPattern)
      .gt('resolution_date', new Date(Date.now() + 3600000).toISOString()) // > 1h remaining
      .order('liquidity_usd', { ascending: false })
      .limit(20);

    // Also try a second search term if first returns few results
    let markets = candidateMarkets ?? [];
    if (markets.length < 3 && searchTerms[1]) {
      const { data: extra } = await supabase
        .from('markets')
        .select('id, question, outcome_prices, liquidity_usd, resolution_date, category')
        .eq('is_active', true)
        .eq('is_resolved', false)
        .gt('liquidity_usd', MIN_LIQUIDITY)
        .ilike('question', `%${searchTerms[1]}%`)
        .gt('resolution_date', new Date(Date.now() + 3600000).toISOString())
        .order('liquidity_usd', { ascending: false })
        .limit(10);
      markets = [...markets, ...(extra ?? [])];
    }

    // Remove duplicates and already-analyzed markets
    const seen = new Set<string>();
    const filteredMarkets = markets.filter(m => {
      if (seen.has(m.id) || recentMarketIds.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    if (filteredMarkets.length === 0) {
      console.log(`[sentiment] No matching markets for signal [${signal.categories.join(',')}]`);
      continue;
    }

    const topMarkets = filteredMarkets.slice(0, 5);
    const marketsText = topMarkets.map((m: { question: string; outcome_prices: number[]; liquidity_usd: number }) =>
      `- "${m.question}" | YES: $${m.outcome_prices[0]?.toFixed(3)} NO: $${m.outcome_prices[1]?.toFixed(3)} | Liquidity: $${m.liquidity_usd.toLocaleString()}`
    ).join('\n');

    const prompt = `You are ARBITER's sentiment analyst. You have detected a market-moving signal and must assess whether current Polymarket prices are mis-priced.

SIGNAL DETECTED: ${signal.summary}
Signal Type: ${signal.type}
Confidence Level: ${signal.confidence}

${signal.trumpContent ? `TRUMP POST CONTENT:
"${signal.trumpContent.substring(0, 500)}"

Market-relevant keywords detected: ${signal.trumpKeywords.join(', ')}
Categories: ${signal.categories.join(', ')}
` : ''}
${signal.optionsTicker ? `OPTIONS FLOW ANOMALY:
- Ticker: ${signal.optionsTicker}
- Direction: ${signal.optionsDirection} (Z-score: ${signal.optionsZscore?.toFixed(2)})
- Interpretation: ${signal.optionsDirection === 'BEARISH' ? 'Unusual put buying — smart money hedging against downside' : 'Unusual call buying — smart money positioning for upside'}
` : ''}
CORRELATED POLYMARKET MARKETS (pick the BEST one to analyze):
${marketsText}

ANALYSIS TASK:
1. Based on the signal, what is the most likely market direction/outcome?
2. Which of the above markets is MOST LIKELY to be mispriced due to this signal?
3. Estimate the true probability for the YES outcome of that market
4. Is the current Polymarket price significantly different (>6%) from your estimate?
5. What is the optimal bet direction and size?

IMPORTANT CONSTRAINTS:
- Only recommend bets with edge >= 0.06 (6%)
- Be conservative — options flow can be noise, Trump posts can reverse quickly
- Set confidence MEDIUM unless the signal is exceptionally clear
- Set auto_eligible = false unless confidence is HIGH and signal is very clear
- Your knowledge cutoff is ~May 2025 — acknowledge if the market requires current info you don't have

Pick EXACTLY ONE market to analyze. Respond ONLY in valid JSON:
{
  "selected_market_question": string,
  "signal_interpretation": string,
  "direction_rationale": string,
  "true_prob_yes": number,
  "polymarket_price_yes": number,
  "edge": number,
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
        signal: AbortSignal.timeout(18000),
      });

      if (!res.ok) { console.error(`[sentiment] Claude error ${res.status}`); continue; }

      const data = await res.json();
      const text = data.content?.[0]?.text ?? '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.warn('[sentiment] No JSON in response'); continue; }

      const analysis = JSON.parse(jsonMatch[0]) as any;

      // Validate analysis
      const { validateSentimentAnalysis } = await import('../../src/lib/validate-analysis');
      const validation = validateSentimentAnalysis(analysis);
      if (!validation.valid) {
        console.error(`[sentiment] Validation failed:`, validation.errors);
        continue;
      }

      // Find the matching market by question
      const selectedMarket = topMarkets.find((m: { question: string }) =>
        (analysis.selected_market_question as string)?.toLowerCase().includes(
          m.question.toLowerCase().substring(0, 30)
        )
      ) ?? topMarkets[0];

      if (!selectedMarket || openMarketIds.has(selectedMarket.id)) continue;

      // Compute Kelly
      // Look up latest calibration for this category + confidence tier
      const { data: calData } = await supabase
        .from('calibration_snapshots')
        .select('total_bets, predicted_win_rate, actual_win_rate')
        .eq('category', 'sentiment')
        .eq('confidence_tier', validation.data.confidence || 'LOW')
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .single();

      const { computeKelly, getCalibrationDiscount } = await import('../../src/lib/trading-math');
      const calDiscount = getCalibrationDiscount(calData);
      const kelly = computeKelly({
        trueProb: validation.data.true_prob,
        marketPrice: validation.data.market_price,
        direction: validation.data.direction,
        confidence: validation.data.confidence,
        category: 'sentiment',
        liquidityUsd: selectedMarket.liquidity_usd,
        bankroll,
        calibrationDiscount: calDiscount,
      });

      await supabase.from('sentiment_analyses').insert({
        market_id:        selectedMarket.id,
        signal_type:      signal.type,
        options_signal_id: signal.optionsSignalId,
        trump_post_id:    signal.trumpPostId,
        trump_keywords:   signal.trumpKeywords,
        market_price:     validation.data.market_price,
        true_prob:        validation.data.true_prob,
        edge:             validation.data.edge,
        direction:        validation.data.direction,
        confidence:       validation.data.confidence,
        kelly_fraction:   kelly.kellyFraction,
        rec_bet_usd:      kelly.recBetUsd,
        reasoning:        validation.data.reasoning,
        auto_eligible:    validation.data.auto_eligible,
        flags:            validation.data.flags ?? [signal.type],
      });

      recentMarketIds.add(selectedMarket.id);
      analyzed++;

      console.log(
        `[sentiment] ✅ [${signal.type}] "${selectedMarket.question.substring(0, 60)}" — ` +
        `edge=${validation.data.edge.toFixed(3)} dir=${validation.data.direction} conf=${validation.data.confidence} $${kelly.recBetUsd}`
      );

    } catch (err) {
      console.error('[sentiment] Analysis error:', err);
    }
  }

  console.log(`[sentiment] Done in ${Date.now() - startTime}ms. Analyzed ${analyzed} markets.`);
  return { statusCode: 200 };
});

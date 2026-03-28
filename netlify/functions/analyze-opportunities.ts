// ============================================================
// Netlify Scheduled Function: General Opportunity Scanner
// Runs every 30 minutes
//
// STRATEGY: The existing analyzers cover weather, sports, crypto,
// and politics — but 7,000+ active Polymarket markets fall outside
// those categories. This scanner samples the uncovered universe:
// business, science, entertainment, tech, elections in other countries,
// company earnings, regulatory decisions, and more.
//
// For each candidate it fetches cross-market references (Manifold +
// Metaculus) and asks Claude to identify mispricings. When 2+ external
// sources diverge >10pp from Polymarket, we get HIGH confidence and
// auto_eligible = true → proper Kelly sizing in place-bets.ts.
//
// Storage: opportunity_analyses table
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL          = 'claude-sonnet-4-20250514';
const MAX_ANALYSES_PER_RUN  = 8;
const MIN_EDGE              = 0.05;
const MIN_LIQUIDITY         = 8000;   // $8K floor — opportunity markets need reasonable liquidity
const REANALYSIS_COOLDOWN_H = 12;     // Don't re-analyze the same market more often than every 12h
const FETCH_TIMEOUT_MS      = 6000;

// Categories already handled by dedicated analyzers — skip these
const COVERED_CATEGORIES = new Set([
  'weather', 'sports', 'crypto', 'cryptocurrency',
  'politics', 'political', 'us-politics', 'us_politics',
]);

// ── Cross-market reference fetchers ──────────────────────────────────

interface CrossMarketRef {
  source:      string;
  question:    string;
  probability: number;
  url:         string;
}

async function fetchManifoldRef(question: string): Promise<CrossMarketRef | null> {
  try {
    const keywords = question
      .replace(/[^a-z0-9 ]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 5)
      .join(' ');
    if (!keywords) return null;

    const url = `https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(keywords)}&limit=3`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const markets = await res.json() as { question: string; probability: number; url: string }[];
    if (!Array.isArray(markets) || markets.length === 0) return null;

    const best = markets[0];
    return { source: 'manifold', question: best.question, probability: best.probability, url: best.url };
  } catch { return null; }
}

async function fetchMetaculusRef(question: string): Promise<CrossMarketRef | null> {
  try {
    const keywords = question
      .replace(/[^a-z0-9 ]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 4)
      .join(' ');
    if (!keywords) return null;

    const url = `https://www.metaculus.com/api2/questions/?search=${encodeURIComponent(keywords)}&status=open&limit=3`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { results?: { title: string; community_prediction?: { full?: { q2?: number } }; page_url?: string }[] };
    const results = data.results ?? [];
    if (results.length === 0) return null;

    const best = results[0];
    const prob = best.community_prediction?.full?.q2;
    if (prob == null) return null;
    return { source: 'metaculus', question: best.title, probability: prob, url: `https://www.metaculus.com${best.page_url ?? ''}` };
  } catch { return null; }
}

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

export const handler = schedule('*/30 * * * *', async () => {
  console.log('[opportunities] Starting general market opportunity scan');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('[opportunities] No ANTHROPIC_API_KEY'); return { statusCode: 500 }; }

  // ── 1. Load config + existing positions ──────────────────────────
  const { data: configRows } = await supabase
    .from('system_config').select('key, value').in('key', ['paper_bankroll']);
  const config: Record<string, string> = {};
  configRows?.forEach((r: { key: string; value: string }) => { config[r.key] = r.value; });
  const bankroll = parseFloat(config.paper_bankroll || '5000');

  // Already-analyzed markets in last 12h (avoid repeating ourselves)
  const cooldownCutoff = new Date(Date.now() - REANALYSIS_COOLDOWN_H * 3600000).toISOString();
  const { data: recentOpp } = await supabase
    .from('opportunity_analyses')
    .select('market_id')
    .gte('analyzed_at', cooldownCutoff);
  const recentlyAnalyzed = new Set((recentOpp ?? []).map((r: { market_id: string }) => r.market_id));

  // Open bet market IDs — don't double-bet
  const { data: openBets } = await supabase.from('bets').select('market_id').eq('status', 'OPEN');
  const openMarketIds = new Set((openBets ?? []).map((b: { market_id: string }) => b.market_id));

  // ── 2. Find uncovered high-liquidity markets ──────────────────────
  // Strategy: rotate through the database by sampling markets we haven't
  // analyzed recently, ordered by liquidity to maximize value per API call.
  // Exclude categories already covered by dedicated analyzers.
  const minResolution = new Date(Date.now() + 6 * 3600000).toISOString(); // at least 6h remaining

  const { data: candidateMarkets } = await supabase
    .from('markets')
    .select('id, question, outcome_prices, liquidity_usd, resolution_date, category')
    .eq('is_active', true)
    .eq('is_resolved', false)
    .gte('liquidity_usd', MIN_LIQUIDITY)
    .gt('resolution_date', minResolution)
    // Exclude extreme certainty prices — not much edge to find near 0 or 1
    .order('liquidity_usd', { ascending: false })
    .limit(200);

  if (!candidateMarkets || candidateMarkets.length === 0) {
    console.log('[opportunities] No candidate markets found');
    return { statusCode: 200 };
  }

  // Filter out covered categories + recently analyzed + open positions + extremes
  interface Market {
    id: string;
    question: string;
    outcome_prices: number[];
    liquidity_usd: number;
    resolution_date: string;
    category: string;
  }

  const filtered = (candidateMarkets as Market[]).filter(m => {
    if (recentlyAnalyzed.has(m.id)) return false;
    if (openMarketIds.has(m.id)) return false;
    const cat = (m.category ?? '').toLowerCase();
    if (COVERED_CATEGORIES.has(cat)) return false;
    // Exclude extreme prices (already essentially resolved)
    const yesPrice = m.outcome_prices?.[0];
    if (yesPrice == null) return false;
    if (yesPrice < 0.03 || yesPrice > 0.97) return false;
    return true;
  });

  console.log(`[opportunities] ${filtered.length} filtered candidates from ${candidateMarkets.length} total`);

  if (filtered.length === 0) {
    console.log('[opportunities] No unanalyzed markets in scope — all covered or cooldown active');
    return { statusCode: 200 };
  }

  // Take top N by liquidity for this run
  const targets = filtered.slice(0, MAX_ANALYSES_PER_RUN * 2);

  // ── 3. Pre-fetch cross-market references in parallel ─────────────
  console.log(`[opportunities] Pre-fetching Manifold + Metaculus refs for ${targets.length} candidates`);
  const refCache = new Map<string, { manifold: CrossMarketRef | null; metaculus: CrossMarketRef | null }>();

  await Promise.allSettled(
    targets.map(async (m) => {
      const [manifold, metaculus] = await Promise.all([
        fetchManifoldRef(m.question),
        fetchMetaculusRef(m.question),
      ]);
      refCache.set(m.id, { manifold, metaculus });
    })
  );

  const refsFound = [...refCache.values()].filter(v => v.manifold || v.metaculus).length;
  console.log(`[opportunities] Got refs for ${refsFound}/${targets.length} markets`);

  // ── 4. Prioritize markets with cross-market refs (most actionable) ─
  const prioritized = [...targets].sort((a, b) => {
    const aRefs = refCache.get(a.id);
    const bRefs = refCache.get(b.id);
    const aCount = (aRefs?.manifold ? 1 : 0) + (aRefs?.metaculus ? 1 : 0);
    const bCount = (bRefs?.manifold ? 1 : 0) + (bRefs?.metaculus ? 1 : 0);
    if (bCount !== aCount) return bCount - aCount; // More refs first
    return (b.liquidity_usd ?? 0) - (a.liquidity_usd ?? 0); // Then by liquidity
  });

  // ── 5. Analyze each target ────────────────────────────────────────
  let analyzed = 0;

  for (const market of prioritized) {
    if (analyzed >= MAX_ANALYSES_PER_RUN) break;
    if (Date.now() - startTime > 50000) { // 50s budget (30s func timeout buffer)
      console.log('[opportunities] Time budget hit');
      break;
    }

    const refs = refCache.get(market.id) ?? { manifold: null, metaculus: null };
    const yesPrice = market.outcome_prices?.[0] ?? 0.5;

    // Build cross-market section for the prompt
    let crossMarketSection = '';
    const crossSources: { source: string; prob: number }[] = [];

    if (refs.manifold) {
      const divergePct = ((refs.manifold.probability - yesPrice) * 100).toFixed(1);
      crossMarketSection += `\nMANIFOLD MARKETS: "${refs.manifold.question}"
  Probability: ${(refs.manifold.probability * 100).toFixed(1)}% YES
  Divergence from Polymarket: ${divergePct}pp
  URL: ${refs.manifold.url}`;
      crossSources.push({ source: 'manifold', prob: refs.manifold.probability });
    }

    if (refs.metaculus) {
      const divergePct = ((refs.metaculus.probability - yesPrice) * 100).toFixed(1);
      crossMarketSection += `\n\nMETACULUS: "${refs.metaculus.question}"
  Probability: ${(refs.metaculus.probability * 100).toFixed(1)}% YES
  Divergence from Polymarket: ${divergePct}pp
  URL: ${refs.metaculus.url}`;
      crossSources.push({ source: 'metaculus', prob: refs.metaculus.probability });
    }

    // Compute weighted cross-market consensus
    let crossMarketConsensus: number | null = null;
    let crossMarketCount = 0;
    if (crossSources.length > 0) {
      crossMarketConsensus = crossSources.reduce((s, v) => s + v.prob, 0) / crossSources.length;
      crossMarketCount = crossSources.length;
    }

    const daysRemaining = (new Date(market.resolution_date).getTime() - Date.now()) / 86400000;

    const prompt = `You are ARBITER's general opportunity analyst. You scan Polymarket for mispricings across all market categories.

MARKET: "${market.question}"
Category: ${market.category || 'uncategorized'}
Polymarket YES Price: $${yesPrice.toFixed(3)} (${(yesPrice * 100).toFixed(1)}% implied probability)
Polymarket NO Price: $${(1 - yesPrice).toFixed(3)}
Liquidity: $${(market.liquidity_usd ?? 0).toLocaleString()}
Days Remaining: ${daysRemaining.toFixed(1)}
Resolution: ${market.resolution_date}
${crossMarketSection ? `\nCROSS-MARKET REFERENCES:${crossMarketSection}` : '\nCROSS-MARKET REFERENCES: None found'}

YOUR TASK:
1. Assess whether the current Polymarket price is mispriced
2. Estimate the true probability for the YES outcome using your knowledge + any cross-market data
3. Calculate edge = |true_prob - market_price|
4. If cross-market sources BOTH diverge >10pp from Polymarket in the same direction → HIGH confidence, auto_eligible = true
5. If only one cross-market source or divergence is 5-10pp → MEDIUM confidence
6. If no cross-market refs or divergence <5pp → LOW confidence or PASS

CROSS-MARKET CONSENSUS: ${crossMarketCount >= 2
  ? `${crossMarketCount} sources agree → strong signal`
  : crossMarketCount === 1
  ? '1 source only → moderate signal'
  : 'No refs found → rely on your knowledge alone'}
${crossMarketConsensus !== null
  ? `External consensus probability: ${(crossMarketConsensus * 100).toFixed(1)}%`
  : ''}

IMPORTANT:
- Knowledge cutoff is ~May 2025; for events after that, trust cross-market references over your priors
- Only recommend bets with edge >= 0.05 (5%)
- A PASS is fine if you're uncertain — don't force an edge
- For resolution dates > 30 days out, be MORE conservative (more time = more uncertainty)
- Never bet both sides of the same event

Respond ONLY in valid JSON:
{
  "true_prob_yes": number (0-1),
  "polymarket_price_yes": number (0-1),
  "edge": number (0-1),
  "direction": "BUY_YES"|"BUY_NO"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "kelly_fraction": number,
  "rec_bet_usd": number,
  "reasoning": string (2-3 sentences),
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
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) { console.error(`[opportunities] Claude error ${res.status}`); continue; }
      const data = await res.json();
      const text = data.content?.[0]?.text ?? '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.warn('[opportunities] No JSON in response'); continue; }

      const analysis = JSON.parse(jsonMatch[0]);
      const edgeNorm  = normalizeEdge(analysis.edge);
      const trueProb  = normalizeProb(analysis.true_prob_yes);
      const mktPrice  = normalizeProb(analysis.polymarket_price_yes);

      // Build flags
      const flags: string[] = [...(analysis.flags ?? [])];
      if (refs.manifold)    flags.push(`manifold_${(refs.manifold.probability * 100).toFixed(0)}pct`);
      if (refs.metaculus)   flags.push(`metaculus_${(refs.metaculus.probability * 100).toFixed(0)}pct`);
      if (crossMarketCount >= 2) flags.push('cross_market_confirmed');

      // Kelly sizing
      let kellyFraction = analysis.kelly_fraction ? normalizeEdge(analysis.kelly_fraction) : 0;
      let recBetUsd = 0;
      if (analysis.direction !== 'PASS' && edgeNorm >= MIN_EDGE && kellyFraction > 0) {
        const confMult = analysis.confidence === 'HIGH' ? 0.8 : analysis.confidence === 'MEDIUM' ? 0.5 : 0.2;
        kellyFraction  = Math.min(kellyFraction, 0.03);
        recBetUsd = Math.max(2, Math.round(bankroll * kellyFraction * confMult * 100) / 100);
        recBetUsd = Math.min(recBetUsd, bankroll * 0.025);
      }

      await supabase.from('opportunity_analyses').insert({
        market_id:       market.id,
        question:        market.question,
        market_category: market.category,
        market_price:    mktPrice,
        true_prob:       trueProb,
        edge:            edgeNorm,
        direction:       analysis.direction ?? 'PASS',
        confidence:      analysis.confidence ?? 'LOW',
        kelly_fraction:  kellyFraction,
        rec_bet_usd:     recBetUsd,
        reasoning:       analysis.reasoning ?? null,
        auto_eligible:   analysis.auto_eligible ?? false,
        flags,
        manifold_prob:   refs.manifold?.probability ?? null,
        metaculus_prob:  refs.metaculus?.probability ?? null,
      });

      recentlyAnalyzed.add(market.id);
      analyzed++;

      const hasEdge = edgeNorm >= MIN_EDGE && analysis.direction !== 'PASS';
      console.log(
        `[opportunities] ${hasEdge ? '✅' : '➖'} "${market.question.substring(0, 55)}" ` +
        `edge=${edgeNorm.toFixed(3)} dir=${analysis.direction} conf=${analysis.confidence} ` +
        `manifold=${refs.manifold ? (refs.manifold.probability * 100).toFixed(0) + '%' : '-'} ` +
        `metaculus=${refs.metaculus ? (refs.metaculus.probability * 100).toFixed(0) + '%' : '-'}`
      );

    } catch (err) {
      console.error(`[opportunities] Error analyzing ${market.id.substring(0, 8)}:`, err);
    }
  }

  console.log(`[opportunities] Done in ${Date.now() - startTime}ms. Analyzed ${analyzed} markets.`);
  return { statusCode: 200 };
});

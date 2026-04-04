// V3 DISABLED: Weather-only rebuild. This function is not part of the active pipeline.
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

// import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ensembleAnalyze, type EnsembleResult } from '../../src/lib/ensemble';

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

// Categories with dedicated analyzers — we still scan these but only when
// the dedicated analyzer hasn't touched the market recently (12h cooldown).
// This turns the scanner into a "mop-up" for the long tail each category
// can't reach per-run. (Sports: 1,187 high-liq; Crypto: 820; Politics: 508)
// Temperature markets are covered by analyze-temperature.ts — skip entirely.
const SKIP_CATEGORIES = new Set([
  'temperature', 'precipitation',  // fully covered by weather/temperature analyzers
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

export const handler = async () => {
  console.log('[analyze-opportunities] V3 DISABLED — weather-only mode'); return { statusCode: 200 };
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

  // ── 2. Find high-liquidity markets NOT analyzed by any pipeline recently ─
  // Strategy: load markets that haven't been touched by weather/sports/crypto/
  // politics analyzers in the last 12h. Sorted by liquidity — biggest
  // untouched opportunities first.
  // Temperature/precipitation markets are fully covered by the weather analyzer.
  const minResolution    = new Date(Date.now() + 6 * 3600000).toISOString();
  const dedicatedCutoff  = new Date(Date.now() - REANALYSIS_COOLDOWN_H * 3600000).toISOString();

  // Get market_ids recently covered by dedicated analyzers so we don't duplicate
  const [waRows, saRows, caRows, paRows] = await Promise.all([
    supabase.from('weather_analyses') .select('market_id').gte('analyzed_at', dedicatedCutoff).then(r => r.data ?? []),
    supabase.from('sports_analyses')  .select('market_id').gte('analyzed_at', dedicatedCutoff).then(r => r.data ?? []),
    supabase.from('crypto_analyses')  .select('market_id').gte('analyzed_at', dedicatedCutoff).then(r => r.data ?? []),
    supabase.from('politics_analyses').select('market_id').gte('analyzed_at', dedicatedCutoff).then(r => r.data ?? []),
  ]);

  const dedicatedCoverage = new Set<string>([
    ...(waRows as { market_id: string }[]).map(r => r.market_id),
    ...(saRows as { market_id: string }[]).map(r => r.market_id),
    ...(caRows as { market_id: string }[]).map(r => r.market_id),
    ...(paRows as { market_id: string }[]).map(r => r.market_id),
  ]);

  console.log(`[opportunities] Dedicated coverage in last ${REANALYSIS_COOLDOWN_H}h: ${dedicatedCoverage.size} markets`);

  const { data: candidateMarkets } = await supabase
    .from('markets')
    .select('id, question, outcome_prices, liquidity_usd, resolution_date, category')
    .eq('is_active', true)
    .eq('is_resolved', false)
    .gte('liquidity_usd', MIN_LIQUIDITY)
    .gt('resolution_date', minResolution)
    .order('liquidity_usd', { ascending: false })
    .limit(300);

  if (!candidateMarkets || candidateMarkets.length === 0) {
    console.log('[opportunities] No candidate markets found');
    return { statusCode: 200 };
  }

  interface Market {
    id: string;
    question: string;
    outcome_prices: number[];
    liquidity_usd: number;
    resolution_date: string;
    category: string;
  }

  const filtered = (candidateMarkets as Market[]).filter(m => {
    // Skip if already analyzed by any pipeline recently
    if (recentlyAnalyzed.has(m.id)) return false;
    if (dedicatedCoverage.has(m.id)) return false;
    if (openMarketIds.has(m.id)) return false;
    // Skip temperature/precipitation — fully covered by weather analyzer
    const cat = (m.category ?? '').toLowerCase();
    if (SKIP_CATEGORIES.has(cat)) return false;
    // Exclude extreme prices — market is near-resolved, not much edge left
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
    if (Date.now() - startTime > 120000) { // 50s budget (30s func timeout buffer)
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

    const categoryHint = (() => {
      const cat = (market.category ?? '').toLowerCase();
      if (cat === 'sports') return 'SPORTS market — no live odds available. Use your knowledge of the teams/event + cross-market references. Be cautious without real-time data.';
      if (cat === 'crypto') return 'CRYPTO market — no live price feed. Use your knowledge of the asset + cross-market references. Crypto moves fast; be conservative without real-time data.';
      if (cat === 'politics') return 'POLITICS market — use cross-market references heavily. Political prediction markets often have stale prices after news events.';
      return 'General market — use your broad knowledge and cross-market references.';
    })();

    const prompt = `You are ARBITER's general opportunity analyst. You scan Polymarket for mispricings across all categories, focusing on markets missed by dedicated analyzers.

MARKET: "${market.question}"
Category: ${market.category || 'uncategorized'}
Polymarket YES Price: $${yesPrice.toFixed(3)} (${(yesPrice * 100).toFixed(1)}% implied probability)
Polymarket NO Price: $${(1 - yesPrice).toFixed(3)}
Liquidity: $${(market.liquidity_usd ?? 0).toLocaleString()}
Days Remaining: ${daysRemaining.toFixed(1)}
Resolution: ${market.resolution_date}

CATEGORY CONTEXT: ${categoryHint}
${crossMarketSection ? `\nCROSS-MARKET REFERENCES:${crossMarketSection}` : '\nCROSS-MARKET REFERENCES: None found'}

YOUR TASK:
1. Assess whether the current Polymarket price is mispriced
2. Estimate the true probability for YES using your knowledge + cross-market data
3. Calculate edge = |true_prob - market_price|
4. CROSS_MARKET EDGE: If 2+ external sources BOTH diverge >10pp from Polymarket in the same direction → HIGH confidence, auto_eligible = true
5. If 1 source diverges >10pp or 2 sources diverge 5-10pp → MEDIUM confidence
6. No refs or <5pp divergence → LOW confidence or PASS

CROSS-MARKET CONSENSUS: ${crossMarketCount >= 2
  ? `${crossMarketCount} sources agree → strong cross-market signal`
  : crossMarketCount === 1
  ? '1 source only → treat as moderate signal'
  : 'No external refs — rely on knowledge alone (be more conservative)'}
${crossMarketConsensus !== null
  ? `External consensus: ${(crossMarketConsensus * 100).toFixed(1)}%`
  : ''}

CONSTRAINTS:
- Knowledge cutoff ~May 2025 — for recent events, trust cross-market refs over priors
- Only recommend bets with edge >= 0.05
- PASS is valid — don't manufacture an edge you don't see
- Markets resolving >30 days out: be more conservative
- Sports/crypto without live data: default to PASS unless cross-market refs strongly diverge

Respond ONLY in valid JSON:
{
  "true_prob": number (0-1),
  "market_price": number (0-1),
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
      // Feature flag: DISABLED — ensemble abstraction is lossy
      const USE_ENSEMBLE = false;

      let analysis: any;
      let ensembleData: EnsembleResult | null = null;

      if (USE_ENSEMBLE) {
        try {
          ensembleData = await ensembleAnalyze(prompt);
          const claudeResponse = ensembleData.model_responses.find((r: any) => r.model === 'claude');

          if (claudeResponse?.direction && claudeResponse.edge !== null) {
            // Build analysis from ensemble Claude response + market context
            const computedTrueProb = claudeResponse.direction === 'BUY_YES'
              ? Math.min(yesPrice + (claudeResponse.edge ?? 0), 0.99)
              : Math.max(yesPrice - (claudeResponse.edge ?? 0), 0.01);

            analysis = {
              true_prob: computedTrueProb,
              market_price: yesPrice,
              edge: claudeResponse.edge,
              direction: claudeResponse.direction,
              confidence: claudeResponse.confidence,
              reasoning: claudeResponse.reasoning,
              auto_eligible: false,
              flags: [],
            };

            console.log(
              `[opportunities] Ensemble: models=${ensembleData.used_models.join(',')} | ` +
              `agreement=${(ensembleData.agreement_score * 100).toFixed(1)}% | ` +
              `consensus=${ensembleData.consensus_direction}`
            );

            // Boost confidence if all models strongly agree
            if (ensembleData.agreement_score >= 1.0 && crossMarketCount >= 2) {
              analysis.auto_eligible = true;
              analysis.flags.push('ensemble_unanimous', 'cross_market_confirmed');
            }

            // Downgrade confidence on model disagreement
            if (ensembleData.agreement_score < 0.67 && analysis.confidence !== 'LOW') {
              analysis.confidence = 'LOW';
            }
          }
        } catch (ensembleErr) {
          console.error(`[opportunities] Ensemble failed, falling back to direct Claude:`, ensembleErr);
          analysis = null;
        }
      }

      // Fallback: direct Claude call if ensemble unavailable or failed
      if (!analysis) {
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

        analysis = JSON.parse(jsonMatch[0]) as any;
      }

      // Validate analysis
      const { validateOpportunityAnalysis } = await import('../../src/lib/validate-analysis');
      const validation = validateOpportunityAnalysis(analysis);
      if (!validation.valid) {
        console.error(`[opportunities] Validation failed for ${market.id}:`, validation.errors);
        continue;
      }

      // Build flags
      const flags: string[] = [...(validation.data.flags ?? [])];
      if (refs.manifold)    flags.push(`manifold_${(refs.manifold.probability * 100).toFixed(0)}pct`);
      if (refs.metaculus)   flags.push(`metaculus_${(refs.metaculus.probability * 100).toFixed(0)}pct`);
      if (crossMarketCount >= 2) flags.push('cross_market_confirmed');

      // Compute Kelly
      // Look up latest calibration for this category + confidence tier
      const { data: calData } = await supabase
        .from('calibration_snapshots')
        .select('total_bets, predicted_win_rate, actual_win_rate')
        .eq('category', 'opportunity')
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
        category: 'opportunity',
        liquidityUsd: market.liquidity_usd,
        bankroll,
        calibrationDiscount: calDiscount,
      });

      await supabase.from('opportunity_analyses').insert({
        market_id:       market.id,
        question:        market.question,
        market_category: market.category,
        market_price:    validation.data.market_price,
        true_prob:       validation.data.true_prob,
        edge:            validation.data.edge,
        direction:       validation.data.direction,
        confidence:      validation.data.confidence,
        kelly_fraction:  kelly.kellyFraction,
        rec_bet_usd:     kelly.recBetUsd,
        reasoning:       validation.data.reasoning,
        auto_eligible:   validation.data.auto_eligible,
        flags,
        manifold_prob:   refs.manifold?.probability ?? null,
        metaculus_prob:  refs.metaculus?.probability ?? null,
      });

      recentlyAnalyzed.add(market.id);
      analyzed++;

      const hasEdge = validation.data.edge >= MIN_EDGE && validation.data.direction !== 'PASS';
      console.log(
        `[opportunities] ${hasEdge ? '✅' : '➖'} "${market.question.substring(0, 55)}" ` +
        `edge=${validation.data.edge.toFixed(3)} dir=${validation.data.direction} conf=${validation.data.confidence} ` +
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

// ============================================================
// Netlify Scheduled Function: Analyze Politics Edge
// Runs every 30 minutes — compares PredictIt + polling data
// against Polymarket politics markets to find mispricings.
//
// DATA SOURCES (all free, no auth):
// - PredictIt public API (cross-reference prices)
// - 538/Nate Silver polling aggregates
// - Polymarket politics markets
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_ANALYSES_PER_RUN = 8;
const MIN_EDGE_PCT = 0.05;

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

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

interface PredictItMarket {
  id: number;
  name: string;
  shortName: string;
  url: string;
  contracts: Array<{
    id: number;
    name: string;
    shortName: string;
    lastTradePrice: number;
    bestBuyYesCost: number;
    bestBuyNoCost: number;
    status: string;
  }>;
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

// ── RSS News Headlines Fetcher ──────────────────────────────
// Fetches recent political headlines from free RSS feeds to
// ground Claude's reasoning in current events.
// Includes structured sources used by top prediction market bots:
//   - White House (executive orders, proclamations)
//   - AP Politics (fast-breaking news)
//   - Reuters Politics + World
//   - Federal Reserve (rate decisions, statements)
//   - NYT Politics
const POLITICS_RSS_FEEDS = [
  'https://www.whitehouse.gov/feed/',                        // Executive orders & proclamations
  'https://feeds.reuters.com/reuters/politicsNews',
  'https://feeds.reuters.com/reuters/worldNews',
  'https://feeds.bbci.co.uk/news/politics/rss.xml',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml', // Economic news
  'https://apnews.com/rss/apf-politics',                     // AP breaking politics
  'https://apnews.com/rss/apf-economy',                      // AP economic news
];

async function fetchPoliticsNewsHeadlines(timeoutMs = 4000): Promise<string[]> {
  const headlines: string[] = [];
  const fetches = POLITICS_RSS_FEEDS.map(async (url) => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'ARBITER/1.0 (+https://arbit3r.netlify.app)', Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      if (!res.ok) return;
      const xml = await res.text();
      // Extract <title> tags (skip the first one, which is the feed title)
      const matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs)];
      for (const m of matches.slice(1, 8)) {
        const title = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        if (title.length > 10 && title.length < 200) headlines.push(title);
      }
    } catch { /* silently skip failed feeds */ }
  });
  await Promise.allSettled(fetches);
  // Deduplicate and return top 15
  return [...new Set(headlines)].slice(0, 15);
}

// ── Headline Relevance Filter ───────────────────────────────
// Returns headlines relevant to the given question (keyword overlap)
function filterRelevantHeadlines(headlines: string[], question: string, maxCount = 5): string[] {
  const qWords = new Set(
    question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 4)
  );
  const scored = headlines.map(h => {
    const hWords = h.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 4);
    const overlap = hWords.filter(w => qWords.has(w)).length;
    return { h, overlap };
  });
  return scored
    .filter(s => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, maxCount)
    .map(s => s.h);
}

function titleOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 4)
  );
  const wa = words(a), wb = words(b);
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : inter / union;
}

export const handler = schedule('*/30 * * * *', async () => {
  console.log('[analyze-politics] Starting politics edge analysis');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[analyze-politics] ANTHROPIC_API_KEY not set');
    return { statusCode: 500 };
  }

  // ── 1. Fetch Polymarket politics markets ───────────────────
  const politicsTagSlugs = ['politics', 'elections', 'us-politics', 'world-politics', 'policy', 'economics'];

  const tagFetches = politicsTagSlugs.map(slug =>
    fetchJson(`https://gamma-api.polymarket.com/tags/slug/${slug}`)
      .then(t => (t as { id?: number } | null)?.id ?? null)
  );
  const tagIds = (await Promise.all(tagFetches)).filter((id): id is number => id !== null);
  const uniqueTagIds = [...new Set(tagIds)];

  const eventFetches = uniqueTagIds.map(id =>
    fetchJson(`https://gamma-api.polymarket.com/events?tag_id=${id}&active=true&closed=false&limit=100`)
  );
  const eventPages = await Promise.all(eventFetches);

  const seenIds = new Set<string>();
  const politicsMarkets: GammaMarket[] = [];

  for (const page of eventPages) {
    if (!Array.isArray(page)) continue;
    for (const event of page as Array<{ markets?: GammaMarket[] }>) {
      for (const m of event.markets ?? []) {
        if (m.conditionId && !seenIds.has(m.conditionId) && m.active && !m.closed) {
          seenIds.add(m.conditionId);
          politicsMarkets.push(m);
        }
      }
    }
  }

  // Also fetch directly from markets table (already ingested).
  // PRIORITY: near-term markets (resolving within 45 days) come first.
  // These are where news-driven edge exists — 2028 election markets
  // are already efficiently priced by millions of traders and should
  // NOT dominate our analysis budget.
  const now = new Date();
  const cutoffNearTerm = new Date(now.getTime() + 45 * 24 * 3600000).toISOString(); // 45 days out
  const cutoffMin      = new Date(now.getTime() + 2 * 3600000).toISOString();        // at least 2h left
  // Hard cap: skip anything resolving > 12 months out (2028 elections, celebrity speculation).
  // These are priced efficiently by millions of traders — no news edge possible.
  const cutoffMaxLong  = new Date(now.getTime() + 12 * 30 * 24 * 3600000).toISOString();

  const [{ data: nearTermMarkets }, { data: longerTermMarkets }] = await Promise.all([
    // Near-term: resolving in 2h–45 days — high priority for news edge
    supabase.from('markets').select('*')
      .eq('is_active', true)
      .eq('category', 'politics')
      .gt('liquidity_usd', 5000)
      .gt('resolution_date', cutoffMin)
      .lt('resolution_date', cutoffNearTerm)
      .order('resolution_date', { ascending: true })  // soonest first
      .limit(100),
    // Longer-term: 45 days–12 months — lower priority, only analyzed if time permits.
    // Excludes 2028 elections (> 12 months) which are efficiently priced.
    supabase.from('markets').select('*')
      .eq('is_active', true)
      .eq('category', 'politics')
      .gt('liquidity_usd', 50000)    // higher liquidity bar for long-term
      .gte('resolution_date', cutoffNearTerm)
      .lt('resolution_date', cutoffMaxLong)  // no 2028 elections
      .order('liquidity_usd', { ascending: false })
      .limit(30),
  ]);

  // Combine: near-term first, longer-term as fallback
  const dbPoliticsMarkets = [
    ...(nearTermMarkets ?? []),
    ...(longerTermMarkets ?? []),
  ];

  // Upsert newly found markets to DB
  if (politicsMarkets.length > 0) {
    const rows = politicsMarkets.map(m => {
      let outcomes: string[];
      let outcomePrices: number[];
      try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = []; }
      try { outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p)); } catch { outcomePrices = []; }
      return {
        condition_id: m.conditionId,
        question: m.question,
        category: 'politics',
        outcomes,
        outcome_prices: outcomePrices,
        volume_usd: parseFloat(m.volume) || 0,
        liquidity_usd: parseFloat(m.liquidity) || 0,
        resolution_date: m.endDate,
        is_active: true,
        updated_at: new Date().toISOString(),
      };
    });
    await supabase.from('markets').upsert(rows, { onConflict: 'condition_id' });
  }

  const allPoliticsMarkets = [
    ...(dbPoliticsMarkets ?? []),
    ...politicsMarkets.filter(m => !(dbPoliticsMarkets ?? []).some((d: { condition_id: string }) => d.condition_id === m.conditionId)),
  ];

  console.log(`[analyze-politics] ${allPoliticsMarkets.length} active politics markets`);

  if (allPoliticsMarkets.length === 0) {
    console.log('[analyze-politics] No politics markets found');
    return { statusCode: 200 };
  }

  // ── 2. Fetch PredictIt cross-reference prices ──────────────
  const predictItData = await fetchJson('https://www.predictit.org/api/marketdata/all/') as {
    markets: PredictItMarket[];
  } | null;

  const predictItMarkets = predictItData?.markets ?? [];
  console.log(`[analyze-politics] ${predictItMarkets.length} PredictIt markets for cross-reference`);

  // ── 3. Fetch current political news headlines ──────────────
  // Run in parallel with DB queries — used to ground Claude's reasoning
  const newsHeadlines = await fetchPoliticsNewsHeadlines(4000);
  console.log(`[analyze-politics] Fetched ${newsHeadlines.length} news headlines for context`);

  // ── 4. Analyze top markets with Claude ────────────────────
  let analyzed = 0;

  // Pre-load recently-analyzed market IDs — use 24h window to cover both tiers.
  // Near-term markets (< 45 days): re-analyze every 3h (fresh news can shift them quickly)
  // Long-term markets (45 days–12 months): re-analyze every 24h (slow-moving)
  const recentCutoffNearTerm = new Date(Date.now() - 3 * 3600000).toISOString();
  const recentCutoffLongTerm = new Date(Date.now() - 24 * 3600000).toISOString();
  const { data: recentRows } = await supabase
    .from('politics_analyses')
    .select('market_id, analyzed_at')
    .gte('analyzed_at', recentCutoffLongTerm); // load last 24h for both tiers
  const analyzedIn3h  = new Set((recentRows ?? []).filter((r: { analyzed_at: string }) => r.analyzed_at >= recentCutoffNearTerm).map((r: { market_id: string }) => r.market_id));
  const analyzedIn24h = new Set((recentRows ?? []).map((r: { market_id: string }) => r.market_id));

  const cutoffNearTermMs = now.getTime() + 45 * 24 * 3600000;

  // Sort: near-term first (always beats long-term), then unanalyzed > analyzed, then liquidity DESC
  const sortedCandidates = [...allPoliticsMarkets].sort((a, b) => {
    const aId = (a as { id?: string }).id ?? '';
    const bId = (b as { id?: string }).id ?? '';
    const aResMs = new Date((a as { resolution_date?: string }).resolution_date ?? (a as { endDate?: string }).endDate ?? '').getTime() || Infinity;
    const bResMs = new Date((b as { resolution_date?: string }).resolution_date ?? (b as { endDate?: string }).endDate ?? '').getTime() || Infinity;
    const aIsNear = aResMs <= cutoffNearTermMs;
    const bIsNear = bResMs <= cutoffNearTermMs;
    // Near-term always comes before long-term
    if (aIsNear !== bIsNear) return aIsNear ? -1 : 1;
    // Within same tier: unanalyzed beats analyzed
    const aAnalyzed = (aIsNear ? analyzedIn3h : analyzedIn24h).has(aId) ? 1 : 0;
    const bAnalyzed = (bIsNear ? analyzedIn3h : analyzedIn24h).has(bId) ? 1 : 0;
    if (aAnalyzed !== bAnalyzed) return aAnalyzed - bAnalyzed;
    const aLiq = (a as { liquidity_usd?: number }).liquidity_usd ?? 0;
    const bLiq = (b as { liquidity_usd?: number }).liquidity_usd ?? 0;
    return bLiq - aLiq;
  });

  for (const market of sortedCandidates) {
    if (Date.now() - startTime > 22000) break;
    if (analyzed >= MAX_ANALYSES_PER_RUN) break;

    const mktId = (market as { id?: string }).id;
    const conditionId = (market as { condition_id?: string; conditionId?: string }).condition_id
      ?? (market as { conditionId?: string }).conditionId;
    const question = (market as { question: string }).question;
    const liquidityUsd = (market as { liquidity_usd?: number }).liquidity_usd ?? 0;
    const volumeUsd = (market as { volume_usd?: number }).volume_usd ?? 0;
    const resolutionDate = (market as { resolution_date?: string }).resolution_date
      ?? (market as { endDate?: string }).endDate;

    if (!mktId || liquidityUsd < 5000) continue;

    // Skip recently analyzed — use tier-appropriate recency window.
    // Near-term (< 45 days): 3h window (news can move fast).
    // Long-term: 24h window (avoid burning API budget on efficiently priced markets).
    const marketIsNearTerm = resolutionDate
      ? new Date(resolutionDate).getTime() <= cutoffNearTermMs
      : false;
    const wasRecentlyAnalyzed = marketIsNearTerm ? analyzedIn3h.has(mktId) : analyzedIn24h.has(mktId);
    if (wasRecentlyAnalyzed) continue;

    const outcomePrices: number[] = (market as { outcome_prices?: number[] }).outcome_prices ?? [];
    if (outcomePrices.length < 2) continue;

    const hoursRemaining = resolutionDate
      ? (new Date(resolutionDate).getTime() - Date.now()) / 3600000
      : 0;
    if (hoursRemaining < 1) continue;

    const outcomesList = outcomePrices
      .map((p, i) => {
        const outcomes: string[] = (market as { outcomes?: string[] }).outcomes ?? [];
        return `${outcomes[i] ?? `Outcome ${i}`} → $${p.toFixed(3)}`;
      })
      .join('\n');

    // Find matching PredictIt market for cross-reference
    const piMatch = predictItMarkets.find(pi =>
      titleOverlap(question, pi.name) > 0.4 || titleOverlap(question, pi.shortName) > 0.4
    );

    const piSection = piMatch
      ? `PREDICTIT CROSS-REFERENCE:
- Market: ${piMatch.name}
${piMatch.contracts.filter(c => c.status === 'Open').slice(0, 4).map(c =>
  `- ${c.name}: YES=$${c.bestBuyYesCost} NO=$${c.bestBuyNoCost} (last=$${c.lastTradePrice})`
).join('\n')}`
      : 'PREDICTIT: No matching market found';

    // Filter news headlines relevant to this market
    const relevantHeadlines = filterRelevantHeadlines(newsHeadlines, question, 5);
    const newsSection = relevantHeadlines.length > 0
      ? `\nRECENT NEWS (RSS headlines, use for current context):\n${relevantHeadlines.map(h => `- ${h}`).join('\n')}`
      : '';

    // Long-shot calibration note for sub-5% markets
    const yesPrice = outcomePrices[0] ?? 0.5;
    const longShotGuidance = yesPrice < 0.05
      ? `\nLONG-SHOT CALIBRATION NOTE: This market is priced at ${(yesPrice * 100).toFixed(1)}% YES — a 1-in-${Math.round(1/yesPrice)} implied probability. To have edge, you need a TRUE probability meaningfully above or below this anchor. Be explicitly Bayesian: start from the base rate for this event type, update only on specific strong evidence. Avoid anchoring bias toward round numbers. A 2% market priced at 1.5% is only a 0.5% edge — typically not worth betting unless very high confidence.`
      : '';

    const isNearTerm = hoursRemaining <= 24 * 45; // within 45 days
    const daysRemaining = hoursRemaining / 24;

    const prompt = `You are ARBITER's politics/news edge detector. Your job is to find MISPRICINGS between current Polymarket prices and reality — driven by breaking news, policy announcements, economic data, or events that traders haven't fully priced in yet.

POLYMARKET QUESTION: ${question}
LIQUIDITY: $${liquidityUsd.toLocaleString()} | VOLUME: $${volumeUsd.toLocaleString()}
RESOLVES IN: ${Math.round(hoursRemaining)} hours (~${daysRemaining.toFixed(1)} days) — ${daysRemaining <= 3 ? '🔴 VERY NEAR-TERM' : daysRemaining <= 14 ? '🟡 NEAR-TERM' : daysRemaining <= 45 ? '🟢 MEDIUM-TERM' : '⚪ LONG-TERM (discount edge)'}

POLYMARKET OUTCOMES (price = implied probability):
${outcomesList}

${piSection}
${newsSection}
${longShotGuidance}

EDGE CATEGORIES — which type of edge might this market have?
A) NEWS EDGE: Recent news has changed the outcome probability but market hasn't repriced yet
B) CROSS-MARKET EDGE: PredictIt or Kalshi prices this differently (structural arbitrage)
C) CALIBRATION EDGE: Market is systematically mispriced vs base rates (e.g., overreacting to unlikely scenario)
D) DATA EDGE: Official data release (CPI, jobs, Fed rate) makes outcome probability much clearer

TASK:
1. Identify which edge type applies (A/B/C/D), or NONE if efficiently priced
2. Estimate true probability using the strongest available signal:
   - If news headlines show a directly relevant development, weight it heavily
   - If PredictIt aligns with Polymarket → sharp money says price is right → lower edge
   - Use base rates for recurring event types (elections, rate decisions, etc.)
3. Calculate edge = true_prob - market_price
4. Set direction = PASS unless edge >= 0.05 AND you have a specific signal (not just vague priors)
5. Set auto_eligible = true only for: confidence HIGH/MEDIUM + edge >= 0.06 + specific evidence + daysRemaining <= 30
6. For markets > 45 days out: apply 40% discount to any edge (long-term efficient market)
7. NEVER bet on "will X win 2028 election" type questions — too far, too noisy

Respond ONLY in valid JSON:
{
  "question_summary": string,
  "category": "executive_action"|"economic_data"|"election"|"geopolitical"|"legal"|"policy"|"other",
  "edge_type": "NEWS"|"CROSS_MARKET"|"CALIBRATION"|"DATA"|"NONE",
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number,
    "true_prob": number,
    "edge": number,
    "direction": "BUY_YES"|"BUY_NO"|"PASS",
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "reasoning": string
  } | null,
  "predictit_aligns": boolean,
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

      if (!res.ok) { console.error(`[analyze-politics] Claude API error: ${res.status}`); continue; }

      const data = await res.json();
      const text = data.content?.[0]?.text ?? '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const analysis = JSON.parse(jsonMatch[0]);

      // Cap at 0.50 max — prevents over-sizing Kelly on near-certain calls
      const edgeNorm    = Math.min(normalizeEdge(analysis.best_bet?.edge) ?? 0, 0.50) || null;
      const mktPriceNorm = normalizeProb(analysis.best_bet?.market_price);
      const trueProbNorm = normalizeProb(analysis.best_bet?.true_prob);

      // Kelly sizing
      let kellyFraction = 0, recBetUsd = 0;
      if (analysis.best_bet?.direction !== 'PASS' && edgeNorm !== null && edgeNorm >= MIN_EDGE_PCT) {
        const { data: configRows } = await supabase.from('system_config').select('key, value').in('key', ['paper_bankroll']);
        const bankroll = parseFloat(configRows?.find((r: { key: string }) => r.key === 'paper_bankroll')?.value ?? '500');
        // BUY_NO: true_prob is YES probability, so flip to NO side for Kelly
        const isBuyNo = analysis.best_bet?.direction === 'BUY_NO';
        const p = isBuyNo ? 1 - (trueProbNorm ?? 0) : (trueProbNorm ?? 0);
        const c = isBuyNo ? 1 - (mktPriceNorm ?? 0) : (mktPriceNorm ?? 0);
        if (p > 0 && c > 0 && c < 1) {
          const b = (1 - c) / c;
          const fullKelly = (p * b - (1 - p)) / b;
          if (fullKelly > 0) {
            const confMult = analysis.best_bet.confidence === 'HIGH' ? 0.8 : analysis.best_bet.confidence === 'MEDIUM' ? 0.5 : 0.2;
            kellyFraction = Math.min(fullKelly * 0.125 * confMult, 0.03);
            recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
          }
        }
      }

      await supabase.from('politics_analyses').insert({
        market_id: mktId,
        question_summary: analysis.question_summary ?? question.substring(0, 100),
        category: analysis.category ?? 'other',
        best_outcome_idx: analysis.best_bet?.outcome_index ?? null,
        best_outcome_label: analysis.best_bet?.outcome_label ?? null,
        market_price: mktPriceNorm,
        true_prob: trueProbNorm,
        edge: edgeNorm,
        direction: analysis.best_bet?.direction ?? 'PASS',
        confidence: analysis.best_bet?.confidence ?? 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: analysis.best_bet?.reasoning ?? null,
        predictit_aligns: analysis.predictit_aligns ?? false,
        auto_eligible: analysis.auto_eligible ?? false,
        flags: analysis.flags ?? [],
      });

      analyzed++;
      console.log(`[analyze-politics] ✅ "${question.substring(0, 60)}": edge=${edgeNorm?.toFixed(3)} dir=${analysis.best_bet?.direction} conf=${analysis.best_bet?.confidence}`);
    } catch (err) {
      console.error(`[analyze-politics] Analysis failed:`, err);
    }
  }

  console.log(`[analyze-politics] Done. Analyzed ${analyzed} politics markets in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

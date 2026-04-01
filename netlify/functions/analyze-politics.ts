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
const MAX_ANALYSES_PER_RUN = 6;
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

  // Also fetch directly from markets table (already ingested)
  const { data: dbPoliticsMarkets } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true)
    .eq('category', 'politics')
    .gt('liquidity_usd', 5000)
    .order('volume_usd', { ascending: false })
    .limit(50);

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

  // ── 3. Analyze top markets with Claude ────────────────────
  let analyzed = 0;

  // Sort by volume descending, skip recently analyzed
  const recentCutoff = new Date(Date.now() - 2 * 3600000).toISOString();

  for (const market of allPoliticsMarkets.slice(0, MAX_ANALYSES_PER_RUN * 2)) {
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

    // Skip recently analyzed
    const { data: recent } = await supabase
      .from('politics_analyses')
      .select('id')
      .eq('market_id', mktId)
      .gte('analyzed_at', recentCutoff)
      .limit(1);
    if (recent?.length) continue;

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

    const prompt = `You are ARBITER's politics analyst. Compare market prices to ground-truth indicators and find mispricings.

POLYMARKET QUESTION: ${question}
LIQUIDITY: $${liquidityUsd.toLocaleString()} | VOLUME: $${volumeUsd.toLocaleString()}
RESOLVES IN: ${Math.round(hoursRemaining)} hours

POLYMARKET OUTCOMES (price = implied probability):
${outcomesList}

${piSection}

TASK:
1. Assess the fair probability for each outcome based on:
   - Current polling/consensus (use your training knowledge up to your cutoff)
   - PredictIt cross-reference if available (sharp money)
   - Base rates for this type of event
   - Recent news that may have repriced the market
2. Calculate edge = true_prob - market_price for each outcome
3. Select the single best bet if edge >= 0.05
4. Be conservative — politics markets are liquid and often efficiently priced
5. Set auto_eligible = true only if confidence HIGH/MEDIUM and edge >= 0.06
6. Flag if this is a near-term event vs a long-duration market (weight accordingly)

Respond ONLY in valid JSON:
{
  "question_summary": string,
  "category": "election"|"policy"|"geopolitical"|"economic"|"other",
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

      const edgeNorm    = normalizeEdge(analysis.best_bet?.edge);
      const mktPriceNorm = normalizeProb(analysis.best_bet?.market_price);
      const trueProbNorm = normalizeProb(analysis.best_bet?.true_prob);

      // Kelly sizing
      let kellyFraction = 0, recBetUsd = 0;
      if (analysis.best_bet?.direction !== 'PASS' && edgeNorm !== null && edgeNorm >= MIN_EDGE_PCT) {
        const { data: configRows } = await supabase.from('system_config').select('key, value').in('key', ['paper_bankroll']);
        const bankroll = parseFloat(configRows?.find((r: { key: string }) => r.key === 'paper_bankroll')?.value ?? '500');
        const p = trueProbNorm ?? 0;
        const c = mktPriceNorm ?? 0;
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

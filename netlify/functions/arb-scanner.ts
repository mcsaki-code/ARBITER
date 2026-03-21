// ============================================================
// Netlify Scheduled Function: Arbitrage Scanner
// Runs every 15 minutes — scans ALL Polymarket markets for
// sum-to-one arbitrage (YES + NO < $0.98 after fees)
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
  category?: string;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  markets: GammaMarket[];
}

// Polymarket fee = 0.01% on trades (US). Effectively negligible.
const POLY_FEE_RATE = 0.0001;
// Minimum gross edge to consider (2% — covers fees + slippage)
const MIN_GROSS_EDGE = 0.02;
// Max markets to scan per run (stay within 25s Netlify budget)
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

async function fetchGamma(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function parseOutcomePrices(raw: string): number[] {
  try {
    return JSON.parse(raw).map((p: string) => parseFloat(p));
  } catch {
    return raw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
  }
}

function categorizeMarket(question: string): string {
  const q = question.toLowerCase();
  if (/temperature|°f|°c|weather|forecast/.test(q)) return 'weather';
  if (/bitcoin|btc|ethereum|eth|crypto|solana/.test(q)) return 'crypto';
  if (/nba|nfl|mlb|nhl|ncaa|ufc|mma|soccer|football|basketball|baseball|hockey|tennis|f1/.test(q)) return 'sports';
  if (/election|president|congress|senate|governor|democrat|republican|trump|biden/.test(q)) return 'politics';
  if (/cpi|inflation|fed|interest rate|unemployment|gdp|jobs|oil price/.test(q)) return 'economics';
  return 'other';
}

export const handler = schedule('*/15 * * * *', async () => {
  console.log('[arb-scanner] Starting arbitrage scan');
  const startTime = Date.now();

  const allMarkets: GammaMarket[] = [];
  const seenIds = new Set<string>();

  function addMarket(m: GammaMarket) {
    if (m.conditionId && !seenIds.has(m.conditionId) && m.active && !m.closed) {
      seenIds.add(m.conditionId);
      allMarkets.push(m);
    }
  }

  // Scan across multiple high-volume tag categories
  const tagSlugs = [
    'temperature', 'weather', 'climate',
    'sports', 'nba', 'nfl', 'mlb', 'nhl', 'ncaa', 'soccer', 'ufc',
    'crypto', 'bitcoin', 'ethereum',
    'politics', 'elections',
    'economics', 'fed', 'inflation',
    'culture', 'entertainment',
  ];

  const tagIds: number[] = [];
  for (const slug of tagSlugs) {
    // Time guard: stop after 20s to leave room for DB operations
    if (Date.now() - startTime > 20000) break;

    const tag = await fetchGamma(
      `https://gamma-api.polymarket.com/tags/slug/${slug}`
    ) as { id?: number } | null;
    if (tag?.id && !tagIds.includes(tag.id)) {
      tagIds.push(tag.id);
    }
  }

  console.log(`[arb-scanner] Resolved ${tagIds.length} unique tag IDs`);

  // Fetch events by tag_id (each event contains nested markets)
  for (const tagId of tagIds) {
    if (Date.now() - startTime > 18000) break;

    for (let offset = 0; offset < 3 * PAGE_SIZE; offset += PAGE_SIZE) {
      if (Date.now() - startTime > 18000) break;

      const page = await fetchGamma(
        `https://gamma-api.polymarket.com/events?tag_id=${tagId}&active=true&closed=false&limit=${PAGE_SIZE}&offset=${offset}`
      );
      if (!Array.isArray(page) || page.length === 0) break;

      for (const event of page as GammaEvent[]) {
        if (event.markets && Array.isArray(event.markets)) {
          for (const m of event.markets) addMarket(m);
        }
      }
      if (page.length < PAGE_SIZE) break;
    }
  }

  // Also do a broad fetch of active markets (no tag filter) to catch uncategorized markets
  for (let offset = 0; offset < 5 * PAGE_SIZE; offset += PAGE_SIZE) {
    if (Date.now() - startTime > 20000) break;

    const page = await fetchGamma(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (!Array.isArray(page) || page.length === 0) break;
    for (const m of page as GammaMarket[]) addMarket(m);
    if (page.length < PAGE_SIZE) break;
  }

  console.log(`[arb-scanner] Scanning ${allMarkets.length} active markets for arbitrage`);

  // Detect sum-to-one arbitrage opportunities
  const arbOpportunities: {
    market_a_id: string;
    event_question: string;
    price_yes: number;
    price_no: number;
    combined_cost: number;
    gross_edge: number;
    net_edge: number;
    volume_a: number;
    liquidity_a: number;
    category: string;
  }[] = [];

  for (const m of allMarkets) {
    const prices = parseOutcomePrices(m.outcomePrices);

    // Binary markets: YES + NO < 1.0
    if (prices.length === 2) {
      const [pYes, pNo] = prices;
      if (pYes > 0 && pNo > 0) {
        const combined = pYes + pNo;
        const grossEdge = 1.0 - combined;

        if (grossEdge >= MIN_GROSS_EDGE) {
          // Net edge accounts for 0.01% fee on both sides
          const netEdge = grossEdge - (2 * POLY_FEE_RATE);
          if (netEdge > 0) {
            arbOpportunities.push({
              market_a_id: m.conditionId,
              event_question: m.question,
              price_yes: pYes,
              price_no: pNo,
              combined_cost: combined,
              gross_edge: grossEdge,
              net_edge: netEdge,
              volume_a: parseFloat(m.volume) || 0,
              liquidity_a: parseFloat(m.liquidity) || 0,
              category: categorizeMarket(m.question),
            });
          }
        }
      }
    }

    // Multi-outcome markets: sum of all outcomes < 1.0
    // (e.g., bracket markets where buying all brackets is cheaper than $1)
    if (prices.length > 2) {
      const totalCost = prices.reduce((sum, p) => sum + p, 0);
      if (totalCost > 0 && totalCost < 1.0) {
        const grossEdge = 1.0 - totalCost;
        if (grossEdge >= MIN_GROSS_EDGE) {
          const netEdge = grossEdge - (prices.length * POLY_FEE_RATE);
          if (netEdge > 0) {
            arbOpportunities.push({
              market_a_id: m.conditionId,
              event_question: m.question,
              price_yes: prices[0],
              price_no: prices.length > 1 ? prices[1] : 0,
              combined_cost: totalCost,
              gross_edge: grossEdge,
              net_edge: netEdge,
              volume_a: parseFloat(m.volume) || 0,
              liquidity_a: parseFloat(m.liquidity) || 0,
              category: categorizeMarket(m.question),
            });
          }
        }
      }
    }
  }

  // Sort by net edge descending
  arbOpportunities.sort((a, b) => b.net_edge - a.net_edge);

  console.log(`[arb-scanner] Found ${arbOpportunities.length} arb opportunities (edge >= ${MIN_GROSS_EDGE * 100}%)`);

  // Log top 5
  for (const arb of arbOpportunities.slice(0, 5)) {
    console.log(`  ${arb.category} | ${arb.gross_edge.toFixed(3)} gross | ${arb.net_edge.toFixed(3)} net | $${arb.liquidity_a.toFixed(0)} liq | ${arb.event_question.substring(0, 80)}`);
  }

  // Store to Supabase: expire old OPEN ones, then insert fresh batch
  if (arbOpportunities.length > 0) {
    // Mark all existing OPEN arbs as expired (fresh scan replaces them)
    await supabase
      .from('arb_opportunities')
      .update({ status: 'EXPIRED' })
      .eq('status', 'OPEN');

    const rows = arbOpportunities.map((arb) => ({
      market_a_id: arb.market_a_id,
      platform_a: 'polymarket',
      event_question: arb.event_question,
      price_yes: arb.price_yes,
      price_no: arb.price_no,
      combined_cost: arb.combined_cost,
      gross_edge: arb.gross_edge,
      net_edge: arb.net_edge,
      volume_a: arb.volume_a,
      liquidity_a: arb.liquidity_a,
      category: arb.category,
      status: 'OPEN',
      detected_at: new Date().toISOString(),
    }));

    // Insert in chunks to avoid payload limits
    const chunkSize = 200;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await supabase.from('arb_opportunities').insert(chunk);
      if (error) {
        console.error('[arb-scanner] Insert error:', error.message);
      } else {
        inserted += chunk.length;
      }
    }
    console.log(`[arb-scanner] Inserted ${inserted} arb opportunities`);
  }

  // Cleanup: delete expired arbs older than 24h to prevent table bloat
  await supabase
    .from('arb_opportunities')
    .delete()
    .eq('status', 'EXPIRED')
    .lt('detected_at', new Date(Date.now() - 86400000).toISOString());

  const elapsed = Date.now() - startTime;
  console.log(`[arb-scanner] Done in ${elapsed}ms. ${arbOpportunities.length} opportunities found.`);

  return { statusCode: 200 };
});

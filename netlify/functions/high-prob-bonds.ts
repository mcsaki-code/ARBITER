// V3 DISABLED: Weather-only rebuild. This function is not part of the active pipeline.
// ============================================================
// Netlify Scheduled Function: High-Probability Bonds
// Runs every 20 minutes — buys near-certain outcomes at 90-97¢
//
// Strategy: Small edge per trade (3-7%) but near-100% win rate
// through massive volume on high-conviction bets.
//
// Example: Buy YES at $0.93 → win $0.07 per dollar → need 93%
// accuracy, but on 50+ positions this achieves 95%+ overall ROI.
// ============================================================

// import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { executeBet } from '../../src/lib/execute-bet';
import { shouldTrade } from '../../src/lib/circuit-breaker';
import { notifyBetPlaced } from '../../src/lib/notify';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Anthropic API for quick Claude assessments
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

interface BondCandidate {
  market_id: string;
  condition_id: string;
  question: string;
  outcome_label: string;
  price: number;
  direction: 'BUY_YES' | 'BUY_NO';
  liquidity: number;
  days_remaining: number;
  category: string;
}

// Parse outcome prices from Gamma API response
function parseOutcomePrices(raw: string): number[] {
  try {
    return JSON.parse(raw).map((p: string) => parseFloat(p));
  } catch {
    return raw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
  }
}

// Parse outcomes from Gamma API response
function parseOutcomes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [raw];
  } catch {
    return [raw];
  }
}

// Categorize market by question
function categorizeMarket(question: string): string {
  const q = question.toLowerCase();
  if (/temperature|°f|°c|weather|forecast|rain|snow|wind/.test(q)) return 'weather';
  if (/bitcoin|btc|ethereum|eth|crypto|solana|xrp/.test(q)) return 'crypto';
  if (/nba|nfl|mlb|nhl|ncaa|ufc|mma|soccer|football|basketball|baseball|hockey|tennis|f1|world cup/.test(q)) return 'sports';
  if (/election|president|congress|senate|governor|democrat|republican|trump|biden|harris/.test(q)) return 'politics';
  if (/cpi|inflation|fed|interest rate|unemployment|gdp|jobs|oil price|economic/.test(q)) return 'economics';
  return 'other';
}

// Fetch all Polymarket markets in parallel
async function fetchAllMarkets(): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  const seenIds = new Set<string>();

  // Fetch markets in parallel (15 pages × 500 markets = up to 7500 markets)
  const BULK_PAGES = 15;
  const bulkFetches = Array.from({ length: BULK_PAGES }, (_, i) =>
    fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&offset=${i * 500}`,
      { signal: AbortSignal.timeout(10000) }
    )
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  );

  const pages = await Promise.all(bulkFetches);
  for (const page of pages) {
    if (Array.isArray(page)) {
      for (const m of page) {
        if (m.conditionId && !seenIds.has(m.conditionId)) {
          seenIds.add(m.conditionId);
          allMarkets.push(m);
        }
      }
    }
  }

  console.log(`[high-prob-bonds] Fetched ${allMarkets.length} active markets`);
  return allMarkets;
}

// Quick Claude assessment: is this outcome likely to resolve in the indicated direction?
// For sports markets with <48h remaining, use heuristic instead of Claude
async function assessBondProbability(
  question: string,
  outcome_label: string,
  category: string,
  daysRemaining: number
): Promise<boolean> {
  // For sports markets resolving very soon (<48h), skip Claude and trust price
  if (category === 'sports' && daysRemaining < 2) {
    console.log(
      `[high-prob-bonds] Sports market resolving in ${daysRemaining.toFixed(1)}d — using price heuristic`
    );
    return true;
  }

  if (!ANTHROPIC_API_KEY) {
    console.log('[high-prob-bonds] No ANTHROPIC_API_KEY — skipping assessments');
    return false;
  }

  const prompt = `Is this outcome likely to resolve in the direction indicated by the high market price (>88% probability)? Answer only YES or NO with one sentence.

Market: ${question}
Outcome: ${outcome_label}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1-20250805',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.log(`[high-prob-bonds] Claude API error: ${res.status}`);
      return false;
    }

    const data = await res.json() as {
      content?: Array<{ type: string; text: string }>;
    };
    const text = data.content?.[0]?.text ?? '';
    const isYes = text.toUpperCase().startsWith('YES');
    console.log(`[high-prob-bonds] Assessment: "${text.substring(0, 80)}" → ${isYes ? 'YES' : 'NO'}`);
    return isYes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[high-prob-bonds] Claude error: ${msg}`);
    return false;
  }
}

export const handler = async () => {
  console.log('[high-prob-bonds] V3 DISABLED — weather-only mode'); return { statusCode: 200 };
  console.log('[high-prob-bonds] Starting high-probability bonds scan');
  const startTime = Date.now();

  // Circuit breaker check
  const cbState = await shouldTrade(supabase);
  if (!cbState.canTrade) {
    console.log(`[high-prob-bonds] CIRCUIT BREAKER ACTIVE: ${cbState.reason}`);
    return { statusCode: 200 };
  }

  // Load system config
  const { data: configRows } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['paper_bankroll', 'live_trading_enabled', 'live_kill_switch']);

  const config: Record<string, string> = {};
  configRows?.forEach((r: { key: string; value: string }) => {
    config[r.key] = r.value;
  });

  const bankroll = parseFloat(config.paper_bankroll || '5000');
  const maxSingleBet = bankroll * 0.01; // 1% per bond for volume strategy
  const maxDailyExposure = bankroll * 0.20;

  // Check today's exposure
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data: todaysBets } = await supabase
    .from('bets')
    .select('amount_usd')
    .eq('category', 'high_prob_bond')
    .gte('placed_at', todayStart.toISOString());

  const todayExposure = todaysBets?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;

  if (todayExposure >= maxDailyExposure) {
    console.log('[high-prob-bonds] Daily exposure limit reached');
    return { statusCode: 200 };
  }

  // Get all open positions to avoid duplicates
  const { data: openBets } = await supabase
    .from('bets')
    .select('market_id');
  const openMarketIds = new Set(openBets?.map((b) => b.market_id) || []);

  // Fetch all markets from Gamma API
  const gammaMarkets = await fetchAllMarkets();
  if (gammaMarkets.length === 0) {
    console.log('[high-prob-bonds] No markets found from Gamma API');
    return { statusCode: 200 };
  }

  // Upsert Gamma markets into DB to ensure we have UUIDs
  if (gammaMarkets.length > 0) {
    const rows = gammaMarkets.map((m) => {
      let outcomes: string[];
      let outcomePrices: number[];
      try {
        outcomes = JSON.parse(m.outcomes);
      } catch {
        outcomes = [];
      }
      try {
        outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p));
      } catch {
        outcomePrices = [];
      }
      return {
        condition_id: m.conditionId,
        question: m.question,
        category: categorizeMarket(m.question),
        outcomes,
        outcome_prices: outcomePrices,
        volume_usd: parseFloat(m.volume) || 0,
        liquidity_usd: parseFloat(m.liquidity) || 0,
        resolution_date: m.endDate,
        is_active: m.active && !m.closed,
        updated_at: new Date().toISOString(),
      };
    });
    await supabase.from('markets').upsert(rows, { onConflict: 'condition_id' });
    console.log(`[high-prob-bonds] Upserted ${rows.length} markets to DB`);
  }

  // Query markets from DB (this gives us the UUIDs we need for the bets table)
  const { data: dbMarkets } = await supabase
    .from('markets')
    .select('id, condition_id, question, category, outcome_prices, liquidity_usd, resolution_date, is_active')
    .eq('is_active', true)
    .gt('liquidity_usd', 50000);

  if (!dbMarkets || dbMarkets.length === 0) {
    console.log('[high-prob-bonds] No markets in DB with sufficient liquidity');
    return { statusCode: 200 };
  }

  // Filter for bond candidates (price 0.90-0.97 or 0.03-0.10)
  const candidates: BondCandidate[] = [];

  for (const m of dbMarkets) {
    // Skip if we already have a position
    if (openMarketIds.has(m.id)) continue;

    // Skip weather markets (too volatile at high prices)
    if (m.category === 'weather') continue;

    // Check resolution date (7-90 days remaining)
    const endDate = new Date(m.resolution_date);
    const daysRemaining = (endDate.getTime() - Date.now()) / (24 * 3600000);
    if (daysRemaining < 7 || daysRemaining > 90) continue;

    // Get prices and outcomes (they're already in the DB)
    const prices = m.outcome_prices || [];
    const outcomes = m.outcomes || [];

    // Look for outcomes at 0.90-0.97 (YES bonds)
    for (let i = 0; i < prices.length; i++) {
      const price = prices[i];
      if (price >= 0.90 && price <= 0.97) {
        candidates.push({
          market_id: m.id, // Use DB UUID, not condition_id
          condition_id: m.condition_id,
          question: m.question,
          outcome_label: outcomes[i] || `Outcome ${i}`,
          price,
          direction: 'BUY_YES',
          liquidity: m.liquidity_usd,
          days_remaining: daysRemaining,
          category: m.category,
        });
      }

      // Also check the NO side: if YES price is 0.03-0.10, then NO is 0.90-0.97 (NO bonds)
      if (price >= 0.03 && price <= 0.10) {
        const noPrice = 1 - price;
        candidates.push({
          market_id: m.id, // Use DB UUID, not condition_id
          condition_id: m.condition_id,
          question: m.question,
          outcome_label: outcomes[i] ? `NOT ${outcomes[i]}` : `NOT Outcome ${i}`,
          price: noPrice,
          direction: 'BUY_NO',
          liquidity: m.liquidity_usd,
          days_remaining: daysRemaining,
          category: m.category,
        });
      }
    }
  }

  console.log(`[high-prob-bonds] Found ${candidates.length} initial candidates (price 0.90-0.97)`);
  if (candidates.length === 0) {
    return { statusCode: 200 };
  }

  // Assess each candidate with Claude (keep timeout short for speed)
  let placed = 0;
  let totalDeployed = todayExposure;

  for (const cand of candidates) {
    // Stop conditions
    if (totalDeployed >= maxDailyExposure) break;
    if (Date.now() - startTime > 18000) break; // Stay within 18s timeout

    // Quick Claude assessment (or heuristic for sports <48h)
    const isHighProb = await assessBondProbability(cand.question, cand.outcome_label, cand.category, cand.days_remaining);
    if (!isHighProb) {
      console.log(`[high-prob-bonds] ${cand.question.substring(0, 60)}... — Assessment says not high prob`);
      continue;
    }

    // Kelly sizing with 1/16th fraction (bonds are about volume not size)
    // Expected return: buy at 0.93, win $0.07, lose $0.93
    // Kelly = (p * b - q) / b where p=0.95, b=(1-p)/p=0.0526, q=1-p
    // Kelly ≈ 0.05 → 1/16th = 0.003 = 0.3% bankroll
    const kellyFraction = 0.003;
    let betAmount = Math.round(bankroll * kellyFraction * 100) / 100;

    // Cap at max single bet and remaining exposure
    betAmount = Math.min(betAmount, maxSingleBet, maxDailyExposure - totalDeployed);
    if (betAmount < 1) break;

    // Execute bet via existing framework
    const result = await executeBet(
      supabase,
      {
        market_id: cand.market_id,
        analysis_id: null,
        category: 'high_prob_bond',
        direction: cand.direction,
        outcome_label: cand.outcome_label,
        entry_price: cand.price,
        amount_usd: betAmount,
        condition_id: cand.condition_id,
        edge: 0.05, // Conservative 5% edge estimate
        confidence: 'HIGH',
      },
      config,
      0
    );

    if (result.success) {
      console.log(
        `[high-prob-bonds] PLACED bond: ${cand.outcome_label} at $${cand.price.toFixed(4)}, ` +
        `$${betAmount.toFixed(0)} bet, ${cand.days_remaining.toFixed(0)}d remaining`
      );
      placed++;
      totalDeployed += betAmount;

      // Notify
      try {
        await notifyBetPlaced({
          category: 'high_prob_bond',
          direction: cand.direction,
          outcomeLabel: cand.outcome_label,
          entryPrice: cand.price,
          amountUsd: betAmount,
          marketQuestion: cand.question,
          isPaper: true,
          edge: 0.05,
          confidence: 'HIGH',
        });
      } catch {
        // Notification failure is not fatal
      }
    } else {
      console.log(`[high-prob-bonds] Failed to place bond: ${result.error}`);
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[high-prob-bonds] Done in ${elapsed}ms. Placed ${placed} bonds, deployed $${totalDeployed.toFixed(0)}`);

  return { statusCode: 200 };
});

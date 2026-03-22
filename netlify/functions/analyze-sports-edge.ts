// ============================================================
// Netlify Scheduled Function: Analyze Sports Edge
// Runs every 30 minutes — uses sportsbook consensus vs Polymarket
// prices to identify mispricings. Claude provides contextual
// analysis for the strongest edges.
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_ANALYSES_PER_RUN = 3;
const MIN_EDGE_PCT = 0.02;

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

interface OddsRow {
  event_id: string;
  sport: string;
  league: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  sportsbook: string;
  market_type: string;
  outcome_name: string;
  price_decimal: number;
  implied_prob: number;
}

export const handler = schedule('*/30 * * * *', async () => {
  console.log('[analyze-sports] Starting sports edge analysis');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[analyze-sports] ANTHROPIC_API_KEY not set');
    return { statusCode: 500 };
  }

  // Get active sports markets from Polymarket
  const { data: sportsMarkets } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true)
    .eq('category', 'sports')
    .gt('liquidity_usd', 10000)
    .order('volume_usd', { ascending: false })
    .limit(50);

  if (!sportsMarkets || sportsMarkets.length === 0) {
    console.log('[analyze-sports] No active sports markets');
    return { statusCode: 200 };
  }

  // Get recent odds data (last 2 hours)
  const cutoff = new Date(Date.now() - 2 * 3600000).toISOString();
  const { data: recentOdds } = await supabase
    .from('sports_odds')
    .select('*')
    .gte('fetched_at', cutoff)
    .eq('market_type', 'h2h');

  if (!recentOdds || recentOdds.length === 0) {
    console.log('[analyze-sports] No recent odds data');
    return { statusCode: 200 };
  }

  // Group odds by event_id to calculate consensus
  const oddsByEvent = new Map<string, OddsRow[]>();
  for (const o of recentOdds) {
    const key = `${o.event_id}_${o.outcome_name}`;
    if (!oddsByEvent.has(key)) oddsByEvent.set(key, []);
    oddsByEvent.get(key)!.push(o);
  }

  // Build consensus implied probabilities per event/outcome
  const consensusByEvent = new Map<string, { home: number; away: number; homeTeam: string; awayTeam: string; league: string; sport: string; commence: string }>();

  for (const o of recentOdds) {
    if (!consensusByEvent.has(o.event_id)) {
      consensusByEvent.set(o.event_id, {
        home: 0,
        away: 0,
        homeTeam: o.home_team,
        awayTeam: o.away_team,
        league: o.league,
        sport: o.sport,
        commence: o.commence_time,
      });
    }
  }

  // Average implied prob across sportsbooks for each outcome
  for (const [eventId, info] of consensusByEvent.entries()) {
    const homeOdds = recentOdds.filter((o) => o.event_id === eventId && o.outcome_name === info.homeTeam);
    const awayOdds = recentOdds.filter((o) => o.event_id === eventId && o.outcome_name === info.awayTeam);

    if (homeOdds.length > 0) {
      info.home = homeOdds.reduce((s, o) => s + o.implied_prob, 0) / homeOdds.length;
    }
    if (awayOdds.length > 0) {
      info.away = awayOdds.reduce((s, o) => s + o.implied_prob, 0) / awayOdds.length;
    }
  }

  // Match Polymarket markets to sportsbook events and find edges
  const edgeCandidates: {
    market: MarketRow;
    consensus: { home: number; away: number; homeTeam: string; awayTeam: string; league: string; sport: string; commence: string };
    edge: number;
    direction: string;
  }[] = [];

  for (const market of sportsMarkets as MarketRow[]) {
    const q = market.question.toLowerCase();

    for (const [, info] of consensusByEvent.entries()) {
      const homeLC = info.homeTeam.toLowerCase();
      const awayLC = info.awayTeam.toLowerCase();

      if (q.includes(homeLC) || q.includes(awayLC)) {
        // Binary market: YES = first outcome wins
        if (market.outcome_prices.length >= 2) {
          const pmYes = market.outcome_prices[0];
          const pmNo = market.outcome_prices[1];

          // Compare to sportsbook consensus
          // Check if "Yes" maps to home team win or away team win
          const isHomeQ = q.includes(homeLC) && (q.includes('win') || q.includes('beat'));

          const sbProb = isHomeQ ? info.home : info.away;
          if (sbProb > 0) {
            const edgeYes = sbProb - pmYes;
            const edgeNo = (1 - sbProb) - pmNo;

            const bestEdge = Math.max(edgeYes, edgeNo);
            const bestDirection = edgeYes > edgeNo ? 'BUY_YES' : 'BUY_NO';

            if (bestEdge >= MIN_EDGE_PCT) {
              edgeCandidates.push({ market, consensus: info, edge: bestEdge, direction: bestDirection });
            }
          }
        }
        break;
      }
    }
  }

  // Sort by edge descending
  edgeCandidates.sort((a, b) => b.edge - a.edge);

  console.log(`[analyze-sports] Found ${edgeCandidates.length} edge candidates (>= ${MIN_EDGE_PCT * 100}%)`);

  // Run Claude analysis on top candidates
  let analyzed = 0;

  for (const candidate of edgeCandidates.slice(0, MAX_ANALYSES_PER_RUN)) {
    if (Date.now() - startTime > 20000) break;

    const { market, consensus } = candidate;
    const hoursToGame = Math.max(0, (new Date(consensus.commence).getTime() - Date.now()) / 3600000);

    if (hoursToGame < 1) continue; // Too close to game time

    // Get sportsbook breakdown
    const eventOdds = recentOdds.filter(
      (o) => o.home_team === consensus.homeTeam && o.away_team === consensus.awayTeam && o.market_type === 'h2h'
    );

    const sbBreakdown = eventOdds
      .map((o) => `${o.sportsbook}: ${o.outcome_name} ${o.implied_prob.toFixed(3)} (${o.price_decimal.toFixed(2)})`)
      .join('\n');

    const prompt = `You are ARBITER's sports analyst. Compare sportsbook consensus to Polymarket prices and identify mispricings.

MATCHUP: ${consensus.homeTeam} vs ${consensus.awayTeam}
LEAGUE: ${consensus.league}
GAME TIME: ${new Date(consensus.commence).toLocaleString()} (${Math.round(hoursToGame)}h from now)

SPORTSBOOK ODDS (implied probabilities):
${sbBreakdown}

SPORTSBOOK CONSENSUS:
- ${consensus.homeTeam} win: ${(consensus.home * 100).toFixed(1)}%
- ${consensus.awayTeam} win: ${(consensus.away * 100).toFixed(1)}%

POLYMARKET:
- Question: ${market.question}
- YES: $${market.outcome_prices[0]?.toFixed(3)}
- NO:  $${market.outcome_prices[1]?.toFixed(3)}
- Volume: $${market.volume_usd.toLocaleString()}
- Liquidity: $${market.liquidity_usd.toLocaleString()}

TASK:
1. Assess which side (YES/NO) offers an edge vs sportsbook consensus
2. Consider lineup news, injuries, rest days, travel, and any known factors
3. Calculate the true probability accounting for vig removal from sportsbook lines
4. Determine if the edge is real or if Polymarket is pricing in something sportsbooks aren't

Respond ONLY in JSON:
{
  "event_description": string,
  "sport": string,
  "sportsbook_consensus": number (0-1, vig-removed true prob for favored outcome),
  "polymarket_price": number (Polymarket price for same outcome),
  "edge": number (true_prob - polymarket_price),
  "direction": "BUY_YES"|"BUY_NO"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "kelly_fraction": number,
  "rec_bet_usd": number,
  "reasoning": string,
  "data_sources": string[] (sportsbooks used),
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
        console.error(`[analyze-sports] Claude API error: ${res.status}`);
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

        const p = analysis.sportsbook_consensus;
        const c = analysis.polymarket_price;
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

      // Store analysis
      await supabase.from('sports_analyses').insert({
        market_id: market.id,
        event_description: analysis.event_description || `${consensus.homeTeam} vs ${consensus.awayTeam}`,
        sport: analysis.sport || consensus.sport,
        sportsbook_consensus: analysis.sportsbook_consensus,
        polymarket_price: analysis.polymarket_price,
        edge: analysis.edge,
        direction: analysis.direction || 'PASS',
        confidence: analysis.confidence || 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: analysis.reasoning,
        data_sources: analysis.data_sources || [],
        auto_eligible: analysis.auto_eligible || false,
        flags: analysis.flags || [],
      });

      analyzed++;
      console.log(`[analyze-sports] Analyzed ${consensus.homeTeam} vs ${consensus.awayTeam}: edge=${analysis.edge?.toFixed(3)} dir=${analysis.direction}`);
    } catch (err) {
      console.error(`[analyze-sports] Analysis failed:`, err);
    }
  }

  console.log(`[analyze-sports] Done. Analyzed ${analyzed} matchups in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

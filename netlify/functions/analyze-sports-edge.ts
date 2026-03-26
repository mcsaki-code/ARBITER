// ============================================================
// Netlify Scheduled Function: Analyze Sports Edge v2
// Runs every 30 minutes — sportsbook consensus vs Polymarket
// FIXED: Edge normalization before DB insert
// FIXED: Team alias map + fuzzy matching (was only finding 1 market)
// FIXED: Increased MAX_ANALYSES_PER_RUN from 3 to 8
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_ANALYSES_PER_RUN = 8;   // was 3 — increased to find more bets
const MIN_EDGE_PCT = 0.02;

// ── Edge/Probability Normalization ────────────────────────
// Claude sometimes returns 84.9 instead of 0.849
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

// ── Team Name Alias Map ────────────────────────────────────
// Maps canonical team names (from sportsbooks) to Polymarket aliases.
// Polymarket often uses short names, nicknames, or city names.
const TEAM_ALIASES: Record<string, string[]> = {
  // NBA
  'los angeles lakers': ['lakers', 'la lakers', 'los angeles'],
  'golden state warriors': ['warriors', 'gsw', 'golden state'],
  'boston celtics': ['celtics', 'boston'],
  'miami heat': ['heat', 'miami'],
  'denver nuggets': ['nuggets', 'denver'],
  'new york knicks': ['knicks', 'ny knicks', 'new york'],
  'milwaukee bucks': ['bucks', 'milwaukee'],
  'phoenix suns': ['suns', 'phoenix'],
  'dallas mavericks': ['mavericks', 'mavs', 'dallas'],
  'oklahoma city thunder': ['thunder', 'okc', 'oklahoma'],
  'minnesota timberwolves': ['timberwolves', 'wolves', 'minnesota'],
  'cleveland cavaliers': ['cavaliers', 'cavs', 'cleveland'],
  'indiana pacers': ['pacers', 'indiana'],
  'new orleans pelicans': ['pelicans', 'new orleans'],
  'los angeles clippers': ['clippers', 'la clippers'],
  'philadelphia 76ers': ['76ers', 'sixers', 'philadelphia'],
  // NFL
  'kansas city chiefs': ['chiefs', 'kansas city'],
  'san francisco 49ers': ['49ers', 'niners', 'san francisco'],
  'philadelphia eagles': ['eagles', 'philadelphia'],
  'buffalo bills': ['bills', 'buffalo'],
  'dallas cowboys': ['cowboys', 'dallas'],
  'green bay packers': ['packers', 'green bay'],
  'baltimore ravens': ['ravens', 'baltimore'],
  'new england patriots': ['patriots', 'new england'],
  // MLB
  'new york yankees': ['yankees', 'ny yankees', 'new york'],
  'los angeles dodgers': ['dodgers', 'la dodgers', 'los angeles'],
  'houston astros': ['astros', 'houston'],
  'atlanta braves': ['braves', 'atlanta'],
  'new york mets': ['mets', 'ny mets'],
  'chicago cubs': ['cubs', 'chicago'],
  'boston red sox': ['red sox', 'boston'],
  // NHL
  'boston bruins': ['bruins', 'boston'],
  'toronto maple leafs': ['maple leafs', 'leafs', 'toronto'],
  'colorado avalanche': ['avalanche', 'colorado', 'avs'],
  'vegas golden knights': ['golden knights', 'vegas', 'knights'],
  'tampa bay lightning': ['lightning', 'tampa bay', 'tampa'],
  // Soccer (EPL)
  'manchester city': ['man city', 'mcfc', 'city'],
  'manchester united': ['man utd', 'man united', 'mufc', 'united'],
  'liverpool': ['liverpool', 'reds', 'lfc'],
  'arsenal': ['arsenal', 'gunners'],
  'chelsea': ['chelsea', 'blues'],
  'tottenham hotspur': ['spurs', 'tottenham', 'thfc'],
  'newcastle united': ['newcastle', 'magpies'],
  'aston villa': ['aston villa', 'villa'],
  // Soccer (La Liga / CL)
  'atletico madrid': ['atletico', 'atlético', 'atleti', 'at. madrid'],
  'real madrid': ['real madrid', 'madrid', 'los blancos'],
  'fc barcelona': ['barcelona', 'barca', 'fcb'],
  'inter milan': ['inter', 'inter milan', 'internazionale'],
  'ac milan': ['milan', 'ac milan'],
  'bayern munich': ['bayern', 'munich', 'fcb'],
  'psg': ['paris saint-germain', 'psg', 'paris sg'],
  'juventus': ['juventus', 'juve'],
  // MMA
  'conor mcgregor': ['mcgregor', 'conor'],
  'jon jones': ['jones', 'jon jones', 'bones'],
  'israel adesanya': ['adesanya', 'izzy'],
};

function teamsMatchQuestion(question: string, homeTeam: string, awayTeam: string): boolean {
  const q = question.toLowerCase();

  function checkTeam(team: string): boolean {
    const t = team.toLowerCase();
    if (q.includes(t)) return true;

    // Check aliases
    const aliases = TEAM_ALIASES[t] ?? [];
    if (aliases.some(a => q.includes(a))) return true;

    // Check last word (e.g., "Warriors" from "Golden State Warriors")
    const words = t.split(' ');
    const lastWord = words[words.length - 1];
    if (lastWord.length >= 4 && q.includes(lastWord)) return true;

    // Check first word (city name)
    const firstWord = words[0];
    if (firstWord.length >= 4 && q.includes(firstWord)) return true;

    return false;
  }

  return checkTeam(homeTeam) || checkTeam(awayTeam);
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
  console.log('[analyze-sports] Starting sports edge analysis v2');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[analyze-sports] ANTHROPIC_API_KEY not set');
    return { statusCode: 500 };
  }

  // Get active sports markets (top 100 by volume)
  const { data: sportsMarkets } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true)
    .eq('category', 'sports')
    .gt('liquidity_usd', 5000)
    .order('volume_usd', { ascending: false })
    .limit(100);

  if (!sportsMarkets?.length) {
    console.log('[analyze-sports] No active sports markets');
    return { statusCode: 200 };
  }

  // Get recent odds (last 4 hours — was 2h, increased for hourly ingest)
  const cutoff = new Date(Date.now() - 4 * 3600000).toISOString();
  const { data: recentOdds } = await supabase
    .from('sports_odds')
    .select('*')
    .gte('fetched_at', cutoff)
    .eq('market_type', 'h2h');

  const oddsRows = recentOdds ?? [];
  const hasOdds = oddsRows.length > 0;

  if (!hasOdds) {
    console.log('[analyze-sports] No recent sportsbook odds — running knowledge-only analysis on top markets');
  } else {
    console.log(`[analyze-sports] ${sportsMarkets.length} markets, ${oddsRows.length} odds rows`);
  }

  // ── KNOWLEDGE-ONLY PATH: analyze top markets when no sportsbook odds ──
  if (!hasOdds) {
    let analyzed = 0;
    const recentCutoff = new Date(Date.now() - 3 * 3600000).toISOString();

    for (const market of (sportsMarkets as MarketRow[]).slice(0, MAX_ANALYSES_PER_RUN)) {
      if (Date.now() - startTime > 22000) break;
      if (analyzed >= MAX_ANALYSES_PER_RUN) break;

      const hoursRemaining = market.resolution_date
        ? (new Date(market.resolution_date).getTime() - Date.now()) / 3600000 : 0;
      if (hoursRemaining < 2 || hoursRemaining > 168) continue;

      // Skip recently analyzed
      const { data: recent } = await supabase
        .from('sports_analyses').select('id')
        .eq('market_id', market.id).gte('analyzed_at', recentCutoff).limit(1);
      if (recent?.length) continue;

      const outcomesList = market.outcomes
        .map((o: string, i: number) => `${o}: $${market.outcome_prices[i]?.toFixed(3) ?? '?'}`)
        .join('\n');

      const prompt = `You are ARBITER's sports analyst. Assess whether the Polymarket price is mis-priced vs your best estimate.

MARKET: ${market.question}
OUTCOMES:
${outcomesList}
LIQUIDITY: $${market.liquidity_usd.toLocaleString()} | VOLUME: $${market.volume_usd.toLocaleString()}
RESOLVES: in ${Math.round(hoursRemaining)} hours

TASK:
1. Based on current team performance, standings, injuries, and recent news (use your training knowledge)
2. Estimate the true probability for each outcome
3. Compare to Polymarket prices — is there a genuine edge >= 5%?
4. Be conservative — only flag high-confidence edges
5. Set auto_eligible = true only if confidence HIGH/MEDIUM and edge >= 0.06

Respond ONLY in valid JSON:
{
  "event_description": string,
  "sport": string,
  "sportsbook_consensus": number (your estimated true prob for YES side),
  "polymarket_price": number,
  "edge": number,
  "direction": "BUY_YES"|"BUY_NO"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "kelly_fraction": number,
  "rec_bet_usd": number,
  "reasoning": string,
  "data_sources": ["claude_knowledge"],
  "auto_eligible": boolean,
  "flags": string[]
}`;

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) { console.error(`[analyze-sports] Claude error ${res.status}`); continue; }

        const data = await res.json();
        const text = data.content?.[0]?.text ?? '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        const analysis = JSON.parse(jsonMatch[0]);
        const edgeNorm = normalizeEdge(analysis.edge);
        const sbProbNorm = normalizeProb(analysis.sportsbook_consensus);
        const pmPriceNorm = normalizeProb(analysis.polymarket_price);

        let kellyFraction = 0, recBetUsd = 0;
        if (analysis.direction !== 'PASS' && edgeNorm !== null && edgeNorm >= MIN_EDGE_PCT) {
          const { data: configRows } = await supabase.from('system_config').select('key, value').in('key', ['paper_bankroll']);
          const bankroll = parseFloat(configRows?.find((r: { key: string }) => r.key === 'paper_bankroll')?.value ?? '500');
          const p = sbProbNorm ?? 0; const c = pmPriceNorm ?? 0;
          if (p > 0 && c > 0 && c < 1) {
            const b = (1 - c) / c;
            const fullKelly = (p * b - (1 - p)) / b;
            if (fullKelly > 0) {
              const confMult = analysis.confidence === 'HIGH' ? 0.8 : analysis.confidence === 'MEDIUM' ? 0.5 : 0.2;
              kellyFraction = Math.min(fullKelly * 0.125 * confMult, 0.03);
              recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
            }
          }
        }

        await supabase.from('sports_analyses').insert({
          market_id: market.id,
          event_description: analysis.event_description ?? market.question.substring(0, 100),
          sport: analysis.sport ?? 'sports',
          sportsbook_consensus: sbProbNorm,
          polymarket_price: pmPriceNorm,
          edge: edgeNorm,
          direction: analysis.direction ?? 'PASS',
          confidence: analysis.confidence ?? 'LOW',
          kelly_fraction: kellyFraction,
          rec_bet_usd: recBetUsd,
          reasoning: analysis.reasoning ?? null,
          data_sources: analysis.data_sources ?? ['claude_knowledge'],
          auto_eligible: analysis.auto_eligible ?? false,
          flags: analysis.flags ?? [],
        });

        analyzed++;
        console.log(`[analyze-sports] ✅ [knowledge] "${market.question.substring(0, 60)}": edge=${edgeNorm?.toFixed(3)} dir=${analysis.direction}`);
      } catch (err) {
        console.error('[analyze-sports] Knowledge analysis error:', err);
      }
    }

    console.log(`[analyze-sports] Knowledge-only mode: analyzed ${analyzed} markets in ${Date.now() - startTime}ms`);
    return { statusCode: 200 };
  }

  // Build consensus probabilities per event
  const consensusByEvent = new Map<string, {
    home: number; away: number; homeTeam: string; awayTeam: string;
    league: string; sport: string; commence: string; bookCount: number;
  }>();

  for (const o of oddsRows) {
    if (!consensusByEvent.has(o.event_id)) {
      consensusByEvent.set(o.event_id, {
        home: 0, away: 0,
        homeTeam: o.home_team,
        awayTeam: o.away_team,
        league: o.league,
        sport: o.sport,
        commence: o.commence_time,
        bookCount: 0,
      });
    }
  }

  // Average implied probs across sportsbooks per event
  for (const [eventId, info] of consensusByEvent) {
    const homeOdds = oddsRows.filter(o => o.event_id === eventId && o.outcome_name === info.homeTeam);
    const awayOdds = oddsRows.filter(o => o.event_id === eventId && o.outcome_name === info.awayTeam);
    if (homeOdds.length > 0) {
      info.home = homeOdds.reduce((s, o) => s + o.implied_prob, 0) / homeOdds.length;
      info.bookCount = homeOdds.length;
    }
    if (awayOdds.length > 0) {
      info.away = awayOdds.reduce((s, o) => s + o.implied_prob, 0) / awayOdds.length;
    }
  }

  // Match Polymarket markets to sportsbook events using improved matching
  const edgeCandidates: {
    market: MarketRow;
    consensus: { home: number; away: number; homeTeam: string; awayTeam: string; league: string; sport: string; commence: string; bookCount: number };
    edge: number;
    direction: string;
    sbProb: number;
    pmPrice: number;
  }[] = [];

  for (const market of sportsMarkets as MarketRow[]) {
    for (const [, info] of consensusByEvent) {
      if (!teamsMatchQuestion(market.question, info.homeTeam, info.awayTeam)) continue;
      if (market.outcome_prices.length < 2) continue;

      const pmYes = market.outcome_prices[0];
      const q = market.question.toLowerCase();

      // Determine if YES = home win or away win
      const homeLC = info.homeTeam.toLowerCase();
      const isHomeQuestion = q.includes(homeLC)
        || (TEAM_ALIASES[homeLC] ?? []).some(a => q.includes(a))
        || q.includes(homeLC.split(' ').pop() ?? '');

      const sbProb = isHomeQuestion ? info.home : info.away;
      if (sbProb <= 0 || sbProb >= 1) continue;

      const edgeYes = sbProb - pmYes;
      const edgeNo  = (1 - sbProb) - market.outcome_prices[1];
      const bestEdge = Math.max(edgeYes, edgeNo);
      const bestDir = edgeYes > edgeNo ? 'BUY_YES' : 'BUY_NO';
      const pmPrice = edgeYes > edgeNo ? pmYes : market.outcome_prices[1];

      if (bestEdge >= MIN_EDGE_PCT) {
        edgeCandidates.push({ market, consensus: info, edge: bestEdge, direction: bestDir, sbProb, pmPrice });
      }
      break;
    }
  }

  edgeCandidates.sort((a, b) => b.edge - a.edge);
  console.log(`[analyze-sports] ${edgeCandidates.length} edge candidates (>= ${MIN_EDGE_PCT * 100}%)`);

  let analyzed = 0;

  for (const candidate of edgeCandidates.slice(0, MAX_ANALYSES_PER_RUN)) {
    if (Date.now() - startTime > 22000) break;

    const { market, consensus } = candidate;
    const hoursToGame = Math.max(0, (new Date(consensus.commence).getTime() - Date.now()) / 3600000);
    if (hoursToGame < 1) continue;

    // Skip if already analyzed recently (last 2 hours) to avoid duplicate analyses
    const recentCutoff = new Date(Date.now() - 2 * 3600000).toISOString();
    const { data: recentAnalysis } = await supabase
      .from('sports_analyses')
      .select('id')
      .eq('market_id', market.id)
      .gte('analyzed_at', recentCutoff)
      .limit(1);

    if (recentAnalysis?.length) {
      console.log(`[analyze-sports] Skip ${market.id.substring(0, 8)} — analyzed recently`);
      continue;
    }

    const eventOdds = oddsRows.filter(
      o => o.home_team === consensus.homeTeam && o.away_team === consensus.awayTeam && o.market_type === 'h2h'
    );
    const sbBreakdown = eventOdds
      .map(o => `${o.sportsbook}: ${o.outcome_name} ${(o.implied_prob * 100).toFixed(1)}% (${o.price_decimal.toFixed(2)})`)
      .join('\n');

    const prompt = `You are ARBITER's sports analyst. Compare sportsbook consensus to Polymarket prices and identify genuine mispricings.

MATCHUP: ${consensus.homeTeam} vs ${consensus.awayTeam}
LEAGUE: ${consensus.league}
GAME TIME: ${new Date(consensus.commence).toLocaleString()} (${Math.round(hoursToGame)}h from now)

SPORTSBOOK CONSENSUS (vig-removed):
- ${consensus.homeTeam} win: ${(consensus.home * 100).toFixed(1)}%
- ${consensus.awayTeam} win: ${(consensus.away * 100).toFixed(1)}%
- Books contributing: ${consensus.bookCount}

SPORTSBOOK BREAKDOWN:
${sbBreakdown || 'No individual book breakdown available'}

POLYMARKET:
- Question: ${market.question}
- YES: $${market.outcome_prices[0]?.toFixed(3)}
- NO:  $${market.outcome_prices[1]?.toFixed(3)}
- Volume: $${market.volume_usd.toLocaleString()}
- Liquidity: $${market.liquidity_usd.toLocaleString()}
- Hours to resolution: ${Math.round(hoursToGame)}

DETECTED EDGE: ${(candidate.edge * 100).toFixed(1)}% on ${candidate.direction} side
Sportsbook true prob: ${(candidate.sbProb * 100).toFixed(1)}% | Polymarket price: $${candidate.pmPrice.toFixed(3)}

TASK:
1. Validate the detected edge — is the sportsbook consensus genuinely pricing this differently from Polymarket?
2. Consider any known factors: injuries, lineup news, rest/travel, home court, weather
3. Calculate the vig-removed true probability from sportsbook consensus
4. Flag if Polymarket is pricing in something sportsbooks aren't (or vice versa)
5. Set auto_eligible = true ONLY if: confidence HIGH or MEDIUM, edge >= 0.05, hours_to_game >= 2

Respond ONLY in valid JSON (no markdown, no explanation):
{
  "event_description": string,
  "sport": string,
  "sportsbook_consensus": number,
  "polymarket_price": number,
  "edge": number,
  "direction": "BUY_YES"|"BUY_NO"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "kelly_fraction": number,
  "rec_bet_usd": number,
  "reasoning": string,
  "data_sources": string[],
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
      const text = data.content?.[0]?.text ?? '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.warn('[analyze-sports] No JSON in Claude response'); continue; }

      const analysis = JSON.parse(jsonMatch[0]);

      // ── Normalize before storing (FIX for 849 bug) ──────────
      const edgeNorm   = normalizeEdge(analysis.edge);
      const sbProbNorm = normalizeProb(analysis.sportsbook_consensus);
      const pmPriceNorm = normalizeProb(analysis.polymarket_price);

      // Calculate Kelly bet size
      let kellyFraction = 0;
      let recBetUsd = 0;
      if (analysis.direction !== 'PASS' && edgeNorm !== null && edgeNorm >= MIN_EDGE_PCT) {
        const { data: configRows } = await supabase
          .from('system_config')
          .select('key, value')
          .in('key', ['paper_bankroll']);
        const bankroll = parseFloat(
          configRows?.find((r: { key: string }) => r.key === 'paper_bankroll')?.value ?? '500'
        );
        const p = sbProbNorm ?? 0;
        const c = pmPriceNorm ?? 0;
        if (p > 0 && c > 0 && c < 1) {
          const b = (1 - c) / c;
          const fullKelly = (p * b - (1 - p)) / b;
          if (fullKelly > 0) {
            const confMult = analysis.confidence === 'HIGH' ? 1.0 : analysis.confidence === 'MEDIUM' ? 0.6 : 0.2;
            kellyFraction = Math.min(fullKelly * 0.125 * confMult, 0.03, (market.liquidity_usd * 0.02) / bankroll);
            recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
          }
        }
      }

      await supabase.from('sports_analyses').insert({
        market_id: market.id,
        event_description: analysis.event_description || `${consensus.homeTeam} vs ${consensus.awayTeam}`,
        sport: analysis.sport || consensus.sport,
        sportsbook_consensus: sbProbNorm,
        polymarket_price: pmPriceNorm,
        edge: edgeNorm,
        direction: analysis.direction || 'PASS',
        confidence: analysis.confidence || 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: analysis.reasoning,
        data_sources: analysis.data_sources || ['pinnacle'],
        auto_eligible: analysis.auto_eligible || false,
        flags: analysis.flags || [],
      });

      analyzed++;
      console.log(`[analyze-sports] ✅ ${consensus.homeTeam} vs ${consensus.awayTeam}: edge=${edgeNorm?.toFixed(3)} dir=${analysis.direction} conf=${analysis.confidence}`);
    } catch (err) {
      console.error(`[analyze-sports] Analysis failed:`, err);
    }
  }

  console.log(`[analyze-sports] Done. Analyzed ${analyzed} matchups in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

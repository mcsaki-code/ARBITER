// ============================================================
// Netlify Scheduled Function: Ingest Sports Odds v2
// Runs every 60 minutes (was 10) to conserve API budget.
// PRIMARY:  Pinnacle public feed (free, no key, sharpest lines)
// FALLBACK: The Odds API (paid key, if ODDS_API_KEY is set)
//
// FIX: The Odds API free tier only allows 500 req/month.
// Every-10-min polling = 1,440/day — exhausted in 8 hours.
// New schedule (60 min) + Pinnacle first = no more budget burn.
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Pinnacle Public API ────────────────────────────────────
// No API key. No rate limits. Sharpest lines in the world.
// NOTE: Pinnacle shows closing lines — use as sharp consensus.
const PINNACLE_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';

// Known Pinnacle sport IDs (stable)
const PINNACLE_SPORTS: { id: number; name: string; league: string }[] = [
  { id: 487, name: 'basketball',       league: 'NBA' },
  { id: 889, name: 'football',         league: 'NFL' },
  { id: 3,   name: 'baseball',         league: 'MLB' },
  { id: 4,   name: 'hockey',           league: 'NHL' },
  { id: 29,  name: 'soccer',           league: 'Soccer' },
  { id: 12,  name: 'mma',              league: 'UFC/MMA' },
  { id: 33,  name: 'tennis',           league: 'Tennis' },
];

// ── The Odds API (fallback) ────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const BOOKMAKERS = 'draftkings,fanduel,betmgm,pinnacle';

// In-season sport filter
const TRACKED_ODDS_API: { sport: string; league: string }[] = [
  { sport: 'basketball_nba',          league: 'NBA' },
  { sport: 'basketball_ncaab',        league: 'NCAAB' },   // ← March Madness!
  { sport: 'baseball_mlb',            league: 'MLB' },
  { sport: 'icehockey_nhl',           league: 'NHL' },
  { sport: 'soccer_epl',              league: 'Premier League' },
  { sport: 'soccer_uefa_champs_league', league: 'Champions League' },
  { sport: 'mma_mixed_martial_arts',  league: 'UFC/MMA' },
];

// ── Shared helpers ─────────────────────────────────────────

async function fetchJson(url: string, timeoutMs = 10000): Promise<unknown> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[ingest-sports] HTTP ${res.status}: ${url.split('?')[0]}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[ingest-sports] Fetch error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// Pinnacle response types
interface PinnacleMatchup {
  id: number;
  league: { id: number; name: string };
  startTime: string;
  teams?: Array<{ id: number; name: string; type?: string }>; // type: 'home'|'away'
  sides?: Array<{
    label: string;  // 'home'|'away'
    odds?: Array<{ price: number; designation: string }>;
  }>;
  // Straight markets
  prices?: Array<{
    designation: string; // 'home','away','draw'
    price: number;       // American odds
    participantId?: number;
  }>;
}

interface PinnacleLeague {
  id: number;
  name: string;
}

// Convert American odds to decimal and implied probability
function americanToDecimal(american: number): number {
  if (american > 0) return (american / 100) + 1;
  return (100 / Math.abs(american)) + 1;
}

function decimalToImplied(decimal: number): number {
  return 1 / decimal;
}

// Remove vig from implied probs (Pinnacle is ~2.5% vig)
function removeVig(probs: number[]): number[] {
  const total = probs.reduce((a, b) => a + b, 0);
  return probs.map(p => p / total);
}

// ── Build odds rows array ──────────────────────────────────
type OddsRow = {
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
  point_spread: number | null;
};

async function fetchPinnacleOdds(startTime: number): Promise<OddsRow[]> {
  const rows: OddsRow[] = [];
  const now = new Date();
  const month = now.getMonth();

  // Filter to in-season sports
  const inSeason = PINNACLE_SPORTS.filter(s => {
    if (s.id === 487) return month >= 9 || month <= 5;   // NBA Oct-Jun
    if (s.id === 889) return month >= 8 || month <= 1;   // NFL Sep-Feb
    if (s.id === 3)   return month >= 2 && month <= 9;   // MLB Mar-Oct
    if (s.id === 4)   return month >= 9 || month <= 5;   // NHL Oct-Jun
    return true;
  });

  for (const sport of inSeason) {
    if (Date.now() - startTime > 18000) break;

    // Get leagues for this sport
    const leagues = await fetchJson(
      `${PINNACLE_BASE}/leagues?sportId=${sport.id}&hasOfferings=true&allowedOnly=true`
    ) as PinnacleLeague[] | null;

    if (!leagues?.length) continue;

    // Focus on top leagues (first 3 by default)
    const topLeagues = leagues.slice(0, 3);

    for (const league of topLeagues) {
      if (Date.now() - startTime > 18000) break;

      const matchups = await fetchJson(
        `${PINNACLE_BASE}/matchups?leagueIds=${league.id}&withSpecials=false&handicapType=asian`
      ) as PinnacleMatchup[] | null;

      if (!matchups?.length) continue;

      for (const matchup of matchups) {
        // Only upcoming games (next 7 days)
        const gameTime = new Date(matchup.startTime).getTime();
        if (gameTime < Date.now() || gameTime > Date.now() + 7 * 86400000) continue;

        const homeTeam = matchup.teams?.find(t => t.type === 'home')?.name ?? matchup.teams?.[0]?.name ?? 'Home';
        const awayTeam = matchup.teams?.find(t => t.type === 'away')?.name ?? matchup.teams?.[1]?.name ?? 'Away';

        // Extract moneyline prices
        const prices = matchup.prices ?? [];
        const homePrice = prices.find(p => p.designation === 'home');
        const awayPrice = prices.find(p => p.designation === 'away');

        if (!homePrice || !awayPrice) continue;

        const homeDecimal = americanToDecimal(homePrice.price);
        const awayDecimal = americanToDecimal(awayPrice.price);
        const [homeImplied, awayImplied] = removeVig([
          decimalToImplied(homeDecimal),
          decimalToImplied(awayDecimal),
        ]);

        const eventId = `pinnacle_${matchup.id}`;

        rows.push({
          event_id: eventId,
          sport: sport.name,
          league: league.name || sport.league,
          home_team: homeTeam,
          away_team: awayTeam,
          commence_time: matchup.startTime,
          sportsbook: 'pinnacle',
          market_type: 'h2h',
          outcome_name: homeTeam,
          price_decimal: homeDecimal,
          implied_prob: homeImplied,
          point_spread: null,
        });

        rows.push({
          event_id: eventId,
          sport: sport.name,
          league: league.name || sport.league,
          home_team: homeTeam,
          away_team: awayTeam,
          commence_time: matchup.startTime,
          sportsbook: 'pinnacle',
          market_type: 'h2h',
          outcome_name: awayTeam,
          price_decimal: awayDecimal,
          implied_prob: awayImplied,
          point_spread: null,
        });
      }
    }
  }

  return rows;
}

async function fetchOddsApiOdds(sport: string): Promise<OddsRow[]> {
  if (!ODDS_API_KEY) return [];

  const url = `${ODDS_API_BASE}/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=${BOOKMAKERS}&oddsFormat=decimal`;
  const res = await fetchJson(url) as Array<{
    id: string; sport_key: string; commence_time: string;
    home_team: string; away_team: string;
    bookmakers: Array<{
      key: string;
      markets: Array<{ key: string; outcomes: Array<{ name: string; price: number }> }>;
    }>;
  }> | null;

  if (!res?.length) return [];

  const rows: OddsRow[] = [];
  for (const event of res) {
    for (const bm of event.bookmakers) {
      for (const mkt of bm.markets) {
        for (const outcome of mkt.outcomes) {
          rows.push({
            event_id: event.id,
            sport: event.sport_key,
            league: event.sport_key.toUpperCase(),
            home_team: event.home_team,
            away_team: event.away_team,
            commence_time: event.commence_time,
            sportsbook: bm.key,
            market_type: mkt.key,
            outcome_name: outcome.name,
            price_decimal: outcome.price,
            implied_prob: 1 / outcome.price,
            point_spread: null,
          });
        }
      }
    }
  }
  return rows;
}

// ── Main handler ───────────────────────────────────────────

export const handler = schedule('0 * * * *', async () => {  // Every hour (was every 10 min)
  console.log('[ingest-sports] Starting sports odds ingestion v2');
  const startTime = Date.now();

  // ── Step 1: Fetch Polymarket sports markets ─────────────────
  const sportTagSlugs = ['sports', 'nba', 'nfl', 'mlb', 'nhl', 'ncaa', 'soccer', 'ufc', 'mma'];
  const tagFetches = sportTagSlugs.map(slug =>
    fetchJson(`https://gamma-api.polymarket.com/tags/slug/${slug}`)
      .then(t => (t as { id?: number } | null)?.id ?? null)
  );
  const tagIds = (await Promise.all(tagFetches)).filter((id): id is number => id !== null);
  const uniqueTagIds = [...new Set(tagIds)];

  const eventFetches = uniqueTagIds.map(id =>
    fetchJson(`https://gamma-api.polymarket.com/events?tag_id=${id}&active=true&closed=false&limit=100`)
  );
  const eventPages = await Promise.all(eventFetches);

  const polymarketSports: { conditionId: string; question: string; outcomePrices: string }[] = [];
  const seenIds = new Set<string>();

  for (const page of eventPages) {
    if (!Array.isArray(page)) continue;
    for (const event of page as Array<{ markets?: Array<{ conditionId: string; question: string; outcomePrices: string; active: boolean; closed: boolean }> }>) {
      for (const m of event.markets ?? []) {
        if (m.conditionId && !seenIds.has(m.conditionId) && m.active && !m.closed) {
          seenIds.add(m.conditionId);
          polymarketSports.push(m);
        }
      }
    }
  }

  console.log(`[ingest-sports] Found ${polymarketSports.length} Polymarket sports markets`);

  // Upsert Polymarket sports markets
  const sportMarketRows = polymarketSports.map(m => {
    let outcomes: string[];
    let outcomePrices: number[];
    try { outcomes = JSON.parse((m as any).outcomes); } catch { outcomes = []; }
    try { outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p)); } catch { outcomePrices = []; }
    return {
      condition_id: m.conditionId,
      question: m.question,
      category: 'sports',
      outcomes,
      outcome_prices: outcomePrices,
      volume_usd: parseFloat((m as any).volume) || 0,
      liquidity_usd: parseFloat((m as any).liquidity) || 0,
      resolution_date: (m as any).endDate,
      is_active: true,
      updated_at: new Date().toISOString(),
    };
  });

  if (sportMarketRows.length > 0) {
    const { error } = await supabase.from('markets').upsert(sportMarketRows, { onConflict: 'condition_id' });
    if (error) console.error('[ingest-sports] Markets upsert error:', error.message);
    else console.log(`[ingest-sports] Upserted ${sportMarketRows.length} sports markets`);
  }

  // ── Step 2: Fetch odds — Pinnacle + NCAA in parallel ──────────
  // CRITICAL: Run NCAA fetch in parallel with Pinnacle so it never gets
  // blocked by Pinnacle's many sequential HTTP calls. NCAA Tournament
  // ($6-7M markets) is the highest-value opportunity in March/April.
  const nowMonth = new Date().getMonth(); // 0-indexed
  const isTournamentSeason = nowMonth >= 2 && nowMonth <= 4; // Mar-May
  const shouldFetchNcaa = !!ODDS_API_KEY && isTournamentSeason;

  console.log('[ingest-sports] Fetching Pinnacle + NCAA odds in parallel...');
  const [pinnacleRows, ncaaRows] = await Promise.all([
    fetchPinnacleOdds(startTime),
    shouldFetchNcaa ? fetchOddsApiOdds('basketball_ncaab') : Promise.resolve([]),
  ]);

  console.log(`[ingest-sports] Pinnacle returned ${pinnacleRows.length} odds rows`);
  if (shouldFetchNcaa) console.log(`[ingest-sports] NCAA returned ${ncaaRows.length} odds rows`);

  let allOddsRows: OddsRow[] = [...pinnacleRows, ...ncaaRows];

  // If Pinnacle returned nothing (API changed?), fall back to The Odds API for other sports
  if (pinnacleRows.length === 0 && ODDS_API_KEY) {
    console.log('[ingest-sports] Pinnacle returned 0 rows — falling back to The Odds API');
    const now = new Date();
    const month = now.getMonth();
    const inSeasonSports = TRACKED_ODDS_API.filter(s => {
      if (s.sport.includes('ncaab')) return false; // already fetched above
      if (s.sport.includes('nba')) return month >= 9 || month <= 5;
      if (s.sport.includes('mlb')) return month >= 2 && month <= 9;
      if (s.sport.includes('nhl')) return month >= 9 || month <= 5;
      if (s.sport.includes('nfl')) return month >= 8 || month <= 1;
      return true;
    });

    for (const s of inSeasonSports.slice(0, 3)) { // Max 3 to conserve quota
      if (Date.now() - startTime > 20000) break;
      const rows = await fetchOddsApiOdds(s.sport);
      allOddsRows.push(...rows);
    }
    console.log(`[ingest-sports] Odds API fallback returned ${allOddsRows.length} rows`);
  }

  // ── Step 3: Insert odds to DB ───────────────────────────────
  if (allOddsRows.length > 0) {
    const chunkSize = 500;
    let inserted = 0;
    for (let i = 0; i < allOddsRows.length; i += chunkSize) {
      const chunk = allOddsRows.slice(i, i + chunkSize);
      const { error } = await supabase.from('sports_odds').insert(chunk);
      if (!error) inserted += chunk.length;
      else console.error(`[ingest-sports] Insert error chunk ${i}:`, error.message);
    }
    console.log(`[ingest-sports] Inserted ${inserted} odds rows`);
  } else {
    console.warn('[ingest-sports] No odds data from any source — check Pinnacle API and ODDS_API_KEY');
  }

  // ── Step 4: Quick edge scan (log only) ─────────────────────
  if (polymarketSports.length > 0 && allOddsRows.length > 0) {
    let edgesFound = 0;
    for (const pm of polymarketSports.slice(0, 50)) {
      const q = pm.question.toLowerCase();
      for (const o of allOddsRows) {
        if (o.market_type !== 'h2h') continue;
        if (q.includes(o.home_team.toLowerCase()) || q.includes(o.away_team.toLowerCase())) {
          let pmPrices: number[];
          try { pmPrices = JSON.parse(pm.outcomePrices).map((p: string) => parseFloat(p)); } catch { continue; }
          if (pmPrices.length < 2) continue;
          const edge = Math.abs(pmPrices[0] - o.implied_prob);
          if (edge >= 0.05) edgesFound++;
          break;
        }
      }
    }
    console.log(`[ingest-sports] Quick scan found ${edgesFound} potential edge opportunities (>= 5%)`);
  }

  // ── Cleanup old odds ────────────────────────────────────────
  await supabase
    .from('sports_odds')
    .delete()
    .lt('fetched_at', new Date(Date.now() - 86400000).toISOString());

  console.log(`[ingest-sports] Done in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});

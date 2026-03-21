// ============================================================
// Netlify Scheduled Function: Ingest Sports Odds
// Runs every 10 minutes — pulls odds from The Odds API and
// cross-references with Polymarket sports markets
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// The Odds API — free tier: 500 requests/month
// Set your API key in Netlify env vars as ODDS_API_KEY
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// Sports we track (mapped to The Odds API sport keys)
const TRACKED_SPORTS = [
  'basketball_nba',
  'basketball_ncaab',
  'americanfootball_nfl',
  'americanfootball_ncaaf',
  'baseball_mlb',
  'icehockey_nhl',
  'mma_mixed_martial_arts',
  'soccer_epl',
  'soccer_uefa_champs_league',
  'tennis_atp_french_open', // rotates by tournament
];

// Sportsbook sources to pull (best coverage + most liquid)
const BOOKMAKERS = 'draftkings,fanduel,betmgm,bovada,pointsbet';

// Map Odds API sport keys to display league names
const LEAGUE_MAP: Record<string, string> = {
  basketball_nba: 'NBA',
  basketball_ncaab: 'NCAA Basketball',
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAA Football',
  baseball_mlb: 'MLB',
  icehockey_nhl: 'NHL',
  mma_mixed_martial_arts: 'UFC/MMA',
  soccer_epl: 'Premier League',
  soccer_uefa_champs_league: 'Champions League',
  tennis_atp_french_open: 'Tennis ATP',
};

interface OddsOutcome {
  name: string;
  price: number; // decimal odds
  point?: number; // spread/total point
}

interface OddsBookmaker {
  key: string;
  title: string;
  markets: {
    key: string; // 'h2h', 'spreads', 'totals'
    outcomes: OddsOutcome[];
  }[];
}

interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

async function fetchOdds(sport: string): Promise<OddsEvent[]> {
  if (!ODDS_API_KEY) {
    console.log('[ingest-sports] No ODDS_API_KEY set, skipping');
    return [];
  }

  try {
    const url = `${ODDS_API_BASE}/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&bookmakers=${BOOKMAKERS}&oddsFormat=decimal`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) {
      console.log(`[ingest-sports] ${sport}: HTTP ${res.status}`);
      return [];
    }

    // Log remaining API requests
    const remaining = res.headers.get('x-requests-remaining');
    if (remaining) {
      console.log(`[ingest-sports] API requests remaining: ${remaining}`);
    }

    return await res.json();
  } catch (err) {
    console.error(`[ingest-sports] Fetch error for ${sport}:`, err);
    return [];
  }
}

async function fetchGamma(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

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

interface GammaEvent {
  id: string;
  title: string;
  markets: GammaMarket[];
}

export const handler = schedule('*/10 * * * *', async () => {
  console.log('[ingest-sports] Starting sports odds ingestion');
  const startTime = Date.now();

  if (!ODDS_API_KEY) {
    console.log('[ingest-sports] ODDS_API_KEY not configured — set it in Netlify env vars');
    console.log('[ingest-sports] Get a free key at https://the-odds-api.com/');
    return { statusCode: 200 };
  }

  // Step 1: Fetch Polymarket sports markets for cross-referencing
  const sportTagSlugs = ['sports', 'nba', 'nfl', 'mlb', 'nhl', 'ncaa', 'soccer', 'ufc'];
  const polymarketSports: GammaMarket[] = [];
  const seenIds = new Set<string>();

  for (const slug of sportTagSlugs) {
    if (Date.now() - startTime > 10000) break;
    const tag = await fetchGamma(
      `https://gamma-api.polymarket.com/tags/slug/${slug}`
    ) as { id?: number } | null;

    if (tag?.id) {
      const events = await fetchGamma(
        `https://gamma-api.polymarket.com/events?tag_id=${tag.id}&active=true&closed=false&limit=100`
      );
      if (Array.isArray(events)) {
        for (const event of events as GammaEvent[]) {
          if (event.markets) {
            for (const m of event.markets) {
              if (m.conditionId && !seenIds.has(m.conditionId)) {
                seenIds.add(m.conditionId);
                polymarketSports.push(m);
              }
            }
          }
        }
      }
    }
  }

  console.log(`[ingest-sports] Found ${polymarketSports.length} Polymarket sports markets`);

  // Step 2: Upsert Polymarket sports markets into the markets table
  // (same as refresh-markets does for weather, but for sports)
  const sportMarketRows = polymarketSports.map((m) => {
    let outcomes: string[];
    let outcomePrices: number[];
    try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = m.outcomes?.split(',').map(s => s.trim()) || []; }
    try { outcomePrices = JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p)); } catch { outcomePrices = []; }

    return {
      condition_id: m.conditionId,
      question: m.question,
      category: 'sports',
      outcomes,
      outcome_prices: outcomePrices,
      volume_usd: parseFloat(m.volume) || 0,
      liquidity_usd: parseFloat(m.liquidity) || 0,
      resolution_date: m.endDate,
      is_active: m.active && !m.closed,
      updated_at: new Date().toISOString(),
    };
  });

  if (sportMarketRows.length > 0) {
    const { error } = await supabase
      .from('markets')
      .upsert(sportMarketRows, { onConflict: 'condition_id' });
    if (error) console.error('[ingest-sports] Markets upsert error:', error.message);
    else console.log(`[ingest-sports] Upserted ${sportMarketRows.length} sports markets`);
  }

  // Step 3: Fetch sportsbook odds for active sports
  // Only fetch sports that are currently in season to conserve API budget
  const now = new Date();
  const month = now.getMonth(); // 0=Jan

  // Filter to in-season sports
  const inSeasonSports = TRACKED_SPORTS.filter((sport) => {
    // NBA: Oct-Jun, NCAA BB: Nov-Apr, NFL: Sep-Feb, NCAA FB: Aug-Jan
    // MLB: Mar-Oct, NHL: Oct-Jun, UFC: year-round, Soccer: year-round
    if (sport.includes('nba')) return month >= 9 || month <= 5;
    if (sport.includes('ncaab')) return month >= 10 || month <= 3;
    if (sport.includes('nfl')) return month >= 8 || month <= 1;
    if (sport.includes('ncaaf')) return month >= 7 || month <= 0;
    if (sport.includes('mlb')) return month >= 2 && month <= 9;
    if (sport.includes('nhl')) return month >= 9 || month <= 5;
    return true; // UFC, soccer = year-round
  });

  console.log(`[ingest-sports] Fetching odds for ${inSeasonSports.length} in-season sports`);

  const allOddsRows: {
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
  }[] = [];

  for (const sport of inSeasonSports) {
    if (Date.now() - startTime > 20000) break;

    const events = await fetchOdds(sport);
    const league = LEAGUE_MAP[sport] || sport;

    for (const event of events) {
      for (const bm of event.bookmakers) {
        for (const mkt of bm.markets) {
          for (const outcome of mkt.outcomes) {
            allOddsRows.push({
              event_id: event.id,
              sport,
              league,
              home_team: event.home_team,
              away_team: event.away_team,
              commence_time: event.commence_time,
              sportsbook: bm.key,
              market_type: mkt.key,
              outcome_name: outcome.name,
              price_decimal: outcome.price,
              implied_prob: 1 / outcome.price,
              point_spread: outcome.point ?? null,
            });
          }
        }
      }
    }
  }

  console.log(`[ingest-sports] Collected ${allOddsRows.length} odds data points`);

  // Step 4: Batch upsert sports odds
  if (allOddsRows.length > 0) {
    // Insert in chunks of 500 to avoid payload limits
    const chunkSize = 500;
    let inserted = 0;

    for (let i = 0; i < allOddsRows.length; i += chunkSize) {
      const chunk = allOddsRows.slice(i, i + chunkSize);
      const { error } = await supabase.from('sports_odds').insert(chunk);
      if (error) {
        console.error(`[ingest-sports] Insert error (chunk ${i}):`, error.message);
      } else {
        inserted += chunk.length;
      }
    }

    console.log(`[ingest-sports] Inserted ${inserted} odds rows`);
  }

  // Step 5: Identify cross-platform edge opportunities
  // Compare sportsbook consensus to Polymarket prices
  if (polymarketSports.length > 0 && allOddsRows.length > 0) {
    let edgesFound = 0;

    for (const pm of polymarketSports) {
      const q = pm.question.toLowerCase();

      // Try to match Polymarket market to sportsbook event by team names
      for (const oddsEvent of allOddsRows) {
        const homeLC = oddsEvent.home_team.toLowerCase();
        const awayLC = oddsEvent.away_team.toLowerCase();

        if (q.includes(homeLC) || q.includes(awayLC)) {
          // Found a match! Compare implied probabilities
          let pmPrices: number[];
          try { pmPrices = JSON.parse(pm.outcomePrices).map((p: string) => parseFloat(p)); }
          catch { continue; }

          if (pmPrices.length >= 2 && oddsEvent.market_type === 'h2h') {
            const pmYes = pmPrices[0];
            const sbImplied = oddsEvent.implied_prob;
            const edge = Math.abs(pmYes - sbImplied);

            if (edge >= 0.05) { // 5% edge
              edgesFound++;
              console.log(`[ingest-sports] EDGE: ${oddsEvent.home_team} vs ${oddsEvent.away_team} | PM=${pmYes.toFixed(2)} SB=${sbImplied.toFixed(2)} | Edge=${(edge*100).toFixed(1)}%`);
            }
          }
          break; // Only match once per Polymarket market
        }
      }
    }

    console.log(`[ingest-sports] Found ${edgesFound} sports edge opportunities (>= 5%)`);
  }

  // Cleanup: delete odds older than 24h to prevent table bloat
  await supabase
    .from('sports_odds')
    .delete()
    .lt('fetched_at', new Date(Date.now() - 86400000).toISOString());

  const elapsed = Date.now() - startTime;
  console.log(`[ingest-sports] Done in ${elapsed}ms`);

  return { statusCode: 200 };
});

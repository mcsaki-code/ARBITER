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
  // NBA — full roster with standard abbreviations
  'los angeles lakers': ['lakers', 'la lakers', 'los angeles', 'lal'],
  'golden state warriors': ['warriors', 'gsw', 'golden state'],
  'boston celtics': ['celtics', 'boston', 'bos'],
  'miami heat': ['heat', 'miami', 'mia'],
  'denver nuggets': ['nuggets', 'denver', 'den'],
  'new york knicks': ['knicks', 'ny knicks', 'new york', 'nyk'],
  'milwaukee bucks': ['bucks', 'milwaukee', 'mil'],
  'phoenix suns': ['suns', 'phoenix', 'phx'],
  'dallas mavericks': ['mavericks', 'mavs', 'dallas', 'dal'],
  'oklahoma city thunder': ['thunder', 'okc', 'oklahoma'],
  'minnesota timberwolves': ['timberwolves', 'wolves', 'minnesota', 'min'],
  'cleveland cavaliers': ['cavaliers', 'cavs', 'cleveland', 'cle'],
  'indiana pacers': ['pacers', 'indiana', 'ind'],
  'new orleans pelicans': ['pelicans', 'new orleans', 'nop'],
  'los angeles clippers': ['clippers', 'la clippers', 'lac'],
  'philadelphia 76ers': ['76ers', 'sixers', 'philadelphia', 'phi', 'philly'],
  'atlanta hawks': ['hawks', 'atlanta', 'atl'],
  'chicago bulls': ['bulls', 'chicago', 'chi'],
  'sacramento kings': ['kings', 'sacramento', 'sac'],
  'portland trail blazers': ['trail blazers', 'blazers', 'portland', 'por'],
  'toronto raptors': ['raptors', 'toronto', 'tor'],
  'memphis grizzlies': ['grizzlies', 'memphis', 'mem'],
  'san antonio spurs': ['spurs', 'san antonio', 'sas'],
  'orlando magic': ['magic', 'orlando', 'orl'],
  'charlotte hornets': ['hornets', 'charlotte', 'cha'],
  'detroit pistons': ['pistons', 'detroit', 'det'],
  'washington wizards': ['wizards', 'washington', 'wsh'],
  'brooklyn nets': ['nets', 'brooklyn', 'bkn'],
  'utah jazz': ['jazz', 'utah', 'uta'],
  'houston rockets': ['rockets', 'houston', 'hou'],
  // NFL — expanded with abbreviations
  'kansas city chiefs': ['chiefs', 'kansas city', 'kc'],
  'san francisco 49ers': ['49ers', 'niners', 'san francisco', 'sf'],
  'philadelphia eagles': ['eagles', 'philadelphia', 'phi', 'philly'],
  'buffalo bills': ['bills', 'buffalo', 'buf'],
  'dallas cowboys': ['cowboys', 'dallas', 'dal'],
  'green bay packers': ['packers', 'green bay', 'gb'],
  'baltimore ravens': ['ravens', 'baltimore', 'bal'],
  'new england patriots': ['patriots', 'new england', 'ne'],
  'detroit lions': ['lions', 'detroit', 'det'],
  'seattle seahawks': ['seahawks', 'seattle', 'sea'],
  'minnesota vikings': ['vikings', 'minnesota', 'min'],
  'cincinnati bengals': ['bengals', 'cincinnati', 'cin'],
  'jacksonville jaguars': ['jaguars', 'jags', 'jacksonville', 'jax'],
  'miami dolphins': ['dolphins', 'miami', 'mia'],
  'pittsburgh steelers': ['steelers', 'pittsburgh', 'pit'],
  'chicago bears': ['bears', 'chicago', 'chi'],
  'los angeles rams': ['rams', 'la rams', 'lar'],
  'los angeles chargers': ['chargers', 'la chargers', 'lac'],
  // MLB — expanded
  'new york yankees': ['yankees', 'ny yankees', 'new york', 'nyy'],
  'los angeles dodgers': ['dodgers', 'la dodgers', 'los angeles', 'lad'],
  'houston astros': ['astros', 'houston', 'hou'],
  'atlanta braves': ['braves', 'atlanta', 'atl'],
  'new york mets': ['mets', 'ny mets', 'nym'],
  'chicago cubs': ['cubs', 'chicago', 'chc'],
  'boston red sox': ['red sox', 'boston', 'bos'],
  'chicago white sox': ['white sox', 'chisox', 'cws'],
  'san francisco giants': ['giants', 'sf giants', 'sf'],
  'san diego padres': ['padres', 'san diego', 'sd'],
  'philadelphia phillies': ['phillies', 'philadelphia', 'phi'],
  'texas rangers': ['rangers', 'texas', 'tex'],
  'seattle mariners': ['mariners', 'seattle', 'sea'],
  'toronto blue jays': ['blue jays', 'jays', 'toronto', 'tor'],
  'baltimore orioles': ['orioles', 'baltimore', 'bal'],
  'st. louis cardinals': ['cardinals', 'cards', 'st. louis', 'stl'],
  'detroit tigers': ['tigers', 'detroit', 'det'],
  'minnesota twins': ['twins', 'minnesota', 'min'],
  // NHL — expanded
  'boston bruins': ['bruins', 'boston', 'bos'],
  'toronto maple leafs': ['maple leafs', 'leafs', 'toronto', 'tor'],
  'colorado avalanche': ['avalanche', 'colorado', 'avs', 'col'],
  'vegas golden knights': ['golden knights', 'vegas', 'knights', 'vgk'],
  'tampa bay lightning': ['lightning', 'tampa bay', 'tampa', 'tbl'],
  'carolina hurricanes': ['hurricanes', 'canes', 'carolina', 'car'],
  'edmonton oilers': ['oilers', 'edmonton', 'edm'],
  'florida panthers': ['panthers', 'florida', 'fla'],
  'new york rangers': ['rangers', 'ny rangers', 'nyr'],
  'new york islanders': ['islanders', 'isles', 'nyi'],
  'dallas stars': ['stars', 'dallas', 'dal'],
  'winnipeg jets': ['jets', 'winnipeg', 'wpg'],
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
  // NCAA Basketball (March Madness — common tournament programs)
  'connecticut huskies': ['connecticut', 'uconn', 'huskies'],
  'michigan state spartans': ['michigan state', 'spartans', 'msu'],
  'alabama crimson tide': ['alabama', 'crimson tide', 'bama'],
  'michigan wolverines': ['michigan wolverines', 'wolverines'],
  'duke blue devils': ['duke', 'blue devils'],
  'kentucky wildcats': ['kentucky', 'wildcats', 'uk cats'],
  'kansas jayhawks': ['kansas', 'jayhawks', 'ku'],
  'north carolina tar heels': ['north carolina', 'unc', 'tar heels'],
  'gonzaga bulldogs': ['gonzaga', 'bulldogs', 'zags'],
  'houston cougars': ['houston cougars', 'cougars', 'uh'],
  'purdue boilermakers': ['purdue', 'boilermakers'],
  'tennessee volunteers': ['tennessee', 'vols', 'volunteers'],
  'arizona wildcats': ['arizona wildcats', 'arizona', 'wildcats'],
  'baylor bears': ['baylor', 'bears'],
  'florida gators': ['florida', 'gators', 'uf'],
  'illinois fighting illini': ['illinois', 'illini', 'fighting illini'],
  'iowa state cyclones': ['iowa state', 'cyclones'],
  'auburn tigers': ['auburn', 'tigers'],
  'creighton bluejays': ['creighton', 'bluejays'],
  'marquette golden eagles': ['marquette', 'golden eagles'],
  'st. johns red storm': ["st. john's", 'st. johns', 'red storm'],
  'texas longhorns': ['texas', 'longhorns', 'ut'],
  'arkansas razorbacks': ['arkansas', 'razorbacks', 'hogs'],
  'villanova wildcats': ['villanova', 'nova', 'wildcats'],
  'indiana hoosiers': ['indiana', 'hoosiers', 'iu'],
  'ucla bruins': ['ucla', 'bruins'],
  'oregon ducks': ['oregon', 'ducks'],
  'iowa hawkeyes': ['iowa', 'hawkeyes'],
};

// ── Sport Name Normalizer ──────────────────────────────────
// Claude returns inconsistent sport strings ("Soccer", "BASKETBALL_NBA",
// "BASEBALL_MLB", "MIXED_SPORTS_ERROR"). Normalize to clean lowercase slugs.
function normalizeSport(raw: string | null | undefined, fallback?: string): string {
  const s = (raw ?? fallback ?? 'sports').toLowerCase().trim();
  if (s.includes('basketball') || s === 'nba')  return 'basketball';
  if (s.includes('baseball')   || s === 'mlb')  return 'baseball';
  if (s.includes('football')   || s === 'nfl')  return 'football';
  if (s.includes('hockey')     || s === 'nhl')  return 'hockey';
  if (s.includes('soccer') || s.includes('mls') || s.includes('epl')
    || s.includes('la liga') || s.includes('bundesliga') || s.includes('serie a')
    || s.includes('ligue 1') || s.includes('champions league')) return 'soccer';
  if (s.includes('mma') || s.includes('ufc'))   return 'mma';
  if (s.includes('tennis'))  return 'tennis';
  if (s.includes('golf'))    return 'golf';
  if (s.includes('cricket')) return 'cricket';
  // Catch-all for ERROR/MISMATCH codes — log and default to sports
  if (s.includes('error') || s.includes('mismatch') || s.includes('mixed')) return 'sports';
  return 'sports';
}

// ── Futures Market Detector ────────────────────────────────
// Season-long and futures markets share team names with tonight's games
// but are fundamentally different. Skip them in game-level matching.
const FUTURES_PATTERNS = [
  /win the .*(championship|title|cup|series|league|trophy|pennant|super bowl|stanley cup|world series)/i,
  /make the .*(playoffs|finals|postseason)/i,
  /finish .*(season|year|campaign)/i,
  /(season|year).*(champion|winner|mvp|award)/i,
  // Tightened: require "win the <league>" NOT just "win ... <league>" which matches game-level
  /win the (?:20\d{2}[-–]?\d{0,2}\s+)?(?:nba|nfl|mlb|nhl|ncaa|champions league|premier league|la liga|bundesliga|serie a|ligue 1)/i,
  /qualified? for .*(world cup|olympics|tournament)/i,
  /(?:2025[-–]26|2026[-–]27|2026|2027) .*(winner|champion|title)/i,
  // "will X win the" is futures UNLESS followed by game-level context
  /will .+(?:win|claim) the (?!next game|tonight|today|this week|game against)/i,
];

function isFuturesMarket(question: string): boolean {
  return FUTURES_PATTERNS.some(p => p.test(question));
}

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

  // Get active sports markets with 2+ hours remaining (top 100 by volume)
  const minSportsResolutionDate = new Date(Date.now() + 2 * 3600000).toISOString();
  const { data: sportsMarkets } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true)
    .eq('category', 'sports')
    .gt('liquidity_usd', 5000)
    .gt('resolution_date', minSportsResolutionDate)
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
    // Knowledge-only mode disabled: Claude's training data is 10+ months stale for sports.
    // Every run was producing phantom edges of 60-90% (hallucinated) with confidence:LOW,
    // wasting API quota and filling the DB with noise. Sportsbook-odds path only.
    console.log('[analyze-sports] No recent sportsbook odds — skipping (knowledge-only disabled due to stale data)');
    return { statusCode: 200 };
  } else {
    console.log(`[analyze-sports] ${sportsMarkets.length} markets, ${oddsRows.length} odds rows`);
  }

  // ── KNOWLEDGE-ONLY PATH: DISABLED (kept for reference, unreachable) ──
  if (false && !hasOdds) {
    let analyzed = 0;
    const recentCutoff = new Date(Date.now() - 3 * 3600000).toISOString();

    // Iterate the full 100-market pool — futures/long-horizon markets are filtered inside
    // the loop. The old slice(0, 8) was exhausting all 8 items on futures markets
    // (e.g. NBA Finals, World Cup) and producing 0 game analyses every run.
    for (const market of (sportsMarkets as MarketRow[])) {
      if (Date.now() - startTime > 22000) break;
      if (analyzed >= MAX_ANALYSES_PER_RUN) break;

      // Skip futures/season-long markets — Claude's knowledge is ~10 months stale,
      // completely unreliable for season-long predictions (standings, injuries, trades)
      if (isFuturesMarket(market.question)) {
        console.log(`[analyze-sports] SKIP futures: "${market.question.substring(0, 60)}"`);
        continue;
      }

      // Treat null resolution_date as Infinity → hoursRemaining > 72 → skipped
      const hoursRemaining = market.resolution_date
        ? (new Date(market.resolution_date as string).getTime() - Date.now()) / 3600000
        : Infinity;
      // Tightened from 168h to 72h: knowledge-only mode only analyzes near-term game markets
      // (season-long futures require current standings knowledge we don't have)
      if (hoursRemaining < 2 || hoursRemaining > 72) continue;

      // Skip recently analyzed
      const { data: recent } = await supabase
        .from('sports_analyses').select('id')
        .eq('market_id', market.id).gte('analyzed_at', recentCutoff).limit(1);
      if (recent?.length) continue;

      const outcomesList = market.outcomes
        .map((o: string, i: number) => `${o}: $${market.outcome_prices[i]?.toFixed(3) ?? '?'}`)
        .join('\n');

      const prompt = `You are ARBITER's sports analyst. Assess whether the Polymarket price is mis-priced vs your best estimate.

⚠️  IMPORTANT CALIBRATION WARNING: Your training data has a knowledge cutoff of ~May 2025. The current date is approximately ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}. This means your knowledge is approximately 10+ months out of date. You do NOT know:
- Current standings, records, or recent form
- Trade deadline moves that occurred after May 2025
- Current injuries or lineup news
- Recent head-to-head results
- The current state of this team's season

Because of this knowledge gap, you MUST be extremely conservative. Only flag edges where you have HIGH confidence based on structural/historical factors that don't change quickly (e.g., a historically dominant favorite priced as an underdog). Set auto_eligible = false unless confidence is HIGH and the structural case is very clear.

MARKET: ${market.question}
OUTCOMES:
${outcomesList}
LIQUIDITY: $${market.liquidity_usd.toLocaleString()} | VOLUME: $${market.volume_usd.toLocaleString()}
RESOLVES: in ${Math.round(hoursRemaining)} hours

TASK:
1. With the caveat that your knowledge is ~10 months stale, estimate the true probability for each outcome
2. Compare to Polymarket prices — is there a genuine structural edge >= 8%? (higher threshold than normal due to knowledge staleness)
3. Be very conservative — only flag edges you would bet on even accounting for the knowledge gap
4. Set auto_eligible = true ONLY if: confidence HIGH, edge >= 0.10, AND you can clearly explain why this is a structural advantage NOT dependent on recent form/standings
5. Add "KNOWLEDGE_STALE_MAY_2025" to flags always

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
  "reasoning": string (must acknowledge knowledge staleness),
  "data_sources": ["claude_knowledge_stale_may2025"],
  "auto_eligible": boolean,
  "flags": string[]
}`;

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) { console.error(`[analyze-sports] Claude error ${res.status}`); continue; }

        const data = await res.json();
        const text = data.content?.[0]?.text ?? '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        let analysis: any;
        try {
          analysis = JSON.parse(jsonMatch[0]);
        } catch {
          console.error(`[analyze-sports] JSON parse error for market ${market.id}`);
          continue;
        }

        // Runtime validation — reject bad Claude responses at the boundary
        const { validateSportsAnalysis } = await import('../../src/lib/validate-analysis');
        const validation = validateSportsAnalysis(analysis);
        if (!validation.valid) {
          console.error(`[analyze-sports] VALIDATION FAILED for ${market.id}:`, (validation as any).errors.join('; '));
          continue;
        }

        // Use validated + normalized values
        const edgeNorm = (validation as any).data.edge;
        const sbProbNorm = (validation as any).data.sportsbook_consensus;
        const pmPriceNorm = (validation as any).data.polymarket_price;
        analysis.direction = (validation as any).data.direction;
        analysis.confidence = (validation as any).data.confidence;

        let kellyFraction = 0, recBetUsd = 0;
        if (analysis.direction !== 'PASS' && edgeNorm !== null && edgeNorm >= MIN_EDGE_PCT) {
          const { data: configRows } = await supabase.from('system_config').select('key, value').in('key', ['paper_bankroll']);
          const bankroll = parseFloat(configRows?.find((r: { key: string }) => r.key === 'paper_bankroll')?.value ?? '5000');

          // Look up latest calibration for this category + confidence tier
          const { data: calData } = await supabase
            .from('calibration_snapshots')
            .select('total_bets, predicted_win_rate, actual_win_rate')
            .eq('category', 'sports')
            .eq('confidence_tier', analysis.confidence || 'LOW')
            .order('snapshot_date', { ascending: false })
            .limit(1)
            .single();

          const { computeKelly, getCalibrationDiscount } = await import('../../src/lib/trading-math');
          const calDiscount = getCalibrationDiscount(calData);
          const kelly = computeKelly({
            trueProb: sbProbNorm ?? 0,
            marketPrice: pmPriceNorm ?? 0,
            direction: analysis.direction,
            confidence: analysis.confidence,
            category: 'sports',
            bankroll,
            calibrationDiscount: calDiscount,
          });
          kellyFraction = kelly.kellyFraction;
          recBetUsd = kelly.recBetUsd;
        }

        await supabase.from('sports_analyses').insert({
          market_id: market.id,
          event_description: analysis.event_description ?? market.question.substring(0, 100),
          sport: normalizeSport(analysis.sport),
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
        console.log(`[analyze-sports] ✅ [knowledge] "${market.question.substring(0, 60)}": edge=${(edgeNorm ?? 0).toFixed(3)} dir=${analysis.direction}`);
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
    // ── PRE-FILTER: reject season-long/futures markets immediately ──────
    // These match team names but are not individual game markets.
    if (isFuturesMarket(market.question)) continue;

    for (const [, info] of consensusByEvent) {
      if (!teamsMatchQuestion(market.question, info.homeTeam, info.awayTeam)) continue;
      if (market.outcome_prices.length < 2) continue;

      // ── DURATION MISMATCH GUARD ──────────────────────────────────────
      // Polymarket season-long markets share team names with tonight's games
      // but resolve months later. CRITICAL BUG FIX: null resolution_date was
      // treated as 0 hours remaining (0 > game + 168 = false → not skipped!).
      // Now treat null as Infinity so it always fails the duration check.
      // All timestamps are ISO 8601 / UTC from both Polymarket and The Odds API.
      // new Date().getTime() normalizes to UTC ms, so no timezone mismatch risk.
      const marketHoursRemaining = market.resolution_date
        ? (new Date(market.resolution_date).getTime() - Date.now()) / 3600000
        : Infinity; // null = unknown end date = treat as far future = skip
      const gameHoursFromNow = (new Date(info.commence).getTime() - Date.now()) / 3600000;
      // Skip past games (negative hours) — stale sportsbook data can linger
      if (gameHoursFromNow < -2) continue;
      if (marketHoursRemaining > gameHoursFromNow + 48) continue; // >2-day gap → skip (tightened from 7d)

      const pmYes = market.outcome_prices[0];
      const q = market.question.toLowerCase();

      // Determine if YES = home win or away win
      const homeLC = info.homeTeam.toLowerCase();
      const isHomeQuestion = q.includes(homeLC)
        || (TEAM_ALIASES[homeLC] ?? []).some(a => q.includes(a))
        || q.includes(homeLC.split(' ').pop() ?? '');

      // Require at least 2 sportsbooks for a reliable consensus.
      // A single book's line could be stale or an outlier.
      if (info.bookCount < 2) continue;

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

      let analysis: Record<string, unknown>;
      try {
        analysis = JSON.parse(jsonMatch[0]);
      } catch {
        console.error(`[analyze-sports] JSON parse error for ${market.id}`);
        continue;
      }

      // Runtime validation — reject bad Claude responses at the boundary
      const { validateSportsAnalysis: validateSports2 } = await import('../../src/lib/validate-analysis');
      const validation2 = validateSports2(analysis);
      if (!validation2.valid) {
        console.error(`[analyze-sports] VALIDATION FAILED for ${market.id}:`, validation2.errors.join('; '));
        continue;
      }

      const edgeNorm   = validation2.data.edge || null;
      const sbProbNorm = validation2.data.sportsbook_consensus;
      const pmPriceNorm = validation2.data.polymarket_price;
      analysis.direction = validation2.data.direction;
      analysis.confidence = validation2.data.confidence;

      // Calculate Kelly bet size
      let kellyFraction = 0;
      let recBetUsd = 0;
      if (analysis.direction !== 'PASS' && edgeNorm !== null && edgeNorm >= MIN_EDGE_PCT) {
        const { data: configRows } = await supabase
          .from('system_config')
          .select('key, value')
          .in('key', ['paper_bankroll']);
        const bankroll = parseFloat(
          configRows?.find((r: { key: string }) => r.key === 'paper_bankroll')?.value ?? '5000'
        );

        // Look up latest calibration for this category + confidence tier
        const { data: calData } = await supabase
          .from('calibration_snapshots')
          .select('total_bets, predicted_win_rate, actual_win_rate')
          .eq('category', 'sports')
          .eq('confidence_tier', analysis.confidence || 'LOW')
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .single();

        const { computeKelly, getCalibrationDiscount } = await import('../../src/lib/trading-math');
        const calDiscount = getCalibrationDiscount(calData);
        const kelly = computeKelly({
          trueProb: sbProbNorm ?? 0,
          marketPrice: pmPriceNorm ?? 0,
          direction: analysis.direction as string,
          confidence: analysis.confidence as string,
          category: 'sports',
          liquidityUsd: market.liquidity_usd,
          bankroll,
          calibrationDiscount: calDiscount,
        });
        kellyFraction = kelly.kellyFraction;
        recBetUsd = kelly.recBetUsd;
      }

      await supabase.from('sports_analyses').insert({
        market_id: market.id,
        event_description: analysis.event_description || `${consensus.homeTeam} vs ${consensus.awayTeam}`,
        sport: normalizeSport(analysis.sport as string | null | undefined, consensus.sport),
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

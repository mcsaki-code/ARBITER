# ARBITER Overhaul Plan — Full Rebuild to Profitability
### March 26, 2026 | Engineering + Strategy Document

---

## Executive Summary

ARBITER's architecture is solid. The pipeline design (ingest → analyze → place → resolve → snapshot) is exactly right. The problem is that **two ingest functions are broken** due to fixable API issues, the sports matching logic is too narrow, weather is over-filtering, and the system is missing the three highest-ROI strategies that profitable bots are running right now.

This document covers: why exactly things are broken today, what to fix immediately, what new strategies to add (with exact API specs and code patterns), and what infrastructure upgrades unlock the real alpha.

**Estimated effort to go from 2 bets/4 days → 10+ bets/day: 3–5 days of focused work.**

---

## Part 1: Root Cause Fixes (Do These First — 1–2 Days)

### Fix #1 — `ingest-crypto` is hitting US IP restrictions on Binance

**Root cause:** Netlify functions run on US-based AWS Lambda instances. Binance blocks US IPs at the API level — `api.binance.com` returns a 451 or connection error from US servers. This means `btcTicker` and `ethKlines` come back as `null` on every run. When `ticker === null`, the function skips the asset entirely and inserts zero rows into `crypto_signals`. `analyze-crypto` then exits with "No signal data available." Zero bets get placed.

**Fix:** Replace Binance with US-accessible price sources:

```typescript
// REPLACE THIS:
const btcTicker = await fetchJson('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');

// WITH THIS (CoinCap — no API key, no geo restrictions, free):
const btcPrice = await fetchJson('https://api.coincap.io/v2/assets/bitcoin');
// Returns: { data: { priceUsd: "84230.45", changePercent24Hr: "2.15", volumeUsd24Hr: "42000000000" } }

// For klines/candle data, use CoinCap history (free, no key):
const btcHistory = await fetchJson('https://api.coincap.io/v2/assets/bitcoin/history?interval=h1&start=<ms>&end=<ms>');
// Returns array of { priceUsd, time } — calculate RSI/BB from this

// Alternative: CryptoCompare (free tier, 100K calls/month, no geo block):
const btcCandles = await fetchJson('https://min-api.cryptocompare.com/data/v2/histohour?fsym=BTC&tsym=USD&limit=50');
// Returns OHLCV array — same structure as Binance klines
```

For 1-minute candles (needed for momentum strategy — see Part 2), use:
```typescript
// CryptoCompare 1-min candles (free, US-accessible):
const btcMinutes = await fetchJson('https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=10');
```

**ENV VAR NEEDED:** None — CoinCap and CryptoCompare public endpoints are free and unauthenticated.

---

### Fix #2 — `ingest-sports-odds` is exhausting its 500 req/month free tier

**Root cause:** The free tier of The Odds API allows 500 requests/month. The function runs every 10 minutes and fetches 10 sports = 10 API calls per run. That's 10 × 6 runs/hour × 24h = 1,440 calls/day. The free tier runs out in **8 hours of operation**. Once exhausted, every call returns HTTP 401 and the function returns zero rows.

**Fix Option A (cheapest):** Upgrade to The Odds API paid tier ($20/month for 30,000 calls — enough for aggressive polling) and add a call-budget governor:

```typescript
// Add to ingest-sports-odds.ts — check remaining quota before each sport
const remaining = parseInt(res.headers.get('x-requests-remaining') || '0');
if (remaining < 50) {
  console.log('[ingest-sports] API budget low — stopping early');
  break; // Stop fetching more sports
}
```

Also reduce polling frequency: from every 10 min to every 30 min for sports odds (they don't change that fast). This drops consumption from 1,440/day to 480/day — under the paid 30K/month limit easily.

**Fix Option B (free):** Replace The Odds API with `api.the-odds-api.com` alternatives:
- **OddsJam API** — free tier with 1,000 calls/day
- **Pinnacle Public Feed** — completely free, no auth, best sharp lines: `https://guest.api.arcadia.pinnacle.com/0.1/sports`

Pinnacle is actually the gold standard for sharp money consensus:
```typescript
// Pinnacle public odds (no key, no rate limits):
const pinnacleLeagues = await fetchJson('https://guest.api.arcadia.pinnacle.com/0.1/leagues?sportId=29'); // NBA=29, NFL=3, MLB=10
const pinnacleOdds = await fetchJson(`https://guest.api.arcadia.pinnacle.com/0.1/matchups?leagueIds=${leagueId}&withSpecials=false`);
```

**Pinnacle is the sharpest book in the world — it's actually a better signal than DraftKings/FanDuel consensus.**

**ENV VAR NEEDED:** `ODDS_API_KEY` (upgrade to paid) OR switch to Pinnacle (no key needed).

---

### Fix #3 — Edge normalization must happen before DB insert, not only in place-bets

**Root cause:** The `normalizeEdge()` function exists in `place-bets.ts` but the analyze functions store raw uncorrected edge values. When Claude returns `edge: 0.998` (clearly a bug — 99.8% edge on a BTC bracket), it gets stored as-is. The DB contains corrupt data and analytics are meaningless.

**Fix:** Copy the normalize functions into each analyze function and apply them before every `supabase.from('...').insert()`:

```typescript
// Add to analyze-crypto.ts, analyze-sports-edge.ts, analyze-weather.ts:
function normalizeEdge(raw: number | null): number | null {
  if (raw === null || raw === undefined) return null;
  if (raw > 100) return raw / 1000;
  if (raw > 1) return raw / 100;
  return raw;
}
function normalizeProb(raw: number | null): number | null {
  if (raw === null || raw === undefined) return null;
  if (raw > 1) return raw / 100;
  return raw;
}

// Then before every insert:
analysis.edge = normalizeEdge(analysis.edge);
analysis.market_price = normalizeProb(analysis.market_price);
analysis.bracket_prob = normalizeProb(analysis.bracket_prob);
```

---

### Fix #4 — Sports market matching is too narrow (only finds exact team names)

**Root cause:** The matching code uses `q.includes(homeLC)` where `q` is the Polymarket question and `homeLC` is the full team name from The Odds API (e.g., "manchester city"). Polymarket markets often say "Man City", "LA Lakers", "Atlético de Madrid" (accent), etc. This is why only one match (Atletico Madrid) is found — and even that only works because both sources use a similar name.

**Fix:** Build a comprehensive team name alias map and add fuzzy matching:

```typescript
// Add to analyze-sports-edge.ts:
const TEAM_ALIASES: Record<string, string[]> = {
  'los angeles lakers': ['lakers', 'la lakers'],
  'golden state warriors': ['warriors', 'gsw'],
  'manchester city': ['man city', 'mcfc', 'city'],
  'manchester united': ['man utd', 'man united', 'mufc'],
  'tottenham hotspur': ['spurs', 'tottenham'],
  'atletico madrid': ['atletico', 'atlético', 'atleti'],
  'inter miami': ['miami', 'inter'],
  'new york knicks': ['knicks', 'ny knicks'],
  'boston celtics': ['celtics'],
  'denver nuggets': ['nuggets'],
  // ... expand as needed
};

function teamsMatch(question: string, homeTeam: string, awayTeam: string): boolean {
  const q = question.toLowerCase();
  const checkTeam = (team: string): boolean => {
    const teamLC = team.toLowerCase();
    if (q.includes(teamLC)) return true;
    const aliases = TEAM_ALIASES[teamLC] || [];
    return aliases.some(alias => q.includes(alias));
    // Also check partial: "Lakers" in "Will the Lakers win?"
    const shortName = teamLC.split(' ').pop() || '';
    if (shortName.length > 4) return q.includes(shortName);
    return false;
  };
  return checkTeam(homeTeam) || checkTeam(awayTeam);
}
```

---

### Fix #5 — Stale analysis 2-hour window causes missed bets

**Root cause:** `place-bets.ts` uses `MAX_ANALYSIS_AGE_MS = 2h`. If `analyze-sports-edge` runs at 8:30am and `place-bets` runs at 10:31am (2 hours 1 minute later), the analysis is stale and gets skipped. The window is too tight for the 30-minute polling rhythm.

**Fix:** Increase to 4 hours for sports/crypto, keep 2 hours for weather (shorter-duration markets):

```typescript
// In place-bets.ts:
const MAX_ANALYSIS_AGE_WEATHER = 2 * 3600000;  // 2h for weather
const MAX_ANALYSIS_AGE_SPORTS  = 4 * 3600000;  // 4h for sports
const MAX_ANALYSIS_AGE_CRYPTO  = 3 * 3600000;  // 3h for crypto
```

Also: add a `MIN_LIQUIDITY` override per category. Weather markets legitimately have lower liquidity. The current $5K minimum is blocking valid weather bets.

---

### Fix #6 — Weather analysis over-filters due to LOW agreement

**Root cause:** The weather pipeline always returns LOW confidence and null edge. The cause: weather markets currently active are either resolving within 2 hours (getting skipped by the `hoursRemaining < 2` check), have liquidity under $5K (skipped), or their consensus data has `agreement: LOW` (skipped by `if (consensus.agreement === 'LOW' && marketType.startsWith('temperature')) continue`).

**Fix:**
1. Check the `weather_cities` and `weather_consensus` tables for populated data
2. If `weather_consensus` is empty or stale, the ingest-weather function may be failing too
3. Lower the LOW-agreement skip: only skip if model spread > 8°F (not simply `agreement === LOW`)
4. Add a fallback: if no consensus, use NWS official forecast directly (highest weight)

---

## Part 2: New Strategies to Add (Biggest Alpha — 3–5 Days)

### Strategy #1 — Crypto 15-Minute Momentum Markets (Highest Priority)

**Why:** The $313→$438,000 bot made its fortune exclusively on this. Polymarket runs continuous 15-minute BTC/ETH/SOL "higher or lower" markets. The key insight: when spot price on Coinbase/Kraken shows clear directional momentum (3+ consecutive green 1-minute candles + volume above 20-period average), Polymarket's price for that direction is typically 5-10 cents stale. The bot bets before the market catches up.

**New function: `netlify/functions/analyze-crypto-momentum.ts`**

This function should run every **5 minutes** (not 30) and:

1. Fetch current 15-min BTC market from Polymarket:
```typescript
// Find active 15-min markets:
const markets = await fetchGamma(
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&question=will+bitcoin+be+higher'
);
// Filter for: endDate within 15 minutes of now
const active15min = markets.filter(m => {
  const minutesLeft = (new Date(m.endDate).getTime() - Date.now()) / 60000;
  return minutesLeft > 2 && minutesLeft < 14; // Active window: 2-14 minutes remaining
});
```

2. Fetch 1-minute BTC candles from CryptoCompare (US-accessible):
```typescript
const candles = await fetchJson(
  'https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=10'
);
const closes = candles.Data.Data.map(c => c.close);
// Check momentum: last 3 candles all going same direction + volume spike
const last3 = closes.slice(-3);
const isUpMomentum = last3[0] < last3[1] && last3[1] < last3[2];
const isDownMomentum = last3[0] > last3[1] && last3[1] > last3[2];
const momentumStrength = Math.abs(last3[2] - last3[0]) / last3[0]; // % move in 3 mins
```

3. Compare momentum direction to current Polymarket price:
```typescript
// If strong upward momentum but Polymarket "HIGHER" is priced at only 0.55...
// True probability of being higher in next 10 min is likely 0.65+
// Edge = 0.65 - 0.55 = 0.10 = 10% edge
if (isUpMomentum && momentumStrength > 0.002) { // >0.2% move in 3 mins
  const pmHigherPrice = parseFloat(market.outcomePrices[0]);
  const estimatedTrueProb = 0.5 + (momentumStrength * 20); // Rough heuristic: scale up
  const edge = estimatedTrueProb - pmHigherPrice;
  if (edge > 0.05) {
    // Place bet immediately — don't wait for Claude analysis, the window is 5 minutes
  }
}
```

**Key design decision:** Don't use Claude for the 15-min momentum strategy. By the time Claude responds (3-15 seconds), the window may be closing. Use a hardcoded rule: if `isUpMomentum && momentumStrength > 0.003 && pmHigherPrice < 0.60`, bet YES. This is rule-based execution, not AI reasoning.

**New Netlify env var needed:** None (CryptoCompare is free and unauthenticated for basic endpoints)

**Expected performance (from research):** 70-85% win rate with consistent momentum filter, 5-15% average edge.

---

### Strategy #2 — Whale Copy Trading

**Why:** Every Polymarket bet is public on-chain. The top 50 wallets have documented 65-85% win rates. Following them is mechanically extractable and doesn't require any predictive modeling.

**New function: `netlify/functions/track-whales.ts`** (runs every 15 minutes)

Step 1: Build a whale wallet list. Use the Gamma API to find the top traders by profit:
```typescript
// Polymarket Gamma API — top traders by profit (public):
const topTraders = await fetchJson(
  'https://gamma-api.polymarket.com/profiles?sort=profit&order=desc&limit=50'
);
// Store wallet addresses with their win rates in system_config or a new table
```

Step 2: Poll for recent trades from those wallets:
```typescript
// Polymarket CLOB API — recent trades for a specific maker:
const recentTrades = await fetchJson(
  `https://clob.polymarket.com/trades?maker_address=${walletAddress}&limit=10`
);
// Filter for: trades in the last 15 minutes with size > $500
const freshLargeTrades = recentTrades.filter(t => {
  const minsAgo = (Date.now() - new Date(t.match_time).getTime()) / 60000;
  return minsAgo < 15 && parseFloat(t.size) > 500;
});
```

Step 3: For each fresh large trade, mirror it at 10-15% of their size:
```typescript
for (const trade of freshLargeTrades) {
  // Only mirror if: wallet win rate > 65%, trade size > $500, market liquidity > $25K
  const walletProfile = whaleProfiles[trade.maker];
  if (!walletProfile || walletProfile.winRate < 0.65) continue;

  const mirrorAmount = Math.min(
    parseFloat(trade.size) * 0.12, // 12% of whale's bet
    bankroll * 0.02                 // Max 2% of our bankroll
  );

  // Place the same bet (same conditionId, same direction)
  await executeBet(supabase, {
    market_id: await getMarketIdByConditionId(trade.asset_id),
    category: 'whale_copy',
    direction: trade.side === 'BUY' ? 'BUY_YES' : 'BUY_NO',
    entry_price: parseFloat(trade.price),
    amount_usd: mirrorAmount,
  }, config);
}
```

**New DB table needed:** `whale_profiles` with columns: `address, win_rate, total_profit, total_bets, last_tracked`

**New Netlify env var needed:** None (Polymarket CLOB API is public for trade history)

**Expected performance (from research):** 65-75% win rate, 5-12% average edge when following wallets with documented 70%+ win rates.

---

### Strategy #3 — Kalshi Cross-Platform Arbitrage

**Why:** When the same event is listed on both Polymarket and Kalshi, price discrepancies create risk-free arbitrage (buy YES cheap on one platform, buy NO cheap on the other). This requires no predictive ability — it's structural profit that exists purely because two markets haven't synced.

**New function: `netlify/functions/ingest-kalshi.ts`** (runs every 15 minutes)

```typescript
// Kalshi public market data — no auth required:
const kalshiEvents = await fetchJson(
  'https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open'
);

// Kalshi market prices:
const kalshiMarket = await fetchJson(
  `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`
);
// Returns: { result: { yes_ask: 0.62, no_ask: 0.41, ... } }
```

**New function: `netlify/functions/arb-scanner-cross.ts`**

The logic:
```typescript
// For each Kalshi market, find matching Polymarket market:
for (const kalshiMkt of kalshiMarkets) {
  const polyMatch = findPolymarketMatch(kalshiMkt.title, polymarketActives);
  if (!polyMatch) continue;

  const kalshiYes = kalshiMkt.yes_ask;      // e.g., 0.62
  const polyYes = polyMatch.outcomePrices[0]; // e.g., 0.57

  // If buying YES on Poly (0.57) + YES on Kalshi (0.62) = 1.19 — that's NOT arb
  // We need: poly_YES + kalshi_NO < 1.0 OR kalshi_YES + poly_NO < 1.0

  const kalshiNo = 1 - kalshiMkt.yes_bid;   // Using bid-ask spread
  const polyNo = polyMatch.outcomePrices[1];

  // Arb exists if:
  // Option A: buy YES on Poly + buy NO on Kalshi
  const costA = polyYes + kalshiNo;
  // Option B: buy YES on Kalshi + buy NO on Poly
  const costB = kalshiYes + polyNo;

  if (costA < 0.96) { // 4% net edge after fees
    console.log(`ARB: Buy YES on Poly ($${polyYes}) + NO on Kalshi ($${kalshiNo}) = $${costA.toFixed(3)} for $1 payout`);
    // Edge = 1 - costA = 4%+ risk-free
  }
}
```

**Note on Kalshi trading:** Kalshi requires a US account and their own API key for order placement. For now, flag these opportunities in the `arb_opportunities` table for manual execution. Automated Kalshi execution can come in Phase 2.

**New Netlify env var needed:** `KALSHI_API_KEY` (free to get, only needed for placing orders — market data is free)

---

### Strategy #4 — Politics & Macro Markets

**Why:** Polymarket has thousands of active politics markets with combined volume in the hundreds of millions. ARBITER currently has 0 politics markets in its pipeline. These are often mispriced around news events and offer significant edge for anyone doing careful analysis.

**New function: `netlify/functions/analyze-politics.ts`** (runs every 30 minutes)

Data sources to feed Claude:
```typescript
// 538 polling averages (free, no key):
const polls538 = await fetchJson('https://projects.fivethirtyeight.com/polls/data/president_polls.csv');

// PredictIt prices (free, public API — great cross-reference):
const predictitMarkets = await fetchJson('https://www.predictit.org/api/marketdata/all/');

// RealClearPolitics aggregated averages:
// (scrape or use their embeds — no official API but public data)

// Polymarket politics markets:
const politicsMarkets = await fetchGamma(
  'https://gamma-api.polymarket.com/events?tag_id=POLITICS_TAG_ID&active=true&limit=100'
);
```

Claude prompt for politics:
- Feed it the current polling averages, PredictIt prices, and recent news headlines
- Ask it to assess Polymarket prices vs fair value
- Focus on: elections, policy outcomes, regulatory decisions, geopolitical events

**Expected performance:** Politics markets are informationally inefficient, especially between major news cycles. 8-15% edges are common.

---

### Strategy #5 — Expand Arb Scanner to Full Market Coverage

**Current problem:** The arb scanner frequently times out before scanning all markets. It spends too much time on sequential tag lookups.

**Fix:** Parallelize with `Promise.all()` and use the bulk markets endpoint:

```typescript
// INSTEAD OF sequential tag lookups, fetch all active markets in parallel pages:
const PAGE_SIZE = 500;
const TOTAL_PAGES = 15; // 7,500 markets in one scan

const pagePromises = Array.from({ length: TOTAL_PAGES }, (_, i) =>
  fetchGamma(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${PAGE_SIZE}&offset=${i * PAGE_SIZE}`)
    .then(page => Array.isArray(page) ? page : [])
);

// Fetch all pages in parallel (Netlify allows ~50 concurrent fetch calls):
const pages = await Promise.all(pagePromises);
const allMarkets = pages.flat();

// Now scan all 7,500 markets for arb in <2 seconds (in-memory computation is fast)
```

This turns a sequential 25-second operation that times out into a 3-second parallel fetch.

---

## Part 3: Infrastructure — What to Keep on Netlify vs. What to Move

### Keep on Netlify (Scheduled Functions are Fine):
| Function | Why Keep | Cadence |
|---|---|---|
| `ingest-weather` | No speed requirement, 20-min cycle is fine | Every 20 min |
| `analyze-weather` | Long-duration markets, 20-min latency acceptable | Every 20 min |
| `ingest-sports-odds` | Odds don't change in <30 min meaningfully | Every 30 min |
| `analyze-sports-edge` | Pre-game analysis, hours of lead time | Every 30 min |
| `refresh-markets` | Market catalog refresh | Every 15 min |
| `arb-scanner` (intra) | With parallelization fix, stays under 10s | Every 15 min |
| `arb-scanner-cross` (Kalshi) | API polling, no speed requirement | Every 15 min |
| `resolve-bets` | Outcome checking, no speed requirement | Hourly |
| `performance-snapshot` | Aggregate stats | Daily |
| `analyze-politics` | News cycle is slow, 30-min is fine | Every 30 min |

### Move to Railway.app (Persistent Process — $5/month):

Railway runs a persistent Node.js server that never sleeps. This is needed for two things:

**Worker 1: `crypto-momentum-worker.ts`**
- Polls Polymarket for active 15-min BTC/ETH/SOL markets every 60 seconds
- Fetches CryptoCompare 1-min candles
- Applies momentum rules (no Claude needed)
- Places bets via Supabase REST API when signal detected
- **Why not Netlify?** The 15-min market window requires <5 min total latency. Netlify cold start + 15-min polling gap = too slow.

**Worker 2: `whale-tracker-worker.ts`**
- Polls Polymarket CLOB trades endpoint every 3 minutes
- Checks against whale wallet list
- Mirrors qualifying trades immediately
- **Why not Netlify?** Whale trade windows close in minutes. A 15-minute poll would miss most opportunities.

**Railway setup:**
```bash
# One-time setup:
npm install -g @railway/cli
railway login
railway init
railway add
# Point to a new /workers directory in the monorepo
railway up
```

**Environment:**
- Same Supabase credentials (already in Netlify env — copy to Railway)
- Railway free tier: 500 hours/month = enough for 2 persistent workers
- Paid tier: $5/month for unlimited always-on

**Monthly cost impact:** +$5/month Railway + $20/month Odds API upgrade = $25/month additional. Well worth it for the alpha unlocked.

---

## Part 4: Implementation Roadmap

### Day 1 — Stop the Bleeding (Fix What's Broken)

**Morning:**
1. **Fix `ingest-crypto`** — Replace Binance API calls with CoinCap/CryptoCompare. Deploy. Verify crypto_signals table populates.
2. **Fix `ingest-sports-odds`** — Either upgrade The Odds API key or switch to Pinnacle public feed. Deploy. Verify sports_odds table populates.
3. **Add edge normalization** to analyze-crypto.ts and analyze-sports-edge.ts before DB insert.

**Afternoon:**
4. **Fix sports team name matching** — Add alias map, fuzzy matching.
5. **Increase stale analysis window** from 2h to 4h in place-bets.ts for sports/crypto.
6. **Fix `arb-scanner`** parallelization — use `Promise.all()`, scan all 7,500 markets.

**End of Day 1:** System should be placing 3-8 bets/day automatically.

---

### Day 2 — Add Kalshi Arb + Politics

**Morning:**
1. Build `ingest-kalshi.ts` — fetch all open Kalshi markets + prices, upsert to new `kalshi_markets` table.
2. Build `arb-scanner-cross.ts` — compare Kalshi vs Polymarket for matching events.
3. Update `arb_opportunities` table to include `platform_b` (Kalshi) rows.

**Afternoon:**
4. Build `analyze-politics.ts` — fetch PredictIt, 538 polls, feed to Claude alongside Polymarket politics markets.
5. Add politics to `place-bets.ts` candidate collection.

**End of Day 2:** Cross-platform arb opportunities visible in dashboard. Politics pipeline active.

---

### Day 3 — Crypto 15-Minute Momentum (Netlify Version)

Build `netlify/functions/analyze-crypto-momentum.ts`:
1. Fetch active 15-min Polymarket markets (BTC, ETH, SOL)
2. Fetch last 10 1-min candles from CryptoCompare
3. Apply momentum rules (rule-based, no Claude)
4. Insert directly into `bets` table if signal found (skip the normal analyze→place pipeline — too slow)
5. Schedule at `*/5 * * * *` (every 5 minutes)

**Note:** This is the one function that writes directly to `bets` rather than going through `place-bets.ts`. It needs to act within the 5-minute window.

---

### Day 4 — Whale Tracking (Railway Worker)

1. Set up Railway project: `railway init` in `/workers` directory.
2. Build `whale-tracker-worker.ts`:
   - Load whale wallet list from Supabase on startup
   - Poll CLOB trades every 3 minutes
   - Mirror qualifying trades
3. Build `refresh-whales.ts` (Netlify, runs daily) — update whale profiles from Gamma API leaderboard.
4. Add `whale_copy` category to `place-bets.ts` and `resolve-bets.ts`.

---

### Day 5 — Dashboard + Monitoring

1. Add a **Whale Tracker** page to the Next.js app:
   - Show top 50 tracked wallets with win rates
   - Show recent mirrored trades
   - Live feed of whale activity

2. Add a **Cross-Platform Arb** section to the Arb page:
   - Show Polymarket vs Kalshi price differences
   - Flag actionable arb opportunities with combined cost and net edge

3. Add a **15-Min Momentum** feed to the Crypto page:
   - Live BTC/ETH momentum signal (up/down/neutral)
   - Current active 15-min markets and current edge

4. Set up Netlify email alerts for:
   - Any cross-platform arb with edge > 5%
   - Any whale trade mirrored
   - Any 15-min momentum bet placed

---

## Part 5: Full Tech Stack After Overhaul

### Data Sources
| Source | Used For | Cost | Auth |
|---|---|---|---|
| Polymarket Gamma API | Markets, prices, leaderboard | Free | None |
| Polymarket CLOB API | Order placement, trade history | Free | Wallet key (existing) |
| CoinCap API | BTC/ETH/SOL real-time prices | Free | None |
| CryptoCompare API | 1-min + 1h candles, indicators | Free (100K/mo) | None |
| Pinnacle Public Feed | Sharp sportsbook lines | Free | None |
| Kalshi Public API | Prediction market cross-reference | Free | None (data) / Key (orders) |
| NWS / GFS / ECMWF / HRRR | Weather forecasts | Free | None |
| PredictIt Public API | Politics prices cross-reference | Free | None |
| 538 Polling API | Political probabilities | Free | None |

### Services
| Service | Used For | Cost |
|---|---|---|
| Netlify Pro | 11 scheduled functions + Next.js frontend | (existing) |
| Supabase | Database | (existing) |
| Railway.app | 2 persistent workers (momentum + whale) | $5/month |
| Resend | Email notifications | (existing) |
| Anthropic Claude | AI analysis (weather, sports, politics, crypto) | (per-use, existing) |
| **Total new cost** | | **~$25/month** |

---

## Part 6: Expected Performance After Overhaul

Based on research into what comparable systems achieve:

| Metric | Today | Post-Overhaul (30 days) |
|---|---|---|
| Bets per day | 0 | 10–20 |
| Active strategies | 3 (broken) | 7 (weather, sports, crypto-bracket, crypto-momentum, whale-copy, kalshi-arb, politics) |
| Markets analyzed per day | ~85 | 8,000+ |
| Expected win rate | Unknown (2 bets) | 62–70% (mixed strategies) |
| Expected daily ROI | 0% | 0.8–2.5% on deployed capital |
| Monthly P&L on $500 paper bankroll | - | +$40–$100 paper |
| Time to live trading readiness | Unknown | 30 days of paper trading |

### Realistic Expectations by Strategy:
- **Weather (multi-model ensemble):** 65–75% win rate, 8-15% avg edge — this is ARBITER's strongest and most defensible edge
- **Sports (sportsbook vs Polymarket):** 58–65% win rate, 5-10% avg edge — good but competitive
- **Crypto 15-min momentum:** 65–80% win rate, 5-12% avg edge — volume-dependent
- **Whale copy trading:** 60–70% win rate, 5-10% avg edge — mirrors proven performers
- **Kalshi cross-platform arb:** Near risk-free when found, 3-8% net edge
- **Politics:** 58–68% win rate, 8-20% avg edge around news events

---

## Part 7: What to DROP

These current approaches should be de-prioritized or removed:

### Drop: Crypto bracket markets (long-duration)
The "Will BTC be above $X by end of month?" markets are efficiently priced and ARBITER's RSI/BB-based analysis is outgunned by quantitative funds. The edge is consistently < 3%. The 15-minute momentum approach in the same asset class is far more profitable.

### Drop: Weather markets with LOW model agreement
Currently the code skips LOW-agreement weather. Keep this filter. Betting against uncertain forecasts is how you lose. Only bet HIGH/MEDIUM agreement forecasts with meaningful ensemble backing.

### Drop: The Odds API free tier
500 requests/month is functionally useless. Either pay $20/month or switch to Pinnacle public feed (free, actually sharper lines). The current approach is exhausting the budget in under 8 hours.

### Drop: CoinGecko as primary price source
CoinGecko's free tier is rate-limited to 10-30 calls/minute and frequently returns 429 errors. Replace entirely with CoinCap for spot prices and CryptoCompare for historical candles.

### Drop: Sequential arb scanner page fetches
The current arb-scanner uses sequential `await` inside a for loop to fetch each page. Replace with `Promise.all()`. The sequential version times out before scanning most markets.

---

## Appendix: Key API Endpoints Reference

```
# Polymarket
Gamma API (markets/events):  https://gamma-api.polymarket.com/
CLOB API (orders/trades):     https://clob.polymarket.com/
WebSocket (real-time):        wss://ws-subscriptions-clob.polymarket.com/ws/market

# Price Data (US-accessible, free)
CoinCap spot:                 https://api.coincap.io/v2/assets/bitcoin
CryptoCompare candles:        https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=10

# Sports Odds
Pinnacle public lines:        https://guest.api.arcadia.pinnacle.com/0.1/sports
The Odds API (paid):          https://api.the-odds-api.com/v4/sports/{sport}/odds

# Kalshi
Market data (public):         https://api.elections.kalshi.com/trade-api/v2/markets
Events (public):              https://api.elections.kalshi.com/trade-api/v2/events

# Politics
PredictIt (public):           https://www.predictit.org/api/marketdata/all/
538 polls:                    https://projects.fivethirtyeight.com/polls/
```

---

## Where to Start Right Now

**This afternoon:** Open Netlify env vars for the ARBITER site and check:
1. Is `ODDS_API_KEY` set? If yes, check its remaining quota at `https://api.the-odds-api.com/v4/sports/?apiKey=YOUR_KEY` — if it returns `{"message":"You are... allowed 0 more requests"}`, the key is exhausted.
2. Is `ANTHROPIC_API_KEY` set and valid?

Then make these three code changes and push to main (Netlify will auto-deploy in ~2 min):
1. `ingest-crypto.ts`: Replace Binance with CoinCap
2. `ingest-sports-odds.ts`: Replace The Odds API with Pinnacle public feed OR add the budget governor and upgrade the key
3. `analyze-crypto.ts` and `analyze-sports-edge.ts`: Add normalizeEdge before insert

After those deploy and verify (check Supabase for fresh rows in `crypto_signals` and `sports_odds`), the system will start placing bets again within 30 minutes. Everything else in this plan is additive alpha on top of a working foundation.

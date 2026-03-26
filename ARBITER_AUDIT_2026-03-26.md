# ARBITER Full System Audit — March 26, 2026

## TL;DR

The pipeline is architecturally sound but **critically under-firing**. Only 2 bets have been placed since launch (March 22). The ingest functions for sports odds and crypto signals have **stopped producing data**, which means the analyze functions have nothing to work with. Weather analysis is running but producing 100% PASS decisions. The arb scanner is finding zero opportunities. The system is alive but not betting — and compared to what profitable bots are actually doing in 2026, ARBITER is missing the three highest-ROI strategies entirely.

---

## Part 1: Pipeline Health (Live Database)

### Bet Activity
| Metric | Value |
|---|---|
| Total bets placed (all time) | **2** |
| Last bet date | **March 22, 2026** (4 days ago) |
| Current open positions | 1 sports ($2.35) + 1 crypto ($3.75) |
| Total deployed | **$6.10 of $500 bankroll (1.2%)** |
| Paper trade start | March 22, 2026 |
| Win rate | 0.00% (unresolved) |

The system has been live for 4 days and placed exactly 2 bets. It should be placing 5–15 per day based on the pipeline design.

---

### Analysis Pipeline (Last 24 Hours)

| Vertical | Runs (24h) | Last Run | Actionable | Avg Edge |
|---|---|---|---|---|
| Weather | 4 | 09:40 UTC today | **0 / 4** | null |
| Sports | 1 | 20:48 UTC yesterday | 1 / 1 | 0.148 |
| Crypto | 2 | 20:48 UTC yesterday | 2 / 2 | 0.541* |

*The 0.541 average is skewed by a corrupted row with edge=0.998 (see Bug #2 below).

---

### Ingest Pipeline (Last 24 Hours)

| Feed | Rows in Last 24h | Status |
|---|---|---|
| `sports_odds` | **0** | 🔴 DEAD |
| `crypto_signals` | **0** | 🔴 DEAD |
| `weather_forecasts` | Running (analyses show today) | 🟡 OK but no edge found |
| `arb_opportunities` (OPEN) | **0** | 🔴 EMPTY |

**This is the root cause of low bet volume.** The `ingest-sports-odds` and `ingest-crypto` Netlify functions are not producing any data. Without fresh signals, `analyze-sports-edge` and `analyze-crypto` have nothing to work with, and `place-bets` has nothing to place.

---

### Active Market Inventory

| Category | Count |
|---|---|
| Sports | 4,387 |
| Crypto | 1,092 |
| Weather | 70 |
| **Politics** | **0** |
| Other | ~1,451 |
| **Total** | **7,000** |

ARBITER is only actively analyzing a tiny slice: 50 sports markets, 30 crypto markets, 5 weather markets per run. 6,800+ markets get zero attention.

---

## Part 2: Specific Bugs Found

### Bug #1 — Sports Analysis Stuck on One Market
Every sports analysis for the past 4 days is the same market: **"Will Atletico Madrid win the 2025–26 La Liga?"** — same edge (0.148), same confidence (HIGH), same direction (BUY_YES), repeated 5 times. A bet WAS placed on this market on March 22, so `place-bets` correctly skips it on every subsequent run. But the `analyze-sports-edge` function is re-analyzing the same market over and over instead of finding new ones. This suggests the sports matching logic is only finding one Polymarket/sportsbook pair that aligns, meaning the team-name matching in `analyze-sports-edge` is too narrow.

### Bug #2 — Crypto Edge Corruption in Database
One crypto analysis row has `edge = 0.998` (99.8% edge on a BTC bracket). This is the known "Claude returns 849 instead of 0.849" problem. `normalizeEdge()` in `place-bets.ts` handles this at execution time, but the corrupted value gets stored in the DB, polluting analytics and the avg_edge calculation. The normalization needs to happen in `analyze-crypto.ts` before the `supabase.insert()` call, not only in `place-bets.ts`.

### Bug #3 — Weather Analysis: 100% PASS Rate
All 10 of the most recent weather analyses returned `direction: PASS`, `confidence: LOW`, `edge: null`. The cause is likely that `weather_consensus` rows have `agreement: LOW` for the current markets, and the code correctly skips LOW-agreement markets. But the deeper issue is that weather consensus data may not be diverse enough or the model spread thresholds are too conservative. It is also possible the weather markets currently active on Polymarket resolve tomorrow and the 2h minimum is filtering them out.

### Bug #4 — Sports Odds Ingest is Down
Zero rows in `sports_odds` in the last 24 hours. Either the `ingest-sports-odds` Netlify function is failing (API key expired, rate limit, or function timeout), or the external odds API (The Odds API) has an issue. Without this, the sports pipeline is completely blind.

### Bug #5 — Crypto Signals Ingest is Down
Zero rows in `crypto_signals` in the last 24 hours. The `ingest-crypto` function is failing silently. Without BTC/ETH price and technical indicator data, `analyze-crypto` skips with "No signal data available."

### Bug #6 — Arb Scanner Producing Zero Results
The `arb_opportunities` table has no OPEN rows. Either the arb scanner is not running (Netlify schedule silently failing), or it's timing out scanning 7,000 markets within the 25-second budget. With 7,000 active markets, the multi-page scan approach is very likely hitting the time guard and returning before completing.

---

## Part 3: Competitor Landscape

### Who's Actually Making Money on Polymarket in 2026

**The bot dominance numbers:**
- 14 of the top 20 most profitable Polymarket wallets are bots
- 3.7% of users generate 37.44% of total volume ("Bot Zone")
- Arbitrage bots extracted ~$40M from Polymarket in one year (Hubble Research)
- One bot turned $313 → $438,000 in a single month (Dec 2025)
- Top bots: 78–98% win rates, bots outperforming equivalent human strategies by ~2x

### The Four Profitable Bot Archetypes

#### 1. News/NLP Sentiment Bots (Highest Alpha)
These monitor Twitter, Telegram, news APIs, and political feeds. When a major poll drops, a candidate makes a statement, or breaking news lands, Polymarket prices take 30 seconds to 5 minutes to fully adjust. The bot detects the information, calculates the new fair price, and places orders before the crowd catches up. An ensemble probability model (GPT-4o + Claude + Gemini) trained on news + social data generated $2.2M in two months.

**ARBITER has zero news/NLP monitoring.**

#### 2. Crypto Momentum Bots on 15-Minute Markets (Most Scalable)
This is the strategy behind the $313→$438K bot. Polymarket runs 15-minute BTC/ETH/SOL up/down markets continuously. These markets price the probability of "BTC higher in 15 min than now." The key insight: Polymarket prices lag Binance/Coinbase spot momentum by 30–90 seconds. When confirmed momentum appears on a spot exchange (e.g., 3 consecutive 1-minute green candles + volume spike), the bot bets on the direction before Polymarket updates. This isn't forecasting — it's pure latency arbitrage between spot exchanges and Polymarket.

**ARBITER does not monitor 15-minute markets at all.** Its crypto analysis focuses on multi-day bracket markets ("Will BTC be above $X by end of month?"), which are far less efficient but also far less liquid for momentum plays.

#### 3. Whale Copy Trading (Most Accessible)
Polymarket bets are on-chain and completely public. Top bots track 20–50 wallets with proven track records (>70% win rate, >$50K lifetime profit). When a whale places a new bet, the bot mirrors it within seconds at a fractional size. One tool (Polycop) claims 75% accuracy copying whale moves.

**ARBITER has no whale tracking or copy trading capability.**

#### 4. Market Making (Most Consistent, Lowest Risk)
Rather than taking directional bets, market makers quote both YES and NO at prices slightly away from mid, capturing the spread on both sides. Win rates of 78–85%, 1–3% monthly returns, no directional risk needed. Requires managing inventory and avoiding being adversely selected on heavily informed markets.

**ARBITER has no market making functionality.**

---

## Part 4: ARBITER vs Competitors — Gap Analysis

### What ARBITER Does Well
- **Multi-model weather analysis** — Using NWS + GFS + ECMWF + ICON + HRRR ensemble is genuinely sophisticated and not something most bots do. Weather markets are relatively underexplored.
- **Kelly sizing + risk guardrails** — 1/8th Kelly, 3% max per bet, 20% daily exposure cap, liquidity filters. This is professional-grade risk management.
- **Architecture** — The ingest→analyze→place→resolve→snapshot pipeline is the right design. The issue is execution, not architecture.
- **Edge normalization** — The `normalizeEdge()` defense against Claude returning "849 instead of 0.849" is smart.

### Critical Gaps vs. What Actually Makes Money

| Strategy | Top Bots | ARBITER | Impact |
|---|---|---|---|
| News/NLP sentiment monitoring | ✅ Core strategy | ❌ None | 🔴 Highest alpha missing |
| Crypto 15-min momentum markets | ✅ $313→$438K bot | ❌ None | 🔴 Biggest scalable edge |
| Whale copy trading | ✅ 75% accuracy | ❌ None | 🔴 Easiest to implement |
| Cross-platform arb (Polymarket/Kalshi) | ✅ Major strategy | ❌ None | 🟠 Structural profits |
| Market making | ✅ 78–85% win rate | ❌ None | 🟠 Consistent income |
| Politics/macro markets | ✅ High volume | ❌ 0 politics markets | 🟠 Huge category ignored |
| Execution speed | ✅ <50ms | ⚠️ 15–30 min schedule | 🔴 Speed-dependent strategies impossible |
| Market coverage | ✅ 7,000+ markets scanned | ⚠️ ~85 markets analyzed | 🟠 Missing most opportunities |
| Real-time order flow | ✅ Used for signal | ❌ Not tracked | 🟡 Good secondary signal |

### The Speed Problem
This deserves special emphasis. ARBITER runs on 15-30 minute Netlify scheduled functions. Top bots operate in <50ms. For news arbitrage, crypto momentum, and whale copy trading — **the window of opportunity closes in seconds to minutes**. ARBITER is architecturally incapable of capturing these opportunities without migrating to a persistent process (Railway, Fly.io, Render, or a VPS). The Netlify scheduled function model is fine for weather and long-duration bracket markets, but it's the wrong infrastructure for the highest-alpha strategies.

---

## Part 5: Prioritized Action Plan

### Immediate Fixes (This Week)

**Fix #1 — Diagnose and restore ingest functions**
Check Netlify function logs for `ingest-sports-odds` and `ingest-crypto`. These are completely down and are the primary reason bets aren't being placed. Likely causes: API key expiration, rate limit on The Odds API, or a change in the crypto price feed API. Without these, the analyze functions have no data.

**Fix #2 — Normalize edge before DB insert in analyze-crypto.ts and analyze-sports-edge.ts**
The normalization currently only happens in `place-bets.ts`. Add the same `normalizeEdge()` call in the analyze functions before the Supabase insert. This keeps the DB clean and analytics accurate.

**Fix #3 — Broaden sports market matching**
The team-name matching (`q.includes(homeLC)`) is only finding one Polymarket market (Atletico Madrid). This needs fuzzy matching, nickname handling (e.g., "Man City" vs "Manchester City"), and support for player-level and prop markets, not just head-to-head win markets.

**Fix #4 — Debug weather PASS rate**
Investigate why all weather analyses are returning PASS. Check: (1) whether the weather_consensus rows have `agreement = LOW` for current markets, (2) whether `resolution_date` is within 2h causing skips, (3) whether NWS/GFS forecast data is actually populated.

**Fix #5 — Increase max analyses per run**
`MAX_ANALYSES_PER_RUN = 3` in sports and crypto. With 4,387 sports markets and 1,092 crypto markets active, this is far too low. Even bumping to 10–15 per run (within the 10s Netlify timeout using `Promise.all`) would meaningfully increase bet frequency.

### Medium-Term Opportunities (Next 2–4 Weeks)

**Opportunity #1 — Crypto 15-Minute Markets**
Add a new function `analyze-crypto-momentum.ts` that specifically targets the continuous 15-minute BTC/ETH/SOL up/down markets. The signal is simple: fetch real-time spot price from Binance/Coinbase (not a scheduled ingest — a direct API call inside the analyze function), check if there's confirmed momentum (3+ consecutive 1-min candles in one direction, volume above average), and compare to current Polymarket price. This is the single highest-ROI addition available.

**Opportunity #2 — Whale Tracking**
Use the Polymarket CLOB API to scan the top 50 wallets by lifetime profit. When one of them places a new bet (detected by watching their on-chain activity or via the Gamma API event feed), mirror it at 10–20% of their bet size. This requires a persistent watcher (not a scheduled function), but even a 15-minute polling version would capture some whale moves.

**Opportunity #3 — Politics Markets**
The database shows 0 politics markets in ARBITER's active set — but Polymarket has thousands of active politics/macro markets. These are high-volume, high-liquidity, and often mispriced around news events. Adding a `analyze-politics-edge.ts` function that uses Claude to assess polls, betting odds, and news sentiment against Polymarket prices would open a large new opportunity set.

**Opportunity #4 — Kalshi Cross-Platform Arb**
When Polymarket and Kalshi are both pricing the same event, price discrepancies create risk-free arbitrage (buy YES on the cheaper platform, buy NO on the more expensive). The Kalshi API is public. This is structural profit that doesn't require any predictive ability.

### Long-Term Infrastructure (Month 2+)

**Move to persistent workers for speed-sensitive strategies.** Railway.app or Fly.io would allow continuous processes that react to market data in near-real-time. Keep Netlify for weather/long-duration analysis (where 15-min latency is fine) but use persistent workers for crypto momentum and news monitoring. This is the infrastructure upgrade that unlocks the #1 and #2 profit strategies.

---

## Summary Scorecard

| Area | Current Status | Target |
|---|---|---|
| Bets per day | 0 (pipeline broken) | 5–15 |
| Verticals active | 3 (weather/sports/crypto) | 5+ (+ politics, 15-min crypto) |
| Markets analyzed per run | ~85 | 500+ |
| News/sentiment monitoring | None | Real-time NLP |
| Whale tracking | None | Top-50 wallet watcher |
| Speed (time-to-bet after signal) | 15–30 min | <5 min (persistent) |
| Edge sources | 3 internal models | 6+ (+ copy trading, cross-platform arb) |

The most important thing to fix right now is simply getting the ingest functions back online. Everything else flows from that. Once the pipeline is reliably producing data and bets, the next highest-leverage addition is the crypto 15-minute momentum strategy — that's where the outsized returns are being captured right now.

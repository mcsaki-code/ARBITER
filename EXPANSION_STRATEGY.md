# ARBITER Expansion Strategy — Ruthless Edge Maximization

**Generated**: March 21, 2026
**Status**: Phase 1 (Weather/Temperature) operational. Expansion planning.

---

## Executive Summary

ARBITER currently exploits a single edge: **weather model consensus vs. Polymarket temperature brackets**. This works because NWS + GFS + ECMWF + ICON forecasts are free, fast, and more accurate than crowd pricing 24-48 hours out. But temperature markets represent only ~$1.9M of Polymarket's **multi-billion dollar** ecosystem.

The research below identifies **5 high-priority expansion verticals** ranked by edge exploitability, data availability, and volume. The strategy is simple: **anywhere we can get data faster or process it more accurately than the crowd, we bet.**

---

## I. POLYMARKET MARKET LANDSCAPE (March 2026)

| Category | Active Markets | Est. Volume | Edge Potential |
|---|---|---|---|
| **Politics** (elections, legislation) | 2,000+ | $2B+ | LOW — efficient, whale-dominated |
| **Sports** (NFL, NBA, NCAA, FIFA) | 3,100+ | $500M+ | **HIGH** — real-time data arbitrage |
| **Crypto/Bitcoin** | 1,600+ | $300M+ | **MEDIUM** — on-chain data edge |
| **Temperature/Weather** | 1,100+ | $1.9M | **HIGH** — model consensus (CURRENT) |
| **Culture/Entertainment** | 500+ | $50M+ | LOW — subjective, hard to model |
| **Economics/Commodities** | 200+ | $80M+ | **MEDIUM** — leading indicators |
| **AI/Tech** | 300+ | $40M+ | LOW — insider-dependent |

---

## II. EXPANSION PRIORITIES (Ranked by Expected ROI)

### PRIORITY 1: SPORTS — Cross-Platform Odds Arbitrage
**Edge type**: Stale pricing / sportsbook-vs-prediction-market spread
**Volume**: $500M+ across 3,100+ markets
**Implementation effort**: Medium (4-6 weeks)
**Expected edge**: 2-8% per opportunity, 2-5 trades/day

#### Why This Is the #1 Priority

Polymarket sports markets are priced by prediction market traders, NOT by sophisticated sportsbook algorithms. Meanwhile, traditional sportsbooks (DraftKings, FanDuel, BetMGM) have armies of quants pricing the same events. The inefficiency:

- **Polymarket prices update slower** than sportsbook lines after breaking news (injuries, lineup changes, weather delays)
- **Sportsbook-to-Polymarket arbitrage** windows last 30-120 seconds — long enough for a bot
- **NCAA/college sports** have the widest spreads because Polymarket liquidity is thinner
- March Madness alone generates $150M+ in Polymarket volume

#### Data Sources (All Free or Cheap)

| Source | Data | Latency | Cost |
|---|---|---|---|
| **The Odds API** | Lines from 15+ sportsbooks | Real-time | Free tier: 500 req/mo |
| **TheRundown API** | 30+ leagues, live odds | Sub-second | Free tier available |
| **OpticOdds** | Polymarket + sportsbooks unified | Real-time WebSocket | Paid but worth it |
| **ESPN API** | Scores, injuries, lineups | Near real-time | Free |
| **SportsGameOdds** | Cross-platform with Polymarket | Real-time | Free tier |

#### Strategy: The "Line Staleness" Bot

```
1. Subscribe to sportsbook odds via WebSocket (TheRundown/OpticOdds)
2. Monitor corresponding Polymarket markets via CLOB WebSocket
3. When sportsbook line moves >2% but Polymarket hasn't moved yet:
   a. Calculate implied probability from sportsbook consensus
   b. Compare to Polymarket price
   c. If edge > 3%: place limit order on Polymarket
4. Kelly-size the bet based on edge magnitude and liquidity
5. Auto-exit if Polymarket price converges within 2 hours
```

#### Sub-Strategies

- **Injury arbitrage**: Monitor Twitter/X injury feeds (Schefter, Woj, Shams). When a star player is ruled out, sportsbooks adjust in <30 seconds. Polymarket takes 2-5 minutes. That's our window.
- **In-game momentum**: Polymarket live sports markets lag real-time game flow. If a team goes on a 15-0 run in basketball, the Polymarket moneyline takes minutes to catch up.
- **March Madness/FIFA World Cup**: Highest volume events with thinnest Polymarket market-maker coverage. More retail traders = more mispricing.
- **Weather-impacted sports**: We ALREADY have weather models. Cross-reference NFL/MLB games in cities where we track weather. Rain delay? High wind? Our models know before the market does.

#### Why Not High School Sports?

Polymarket does NOT offer high school sports markets. Their sports coverage is limited to: NFL, NBA, MLB, NHL, NCAA (Football + Basketball), FIFA World Cup, UFC/MMA, Tennis majors, F1, and select international soccer leagues. No local or amateur events.

---

### PRIORITY 2: CRYPTO PRICE BRACKETS — On-Chain + Exchange Data Edge
**Edge type**: Technical analysis + order flow + on-chain metrics
**Volume**: $300M+ across 1,600+ markets (Bitcoin alone: $88M/month)
**Implementation effort**: Medium (3-4 weeks)
**Expected edge**: 3-6% per bracket

#### Why This Works

Polymarket offers daily/weekly Bitcoin price bracket markets identical in structure to our temperature brackets. Example: "Bitcoin price on March 26?" with brackets like "$82K-$84K", "$84K-$86K", etc.

The crowd prices these based on vibes and recent momentum. We can price them using:

1. **Real-time order book depth** from Binance/Coinbase (free WebSocket APIs)
2. **Options-implied volatility** from Deribit (tells us the actual expected range)
3. **On-chain whale movements** — large BTC transfers to exchanges signal selling pressure
4. **Funding rates** on perpetual futures — extreme rates predict mean reversion
5. **Technical indicators** — Bollinger Bands, RSI, VWAP on 1h/4h charts

#### Architecture Parallel to Weather

This is almost identical to our weather pipeline:

| Weather Pipeline | Crypto Pipeline |
|---|---|
| NWS forecast → high temp | Binance spot price → BTC price |
| GFS/ECMWF/ICON models | Deribit options IV, funding rates, order flow |
| Consensus = avg of models | Consensus = weighted avg of signals |
| Temperature brackets | Price brackets |
| Edge = true_prob − market_price | Edge = true_prob − market_price |

#### Data Sources

| Source | Data | Cost |
|---|---|---|
| **Binance WebSocket** | Real-time BTC/ETH price, order book | Free |
| **CoinGecko API** | Multi-exchange aggregated price | Free tier |
| **Glassnode / CryptoQuant** | On-chain metrics, whale alerts | Free tier limited |
| **Deribit API** | Options implied volatility, skew | Free |
| **Coinglass** | Funding rates, liquidation data | Free tier |

#### Implementation: `ingest-crypto.ts` + `analyze-crypto.ts`

Same scheduled function pattern as weather. Claude analyzes the signal stack against Polymarket brackets and identifies mispricings. Kelly sizes the bets.

---

### PRIORITY 3: ECONOMICS / COMMODITIES — Leading Indicator Edge
**Edge type**: Macro data releases + futures data
**Volume**: $80M+ (oil, CPI, jobs, Fed decisions)
**Implementation effort**: Low-Medium (2-3 weeks)
**Expected edge**: 5-12% around data releases

#### Why This Works

Economic data releases follow exact schedules (BLS jobs report = first Friday of month, CPI = ~10th of month). The market prices these events days in advance based on surveys and expectations. But:

- **Futures markets price in the data BEFORE the official release** (CME FedWatch, oil futures, Treasury yields)
- **"Whisper numbers"** from institutional surveys (Bloomberg, Reuters) are more accurate than consensus
- **Nowcasting models** (Atlanta Fed GDPNow, NY Fed) update in real-time with partial data

#### Key Markets

- "Will CPI come in above/below X%?" — Use Cleveland Fed median CPI nowcast
- "Will the Fed cut rates?" — Use CME FedWatch probability directly
- "Will oil hit $X?" — Use Brent futures + inventory data (EIA weekly)
- "Will unemployment rise above X%?" — Use initial claims trend + ADP pre-release

#### Strategy: "The Nowcaster"

For each economic event:
1. Pull the official consensus estimate (Bloomberg/Reuters survey)
2. Pull the nowcast/leading indicator (GDPNow, FedWatch, etc.)
3. If nowcast diverges from market-priced probability by >5%, bet the nowcast
4. Size aggressively on day-of because data is T-minus hours and nowcasts tighten

This is extremely high-conviction when it fires — economic nowcasts within 24 hours of release have >80% directional accuracy.

---

### PRIORITY 4: SPORTSBOOK-POLYMARKET PURE ARBITRAGE
**Edge type**: Sum-to-one / cross-platform pricing inconsistency
**Volume**: Scales with number of markets scanned
**Implementation effort**: Low (1-2 weeks for scanner)
**Expected edge**: 1-3% per trade, near-zero risk

#### How It Works

When Polymarket's YES + NO prices sum to less than $1.00, you can buy both sides and lock in a guaranteed profit at resolution. Example:

- Event: "Will Team X win?"
- Polymarket YES: $0.48, NO: $0.49
- Total: $0.97 → guaranteed $0.03 profit per $0.97 invested = 3.1% return

This also works cross-platform (Polymarket vs. Kalshi):
- Polymarket YES: $0.60
- Kalshi NO: $0.35 (which is Kalshi's YES at $0.65)
- Combined: $0.95 → 5.3% locked profit

#### Why Polymarket Is Especially Good for Arb

- **Polymarket fees**: 0.01% on trades (US) — essentially free
- **Kalshi fees**: ~0.7% — still viable for 2%+ arbs
- **Windows last longer** than sportsbook arb (minutes vs. seconds)
- **Arbitrage scanners find 100+ opportunities daily** with 2-8% spreads

#### Implementation: `arb-scanner.ts`

A lightweight scanner that:
1. Polls Polymarket CLOB API for all active sports/crypto markets
2. Checks YES + NO < $0.98 (2% threshold after fees)
3. Cross-references Kalshi API for the same event
4. If arb exists: place both legs simultaneously
5. Log and track guaranteed profit

---

### PRIORITY 5: AI-ENHANCED MULTI-MODEL ENSEMBLE (Cross-Cutting)
**Edge type**: Better probability estimation across ALL categories
**Volume**: Applies to entire portfolio
**Implementation effort**: Medium (ongoing)
**Expected edge**: +2-5% improvement on existing edge

#### Why Multi-Model Works

The top-performing Polymarket bots use ensemble approaches:
- GPT-4o (40%) + Claude (35%) + Gemini (25%) — trimmed mean aggregation
- One bot turned **$313 → $414,000 in one month** using this approach
- Another made **$116K in a single day** (52 trades, 83% win rate)

#### Our Advantage

We already have Claude in the pipeline. Adding:
1. **A second Claude call with different system prompts** (bull vs. bear framing)
2. **Structured data extraction** instead of free-form reasoning
3. **Historical calibration** — track Claude's predicted probabilities vs. actual outcomes and adjust

---

## III. CLOB API INTEGRATION — From Paper to Real Money

### Authentication Flow

```
1. Create Polymarket account + fund with USDC on Polygon
2. Generate API key (apiKey, secret, passphrase) via UI
3. Initialize ClobClient with signer + credentials
4. All orders are signed with HMAC-SHA256 (30s expiry)
```

### Rate Limits

| Endpoint Type | Limit |
|---|---|
| Public (market data) | 100 req/min per IP |
| Authenticated reads | 300 req/min |
| Trading (orders) | 60 orders/min per key |

### Order Types

- **Limit orders** (GTC — Good Till Cancelled): Our primary order type
- **Market orders**: Limit order with marketable price (instant fill)
- **PostOnly**: Ensures you're a maker (better fills, no taker fees)

### Libraries

- TypeScript: `@polymarket/clob-client` (npm)
- Python: `py-clob-client` (pip)
- Rust: `polymarket-client-sdk`

### Paper → Real Transition (Our Guardrails)

Current requirements before real money:
- 30 days of paper trading
- 50+ bets placed
- 58%+ win rate
- Max 5% single bet, 25% daily exposure
- Auto-pause after 5 consecutive losses

---

## IV. IMPLEMENTATION ROADMAP

### Phase 2A: Sports Odds Engine (Weeks 1-4)
- [ ] Integrate The Odds API / TheRundown for real-time sportsbook lines
- [ ] Create `ingest-sports-odds.ts` scheduled function (every 5 min)
- [ ] Map Polymarket sports markets to sportsbook events
- [ ] Build `analyze-sports-edge.ts` — compare sportsbook consensus to Polymarket prices
- [ ] Add `sports_odds` and `sports_analyses` Supabase tables
- [ ] Create Sports dashboard page (`/sports`)
- [ ] Wire up injury/news feed for latency advantage

### Phase 2B: Crypto Price Engine (Weeks 2-5)
- [ ] Integrate Binance WebSocket for real-time BTC/ETH prices
- [ ] Pull Deribit options IV + funding rates
- [ ] Create `ingest-crypto.ts` scheduled function (every 10 min)
- [ ] Match Polymarket BTC bracket markets (same tag_id lookup pattern)
- [ ] Build `analyze-crypto.ts` — technical + on-chain signal consensus
- [ ] Add `crypto_signals` and `crypto_analyses` Supabase tables
- [ ] Create Crypto dashboard page (`/crypto`)

### Phase 2C: Arbitrage Scanner (Weeks 1-2)
- [ ] Build `arb-scanner.ts` — scan all Polymarket markets for YES+NO < $0.98
- [ ] Cross-reference with Kalshi API
- [ ] Auto-alert on arb opportunities > 2%
- [ ] Create Arb dashboard page (`/arb`)

### Phase 2D: Economics Nowcaster (Weeks 3-6)
- [ ] Build calendar of scheduled economic releases (BLS, Fed, EIA)
- [ ] Integrate CME FedWatch, GDPNow, Cleveland Fed Nowcast
- [ ] Create `ingest-econ.ts` — pull leading indicators 24h before release
- [ ] Build `analyze-econ.ts` — nowcast vs. Polymarket pricing
- [ ] Add `econ_signals` and `econ_analyses` Supabase tables

### Phase 3: CLOB Integration & Live Trading (Week 6+)
- [ ] Integrate `@polymarket/clob-client` TypeScript SDK
- [ ] Build order placement module (`src/lib/clob.ts`)
- [ ] Implement paper order execution (simulated fills at market price)
- [ ] Add live order placement behind guardrail gate
- [ ] WebSocket connection for real-time order status
- [ ] Build unified portfolio/PnL tracker

### Phase 3B: Existing Weather Enhancements
- [ ] Precipitation probability engine (rain/snow markets)
- [ ] Historical model weighting (ECMWF has been 2°F more accurate historically)
- [ ] Record temperature detection (extreme events = mispriced markets)
- [ ] Wind chill / heat index markets

---

## V. REVENUE PROJECTIONS (Conservative)

Assuming $500 paper bankroll, 25% Kelly, scaling after 30-day gate:

| Vertical | Monthly Bets | Avg Edge | Win Rate | Est. Monthly PnL |
|---|---|---|---|---|
| Weather (current) | 60 | 8% | 62% | $25-40 |
| Sports odds arb | 100 | 4% | 58% | $40-80 |
| Crypto brackets | 80 | 5% | 57% | $30-60 |
| Pure arbitrage | 50 | 2% | 95% | $15-25 |
| Economics | 15 | 10% | 65% | $20-40 |
| **TOTAL** | **305** | | | **$130-245/mo** |

After bankroll grows (compound): ~$500-1,000/mo within 3 months, scaling from there.

With real money and larger bankroll ($5,000+), these numbers multiply 10x.

---

## VI. COMPETITIVE MOAT

Why ARBITER can win:

1. **Multi-source consensus** — We don't guess. We aggregate 4+ data sources per vertical and let disagreement tell us when NOT to bet.
2. **Speed** — Scheduled functions running every 5-20 minutes catch mispricings that manual traders miss entirely.
3. **Discipline** — Kelly sizing + guardrails prevent the #1 cause of prediction market failure: overconfidence and overleveraging.
4. **Compounding architecture** — Every resolved bet improves our calibration data. After 500 bets, we'll know exactly how much to trust each signal source.
5. **Cross-vertical intelligence** — Weather data improves sports predictions (outdoor games). Crypto volatility predicts economic market pricing. Everything feeds everything.

---

## VII. IMMEDIATE NEXT STEPS

1. **Verify weather pipeline is producing signals** — Check if `analyze-weather.ts` has generated any analyses in the last 24 hours
2. **Tag discovery for sports + crypto** — Use the same `/tags/slug/{slug}` → `tag_id` → `/events?tag_id=X` pattern to discover sports and crypto markets
3. **Stand up The Odds API integration** — Free tier gives us 500 requests/month, enough to prototype the sports edge engine
4. **Build `ingest-crypto.ts`** — Binance WebSocket → BTC price + volume → compare to Polymarket brackets
5. **Build `arb-scanner.ts`** — Lowest effort, highest certainty. Guaranteed profit from sum-to-one violations.

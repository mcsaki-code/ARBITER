# ARBITER V3 — Weather-Only Master Spec

**Version**: 3.0
**Effective**: 2026-04-04
**Author**: Matt Csaki + Claude
**Status**: ACTIVE — Paper trading, weather markets only

---

## 1. MISSION

ARBITER V3 is a focused, automated weather prediction market trading system. It finds mispriced weather contracts on Polymarket, evaluates edge using multi-model forecast ensembles + Claude AI analysis, and places paper bets using Kelly-criterion sizing. Every non-weather category (sports, crypto, politics, sentiment, arbitrage) has been stripped from the pipeline, frontend, and API layer.

**The thesis**: Weather markets are inefficient because (1) retail bettors rely on outdated or single-source forecasts, (2) Polymarket's bracket structure creates opportunities at the tails, and (3) ensemble forecast consensus from 5+ NWP models provides a statistical edge that the market doesn't price in.

---

## 2. SYSTEM ARCHITECTURE

```
GitHub (main) → Netlify (auto-deploy ~2min) → Supabase (PostgreSQL)
                    ↓
         7 Scheduled Functions (cron)
                    ↓
    ┌─────────────────────────────────────────┐
    │  1. REFRESH MARKETS      (every 30 min) │
    │  2. INGEST WEATHER       (every 15 min) │
    │  3. ANALYZE WEATHER      (every 20 min) │
    │  4. PLACE BETS           (every 15 min) │
    │  5. RESOLVE BETS         (every hour)   │
    │  6. REPAIR BETS          (every 15 min) │
    │  7. PERFORMANCE SNAPSHOT (daily)        │
    └─────────────────────────────────────────┘
```

### Live URLs
- **Frontend**: https://arbit3r.netlify.app
- **Supabase**: Project ID `kntdxewgksmvnkynzgyx`
- **Netlify**: Site ID `9e4df4b0-09b1-43d7-a120-4ede5174e236`
- **GitHub**: github.com/mcsaki-code/ARBITER

### Tech Stack
- **Frontend**: Next.js 14.1 + React 18 + Tailwind CSS + Recharts
- **Database**: Supabase PostgreSQL (RLS enabled)
- **AI**: Anthropic Claude (claude-sonnet-4-20250514) for edge analysis
- **Hosting**: Netlify Pro — 7 active cron functions + frontend
- **Trading**: @polymarket/clob-client + viem (Polygon) — paper mode
- **Weather Data**: NWS API, Open-Meteo (GFS/ECMWF/ICON/HRRR/Ensemble)
- **Notifications**: Resend (email on bet placement)

---

## 3. PIPELINE — STAGE BY STAGE

### Stage 1: REFRESH MARKETS (refresh-markets.ts)
**Schedule**: Every 30 minutes
**Purpose**: Discover and track weather bracket markets on Polymarket

- Queries Gamma API for active events matching weather/temperature keywords
- Filters out sports, crypto, politics using keyword allowlist/denylist
- Upserts into `markets` table with `condition_id` as conflict key
- Stores `gamma_market_id` (Gamma's numeric ID) — critical for resolution lookups
- Matches markets to tracked cities using fuzzy keyword matching
- Marks expired markets as inactive (resolution_date < now)
- Marks stale markets as inactive (not refreshed in 2 hours)

**Key data stored**: question, category (temperature/precipitation/weather), city_id, outcomes, outcome_prices, volume_usd, liquidity_usd, resolution_date, gamma_market_id

### Stage 2: INGEST WEATHER (ingest-weather.ts)
**Schedule**: Every 15 minutes
**Purpose**: Fetch multi-model forecast data for all tracked cities

- Pulls forecasts from 5 NWP models via NWS API and Open-Meteo:
  - **GFS** (Global Forecast System) — US primary
  - **ECMWF** (European Centre) — global gold standard
  - **ICON** (DWD Germany) — strong European/global coverage
  - **HRRR** (High-Resolution Rapid Refresh) — US short-range
  - **Ensemble** (GFS Ensemble mean) — uncertainty quantification
- Stores hourly/daily forecasts in `weather_forecasts`
- Builds consensus from available models in `weather_consensus`
- Consensus fields: temp_high, temp_low, precip_probability, precip_amount, model_agreement score

### Stage 3: ANALYZE WEATHER (analyze-weather.ts)
**Schedule**: Every 20 minutes
**Purpose**: Claude AI evaluates edge on weather markets using forecast data

- Fetches active weather markets with sufficient liquidity ($400+)
- For each market, retrieves latest forecast consensus for the city
- Sends structured prompt to Claude with:
  - Market question and current prices
  - Multi-model forecast data (individual models + consensus)
  - Historical accuracy context
  - Ensemble agreement score
- Claude returns: predicted probability, edge vs market, confidence level, direction (BUY_YES/BUY_NO/PASS), Kelly fraction, reasoning
- Stores analysis in `weather_analyses` table
- Ensemble metadata stored: ensemble_agreement_score, ensemble_used_models

### Stage 4: PLACE BETS (place-bets.ts)
**Schedule**: Every 15 minutes
**Purpose**: Convert high-edge analyses into paper bets through risk management

**Analysis Selection**:
- Queries `weather_analyses` from last 2 hours
- Filters: edge > 8%, direction != PASS, not already bet
- Sorts by edge descending (best opportunities first)
- Deduplicates: 1 bet per market, no open positions on same market

**Risk Management Rules**:
| Rule | Value | Rationale |
|------|-------|-----------|
| Max single bet | 3% of bankroll | Prevent catastrophic single-bet loss |
| Max daily exposure | 20% of bankroll | Capital preservation |
| Max bets per day | 15 | Prevent over-betting on marginal edges |
| Max bets per market | 1 | No position doubling |
| Min edge (weather) | 8% | Higher threshold for weather uncertainty |
| Min liquidity | $400 | Ensure market is tradeable |
| Max analysis age | 2 hours | Forecasts update frequently |
| Min entry price | $0.02 | Below = adverse selection |
| Max entry price | $0.40 | ALL historical bets >40c lost |

**Sizing (1/8th Kelly)**:
- Base: Kelly fraction from Claude analysis, capped at 3.5%
- Confidence scaling: HIGH = 0.8x, MEDIUM = 0.5x, LOW = 0.3x
- Tail bet boost: entries < $0.15 get 1.5x sizing (asymmetric payoff)
- Floor: $2 minimum bet
- Final fraction applied to current bankroll

**Orderbook Validation** (first 8 bets per cycle):
- Checks CLOB orderbook for live spread
- Rejects if spread > 40% of edge
- Rejects if slippage > 20% of bet amount
- Updates entry price if real-time price differs >3c from analysis

**Entry Price Logic**:
- BUY_YES: entry_price = Yes price from market
- BUY_NO: entry_price = 1 - Yes price (we're buying the No side)
- Both directions enforced within [0.02, 0.40] bounds

### Stage 5: RESOLVE BETS (resolve-bets.ts)
**Schedule**: Hourly
**Purpose**: Check settled markets and compute P&L

**CRITICAL — Resolution Detection**:
- Uses `resolvedBy` field from Polymarket's UMA Optimistic Oracle V2
- `resolvedBy` = null → market NOT yet resolved (still in oracle process)
- `resolvedBy` = Ethereum address → officially settled by oracle
- NEVER uses `closed` field (closed = trading stopped, NOT resolved)

**Gamma API Strategy**:
- Uses `/markets/{gamma_market_id}` endpoint (numeric ID lookup)
- DOES NOT use `?condition_id=0x...` filter (broken — returns random legacy markets)
- Batches API calls in groups of 5 with Promise.all

**Outcome Determination**:
- Parses outcome_prices array — winning outcome has price ~1.0
- Requires max price >= 0.98 (ensures oracle fully settled, not mid-dispute)
- outcomes=["Yes","No"], outcome_prices=[1,0] → Yes won
- outcomes=["Yes","No"], outcome_prices=[0,1] → No won

**P&L Calculation**:
- Win: `amount_usd * ((1.0 / entry_price) - 1)` — e.g., buy at $0.10, win = 9x profit
- Loss: `-amount_usd` — lose entire stake
- Safety cap: if winning P&L > 200x stake, cap and log for review
- Brier score tracked for calibration quality

**BUY_NO Logic**:
- BUY_NO + outcome_label = "No" → we win when "No" wins
- BUY_NO + outcome_label = anything else → we win when that outcome does NOT win

**Bankroll Update**:
- Only V3 bets (placed after v3_start_date) affect bankroll
- Pre-V3 bets resolved but excluded from bankroll calculation

### Stage 6: REPAIR BETS (repair-bets.ts)
**Schedule**: Every 15 minutes
**Purpose**: Backfill missing condition_ids on open bets

- Finds OPEN bets where condition_id is null (transient Supabase failures)
- Joins to markets table and backfills condition_id
- Idempotent — safe to run repeatedly

### Stage 7: PERFORMANCE SNAPSHOT (performance-snapshot.ts)
**Schedule**: Daily at midnight UTC
**Purpose**: Aggregate daily performance metrics

- Computes: total bets, wins, losses, win rate, total P&L, current bankroll
- Filters to V3 epoch only (bets after v3_start_date)
- Stores in `performance_snapshots` table for historical tracking

---

## 4. DATABASE SCHEMA (Active Tables)

### Core Pipeline
| Table | Purpose | Key Fields |
|-------|---------|------------|
| `markets` | Polymarket weather contracts | condition_id, gamma_market_id, question, category, city_id, outcomes, outcome_prices, volume_usd, liquidity_usd, resolution_date, is_active |
| `bets` | All paper bets placed | market_id, analysis_id, category, direction, outcome_label, amount_usd, entry_price, status (OPEN/WON/LOST/CANCELLED), pnl, placed_at |
| `system_config` | Key-value runtime config | paper_bankroll, v3_start_date, v3_bankroll |
| `performance_snapshots` | Daily P&L snapshots | date, total_bets, wins, losses, win_rate, total_pnl, bankroll |

### Weather Data
| Table | Purpose | Key Fields |
|-------|---------|------------|
| `weather_cities` | Tracked city definitions | name, latitude, longitude, timezone |
| `weather_forecasts` | Raw model forecasts per city | city_id, model_source, forecast_date, temp_high, temp_low, precip_prob |
| `weather_consensus` | Multi-model consensus | city_id, forecast_date, temp_high, temp_low, precip_probability, model_agreement |
| `weather_analyses` | Claude AI analysis per market | market_id, predicted_prob, edge, confidence, direction, kelly_fraction, reasoning, ensemble_agreement_score, ensemble_used_models |

### Legacy (Inactive — data preserved)
sports_odds, sports_analyses, crypto_signals, crypto_analyses, arb_opportunities

---

## 5. FRONTEND

### Active Pages
| Route | Purpose |
|-------|---------|
| `/` | Dashboard — pipeline status, open bets, weather signals, bankroll |
| `/weather` | Weather forecasts, consensus data, city tracking |
| `/performance` | Bet history, P&L chart, win rate, Brier score |
| `/markets` | Active weather market browser (deep-dive view, not in nav) |

### Navigation
Dashboard | Weather | Performance (3 items only)

### Disabled Routes
`/sports`, `/crypto`, `/politics`, `/sentiment`, `/arb` — all redirect to `/`

### Disabled API Routes
`/api/sports`, `/api/crypto`, `/api/politics`, `/api/sentiment` — return `{ message: "V3: Weather-only system. This endpoint is disabled." }`

---

## 6. WHALE STRATEGY INSIGHTS

Based on analysis of gopfan2 ($2M+ Polymarket profit on weather):

1. **Tail bets**: Best returns come from entries < $0.15 (10x-27x payout potential)
2. **Entry timing**: 24-48 hours before resolution is the sweet spot
3. **Ensemble edge**: Multi-model forecast consensus finds mispricing the market misses
4. **Position sizing**: 1/8th Kelly fraction balances growth vs drawdown
5. **Price ceiling**: No entries above $0.40 — historical 100% loss rate above this threshold
6. **Bracket structure**: Weather brackets create natural tail opportunities (extremes are mispriced)

---

## 7. RISK CONTROLS

### Bet-Level
- 3% bankroll cap per bet
- $0.02-$0.40 entry price window
- 8% minimum edge threshold
- $400 minimum liquidity
- Orderbook spread/slippage validation

### Daily-Level
- 20% daily exposure cap
- 15 bets/day maximum
- 1 bet per market (no doubling)

### System-Level
- Paper trading only (LIVE_TRADING_ENABLED = false)
- V3 epoch isolation — pre-V3 bets don't affect bankroll
- Circuit breaker tracks consecutive losses
- 200x P&L cap prevents corrupt data inflation
- Resolution requires `resolvedBy` oracle confirmation (not just market close)
- Resolution price threshold 0.98+ (oracle must be fully settled)

---

## 8. KNOWN LIMITATIONS & FUTURE WORK

### Accepted Risks
- Bankroll read-modify-write is not atomic (acceptable for hourly cron; needs atomic UPDATE for live trading)
- Concurrent place-bets instances could theoretically duplicate (low risk with 15-min cron spacing)
- Win rate query includes all post-V3 categories (only weather exists, so this is fine)

### Future Enhancements
- **Multi-model AI ensemble**: GPT-4o + Claude + Gemini weighted consensus for analysis
- **Railway migration**: Move from Netlify crons to persistent workers for continuous monitoring
- **Live trading**: Enable LIVE_TRADING_ENABLED flag once paper P&L proves positive
- **Gaussian statistical analyzer**: Re-enable analyze-temperature.ts as supplementary signal
- **Precipitation expansion**: Deeper analysis on precip/snowfall markets (currently 60 active)
- **International cities**: Expand tracked cities beyond US + major international

---

## 9. ENV VARS

| Variable | Required | Purpose |
|----------|----------|---------|
| ANTHROPIC_API_KEY | Yes | Claude API for weather analysis |
| NEXT_PUBLIC_SUPABASE_URL | Yes | Supabase project URL |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Yes | Supabase anonymous key (frontend) |
| SUPABASE_SERVICE_ROLE_KEY | Yes | Supabase service key (functions) |
| POLYMARKET_PRIVATE_KEY | No | Polygon wallet for live trading |
| POLYGON_RPC_URL | No | Polygon RPC endpoint |
| LIVE_TRADING_ENABLED | No | Enable live trading (default: false) |
| RESEND_API_KEY | No | Email notifications |
| NOTIFICATION_EMAIL | No | Where to send bet alerts |

---

## 10. DEPLOYMENT

```bash
git add -A && git commit -m "message" && git push origin main
```

Netlify auto-deploys from `main` in ~2 minutes. All 7 scheduled functions deploy as part of the build.

### Git Clone Location
Active development clone: `/sessions/relaxed-jolly-maxwell/arbiter-v3`
Mounted workspace: `/sessions/relaxed-jolly-maxwell/mnt/PolyMarket/arbiter`

---

## 11. CRITICAL GOTCHAS

1. **Netlify sync functions have 10-15s timeout** — use Promise.all() for parallel calls
2. **Claude sometimes returns edge as 849 instead of 0.849** — normalizeEdge() handles this
3. **system_config stores values as strings** — always parseFloat() the bankroll
4. **Gamma API condition_id filter is BROKEN** — MUST use `/markets/{numeric_id}` endpoint
5. **`closed` != `resolved` in Polymarket** — only `resolvedBy` means oracle has settled
6. **outcome_prices interpretation**: outcomes=["Yes","No"], prices=[0,1] means No won
7. **Multiple weather markets can exist per city** — always match on market_id, not city_id
8. **Use service role key in functions, anon key in frontend**

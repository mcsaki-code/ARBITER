# ARBITER — Complete Project Documentation

> AI-Powered Prediction Market Edge Detection System
> Live at: https://arbit3r.netlify.app

---

## 1. Architecture Overview

ARBITER is a fully automated prediction market trading system that ingests data, analyzes it with AI (Claude), places paper bets, and tracks performance. It runs entirely on three services:

```
┌─────────────────────────────────────────────────────────┐
│                    YOUR COMPUTER                         │
│  Terminal → git push origin main                        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                     GITHUB                               │
│  Repo: mattcsaki/arbiter (private)                      │
│  Branch: main                                            │
│  Auto-deploys to Netlify on push                        │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
┌──────────────────┐  ┌──────────────────────────────────┐
│     NETLIFY      │  │          SUPABASE                 │
│  Pro Plan $20/mo │  │  Project: kntdxewgksmvnkynzgyx   │
│                  │  │                                    │
│  • Next.js app   │  │  • PostgreSQL database             │
│  • 11 scheduled  │  │  • 11 tables                       │
│    functions     │  │  • Row-level security enabled      │
│  • API routes    │  │  • Real-time subscriptions         │
└──────────────────┘  └──────────────────────────────────┘
```

### Data Flow Pipeline

```
1. INGEST (every 10-15 min)
   ├── refresh-markets     → Polymarket API → markets table
   ├── ingest-weather      → NWS/GFS/ECMWF/ICON/HRRR/Ensemble → weather_forecasts + weather_consensus
   ├── ingest-sports-odds  → Sportsbook APIs → sports_odds
   └── ingest-crypto       → Price/Volume APIs → crypto_signals

2. ANALYZE (every 20-30 min)
   ├── analyze-weather     → Claude AI → weather_analyses
   ├── analyze-sports-edge → Claude AI → sports_analyses
   ├── analyze-crypto      → Claude AI → crypto_analyses
   └── arb-scanner         → Price comparison → arb_opportunities

3. EXECUTE (every 15 min)
   └── place-bets          → Filters + Kelly sizing → bets table

4. RESOLVE (every 1 hour)
   └── resolve-bets        → Check market outcomes → update bets (pnl, status)

5. SNAPSHOT (daily at midnight)
   └── performance-snapshot → Aggregate stats → performance_snapshots
```

---

## 2. Infrastructure Details

### Netlify (Frontend + Functions)
- **Plan**: Pro ($20/month)
- **Site ID**: `9e4df4b0-09b1-43d7-a120-4ede5174e236`
- **Site name**: arbit3r
- **URL**: https://arbit3r.netlify.app
- **Team**: ChangeCraft (slug: mattcsaki)
- **Build command**: `npm run build`
- **Publish directory**: `.next`
- **Node version**: 20
- **Function bundler**: esbuild

### Supabase (Database)
- **Project ID**: `kntdxewgksmvnkynzgyx`
- **Region**: (check Supabase dashboard)
- **URL**: `https://kntdxewgksmvnkynzgyx.supabase.co`
- **Tables**: 11 (see Database Schema section)
- **RLS**: Enabled on all tables

### GitHub
- **Repo**: Private, connected to Netlify for auto-deploy
- **Branch**: `main` (production)
- **Deploy trigger**: Push to `main`

---

## 3. Environment Variables

These must be set in **Netlify → Site Settings → Environment Variables**.

### Required

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `ANTHROPIC_API_KEY` | Claude API key for AI analysis | https://console.anthropic.com/settings/keys |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Supabase dashboard → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key (public) | Supabase dashboard → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (secret) | Supabase dashboard → Settings → API |

### Optional — Live Trading

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `POLYMARKET_PRIVATE_KEY` | Polygon wallet private key (0x...) | Polymarket → Settings → Advanced → Export |
| `POLYGON_RPC_URL` | Polygon RPC endpoint | Alchemy, Infura, or `https://polygon-rpc.com` |
| `LIVE_TRADING_ENABLED` | Set to `"true"` to enable real trades | Manual toggle |

### Optional — Notifications

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `RESEND_API_KEY` | Email notification API key | https://resend.com (100 free emails/day) |
| `NOTIFICATION_EMAIL` | Where to send bet alerts | Your email address |

---

## 4. Netlify Scheduled Functions

All functions live in `netlify/functions/`. Each uses `@netlify/functions` `schedule()`.

| Function | Schedule | Purpose |
|----------|----------|---------|
| `refresh-markets.ts` | `*/30 * * * *` (every 30 min) | Fetch active Polymarket markets → `markets` table |
| `ingest-weather.ts` | `*/15 * * * *` (every 15 min) | Fetch NWS/GFS/ECMWF/ICON/HRRR/Ensemble forecasts → `weather_forecasts` + `weather_consensus` |
| `ingest-sports-odds.ts` | `*/10 * * * *` (every 10 min) | Fetch sportsbook odds → `sports_odds` |
| `ingest-crypto.ts` | `*/10 * * * *` (every 10 min) | Fetch crypto prices/volume → `crypto_signals` |
| `analyze-weather.ts` | `*/20 * * * *` (every 20 min) | Claude analyzes weather markets → `weather_analyses` |
| `analyze-sports-edge.ts` | `*/30 * * * *` (every 30 min) | Claude analyzes sports markets → `sports_analyses` |
| `analyze-crypto.ts` | `*/30 * * * *` (every 30 min) | Claude analyzes crypto markets → `crypto_analyses` |
| `arb-scanner.ts` | `*/15 * * * *` (every 15 min) | Scan for YES+NO arbitrage → `arb_opportunities` |
| `place-bets.ts` | `*/15 * * * *` (every 15 min) | Execute bets from analyses → `bets` |
| `resolve-bets.ts` | `0 * * * *` (every hour) | Check resolved markets → update `bets` pnl/status |
| `performance-snapshot.ts` | `0 0 * * *` (midnight daily) | Daily P&L snapshot → `performance_snapshots` |

---

## 5. Frontend Pages

| Route | File | Description |
|-------|------|-------------|
| `/` | `src/app/page.tsx` | Dashboard — bankroll, AI picks, live positions, system status |
| `/sports` | `src/app/sports/page.tsx` | Sports markets + AI edge analysis |
| `/crypto` | `src/app/crypto/page.tsx` | Crypto markets + AI price predictions |
| `/weather` | `src/app/weather/page.tsx` | Weather markets + forecast consensus |
| `/arb` | `src/app/arb/page.tsx` | Arbitrage opportunity scanner |
| `/tracker` | `src/app/tracker/page.tsx` | Results — bet history + P&L tracking |
| `/analytics` | `src/app/analytics/page.tsx` | Performance analytics + charts |
| `/markets` | `src/app/markets/page.tsx` | All Polymarket markets browser |

### API Routes (`src/app/api/`)

| Route | Method | Description |
|-------|--------|-------------|
| `/api/bets` | GET | List all bets |
| `/api/signals` | GET | Weather city signals + edge opportunities |
| `/api/sports` | GET | Sports markets + analyses |
| `/api/crypto` | GET | Crypto markets + analyses |
| `/api/weather` | GET | Weather data + consensus |
| `/api/markets` | GET | All Polymarket markets |
| `/api/arb` | GET | Arbitrage opportunities |
| `/api/config` | GET | System configuration |
| `/api/orders` | GET | Live trade orders |
| `/api/resolve` | POST | Manual bet resolution trigger |
| `/api/trigger/bets` | POST | Manual bet placement trigger |

---

## 6. Database Schema (Supabase)

### Core Tables

**`markets`** (12,636 rows) — All Polymarket markets
- `id` (uuid PK), `condition_id`, `question`, `category`, `city_id` (FK), `outcomes[]`, `outcome_prices[]`, `volume_usd`, `liquidity_usd`, `resolution_date`, `is_active`, `is_resolved`, `resolution_val`, `market_type`

**`bets`** (2 rows) — All placed bets (paper + live)
- `id` (uuid PK), `market_id` (FK), `analysis_id` (FK), `placed_at`, `category`, `direction`, `outcome_label`, `entry_price`, `amount_usd`, `is_paper`, `exit_price`, `pnl`, `status` (OPEN/WON/LOST), `resolved_at`, `notes`
- Live trade fields: `clob_order_id`, `transaction_hash`, `filled_price`, `filled_size`, `condition_id`, `token_id`, `order_status`

**`system_config`** (20 rows) — Key-value configuration
- `key` (text PK), `value`, `updated_at`
- Important keys: `paper_bankroll`, `paper_trade_start_date`, `total_paper_bets`, `live_trading_enabled`, `live_kill_switch`, `live_max_single_bet_usd`, `live_max_daily_usd`

### Weather Tables

**`weather_cities`** (61 rows) — Cities tracked for weather markets
- `id`, `name`, `lat`, `lon`, `nws_office`, `nws_grid_x`, `nws_grid_y`, `timezone`, `is_active`

**`weather_forecasts`** (227,606 rows) — Individual model forecasts
- `id`, `city_id` (FK), `fetched_at`, `valid_date`, `source` (nws/gfs/ecmwf/icon/hrrr), `temp_high_f`, `temp_low_f`, `precip_prob`, `precip_mm`, `rain_mm`, `snowfall_cm`, `wind_speed_max`, `wind_gust_max`, `cloud_cover_pct`, `weather_code`

**`weather_consensus`** (58,763 rows) — Multi-model consensus
- `id`, `city_id` (FK), `valid_date`, `consensus_high_f`, `consensus_low_f`, `model_spread_f`, `agreement` (HIGH/MEDIUM/LOW), `models_used[]`, `precip_consensus_mm`, `precip_agreement`, `snowfall_consensus_cm`, `ensemble_members`, `ensemble_prob_above` (jsonb), `ensemble_prob_below` (jsonb)

**`weather_analyses`** (1 row) — AI analysis results
- `id`, `market_id` (FK), `city_id` (FK), `consensus_id` (FK), `model_high_f`, `model_spread_f`, `model_agreement`, `market_type`, `best_outcome_idx`, `best_outcome_label`, `market_price`, `true_prob`, `edge`, `direction`, `confidence`, `kelly_fraction`, `rec_bet_usd`, `reasoning`, `auto_eligible`, `ensemble_prob`, `ensemble_edge`, `precip_consensus`

### Sports & Crypto Tables

**`sports_analyses`** (7 rows) — AI sports edge analysis
- `id`, `market_id` (FK), `event_description`, `sport`, `sportsbook_consensus`, `polymarket_price`, `edge`, `direction`, `confidence`, `kelly_fraction`, `rec_bet_usd`, `reasoning`, `data_sources[]`, `auto_eligible`

**`crypto_analyses`** (12 rows) — AI crypto analysis
- `id`, `market_id` (FK), `signal_id` (FK), `asset`, `spot_at_analysis`, `target_bracket`, `bracket_prob`, `market_price`, `edge`, `direction`, `confidence`, `kelly_fraction`, `rec_bet_usd`, `reasoning`, `auto_eligible`

**`arb_opportunities`** (0 rows) — Detected arbitrage opportunities
- `id`, `market_a_id`, `market_b_id`, `platform_a`, `platform_b`, `event_question`, `price_yes`, `price_no`, `combined_cost`, `gross_edge`, `net_edge`, `volume_a/b`, `liquidity_a/b`, `category`, `status`, `pnl`

**`performance_snapshots`** (0 rows) — Daily performance history
- `id`, `snapshot_date`, `total_bets`, `wins`, `losses`, `win_rate`, `total_pnl`, `paper_bankroll`, `real_bankroll`

---

## 7. Key Libraries (`src/lib/`)

| File | Purpose |
|------|---------|
| `supabase.ts` | Supabase client initialization |
| `claude.ts` | Anthropic API wrapper |
| `polymarket.ts` | Polymarket CLOB API integration |
| `clob.ts` | Polymarket order book client |
| `wallet.ts` | Polygon wallet management |
| `execute-bet.ts` | Bet execution (paper + live routing) |
| `kelly.ts` | Kelly Criterion bet sizing |
| `guardrails.ts` | Risk management rules |
| `consensus.ts` | Weather model consensus calculation |
| `nws.ts` | National Weather Service API |
| `open-meteo.ts` | Open-Meteo API (GFS/ECMWF/ICON/HRRR/Ensemble) |
| `notify.ts` | Email notifications via Resend |
| `types.ts` | Shared TypeScript types |

---

## 8. Risk Management Parameters

Defined in `netlify/functions/place-bets.ts`:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `MAX_SINGLE_BET_PCT` | 3% | Max bet as % of bankroll |
| `MAX_DAILY_EXPOSURE_PCT` | 20% | Max total daily exposure |
| `MAX_DAILY_BETS_AUTO` | 15 | Max automated bets per day |
| `MAX_BETS_PER_MARKET` | 1 | One bet per market |
| `MIN_EDGE` | 5% | Minimum edge for sports/crypto |
| `MIN_EDGE_WEATHER` | 8% | Minimum edge for weather |
| `MIN_LIQUIDITY` | $5,000 | Skip thin markets |
| `KELLY_FRACTION` | 0.125 | 1/8th Kelly (conservative) |
| `MAX_ANALYSIS_AGE_MS` | 2 hours | Max staleness for analyses |

### Bet Filters (in order)
1. Already have open position on this market → skip
2. Already bet on this market today → skip
3. Analysis too old (>2h) → skip
4. Market inactive → skip
5. Liquidity < $5,000 → skip
6. Resolution < 1 hour away → skip
7. Edge < 2x estimated spread → skip
8. Not auto_eligible AND not medium-eligible → skip
9. Entry price ≥ 0.995 (no profit) → skip
10. Entry price ≤ 0.005 (invalid) → skip

---

## 9. Deployment Guide

### Standard Deploy (what you do now)
```bash
cd ~/PolyMarket/arbiter
git add -A
git commit -m "your commit message"
git push origin main
# Netlify auto-deploys within ~2 minutes
```

### Manual Trigger (if needed)
Go to: https://app.netlify.com/projects/arbit3r → Deploys → Trigger deploy

### Checking Logs
- **Build logs**: Netlify dashboard → Deploys → click latest deploy
- **Function logs**: Netlify dashboard → Logs & metrics → Functions
- **Database**: Supabase dashboard → SQL Editor

---

## 10. Backup & Recovery

### Database Backup
Supabase provides daily automatic backups on paid plans. For manual backup:
```sql
-- Export all bets
SELECT * FROM bets ORDER BY placed_at DESC;

-- Export system config
SELECT * FROM system_config;

-- Export performance history
SELECT * FROM performance_snapshots ORDER BY snapshot_date DESC;
```

### Code Backup
Your code is backed up in GitHub. To clone fresh:
```bash
git clone <your-repo-url> arbiter
cd arbiter
npm install
cp .env.local.example .env.local
# Fill in your API keys in .env.local
npm run dev  # Local development at localhost:3000
```

### Critical Secrets to Save Separately
Store these somewhere safe (password manager, etc.):
1. `ANTHROPIC_API_KEY` — Claude API access
2. `SUPABASE_SERVICE_ROLE_KEY` — Full database access
3. `POLYMARKET_PRIVATE_KEY` — Controls your trading wallet funds
4. `RESEND_API_KEY` — Email notifications

---

## 11. Future: Railway Migration Plan

When you're ready to add continuous news monitoring or need longer function execution times:

### What moves to Railway
- All 11 scheduled functions (`netlify/functions/*.ts`)
- Convert from `schedule()` wrappers to standard Node.js cron (using `node-cron`)
- Run as a single persistent worker process

### What stays on Netlify
- Next.js frontend (pages + API routes)
- Static asset serving
- SSL/CDN

### Migration Steps
1. Create Railway project (you've already done this)
2. Add a `worker/` directory with a single `index.ts` that imports all function logic
3. Use `node-cron` to schedule each function
4. Set the same environment variables in Railway
5. Deploy worker to Railway
6. Remove `schedule()` wrappers from Netlify functions (keep them as manual API triggers only)
7. Test that cron jobs fire correctly in Railway logs

### Railway Environment Variables (same as Netlify)
```
ANTHROPIC_API_KEY=sk-ant-...
NEXT_PUBLIC_SUPABASE_URL=https://kntdxewgksmvnkynzgyx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### Cost Estimate
- Railway worker: ~$5/month (usage-based, 15-min cron jobs are cheap)
- Netlify Pro: $20/month (frontend only)
- Supabase: Free tier (or $25/month for Pro if you need more)
- Total: ~$25-50/month

---

## 12. Tech Stack Summary

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | Next.js | 14.1.0 |
| UI | React + Tailwind CSS | 18.2 / 3.4 |
| Charts | Recharts | 2.10 |
| Database | Supabase (PostgreSQL) | Latest |
| AI | Anthropic Claude | claude-sonnet-4-20250514 |
| Hosting | Netlify Pro | - |
| Trading | @polymarket/clob-client | 5.8 |
| Blockchain | viem (Polygon) | 2.21 |
| Language | TypeScript | 5.3 |

---

## 13. Common Operations

### Check if functions are running
```sql
-- Recent weather analyses (should have entries every 20 min)
SELECT analyzed_at, city_id, edge, direction FROM weather_analyses ORDER BY analyzed_at DESC LIMIT 5;

-- Recent bets placed
SELECT placed_at, category, direction, amount_usd, status FROM bets ORDER BY placed_at DESC LIMIT 10;

-- System config
SELECT * FROM system_config ORDER BY key;
```

### Reset paper trading
```sql
UPDATE system_config SET value = '500' WHERE key = 'paper_bankroll';
UPDATE system_config SET value = '0' WHERE key = 'total_paper_bets';
DELETE FROM system_config WHERE key = 'paper_trade_start_date';
DELETE FROM bets;
DELETE FROM performance_snapshots;
```

### Force a bet scan now
```
POST https://arbit3r.netlify.app/api/trigger/bets
```

---

*Last updated: March 22, 2026*
*Project owner: Matt Csaki (mattcsaki@gmail.com)*

# ARBITER V3 — Project Instructions for Claude

You are working on ARBITER V3, a **weather-only** AI-powered prediction market trading system. The owner is Matt Csaki (mattcsaki@gmail.com).

**Full specification**: See `V3_WEATHER_SPEC.md` for the complete system spec with all pipeline stages, risk rules, database schema, and architectural details.

## V3 Epoch
- **Started**: 2026-04-04 21:57:36 UTC
- **Bankroll**: $1,000 (reset from V2)
- **Scope**: Weather markets ONLY — all sports, crypto, politics, sentiment, and arbitrage have been stripped

## Live URLs
- **Frontend**: https://arbit3r.netlify.app
- **Supabase project ID**: `kntdxewgksmvnkynzgyx`
- **Netlify site ID**: `9e4df4b0-09b1-43d7-a120-4ede5174e236`

## Tech Stack
- **Frontend**: Next.js 14.1 + React 18 + Tailwind CSS + Recharts
- **Database**: Supabase PostgreSQL (RLS enabled)
- **AI**: Anthropic Claude (claude-sonnet-4-20250514) for weather analysis
- **Hosting**: Netlify Pro — 7 active scheduled functions
- **Trading**: @polymarket/clob-client + viem (Polygon) — paper mode
- **Weather Data**: NWS API, Open-Meteo (GFS/ECMWF/ICON/HRRR/Ensemble)
- **Notifications**: Resend (email on bet placement)

## Active Pipeline (7 Functions)
| Function | Schedule | Purpose |
|----------|----------|---------|
| refresh-markets | */30 min | Discover weather markets on Polymarket, store gamma_market_id |
| ingest-weather | */15 min | Fetch multi-model forecasts (NWS/GFS/ECMWF/ICON/HRRR/Ensemble) |
| analyze-weather | */20 min | Claude evaluates edge on weather markets using forecast consensus |
| place-bets | */15 min | Risk-managed paper bet placement (1/8th Kelly, weather-only) |
| resolve-bets | hourly | Resolve via Polymarket UMA Oracle (resolvedBy, NOT closed) |
| repair-bets | */15 min | Backfill missing condition_ids on open bets |
| performance-snapshot | daily | Aggregate V3 P&L metrics |

16 legacy functions are disabled (early return, code preserved).

## Risk Management
- Max 3% bankroll per bet, 20% daily exposure, 15 bets/day
- 8% minimum edge for weather markets
- Entry price window: $0.02-$0.40 (tail bet strategy)
- 1/8th Kelly fraction with confidence scaling
- Min $400 liquidity
- Orderbook spread/slippage validation on first 8 bets per cycle

## Frontend (3 Active Pages)
- `/` — Dashboard (pipeline status, open bets, bankroll)
- `/weather` — Forecasts, consensus, city data
- `/performance` — Bet history, P&L, win rate

All other routes redirect to `/`. Non-weather API routes return disabled message.

## Database
**Active**: markets, bets, system_config, performance_snapshots, weather_cities, weather_forecasts, weather_consensus, weather_analyses
**Legacy (preserved)**: sports_odds, sports_analyses, crypto_signals, crypto_analyses, arb_opportunities

## Critical Gotchas
1. **`closed` ≠ `resolved`** — Only `resolvedBy` (Ethereum address) means the UMA Oracle has settled
2. **Gamma API condition_id filter is BROKEN** — MUST use `/markets/{gamma_market_id}` numeric endpoint
3. **outcome_prices**: outcomes=["Yes","No"], prices=[0,1] means No won; [1,0] means Yes won
4. **system_config stores values as strings** — always parseFloat() the bankroll
5. **normalizeEdge()** handles Claude returning 849 instead of 0.849
6. **Multiple markets per city** — always match on market_id, not city_id
7. **Use service role key in functions, anon key in frontend**
8. **Netlify sync functions timeout at 10-15s** — use Promise.all() for parallel calls

## Deployment
```bash
git add -A && git commit -m "message" && git push origin main
# Netlify auto-deploys in ~2 minutes
```

Active dev clone: `/sessions/relaxed-jolly-maxwell/arbiter-v3`

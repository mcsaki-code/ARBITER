# ARBITER — Project Instructions for Claude

You are working on ARBITER, an AI-powered prediction market edge detection and automated trading system. The owner is Matt Csaki (mattcsaki@gmail.com).

## Live URLs
- **Frontend**: https://arbit3r.netlify.app
- **Supabase project ID**: `kntdxewgksmvnkynzgyx`
- **Netlify site ID**: `9e4df4b0-09b1-43d7-a120-4ede5174e236`
- **Netlify team slug**: `mattcsaki`

## Tech Stack
- **Frontend**: Next.js 14.1 + React 18 + Tailwind CSS + Recharts
- **Database**: Supabase (PostgreSQL) with RLS enabled
- **AI**: Anthropic Claude (claude-sonnet-4-20250514) for market analysis
- **Hosting**: Netlify Pro ($20/mo) — auto-deploys from GitHub `main` branch
- **Trading**: @polymarket/clob-client + viem (Polygon) for live order execution
- **Notifications**: Resend (email alerts on bet placement)

## Architecture
Terminal → GitHub → Netlify (auto-deploy) → Supabase

The system runs a 5-stage automated pipeline:
1. **INGEST** (every 10-15 min): Fetch markets, weather forecasts (NWS/GFS/ECMWF/ICON/HRRR/Ensemble), sports odds, crypto prices
2. **ANALYZE** (every 20-30 min): Claude AI evaluates edge vs market price for weather/sports/crypto
3. **EXECUTE** (every 15 min): `place-bets.ts` filters analyses through risk management rules, sizes bets via 1/8th Kelly, places paper bets
4. **RESOLVE** (hourly): Check resolved markets, update bets with P&L
5. **SNAPSHOT** (daily): Aggregate performance metrics

## Project Structure
```
netlify/functions/     — 11 scheduled serverless functions (cron jobs)
src/app/               — Next.js pages (dashboard, sports, crypto, weather, arb, tracker, analytics, markets)
src/app/api/           — API routes (bets, signals, sports, crypto, weather, markets, arb, config, orders, resolve, trigger)
src/lib/               — Core libraries (supabase, claude, polymarket, clob, wallet, execute-bet, kelly, guardrails, consensus, nws, open-meteo, notify, types)
src/components/        — UI components (NavShell, BankrollCard, Badge, EdgeMeter, Drawer, etc.)
supabase/              — Database migrations
```

## Scheduled Functions (netlify/functions/)
| Function | Schedule | Writes to |
|----------|----------|-----------|
| refresh-markets | */30 min | markets |
| ingest-weather | */15 min | weather_forecasts, weather_consensus |
| ingest-sports-odds | */10 min | sports_odds |
| ingest-crypto | */10 min | crypto_signals |
| analyze-weather | */20 min | weather_analyses |
| analyze-sports-edge | */30 min | sports_analyses |
| analyze-crypto | */30 min | crypto_analyses |
| arb-scanner | */15 min | arb_opportunities |
| place-bets | */15 min | bets |
| resolve-bets | hourly | bets (updates pnl/status) |
| performance-snapshot | daily midnight | performance_snapshots |

## Database Tables (Supabase)
Core: `markets`, `bets`, `system_config`, `performance_snapshots`
Weather: `weather_cities`, `weather_forecasts`, `weather_consensus`, `weather_analyses`
Sports: `sports_odds`, `sports_analyses`
Crypto: `crypto_signals`, `crypto_analyses`
Arbitrage: `arb_opportunities`

## Risk Management (place-bets.ts)
- Max 3% of bankroll per bet, 20% daily exposure
- Max 15 bets/day, 1 bet per market
- Min 5% edge (8% for weather)
- Min $5K liquidity, min 1h to resolution
- Edge must be 2x estimated spread
- Entry price must be between 0.5% and 99.5%
- 1/8th Kelly fraction with confidence multiplier

## Key Design Decisions
- **No manual betting**: All bets placed exclusively by the automated pipeline. Manual bet buttons were removed.
- **Paper trading first**: System runs paper trades until guardrails are passed, then can switch to live via `LIVE_TRADING_ENABLED`
- **Comma formatting**: All dollar amounts use `toLocaleString('en-US')` for readability
- **Mobile-first**: Stats grids use `grid-cols-2 sm:grid-cols-4`, bottom nav is horizontally scrollable
- **Bet status badges**: Sports/crypto pages show why each AI pick was or wasn't bet on (ACTIVE, Skipped — reason, or Queued)
- **Dead market detection**: Signals API checks the specific market_id from each analysis, not just any active market for the city

## Environment Variables (set in Netlify)
Required: `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
Optional (live trading): `POLYMARKET_PRIVATE_KEY`, `POLYGON_RPC_URL`, `LIVE_TRADING_ENABLED`
Optional (notifications): `RESEND_API_KEY`, `NOTIFICATION_EMAIL`

## Deployment
```bash
cd ~/PolyMarket/arbiter
git add -A && git commit -m "message" && git push origin main
# Netlify auto-deploys in ~2 minutes
```

## Planned Improvements
- **Multi-model ensemble**: Add GPT-4o and Gemini alongside Claude for weighted consensus predictions (40/35/25 split)
- **Railway migration**: Move scheduled functions to Railway for longer execution times and persistent workers
- **Continuous news monitoring**: Real-time event/news feed that triggers analysis on market-moving events
- **Background functions**: Convert heavy analysis functions to Netlify background functions (Pro plan supports this)

## Important Gotchas
- Netlify sync functions have a 10-second timeout. Use `Promise.all()` for parallel API calls.
- Claude sometimes returns edge as 849 instead of 0.849 — normalizeEdge() handles this.
- Weather analyses match to markets via `city_id`, but multiple markets can exist per city (temp + precip). Always match on `market_id` specifically.
- The `system_config` table stores `paper_bankroll` as a string — always `parseFloat()` it.
- RLS is enabled on all tables — use the service role key in serverless functions, anon key in the frontend.

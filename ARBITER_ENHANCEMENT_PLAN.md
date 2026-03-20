# ARBITER — Master Enhancement Plan (Phase 1.5 → Phase 3)

## Executive Summary

ARBITER is a prediction market edge detection system. Phase 1 is live at arbit3r.netlify.app with weather forecast ingestion (GFS, ECMWF, ICON, NWS) across 10 US cities, Polymarket market scanning, Claude AI edge analysis, and paper trading infrastructure. This document is the single source of truth for all planned enhancements, research findings, and implementation order.

---

## Current State (Phase 1 — Complete)

**Working:**
- Weather data pipeline: Open-Meteo (GFS/ECMWF/ICON) + NWS for 10 cities
- Supabase database: forecasts, consensus, markets, analyses, bets, performance snapshots
- Multi-strategy Polymarket scanner (5 market searches + 3 event searches)
- Manual pipeline trigger (`/api/trigger`) with batched weather ingestion
- Claude AI analysis engine (claude-sonnet-4-20250514) — compares model consensus to market brackets
- Paper trading with Kelly sizing (fractional 25%, confidence multiplier)
- Bet resolution engine — resolves OPEN bets to WON/LOST against settled markets
- Home page: signals, edges, forecast snapshots, pipeline controls
- Weather Edge page: per-city cards with model temps, bet reasoning, pass explanations
- Markets page: filtered to weather/temperature only, expandable outcome bars
- Tracker page: paper trading dashboard with performance history

**Key Numbers:**
- 10 active US cities (NYC, Chicago, Miami, Seattle, Denver, LA, OKC, Omaha, Minneapolis, Phoenix, Atlanta)
- 4 forecast models per city (GFS, ECMWF, ICON, NWS)
- 3-day forecast window
- Pipeline runs: weather every 15min, markets every 30min, analysis every 20min, bet resolution every hour

---

## Research Findings — Weather Edges (Prioritized by Magnitude)

### Finding 1: Precipitation "Wet Bias" — 2-8% Edge
Commercial weather apps systematically overestimate rain probability. NWS shows 5% rain when Weather Channel shows 20%. Markets priced by humans using these apps inherit this bias. We already collect `precipitation_probability_max` but don't analyze it yet. Additional variables available: `precipitation_sum`, `rain_sum`, `snowfall_sum`, `precipitation_hours`.

### Finding 2: Record Temperature Underestimation — 15-25% Edge
Markets underestimate record-breaking temperature frequency. AI models show 0.91K cold bias on hottest predicted temps. When 3+ models predict temps within 2°F of a city's daily record high, markets systematically underprice the "above X°F" bracket. These are the highest-edge individual trades in the system.

### Finding 3: City Volatility Mismatch — 5-10% Edge
Oklahoma City (volatility score 81/100), Omaha (79.77), and Minneapolis have the widest forecast error bands = widest market spreads = easiest arbitrage. Already added these cities in Phase 1.5.

### Finding 4: Seasonal Transition Anchoring — 2-5% Edge
Humans anchor to seasonal norms. During spring (April-May) and fall (Sept-Oct) transitions, markets lag rapid temperature shifts by 1-2 days. Model consensus detects these transitions 48-72 hours before market prices adjust.

### Finding 5: Model Skill Weighting — 1-3% Edge
ECMWF leads for 5+ day forecasts, GFS updates 4x daily and catches rapid changes faster, ICON excels for European precipitation. A dynamic weighting system by city+season improves consensus accuracy.

---

## Research Findings — Sports Prediction Markets (Phase 3)

### Tier 1: NFL + NBA (Highest Priority)
- **Achievable edge:** 55-58% accuracy on point spreads (market break-even ~52.4%)
- **Data sources:** ESPN API (free), nba_api Python package (free), Pro Football Reference
- **Key signals:** Rest days, back-to-back scheduling, travel distance, pace differentials, injury impact models
- **Market availability:** Polymarket has NFL/NBA prop markets with significant volume
- **Implementation complexity:** Medium — structured data, clear resolution criteria

### Tier 2: NCAA Basketball + MLB
- **Achievable edge:** 54-57% NCAA (tournament variance), 53-55% MLB (high game volume)
- **Data sources:** Sports Reference (free scraping), statsapi.mlb.com (free), Sagarin ratings
- **Key signals:** NCAA — tempo-free metrics, KenPom ratings, conference tournament momentum; MLB — bullpen fatigue, platoon splits, park factors, weather impact on hitting
- **Market availability:** NCAA March Madness has heavy Polymarket activity; MLB less so
- **Implementation complexity:** Medium-High — NCAA requires tournament-specific logic

### Tier 3: Soccer + Other
- **Achievable edge:** 52-54% (very efficient markets)
- **Data sources:** football-data.org (free), FBref
- **Key signals:** xG models, fixture congestion, manager tendencies
- **Market availability:** Limited on Polymarket (mostly World Cup / major tournaments)
- **Implementation complexity:** High — global leagues, complex scheduling

### Sports Architecture Plan
```
┌─────────────────────────────────────────────────┐
│              ARBITER Sports Module               │
├─────────────────────────────────────────────────┤
│  DATA INGESTION                                  │
│  ├─ ESPN API: schedules, scores, stats           │
│  ├─ nba_api: player logs, advanced stats         │
│  ├─ statsapi.mlb.com: pitcher game logs          │
│  └─ Web scraping: injury reports, lines          │
│                                                   │
│  FEATURE ENGINE                                   │
│  ├─ Rest/fatigue calculator                      │
│  ├─ Travel distance model                        │
│  ├─ Injury-adjusted team ratings                 │
│  ├─ Pace/tempo matchup model                     │
│  └─ Historical spread performance                │
│                                                   │
│  ANALYSIS (Claude)                               │
│  ├─ Compare model prediction to market spread    │
│  ├─ Identify value on totals and props           │
│  └─ Generate bet reasoning                       │
│                                                   │
│  UI                                               │
│  ├─ Sports Edge page (by league)                 │
│  ├─ Game cards with model vs market comparison   │
│  └─ Integrated into existing Tracker             │
└─────────────────────────────────────────────────┘
```

---

## Phase 2: Weather Edge Deepening (Next)

### 2.1 Precipitation Edge Engine
**Files:** Update `ingest-weather.ts`, new `src/app/precipitation/page.tsx`, update `analyze-weather.ts`
- Fetch additional precip variables: `precipitation_sum`, `rain_sum`, `snowfall_sum`
- Compare model precipitation consensus to market pricing
- Exploit wet bias: when NWS shows <15% PoP but market prices >25%, flag as edge
- New "Precipitation" section in UI

### 2.2 Enhanced Consensus with Model Weighting
**Files:** New `src/lib/consensus.ts`, update `ingest-weather.ts`
- Weight ECMWF 1.2x for 3+ day forecasts
- Weight GFS 1.1x for 0-48hr forecasts
- Seasonal adjustment: higher confidence in winter, lower in summer convective season
- Track which model is the outlier (not just spread magnitude)
- New `consensus_confidence` field

### 2.3 Record Temperature Detection
**Files:** New `src/lib/records.ts`, update analysis pipeline
- When model consensus predicts temps within 3°F of historical daily record
- Flag as "RECORD WATCH" signal
- Historical records from NWS API (`/stations/{stationId}/observations`)
- 15-25% mispricing opportunity

### 2.4 Seasonal Transition Detection
**Files:** Update analysis pipeline
- Detect rapid multi-day temperature swings (>15°F in 48h)
- Flag markets that haven't adjusted to the new regime
- Spring/fall transitions are highest opportunity windows

### 2.5 Auto-Bet Execution
**Files:** Update `analyze-weather.ts`, new config UI
- When paper trading validates (30 days, 50+ bets, 58%+ win rate)
- Auto-place bets meeting HIGH confidence + HIGH agreement + edge ≥ 8%
- Safety: max daily exposure cap, max single bet cap, kill switch

---

## Phase 3: Sports Expansion

### 3.1 NBA Data Pipeline (Priority 1 — In-Season)
- Integrate nba_api for player logs, team stats, advanced metrics
- Build rest/fatigue model (back-to-back performance drops avg 2.5 pts)
- Travel distance calculation
- Injury impact model (weighted by player usage rate)

### 3.2 NFL Data Pipeline (Priority 1 — Seasonal)
- ESPN API integration for schedules, scores, team stats
- Weather impact on scoring (wind >15mph reduces passing TDs 15%)
- Home/away splits, divisional rivalry adjustments
- Playoff/postseason momentum factors

### 3.3 Sports Analysis Engine
- Claude analysis comparing model predictions to Polymarket spreads
- Sport-specific Kelly sizing (lower fraction for higher-variance sports)
- Cross-sport bankroll management

### 3.4 NCAA March Madness Module (Seasonal — March)
- KenPom/Sagarin ratings integration
- Seed-based historical performance
- Conference tournament form indicators
- One of the highest-volume prediction market events annually

---

## Implementation Order of Operations

### Immediate (This Session)
1. ~~Markets page weather filter~~ ✅
2. ~~Bet reasoning on Weather page~~ ✅
3. ~~City list swap (add high-volatility cities)~~ ✅
4. ~~Bet resolution engine~~ ✅
5. Push to production ← CURRENT

### Phase 2 Sprint 1 (Next Session)
6. Precipitation edge engine (data + analysis + UI)
7. Model weighting in consensus calculation
8. Forecast deduplication (prevent duplicate inserts per pipeline run)

### Phase 2 Sprint 2
9. Record temperature detection
10. Seasonal transition detection
11. Auto-bet execution (with safety gates)
12. Performance analytics dashboard enhancement

### Phase 3 Sprint 1 (Sports Foundation)
13. NBA data pipeline + feature engine
14. Sports analysis with Claude
15. Sports Edge UI page

### Phase 3 Sprint 2 (Sports Expansion)
16. NFL data pipeline
17. NCAA March Madness module (seasonal)
18. Cross-sport bankroll management
19. Historical backtesting framework

---

## Technical Architecture (Current + Planned)

```
┌──────────────────────────────────────────────────────┐
│                  ARBITER System                       │
├──────────────────────────────────────────────────────┤
│  SCHEDULED FUNCTIONS (Netlify Cron)                  │
│  ├─ ingest-weather (*/15)     GFS/ECMWF/ICON/NWS    │
│  ├─ refresh-markets (*/30)    Polymarket Gamma API   │
│  ├─ analyze-weather (*/20)    Claude edge analysis   │
│  ├─ resolve-bets (0 *)        Settle WON/LOST        │
│  └─ performance-snapshot      Daily P&L rollup       │
│                                                       │
│  API ROUTES (Next.js)                                │
│  ├─ /api/weather              City forecast data     │
│  ├─ /api/markets              Active markets         │
│  ├─ /api/signals              Analyzed signals       │
│  ├─ /api/bets                 Bet log + stats        │
│  ├─ /api/trigger              Manual pipeline run    │
│  ├─ /api/trigger/weather      Batched weather fetch  │
│  ├─ /api/resolve              Manual bet resolution  │
│  └─ /api/config               System settings        │
│                                                       │
│  FRONTEND (Next.js + Tailwind)                       │
│  ├─ /                  Home — signals + edges        │
│  ├─ /weather           City analysis + reasoning     │
│  ├─ /markets           Polymarket weather markets    │
│  └─ /tracker           Paper trading dashboard       │
│                                                       │
│  DATABASE (Supabase PostgreSQL)                      │
│  ├─ weather_cities     10 active cities              │
│  ├─ weather_forecasts  Multi-model forecasts         │
│  ├─ weather_consensus  Model agreement calculations  │
│  ├─ markets            Polymarket contracts          │
│  ├─ weather_analyses   Claude edge analysis results  │
│  ├─ bets               Paper/real trade log          │
│  ├─ performance_snapshots  Daily P&L history         │
│  └─ system_config      Runtime parameters            │
│                                                       │
│  EXTERNAL APIs                                       │
│  ├─ Open-Meteo         GFS, ECMWF, ICON forecasts   │
│  ├─ NWS (weather.gov)  US hourly forecasts           │
│  ├─ Polymarket Gamma   Market data (no auth needed)  │
│  └─ Anthropic Claude   Edge analysis AI              │
└──────────────────────────────────────────────────────┘
```

---

## Expected Impact

| Enhancement | Edge Improvement | Effort | Phase |
|-------------|-----------------|--------|-------|
| Bet resolution engine | Operational (enables tracking) | Low | 1.5 ✅ |
| Precipitation engine | +2-8% on precip markets | Medium | 2.1 |
| Model weighting | +1-3% consensus accuracy | Medium | 2.2 |
| Record detection | +15-25% on record markets | High | 2.3 |
| Seasonal transitions | +2-5% during spring/fall | Medium | 2.4 |
| NBA edge detection | +3-6% on NBA props | High | 3.1 |
| NFL edge detection | +3-6% on NFL props | High | 3.2 |

---

## Risk Mitigation

- All changes maintain paper trading gate (30 days, 50 bets, 58% win rate before real money)
- New edge types start with lower Kelly fraction (0.15 vs 0.25) until validated
- Precipitation and record detection flagged as EXPERIMENTAL in UI
- Sports module starts paper-only with separate bankroll tracking
- System config table controls all thresholds — adjustable without code changes
- Max daily exposure cap prevents runaway losses
- Kill switch in system_config to disable auto-execution instantly

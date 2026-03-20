# ARBITER Phase 1.5 — Enhancement Plan

## Executive Summary

ARBITER Phase 1 is live with weather forecast ingestion (GFS, ECMWF, ICON, NWS) across 10 cities and Polymarket market scanning. This plan adds three high-value enhancements based on deep research into climatology, odds-making patterns, and prediction market inefficiencies.

---

## Current State

**Working:**
- Weather data pipeline: Open-Meteo (GFS/ECMWF/ICON) + NWS for 10 cities
- Supabase database with forecasts, consensus, markets, analyses, bets
- Manual pipeline trigger (`/api/trigger`)
- Home page with forecast snapshots and signal cards
- Paper trading infrastructure with Kelly sizing

**Broken/Missing:**
- Markets tab is disabled (no page exists)
- Weather cards don't explain WHY a bet is recommended or passed
- No precipitation data being tracked despite having the API for it
- City list missing highest-edge cities (OKC, Omaha, Rapid City)

---

## Research Findings (Prioritized by Edge Magnitude)

### Finding 1: Precipitation "Wet Bias" — 2-8% Edge
Commercial weather apps and casual forecasters systematically overestimate rain probability. NWS shows 5% actual rain when The Weather Channel shows 20%. Markets priced by humans using these apps inherit this bias. Open-Meteo already provides `precipitation_probability_max` — we just aren't displaying or analyzing it.

### Finding 2: Record Temperature Underestimation — 15-25% Edge
Markets underestimate record-breaking temperature frequency. AI models show 0.91K cold bias on hottest predicted temps. When 3+ models predict temps within 2°F of a city's daily record high, markets are systematically underpricing the "above X°F" bracket.

### Finding 3: City Volatility Mismatch — 5-10% Edge
We're tracking predictable cities (LA, Miami) where models are already accurate and markets are efficiently priced. Oklahoma City (volatility score 81/100), Omaha (79.77), Rapid City, Great Falls, and Houghton have the widest forecast error bands = widest market spreads = easiest arbitrage. Meanwhile London/Paris/Tokyo have almost no Polymarket temperature markets.

### Finding 4: Seasonal Transition Anchoring — 2-5% Edge
Humans anchor to seasonal norms. During spring (April-May) and fall (Sept-Oct) transitions, markets lag rapid temperature shifts by 1-2 days. Model consensus detects these transitions 48-72 hours before market prices adjust.

### Finding 5: Model Skill Weighting — 1-3% Edge
Not all models are equal for all cities. ECMWF leads for 5+ day forecasts, GFS updates 4x daily and catches rapid changes faster, ICON excels for European precipitation. A dynamic weighting system by city+season improves consensus accuracy.

---

## Enhancement Plan — Order of Operations

### Step 1: Fix Markets Tab + Bet Reasoning (Immediate)
**Files:** `src/app/markets/page.tsx` (new), `src/components/NavShell.tsx`, `src/app/weather/page.tsx`

- Create Markets page showing all Polymarket weather markets from DB
- Enable Markets nav tab
- Add detailed "why" reasoning to each city card on Weather page:
  - Show all model temps side-by-side
  - Show market bracket prices vs estimated true probability
  - Show explicit PASS reason when no bet ("spread too wide", "low liquidity", "no market matched")
  - Show edge calculation breakdown when bet IS recommended

### Step 2: Add Precipitation Edge Engine (New Section)
**Files:** `netlify/functions/ingest-weather.ts` (update), `src/app/api/signals/route.ts` (update), new `src/app/precipitation/page.tsx`

Open-Meteo already returns `precipitation_probability_max` — we store it but don't analyze it. Enhancement:
- Fetch additional precip variables: `precipitation_sum`, `rain_sum`, `snowfall_sum`, `precipitation_hours`
- Compare model precipitation consensus to market pricing
- Exploit wet bias: when NWS shows <15% PoP but market prices >25%, flag as edge
- New "Precipitation" section in UI showing rain/snow probability by city with model agreement

### Step 3: Swap City List for High-Edge Cities
**Files:** SQL migration, `src/lib/polymarket.ts` keyword map

Replace low-edge cities (London, Tel Aviv, Tokyo, Paris — no NWS data, rarely have Polymarket markets) with high-volatility US cities that have both NWS data AND frequent Polymarket markets:
- ADD: Oklahoma City, Omaha, Rapid City, Phoenix, Minneapolis
- KEEP: NYC, Chicago, Miami, Seattle, Denver, LA (all have NWS + frequent markets)
- REMOVE: London, Tel Aviv, Tokyo, Paris

### Step 4: Enhanced Consensus with Model Weighting
**Files:** `src/lib/consensus.ts` (update), `netlify/functions/ingest-weather.ts` (update)

Current consensus is simple average. Upgrade to:
- Weight ECMWF 1.2x for 3+ day forecasts
- Weight GFS 1.1x for 0-48hr forecasts (faster update cycle)
- Apply seasonal adjustment: higher confidence in winter (highest model skill), lower in summer convective season
- Track spread direction (which model is the outlier) not just magnitude
- Add `consensus_confidence` field combining agreement + seasonal skill + model weighting

### Step 5: Record Temperature Detection
**Files:** New `src/lib/records.ts`, update analysis pipeline

When model consensus predicts temps within 3°F of a city's historical daily record:
- Flag as "RECORD WATCH" signal
- Historical records available from NWS API (`/stations/{stationId}/observations`)
- Research shows 15-25% mispricing on record-breaking brackets
- These are the highest-edge individual trades in the system

---

## Technical Architecture

```
┌─────────────────────────────────────────────────┐
│                    ARBITER 1.5                    │
├─────────────────────────────────────────────────┤
│  DATA INGESTION (every 15 min)                   │
│  ├─ Open-Meteo: GFS, ECMWF, ICON               │
│  │   ├─ temp_high/low                            │
│  │   ├─ precipitation_sum, rain, snow            │ ← NEW
│  │   └─ precipitation_probability                │
│  ├─ NWS API: hourly forecasts                    │
│  │   └─ temp, precip_prob, conditions            │
│  └─ NWS Records: daily historical records        │ ← NEW
│                                                   │
│  CONSENSUS ENGINE                                 │
│  ├─ Weighted model average (ECMWF/GFS/ICON)     │ ← UPGRADED
│  ├─ Temperature consensus + agreement             │
│  ├─ Precipitation consensus + wet bias calc      │ ← NEW
│  └─ Record proximity detection                   │ ← NEW
│                                                   │
│  MARKET SCANNER (every 30 min)                   │
│  ├─ Polymarket Gamma API (multi-strategy search) │
│  └─ City matching with expanded keyword map      │ ← UPGRADED
│                                                   │
│  ANALYSIS ENGINE (every 20 min)                  │
│  ├─ Claude edge analysis (temperature)           │
│  ├─ Claude edge analysis (precipitation)         │ ← NEW
│  ├─ Wet bias detection                           │ ← NEW
│  ├─ Record watch flagging                        │ ← NEW
│  └─ Kelly sizing with model confidence weight    │ ← UPGRADED
│                                                   │
│  UI                                               │
│  ├─ Home: signals, edges, forecast snapshot       │
│  ├─ Weather: city cards with full reasoning      │ ← UPGRADED
│  ├─ Precipitation: rain/snow edge engine         │ ← NEW
│  ├─ Markets: all tracked Polymarket markets      │ ← NEW
│  └─ Tracker: paper trading + performance         │
└─────────────────────────────────────────────────┘
```

---

## Implementation Order (This Session)

1. **Markets page + nav fix** — 15 min
2. **Weather page bet reasoning upgrade** — 20 min
3. **Precipitation data ingestion** — 10 min
4. **City list swap (SQL + keywords)** — 10 min
5. **Push + deploy** — 5 min

Steps 4-5 (model weighting, record detection) are deferred to next session as they require more testing.

---

## Expected Impact

| Enhancement | Edge Improvement | Effort |
|-------------|-----------------|--------|
| Markets tab + reasoning | UX only (visibility) | Low |
| Precipitation engine | +2-8% edge on precip markets | Medium |
| City swap | +5-10% wider spreads to exploit | Low |
| Model weighting | +1-3% consensus accuracy | Medium |
| Record detection | +15-25% on record markets | High |

---

## Risk Mitigation

- All changes maintain paper trading gate (30 days, 50 bets, 58% win rate before real money)
- New edge types start with lower Kelly fraction (0.15 vs 0.25) until validated
- Precipitation and record detection flagged as EXPERIMENTAL in UI
- System config table controls all thresholds — adjustable without code changes

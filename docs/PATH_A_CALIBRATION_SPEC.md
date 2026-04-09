# Path A — Historical Calibration Ingest

**Status:** Spec + scaffold committed 2026-04-08. Build in progress.
**Author:** Written during the V3.3 reset planning session.
**Goal:** Close the last gap between ARBITER and the top weather-market bots by replacing literature-default parameters with empirically-calibrated ones derived from 2 years of real forecast-vs-actual data.

---

## 1. Why this matters

After the V3.3 reset and the Phase 1+2 math rebuild, our forecast probability calculation (`forecast-ensemble.ts`) is statistically sound. But the **parameters inside that math** are still generic:

- **Sigma floor** comes from a literature-based lead-time table (σ=1.0°F at T+0 growing to σ=4°F at T+7). Same for Seattle in April as for Phoenix in July.
- **Per-model bias** is assumed zero. We treat all 5 forecast sources as unbiased, even though GFS is known to run warm in coastal cities in summer, ECMWF tends to underpredict high-altitude temps, etc.
- **Ensemble weights** are equal. GFS and ECMWF carry the same vote despite ECMWF winning most verification comparisons.
- **Base rates** — we don't know that "bracket questions within 1°F of consensus historically resolve YES 52% of the time in Seattle in March."

Top bots (gopfan2, suislanchez, neobrother) calibrate all of these on years of historical data. That's where their edge comes from. We can match it with ~1 day of build plus a one-shot ingest.

---

## 2. What we're building

### Data sources (all free, no API key)

1. **Open-Meteo Historical Weather API** — ERA5 reanalysis, daily highs/lows back to 1940.
   - Endpoint: `https://archive-api.open-meteo.com/v1/archive`
   - Use: Ground truth for what *actually* happened.

2. **Open-Meteo Historical Forecast API** — what each model *predicted* at each lead time, back to ~2022.
   - Endpoint: `https://historical-forecast-api.open-meteo.com/v1/historical-forecast`
   - Models available: `best_match`, `ecmwf_ifs04`, `ecmwf_ifs025`, `gfs_seamless`, `gfs_global`, `gfs_hrrr`, `icon_seamless`, `icon_global`, `gem_seamless`, `jma_seamless`, `meteofrance_seamless`, `ukmo_seamless`, `bom_access_global`
   - Use: Replay what each model said at T-1 day, T-3 day, T-5 day for every day of the last 2 years.

### Scope

- **Cities:** All 14 active cities in `weather_cities`.
- **Models:** 7 primary sources (`ecmwf_ifs025`, `gfs_global`, `icon_global`, `gem_seamless`, `jma_seamless`, `meteofrance_seamless`, `ukmo_seamless`).
- **Horizon:** 730 days (2 years).
- **Lead times:** T+0 through T+7 days (8 lead times).
- **Variable:** Daily high temperature (our current bet universe).

**Total row count:** 14 cities × 730 days × 7 models × 8 lead times = **~572,000** calibration pairs.
**API calls:** ~14 × 7 = 98 single-request calls (Open-Meteo accepts date ranges). **Ingest time: ~5 minutes.**

---

## 3. Schema

Three derived tables (the raw ingest goes into a fourth, then rolled up).

### `weather_calibration_raw`
The raw pull. Preserved so we can re-derive anything.

```sql
CREATE TABLE weather_calibration_raw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES weather_cities(id),
  valid_date date NOT NULL,
  source text NOT NULL,           -- 'ecmwf_ifs025', 'gfs_global', etc.
  lead_days integer NOT NULL,     -- 0..7
  forecast_high_f numeric,
  observed_high_f numeric,        -- from ERA5 archive
  error_f numeric,                -- forecast - observed (signed)
  ingested_at timestamptz DEFAULT now()
);

CREATE INDEX ON weather_calibration_raw (city_id, source, lead_days);
CREATE INDEX ON weather_calibration_raw (valid_date);
```

### `weather_calibration_sigma`
Empirical σ per (city, lead_time, month). This replaces the lead-time-aware floor.

```sql
CREATE TABLE weather_calibration_sigma (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES weather_cities(id),
  lead_days integer NOT NULL,
  month integer NOT NULL,         -- 1..12 (seasonal calibration)
  n integer NOT NULL,             -- sample size
  empirical_sigma_f numeric NOT NULL,  -- stddev of (forecast - observed) across all models
  mean_error_f numeric,            -- systematic over/under
  computed_at timestamptz DEFAULT now(),
  UNIQUE (city_id, lead_days, month)
);
```

Derivation query (runs after ingest):
```sql
INSERT INTO weather_calibration_sigma (city_id, lead_days, month, n, empirical_sigma_f, mean_error_f)
SELECT
  city_id,
  lead_days,
  EXTRACT(MONTH FROM valid_date)::int AS month,
  COUNT(*) AS n,
  STDDEV_SAMP(error_f) AS empirical_sigma_f,
  AVG(error_f) AS mean_error_f
FROM weather_calibration_raw
WHERE error_f IS NOT NULL
GROUP BY city_id, lead_days, EXTRACT(MONTH FROM valid_date)
HAVING COUNT(*) >= 20
ON CONFLICT (city_id, lead_days, month) DO UPDATE SET
  n = EXCLUDED.n,
  empirical_sigma_f = EXCLUDED.empirical_sigma_f,
  mean_error_f = EXCLUDED.mean_error_f,
  computed_at = now();
```

### `weather_calibration_bias`
Per-model systematic bias per (city, lead_days, month, source). Used to de-bias individual forecasts before ensembling.

```sql
CREATE TABLE weather_calibration_bias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES weather_cities(id),
  source text NOT NULL,
  lead_days integer NOT NULL,
  month integer NOT NULL,
  n integer NOT NULL,
  bias_f numeric NOT NULL,          -- mean(forecast - observed)
  mae_f numeric NOT NULL,           -- mean absolute error
  rmse_f numeric NOT NULL,
  computed_at timestamptz DEFAULT now(),
  UNIQUE (city_id, source, lead_days, month)
);
```

### `weather_calibration_weights`
Ensemble weights per (city, lead_days, source). Derived from RMSE — better models get more weight.

```sql
CREATE TABLE weather_calibration_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES weather_cities(id),
  source text NOT NULL,
  lead_days integer NOT NULL,
  weight numeric NOT NULL,          -- sums to 1 across sources for given (city, lead_days)
  rmse_f numeric,
  n integer,
  computed_at timestamptz DEFAULT now(),
  UNIQUE (city_id, source, lead_days)
);
```

Weight derivation: inverse-RMSE-squared normalization.
```
raw_weight_s = 1 / (rmse_s^2 + epsilon)
weight_s     = raw_weight_s / sum(raw_weight_s across all s)
```

---

## 4. How the math integrates

### Current `forecast-ensemble.ts` flow
```
members = fetch forecasts
mean    = average(members)
sigma   = max(sample_std(members), getDynamicSigmaFloor(lead_hours))
prob    = normalCDF((threshold - mean) / sigma)
```

### New calibrated flow
```
members             = fetch forecasts
calibrated_members  = members.map(m => ({
  ...m,
  temp_high_f: m.temp_high_f - getBias(city, m.source, lead_days, month)
}))
weights             = members.map(m => getWeight(city, m.source, lead_days))
weighted_mean       = sum(calibrated.temp * weights) / sum(weights)
sample_sigma        = weighted_std(calibrated_members, weights)
empirical_sigma     = getEmpiricalSigma(city, lead_days, month)

// Blend: weight empirical more when we have lots of calibration samples
n_cal  = getEmpiricalSigmaN(city, lead_days, month)
alpha  = min(1.0, n_cal / 30)  // full empirical at n>=30
sigma  = sqrt(alpha * empirical_sigma^2 + (1 - alpha) * max(sample_sigma, sigma_floor)^2)

prob   = normalCDF((threshold - weighted_mean) / sigma)
```

**Key properties:**
1. **Graceful degradation** — if calibration data is missing for a (city, lead, month) combo, `alpha=0` and we fall back to current behavior. Zero-risk deploy.
2. **Bias correction is per-source** — GFS's known warm bias in Phoenix gets subtracted before ensembling, so the other models don't have to fight against it.
3. **Weighted mean** — ECMWF (typically RMSE ~1.6°F at T+1) gets more vote than GEM (typically RMSE ~2.2°F at T+1).
4. **Sigma blending** — we trust the sample std when calibration is thin and the empirical σ when calibration is rich. No cliff.

### Feature flag
`system_config.calibration_enabled = 'false'` initially. Flip to `'true'` after ingest + QA. The updated `forecast-ensemble.ts` reads this flag; when `false`, it runs the current code unchanged.

---

## 5. How the 3 AIs use this

Currently the Claude/GPT-4o/Gemini ensemble sees: raw forecast members + consensus number + market question. They produce an edge estimate each, weighted by `ensemble.ts`. They're basically reasoning from vibes + generic weather knowledge.

With calibration data in the prompt, they become dramatically more useful. The new analyzer passes each AI:

1. **The calibrated forecast** — "After bias correction, Seattle April 12 high is 62.3°F ± 1.8°F (empirical σ from 87 historical samples at this city/lead/month)."
2. **Per-model bias disclosure** — "GFS is running 1.4°F warm in Seattle this month historically; we've already corrected for it."
3. **Base rate prior** — "In Seattle in April, bracket markets within 1°F of consensus have historically resolved YES 54% of the time (n=42). Outside 2°F, 8% (n=31)."
4. **Comparable precedents** — "At T-24h, when the forecast ensemble has sigma < 1.5°F and the threshold is within 2°F of mean, YES resolves 72% of the time (n=89)."
5. **Model-skill disclosure** — "ECMWF is 12% more accurate than GFS in Seattle at 48h lead, so its vote is weighted 1.8x in our consensus."

Each AI then reasons **against these priors** rather than constructing them from scratch. Claude is particularly strong at this kind of constrained reasoning — "given the base rate is 54% YES and my forecast says 61%, what's the likely failure mode and do I trust it?" is a much better prompt than "tell me the probability."

### AI skill tracking (bonus use)

Once we have shadow data from Path B AND historical calibration from Path A, we can close the loop on AI quality too. For each bet the AI ensemble makes, track:
- The prior (calibrated probability)
- Each AI's estimate
- Actual outcome

Then measure: **per AI, in which regimes does it add edge over the calibrated prior?** If Claude consistently improves over the prior in the 0.2-0.4 probability band but GPT-4o dominates the tail, we re-weight the ensemble accordingly. This becomes self-updating every 30 days.

---

## 6. Implementation plan

Ordered by value/effort:

### Phase A.1 — Ingest (1 day)
1. `worker/src/calibration-ingest.ts` — one-shot script that hits Open-Meteo historical APIs for all 14 cities, 7 models, 2 years.
2. Writes to `weather_calibration_raw`.
3. Runs via `npm run ingest:calibration` from the worker (or a one-time Railway task).
4. Validation: row count ≥ 500k, error_f distribution looks sane (mean near 0, no wild outliers).

### Phase A.2 — Derivation (half day)
1. SQL view or CTE that aggregates raw into sigma/bias/weights tables.
2. Wrapped in a `derive-calibration.ts` worker script — runs after ingest and can be re-run nightly to incorporate new data.
3. Validation: every (city, lead_days, month) combo has n≥20; σ values look plausible (0.5°F–5°F range); model weights sum to 1.

### Phase A.3 — Math integration (half day)
1. Extend `forecast-ensemble.ts` to accept an optional `calibration` parameter.
2. Pass it from `worker/src/temperature.ts` and `netlify/functions/analyze-weather.ts` (fetched once per cycle, cached).
3. Feature-flagged via `system_config.calibration_enabled`.
4. Backward compat: if `calibration` is null, runs current behavior.

### Phase A.4 — AI context injection (half day)
1. Extend the AI ensemble prompt template to include calibration summary + base rates.
2. Test on a few markets manually, compare AI outputs before/after.

### Phase A.5 — Validation & rollout (half day)
1. Run calibrated math against the `backtest_shadow` rows (Path B) in read-only mode.
2. Compare Brier scores: pre-calibration vs post-calibration.
3. If post-calibration Brier is meaningfully better AND not worse for any (city, lead_time_bucket), flip the feature flag.
4. Monitor for 48 hours with the canary still watching.

**Total estimated effort: 2-3 days of focused build.**

---

## 7. Validation / how we know it worked

Pre-calibration baseline (from Path B shadow data, collected over 14-30 days):
- avg_brier = X
- per-city Brier spread
- per-lead-time Brier

Post-calibration (same metrics, run against same shadow rows with the new math applied):
- avg_brier should drop by ≥10%
- No city/lead-time bucket should get meaningfully worse
- Reliability diagram should tighten (predicted ≈ observed across all buckets)

If post-calibration Brier is only marginally better or worse in some bucket, we've either got a bug, a data quality issue, or the calibration is overfit. In that case we don't flip the flag until we diagnose.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Open-Meteo API rate limits | Ingest in batches with delays; they allow ~10k calls/day free tier which is more than we need |
| Ingest writes bad data | Feature-flagged, zero impact until we flip `calibration_enabled=true` |
| Calibration overfits to historical regime | Use only last 2 years, re-compute monthly as data rolls forward |
| Model naming mismatch (our sources vs Open-Meteo sources) | Write a mapping layer in `calibration-ingest.ts` with explicit source_to_openmeteo_model() |
| Cron steps on Railway worker | Calibration ingest is a one-shot script, not a cron; runs manually or on deploy |
| We break production on deploy | Backward compat in `forecast-ensemble.ts` (null calibration = current behavior) + feature flag + Path B scoring verification |

---

## 9. What lives where

```
docs/PATH_A_CALIBRATION_SPEC.md          (this file)
worker/src/calibration-ingest.ts         (phase A.1 — one-shot ingest)
worker/src/calibration-derive.ts         (phase A.2 — raw → sigma/bias/weights)
worker/src/calibration-lookup.ts         (runtime lookup helpers, exported for temperature.ts)
src/lib/calibration-lookup.ts            (copy for Netlify)
src/lib/forecast-ensemble.ts             (extended with optional calibration param)
worker/src/forecast-ensemble.ts          (same extension)
migrations/create_calibration_tables.sql (this migration)
```

---

## 10. Strategic upside beyond sigma

The calibration data trove enables things we can't do today:

1. **Regime detection.** If forecast errors are systematically larger than empirical σ over the last 14 days, the weather is in a "hard to predict" regime. Raise σ globally, reduce bet sizing, or sit out.
2. **Cross-city correlation.** When Seattle busts warm, does Portland? If correlation is high, our per-city bet cap is under-counting real exposure. Derive the correlation matrix from raw data and add correlated-exposure check to place-bets.ts.
3. **Seasonality discovery.** Which months have which cities historically been hardest to forecast? Preemptively reduce exposure in those (city, month) combos.
4. **Selection bias detection.** Polymarket bracket markets tend to have retail-driven skew. With a city/month base rate, we can tell when the market is pricing against the historical base rate and investigate.
5. **Event anomaly alerts.** Real-time comparison of live forecast vs historical σ detects unusual events (hurricanes, heat domes) early and pauses auto-bet until a human reviews.

All of these are unlocked by the same ~572k row ingest. Path A is not just calibration — it's the foundation for every future improvement.

-- ============================================================
-- Migration 013 — Edge #4: forecast-repricing-lag detection
-- 2026-06-10
--
-- The structural edge in Polymarket weather markets is the window
-- between a forecast model update and the market repricing
-- (gopfan2's actual alpha source per public research). The Railway
-- worker now records, per analysis:
--   prob_shift       — our probability now vs previous analysis
--   price_shift      — market price now vs previous analysis
--   repricing_lag    — forecast moved toward our side >= 5pp while
--                      market moved <= 2pp (thresholds config-driven)
--   prev_analyzed_at — timestamp of the previous analysis compared
--
-- place-bets gates on repricing_lag only when
-- system_config.require_repricing_lag = 'true' (observe mode first).
-- ============================================================

ALTER TABLE weather_analyses
  ADD COLUMN IF NOT EXISTS prob_shift double precision,
  ADD COLUMN IF NOT EXISTS price_shift double precision,
  ADD COLUMN IF NOT EXISTS repricing_lag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prev_analyzed_at timestamptz;

-- Partial index: the lag-performance queries filter on the flag.
CREATE INDEX IF NOT EXISTS idx_weather_analyses_repricing_lag
  ON weather_analyses (analyzed_at)
  WHERE repricing_lag = true;

-- Config: lag thresholds (worker) + gate mode (place-bets).
INSERT INTO system_config (key, value, updated_at) VALUES
  ('lag_min_prob_shift', '0.05', NOW()),
  ('lag_max_price_shift', '0.02', NOW()),
  ('forecast_shift_reanalyze_f', '0.9', NOW()),
  ('require_repricing_lag', 'false', NOW())
ON CONFLICT (key) DO NOTHING;

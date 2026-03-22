-- ============================================================
-- ARBITER Weather V2 — Enhanced Weather Data Schema
-- Adds: precipitation totals, snowfall, wind, ensemble data,
--        market type classification, HRRR model support
-- ============================================================

-- Add new weather data columns to forecasts table
ALTER TABLE weather_forecasts
  ADD COLUMN IF NOT EXISTS precip_mm       FLOAT,
  ADD COLUMN IF NOT EXISTS rain_mm         FLOAT,
  ADD COLUMN IF NOT EXISTS snowfall_cm     FLOAT,
  ADD COLUMN IF NOT EXISTS wind_speed_max  FLOAT,
  ADD COLUMN IF NOT EXISTS wind_gust_max   FLOAT,
  ADD COLUMN IF NOT EXISTS cloud_cover_pct FLOAT,
  ADD COLUMN IF NOT EXISTS weather_code    INT;

-- Add ensemble probability data to consensus table
ALTER TABLE weather_consensus
  ADD COLUMN IF NOT EXISTS consensus_low_f       FLOAT,
  ADD COLUMN IF NOT EXISTS precip_consensus_mm   FLOAT,
  ADD COLUMN IF NOT EXISTS precip_agreement      TEXT,
  ADD COLUMN IF NOT EXISTS snowfall_consensus_cm FLOAT,
  ADD COLUMN IF NOT EXISTS ensemble_members      INT,
  ADD COLUMN IF NOT EXISTS ensemble_prob_above    JSONB,
  ADD COLUMN IF NOT EXISTS ensemble_prob_below    JSONB;

-- Add market type classification to markets table
-- market_type: 'temperature_high', 'temperature_low', 'precipitation', 'snowfall', 'climate', 'other'
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS market_type TEXT DEFAULT 'temperature_high';

-- Add analysis fields for precipitation markets
ALTER TABLE weather_analyses
  ADD COLUMN IF NOT EXISTS market_type        TEXT DEFAULT 'temperature_high',
  ADD COLUMN IF NOT EXISTS precip_consensus   FLOAT,
  ADD COLUMN IF NOT EXISTS ensemble_prob      FLOAT,
  ADD COLUMN IF NOT EXISTS ensemble_edge      FLOAT;

-- Index for market type queries
CREATE INDEX IF NOT EXISTS idx_markets_type ON markets(market_type) WHERE is_active = TRUE;

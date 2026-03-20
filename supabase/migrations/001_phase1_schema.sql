-- ============================================================
-- ARBITER Phase 1 — Database Schema
-- ============================================================

-- Cities we track for weather markets
CREATE TABLE IF NOT EXISTS weather_cities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  lat         FLOAT NOT NULL,
  lon         FLOAT NOT NULL,
  nws_office  TEXT,
  nws_grid_x  INT,
  nws_grid_y  INT,
  timezone    TEXT DEFAULT 'America/New_York',
  is_active   BOOLEAN DEFAULT TRUE
);

-- Seed data
INSERT INTO weather_cities (name, lat, lon, nws_office, nws_grid_x, nws_grid_y, timezone) VALUES
  ('New York City', 40.7128, -74.0060, 'OKX', 33, 37, 'America/New_York'),
  ('Chicago',       41.8781, -87.6298, 'LOT', 76, 73, 'America/Chicago'),
  ('Miami',         25.7617, -80.1918, 'MFL', 110, 39, 'America/New_York'),
  ('Seattle',       47.6062, -122.3321,'SEW', 138, 65, 'America/Los_Angeles'),
  ('Denver',        39.7392, -104.9903,'BOU', 56, 59, 'America/Denver'),
  ('Los Angeles',   34.0522, -118.2437,'LOX', 149, 48, 'America/Los_Angeles'),
  ('London',        51.5074, -0.1278,  NULL, NULL, NULL, 'Europe/London'),
  ('Tel Aviv',      32.0853,  34.7818, NULL, NULL, NULL, 'Asia/Jerusalem'),
  ('Tokyo',         35.6762,  139.6503,NULL, NULL, NULL, 'Asia/Tokyo'),
  ('Paris',         48.8566,  2.3522,  NULL, NULL, NULL, 'Europe/Paris')
ON CONFLICT DO NOTHING;

-- Weather model data per city per forecast window
CREATE TABLE IF NOT EXISTS weather_forecasts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id      UUID REFERENCES weather_cities(id) ON DELETE CASCADE,
  fetched_at   TIMESTAMPTZ DEFAULT NOW(),
  valid_date   DATE NOT NULL,
  source       TEXT NOT NULL,
  temp_high_f  FLOAT,
  temp_low_f   FLOAT,
  precip_prob  FLOAT,
  conditions   TEXT
);

CREATE INDEX IF NOT EXISTS idx_forecasts_city_date ON weather_forecasts(city_id, valid_date);
CREATE INDEX IF NOT EXISTS idx_forecasts_fetched ON weather_forecasts(fetched_at DESC);

-- Computed consensus across models
CREATE TABLE IF NOT EXISTS weather_consensus (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id          UUID REFERENCES weather_cities(id) ON DELETE CASCADE,
  calculated_at    TIMESTAMPTZ DEFAULT NOW(),
  valid_date       DATE NOT NULL,
  consensus_high_f FLOAT NOT NULL,
  model_spread_f   FLOAT NOT NULL,
  agreement        TEXT NOT NULL,
  models_used      TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_consensus_city_date ON weather_consensus(city_id, valid_date);

-- Polymarket markets
CREATE TABLE IF NOT EXISTS markets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_id    TEXT UNIQUE NOT NULL,
  platform        TEXT DEFAULT 'polymarket',
  question        TEXT NOT NULL,
  category        TEXT,
  city_id         UUID REFERENCES weather_cities(id),
  outcomes        TEXT[],
  outcome_prices  FLOAT[],
  volume_usd      FLOAT DEFAULT 0,
  liquidity_usd   FLOAT DEFAULT 0,
  resolution_date TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT TRUE,
  is_resolved     BOOLEAN DEFAULT FALSE,
  resolution_val  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_markets_city ON markets(city_id);

-- Claude's weather edge analysis
CREATE TABLE IF NOT EXISTS weather_analyses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id          UUID REFERENCES markets(id),
  city_id            UUID REFERENCES weather_cities(id),
  consensus_id       UUID REFERENCES weather_consensus(id),
  analyzed_at        TIMESTAMPTZ DEFAULT NOW(),
  model_high_f       FLOAT,
  model_spread_f     FLOAT,
  model_agreement    TEXT,
  best_outcome_idx   INT,
  best_outcome_label TEXT,
  market_price       FLOAT,
  true_prob          FLOAT,
  edge               FLOAT,
  direction          TEXT,
  confidence         TEXT,
  kelly_fraction     FLOAT,
  rec_bet_usd        FLOAT,
  reasoning          TEXT,
  auto_eligible      BOOLEAN DEFAULT FALSE,
  flags              TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_analyses_city ON weather_analyses(city_id, analyzed_at DESC);

-- Bet log (paper and real)
CREATE TABLE IF NOT EXISTS bets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id          UUID REFERENCES markets(id),
  analysis_id        UUID REFERENCES weather_analyses(id),
  placed_at          TIMESTAMPTZ DEFAULT NOW(),
  category           TEXT NOT NULL,
  direction          TEXT NOT NULL,
  outcome_label      TEXT,
  entry_price        FLOAT NOT NULL,
  amount_usd         FLOAT NOT NULL,
  is_paper           BOOLEAN DEFAULT TRUE,
  exit_price         FLOAT,
  pnl                FLOAT,
  status             TEXT DEFAULT 'OPEN',
  resolved_at        TIMESTAMPTZ,
  notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
CREATE INDEX IF NOT EXISTS idx_bets_placed ON bets(placed_at DESC);

-- Daily performance snapshots
CREATE TABLE IF NOT EXISTS performance_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date  DATE DEFAULT CURRENT_DATE,
  total_bets     INT DEFAULT 0,
  wins           INT DEFAULT 0,
  losses         INT DEFAULT 0,
  win_rate       FLOAT,
  total_pnl      FLOAT DEFAULT 0,
  paper_bankroll FLOAT DEFAULT 500,
  real_bankroll  FLOAT DEFAULT 0
);

-- Runtime settings
CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO system_config (key, value) VALUES
  ('paper_bankroll',         '500'),
  ('real_bankroll',          '0'),
  ('auto_execute',           'false'),
  ('max_bet_pct',            '0.05'),
  ('kelly_fraction',         '0.25'),
  ('min_edge',               '0.05'),
  ('min_confidence',         'MEDIUM'),
  ('min_liquidity',          '25000'),
  ('max_daily_bets',         '20'),
  ('paper_days_required',    '30'),
  ('paper_trade_start_date', ''),
  ('total_paper_bets',       '0'),
  ('paper_win_rate',         '0')
ON CONFLICT DO NOTHING;

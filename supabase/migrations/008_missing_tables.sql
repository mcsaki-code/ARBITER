-- ============================================================
-- ARBITER Phase 3 — Missing Tables
-- Adds 8 tables referenced in code but missing from schema:
-- calibration_snapshots, kalshi_markets, opportunity_analyses,
-- options_flow_signals, politics_analyses, sentiment_analyses,
-- trump_posts, whale_profiles
-- ============================================================

-- Daily calibration rollups per category × confidence tier (Brier scores)
CREATE TABLE IF NOT EXISTS calibration_snapshots (
  snapshot_date       DATE NOT NULL,
  category            TEXT NOT NULL,
  confidence_tier     TEXT NOT NULL,
  total_bets          INT DEFAULT 0,
  wins                INT DEFAULT 0,
  losses              INT DEFAULT 0,
  predicted_win_rate  FLOAT,
  actual_win_rate     FLOAT,
  avg_brier_score     FLOAT,
  avg_edge            FLOAT DEFAULT 0,
  avg_pnl             FLOAT DEFAULT 0,
  PRIMARY KEY (snapshot_date, category, confidence_tier)
);

CREATE INDEX IF NOT EXISTS idx_calibration_date ON calibration_snapshots(snapshot_date DESC);

-- Kalshi markets for cross-platform arbitrage scanning
CREATE TABLE IF NOT EXISTS kalshi_markets (
  ticker              TEXT PRIMARY KEY,
  event_ticker        TEXT,
  title               TEXT NOT NULL,
  subtitle            TEXT,
  yes_ask             FLOAT,
  no_ask              FLOAT,
  yes_bid             FLOAT,
  no_bid              FLOAT,
  last_price          FLOAT,
  volume              FLOAT DEFAULT 0,
  open_interest       FLOAT DEFAULT 0,
  close_time          TIMESTAMPTZ,
  status              TEXT DEFAULT 'open',
  category            TEXT DEFAULT 'other',
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kalshi_status ON kalshi_markets(status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_kalshi_category ON kalshi_markets(category);
CREATE INDEX IF NOT EXISTS idx_kalshi_close ON kalshi_markets(close_time);

-- Politics edge analyses (Claude-analyzed political event markets)
CREATE TABLE IF NOT EXISTS politics_analyses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id           UUID REFERENCES markets(id),
  analyzed_at         TIMESTAMPTZ DEFAULT NOW(),
  question_summary    TEXT,
  category            TEXT,
  best_outcome_idx    INT,
  best_outcome_label  TEXT,
  market_price        FLOAT,
  true_prob           FLOAT,
  edge                FLOAT,
  direction           TEXT,
  confidence          TEXT,
  kelly_fraction      FLOAT,
  rec_bet_usd         FLOAT,
  reasoning           TEXT,
  predictit_aligns    BOOLEAN,
  auto_eligible       BOOLEAN DEFAULT FALSE,
  flags               TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_politics_analyses_at ON politics_analyses(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_politics_analyses_market ON politics_analyses(market_id);

-- Trump social media / news posts for sentiment analysis
CREATE TABLE IF NOT EXISTS trump_posts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             TEXT UNIQUE NOT NULL,
  posted_at           TIMESTAMPTZ,
  content             TEXT NOT NULL,
  url                 TEXT,
  keywords            TEXT[],
  market_impact_score FLOAT DEFAULT 0,
  categories          TEXT[],
  source              TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trump_posts_posted ON trump_posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_trump_posts_postid ON trump_posts(post_id);

-- Options flow signals for sentiment-based edge detection
CREATE TABLE IF NOT EXISTS options_flow_signals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker              TEXT NOT NULL,
  call_volume         INT,
  put_volume          INT,
  put_call_ratio      FLOAT,
  mean_pcr            FLOAT,
  stddev_pcr          FLOAT,
  zscore              FLOAT,
  is_anomaly          BOOLEAN DEFAULT FALSE,
  anomaly_direction   TEXT DEFAULT 'NEUTRAL',
  raw_snapshot        JSONB,
  detected_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_options_flow_detected ON options_flow_signals(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_options_flow_ticker ON options_flow_signals(ticker);

-- Sentiment edge analyses (combines Trump posts + options flow)
CREATE TABLE IF NOT EXISTS sentiment_analyses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id           UUID REFERENCES markets(id),
  analyzed_at         TIMESTAMPTZ DEFAULT NOW(),
  signal_type         TEXT,
  options_signal_id   UUID REFERENCES options_flow_signals(id),
  trump_post_id       UUID REFERENCES trump_posts(id),
  trump_keywords      TEXT[],
  categories          TEXT[],
  market_price        FLOAT,
  true_prob           FLOAT,
  edge                FLOAT,
  direction           TEXT,
  confidence          TEXT,
  kelly_fraction      FLOAT,
  rec_bet_usd         FLOAT,
  reasoning           TEXT,
  auto_eligible       BOOLEAN DEFAULT FALSE,
  flags               TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_sentiment_analyses_at ON sentiment_analyses(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentiment_analyses_market ON sentiment_analyses(market_id);

-- General opportunity analyses (catches uncategorized markets)
CREATE TABLE IF NOT EXISTS opportunity_analyses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id           UUID REFERENCES markets(id),
  analyzed_at         TIMESTAMPTZ DEFAULT NOW(),
  question            TEXT,
  market_category     TEXT,
  market_price        FLOAT,
  true_prob           FLOAT,
  edge                FLOAT,
  direction           TEXT,
  confidence          TEXT,
  kelly_fraction      FLOAT,
  rec_bet_usd         FLOAT,
  reasoning           TEXT,
  auto_eligible       BOOLEAN DEFAULT FALSE,
  flags               TEXT[],
  manifold_prob       FLOAT,
  metaculus_prob       FLOAT
);

CREATE INDEX IF NOT EXISTS idx_opportunity_analyses_at ON opportunity_analyses(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunity_analyses_market ON opportunity_analyses(market_id);

-- Whale wallet profiles for copy-trading signals
CREATE TABLE IF NOT EXISTS whale_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address             TEXT UNIQUE NOT NULL,
  win_rate            FLOAT,
  total_profit        FLOAT DEFAULT 0,
  total_bets          INT DEFAULT 0,
  last_updated        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whale_address ON whale_profiles(address);
CREATE INDEX IF NOT EXISTS idx_whale_profit ON whale_profiles(total_profit DESC);

-- ============================================================
-- Safety: partial unique index on bets to prevent duplicate
-- open positions on the same market (race condition guard).
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_one_open_per_market
  ON bets(market_id)
  WHERE status = 'OPEN';

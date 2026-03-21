-- ============================================================
-- ARBITER Phase 2 — Expansion Tables
-- Sports odds, crypto signals, arbitrage opportunities
-- ============================================================

-- Arbitrage opportunities detected across markets
CREATE TABLE IF NOT EXISTS arb_opportunities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  market_a_id     TEXT NOT NULL,                    -- Polymarket condition_id
  market_b_id     TEXT,                             -- Kalshi/other platform ID (nullable for sum-to-one arbs)
  platform_a      TEXT DEFAULT 'polymarket',
  platform_b      TEXT,                             -- 'kalshi', 'polymarket' (same-platform arb), null for sum-to-one
  event_question  TEXT NOT NULL,
  price_yes       FLOAT NOT NULL,
  price_no        FLOAT NOT NULL,
  combined_cost   FLOAT NOT NULL,                   -- price_yes + price_no (< 1.0 = arb)
  gross_edge      FLOAT NOT NULL,                   -- 1.0 - combined_cost
  net_edge        FLOAT,                            -- after fees
  volume_a        FLOAT DEFAULT 0,
  volume_b        FLOAT DEFAULT 0,
  liquidity_a     FLOAT DEFAULT 0,
  liquidity_b     FLOAT DEFAULT 0,
  category        TEXT,                             -- 'sports', 'crypto', 'politics', etc.
  status          TEXT DEFAULT 'OPEN',              -- OPEN, EXECUTED, EXPIRED, SKIPPED
  executed_at     TIMESTAMPTZ,
  pnl             FLOAT,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_arb_detected ON arb_opportunities(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_arb_status ON arb_opportunities(status) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_arb_edge ON arb_opportunities(gross_edge DESC);
-- No unique constraint on market_a_id: scanner expires old OPEN rows and inserts fresh each run

-- Sports odds from external sportsbooks (for cross-reference)
CREATE TABLE IF NOT EXISTS sports_odds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  event_id        TEXT NOT NULL,                    -- external event identifier
  sport           TEXT NOT NULL,                    -- 'basketball_nba', 'football_nfl', etc.
  league          TEXT NOT NULL,                    -- 'NBA', 'NFL', 'NCAA', etc.
  home_team       TEXT NOT NULL,
  away_team       TEXT NOT NULL,
  commence_time   TIMESTAMPTZ NOT NULL,
  sportsbook      TEXT NOT NULL,                    -- 'draftkings', 'fanduel', etc.
  market_type     TEXT DEFAULT 'h2h',               -- 'h2h', 'spreads', 'totals'
  outcome_name    TEXT NOT NULL,
  price_decimal   FLOAT NOT NULL,                   -- decimal odds
  implied_prob    FLOAT NOT NULL,                   -- 1 / decimal odds
  point_spread    FLOAT,                            -- for spreads/totals
  polymarket_id   TEXT,                             -- matched Polymarket condition_id
  polymarket_price FLOAT                            -- Polymarket price for same outcome
);

CREATE INDEX IF NOT EXISTS idx_sports_event ON sports_odds(event_id, sportsbook);
CREATE INDEX IF NOT EXISTS idx_sports_commence ON sports_odds(commence_time);
CREATE INDEX IF NOT EXISTS idx_sports_poly ON sports_odds(polymarket_id) WHERE polymarket_id IS NOT NULL;

-- Sports edge analyses (Claude-analyzed sports mispricings)
CREATE TABLE IF NOT EXISTS sports_analyses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id         UUID REFERENCES markets(id),
  analyzed_at       TIMESTAMPTZ DEFAULT NOW(),
  event_description TEXT NOT NULL,
  sport             TEXT NOT NULL,
  sportsbook_consensus FLOAT,                       -- consensus implied prob from sportsbooks
  polymarket_price  FLOAT,
  edge              FLOAT,
  direction         TEXT,                            -- 'BUY_YES', 'BUY_NO', 'PASS'
  confidence        TEXT,                            -- 'HIGH', 'MEDIUM', 'LOW'
  kelly_fraction    FLOAT,
  rec_bet_usd       FLOAT,
  reasoning         TEXT,
  data_sources      TEXT[],                          -- which sportsbooks were used
  auto_eligible     BOOLEAN DEFAULT FALSE,
  flags             TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_sports_analyses_at ON sports_analyses(analyzed_at DESC);

-- Crypto signals for Bitcoin/ETH price bracket markets
CREATE TABLE IF NOT EXISTS crypto_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  asset           TEXT NOT NULL DEFAULT 'BTC',       -- 'BTC', 'ETH', etc.
  spot_price      FLOAT NOT NULL,
  price_1h_ago    FLOAT,
  price_24h_ago   FLOAT,
  volume_24h      FLOAT,
  rsi_14          FLOAT,                             -- Relative Strength Index
  bb_upper        FLOAT,                             -- Bollinger Band upper
  bb_lower        FLOAT,                             -- Bollinger Band lower
  funding_rate    FLOAT,                             -- perpetual futures funding rate
  open_interest   FLOAT,                             -- derivatives open interest
  fear_greed      INT,                               -- Fear & Greed index (0-100)
  implied_vol     FLOAT,                             -- Deribit options IV
  signal_summary  TEXT                               -- JSON blob of additional indicators
);

CREATE INDEX IF NOT EXISTS idx_crypto_fetched ON crypto_signals(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_asset ON crypto_signals(asset, fetched_at DESC);

-- Crypto edge analyses
CREATE TABLE IF NOT EXISTS crypto_analyses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id         UUID REFERENCES markets(id),
  signal_id         UUID REFERENCES crypto_signals(id),
  analyzed_at       TIMESTAMPTZ DEFAULT NOW(),
  asset             TEXT NOT NULL DEFAULT 'BTC',
  spot_at_analysis  FLOAT,
  target_bracket    TEXT,                             -- e.g., "$84K-$86K"
  bracket_prob      FLOAT,                           -- our estimated probability
  market_price      FLOAT,                           -- Polymarket price
  edge              FLOAT,
  direction         TEXT,
  confidence        TEXT,
  kelly_fraction    FLOAT,
  rec_bet_usd       FLOAT,
  reasoning         TEXT,
  auto_eligible     BOOLEAN DEFAULT FALSE,
  flags             TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_crypto_analyses_at ON crypto_analyses(analyzed_at DESC);

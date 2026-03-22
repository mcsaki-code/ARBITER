-- ============================================================
-- ARBITER Phase 3 — Live Trading Support
-- Adds columns to bets table for tracking real CLOB orders
-- and new system_config keys for live trading controls.
--
-- SAFE MIGRATION: All new columns are nullable with defaults,
-- so existing paper bets are unaffected.
-- ============================================================

-- New columns on bets table for live order tracking
ALTER TABLE bets ADD COLUMN IF NOT EXISTS clob_order_id    TEXT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS transaction_hash TEXT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS filled_price     FLOAT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS filled_size      FLOAT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS condition_id     TEXT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS token_id         TEXT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS order_status     TEXT DEFAULT 'NONE';
  -- NONE = paper bet (no CLOB order)
  -- PENDING = submitted to CLOB, awaiting fill
  -- FILLED = fully filled
  -- PARTIALLY_FILLED = some shares filled
  -- CANCELLED = cancelled by user or system
  -- REJECTED = rejected by CLOB (insufficient balance, invalid price, etc.)
  -- EXPIRED = GTC order expired

-- Index for looking up live orders
CREATE INDEX IF NOT EXISTS idx_bets_clob_order ON bets(clob_order_id) WHERE clob_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bets_order_status ON bets(order_status) WHERE order_status != 'NONE';

-- Live trading system config entries
INSERT INTO system_config (key, value) VALUES
  ('live_trading_enabled',    'false'),
  ('live_kill_switch',        'false'),
  ('live_max_single_bet_usd', '10'),
  ('live_max_daily_usd',      '50'),
  ('live_wallet_address',     ''),
  ('live_total_orders',       '0'),
  ('live_total_pnl',          '0')
ON CONFLICT (key) DO NOTHING;

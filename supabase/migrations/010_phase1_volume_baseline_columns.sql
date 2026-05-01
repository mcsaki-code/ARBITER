-- ============================================================
-- ARBITER Phase 1 — Volume-Spike Exit Trigger (Dry-Run)
-- Migration A: minimal columns on `bets` for rolling volume baseline
--
-- These columns are the ONLY fields on `bets` that the position
-- monitor mutates. They store the trailing-24h average 10-min trade
-- volume for the bet's market, refreshed at most once per
-- `volume_exit_min_baseline_age_minutes` (default 60).
--
-- Numeric type is FLOAT (double precision) to match the rest of the
-- table (entry_price, amount_usd, pnl, exit_price are all FLOAT).
--
-- This migration is reversible — see REVERSE block at the bottom.
-- ============================================================

ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS volume_baseline        FLOAT,
  ADD COLUMN IF NOT EXISTS volume_baseline_set_at TIMESTAMPTZ;

COMMENT ON COLUMN bets.volume_baseline IS
  'Phase 1 vol-exit: trailing 24h average 10-min trade volume (USD), refreshed at most once per volume_exit_min_baseline_age_minutes';
COMMENT ON COLUMN bets.volume_baseline_set_at IS
  'Phase 1 vol-exit: timestamp the rolling baseline was last refreshed';

-- ============================================================
-- REVERSE (run manually if rolling back):
--
-- ALTER TABLE bets DROP COLUMN IF EXISTS volume_baseline;
-- ALTER TABLE bets DROP COLUMN IF EXISTS volume_baseline_set_at;
-- ============================================================

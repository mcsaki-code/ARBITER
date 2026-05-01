-- ============================================================
-- ARBITER Phase 1 — Volume-Spike Exit Trigger (Dry-Run)
-- Migration C: `system_config` flags
--
-- Stores all flags as TEXT to match the existing convention
-- (see `live_trading_enabled`, `min_confidence`, `blocked_cities`).
--
-- `volume_exit_enabled` defaults to "false" — no live exits in
-- Phase 1 regardless of flag state (the code path doesn't exist
-- yet). The flag is the master switch for the monitor itself.
--
-- This migration is reversible — see REVERSE block at the bottom.
-- ============================================================

INSERT INTO system_config (key, value) VALUES
  ('volume_exit_enabled',                   'false'),
  ('volume_exit_threshold',                 '3.0'),
  ('volume_exit_min_baseline_age_minutes',  '60'),
  ('volume_exit_max_alerts_per_day',        '5')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- REVERSE (run manually if rolling back):
--
-- DELETE FROM system_config WHERE key IN (
--   'volume_exit_enabled',
--   'volume_exit_threshold',
--   'volume_exit_min_baseline_age_minutes',
--   'volume_exit_max_alerts_per_day'
-- );
-- ============================================================

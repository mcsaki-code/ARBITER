-- ============================================================
-- ARBITER Phase 1 — Volume-Spike Exit Trigger (Dry-Run)
-- Migration B: `position_alerts` table
--
-- One row per detected volume-spike on an open position.
-- Pure observability — Phase 1 only writes to this table; it never
-- mutates `bets` (other than the rolling baseline columns added in
-- migration 010), never closes positions, never affects P&L.
--
-- Snapshots `entry_price`, `current_price`, `shares` at alert time
-- so post-hoc analysis is stable even after the bet eventually
-- resolves and `exit_price`/`pnl` are populated by the resolver.
--
-- `condition_id` is snapshotted alongside the FK so re-fetches
-- against the Polymarket data API don't require a join.
--
-- This migration is reversible — see REVERSE block at the bottom.
-- ============================================================

CREATE TABLE IF NOT EXISTS position_alerts (
  id                    BIGSERIAL PRIMARY KEY,
  bet_id                UUID         NOT NULL REFERENCES bets(id),
  market_id             UUID         NOT NULL REFERENCES markets(id),
  condition_id          TEXT         NOT NULL,
  alert_type            TEXT         NOT NULL,
  alert_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Snapshotted from `bets` at alert time
  entry_price           FLOAT        NOT NULL,
  current_price         FLOAT        NOT NULL,
  shares                FLOAT        NOT NULL,
  hypothetical_pnl      FLOAT        NOT NULL,

  -- Volume metrics (USD-equivalent, sum of size * price)
  current_volume_10min  FLOAT        NOT NULL,
  baseline_volume       FLOAT        NOT NULL,
  threshold_used        FLOAT        NOT NULL,

  dry_run               BOOLEAN      NOT NULL DEFAULT TRUE,
  notified              BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_position_alerts_bet_id   ON position_alerts(bet_id);
CREATE INDEX IF NOT EXISTS idx_position_alerts_alert_at ON position_alerts(alert_at);

COMMENT ON TABLE position_alerts IS
  'Phase 1 vol-exit dry-run: one row per detected volume-spike on an open bet. Pure observability.';
COMMENT ON COLUMN position_alerts.alert_type IS
  'Currently always VOLUME_SPIKE. Reserved for future trigger types.';
COMMENT ON COLUMN position_alerts.dry_run IS
  'Always TRUE in Phase 1. Phase 1.5 (sell path) will write FALSE rows when an exit is actually placed.';
COMMENT ON COLUMN position_alerts.notified IS
  'TRUE once the daily-cap email has been sent for the day this row falls in.';

-- ============================================================
-- REVERSE (run manually if rolling back):
--
-- DROP INDEX IF EXISTS idx_position_alerts_alert_at;
-- DROP INDEX IF EXISTS idx_position_alerts_bet_id;
-- DROP TABLE IF EXISTS position_alerts;
-- ============================================================

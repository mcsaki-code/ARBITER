-- ============================================================
-- ARBITER Phase 3 — Missing Bet Columns
-- Adds columns to bets table for tracking analysis metadata:
-- edge, confidence, predicted_prob, brier_score
-- ============================================================

-- Add columns for analysis metadata tracking
ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS edge            FLOAT,          -- Edge from analysis (for performance snapshot)
  ADD COLUMN IF NOT EXISTS confidence      TEXT,           -- Confidence level (HIGH/MEDIUM/LOW)
  ADD COLUMN IF NOT EXISTS predicted_prob  FLOAT,          -- Predicted win probability at bet time
  ADD COLUMN IF NOT EXISTS brier_score     FLOAT;          -- Calibration metric (post-resolution)

-- Index for performance snapshot queries
CREATE INDEX IF NOT EXISTS idx_bets_resolved_status ON bets(status, category, confidence)
  WHERE status IN ('WON', 'LOST');

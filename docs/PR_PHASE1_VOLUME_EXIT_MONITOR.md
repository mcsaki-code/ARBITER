# Phase 1 — Volume-Spike Exit Trigger (Dry-Run Observability)

**Branch:** `feature/phase1-volume-exit-monitor`
**Spec:** `~/PolyMarket/ARBITER_SPEC_volume_exit_and_whale_signal.md` (§3, with verification updates dated 2026-05-01)
**Scope:** Phase 1 only — pure observability. Phase 1.5 (sell path) and Phase 2 (whale signal) are out of scope.

## What this PR does

Adds a 5-minute Netlify cron that, when enabled, watches each open bet's market for a 3× spike in 10-minute trade volume. When a spike is detected, it writes a row to a new `position_alerts` table capturing the hypothetical-exit P&L at that moment. **No bets are closed, no positions are touched, no P&L is mutated.** Phase 1 is a measurement instrument — the data it collects decides whether Phase 1.5 (the actual sell path) is worth building.

Master flag `system_config.volume_exit_enabled` defaults to `'false'`. The function ships off; flip the flag manually to start collecting alerts.

## Files changed

**New**

- `supabase/migrations/010_phase1_volume_baseline_columns.sql` — adds `volume_baseline FLOAT`, `volume_baseline_set_at TIMESTAMPTZ` to `bets`. Reversible.
- `supabase/migrations/011_phase1_position_alerts.sql` — creates `position_alerts` table with UUID FKs to `bets` and `markets`, indexed on `bet_id` and `alert_at`. Reversible.
- `supabase/migrations/012_phase1_volume_exit_config.sql` — inserts 4 `system_config` flags (`volume_exit_enabled`, `volume_exit_threshold`, `volume_exit_min_baseline_age_minutes`, `volume_exit_max_alerts_per_day`). Reversible.
- `src/lib/position-monitor.ts` — the monitor itself. `runOnce()` is the single entry point; never throws.
- `netlify/functions/monitor-positions.ts` — thin Netlify scheduled handler (`schedule('*/5 * * * *', …)`) that calls `runOnce()`.
- `docs/PR_PHASE1_VOLUME_EXIT_MONITOR.md` — this file.

**Extended**

- `src/lib/polymarket.ts` — adds `getRecentVolume()`, `getTrailingVolumeAverage()`, `getCurrentMidPrice()` against the public `data-api.polymarket.com/trades` and `gamma-api.polymarket.com/markets` endpoints. All read-only, fail-open.
- `src/lib/notify.ts` — adds `sendVolumeExitCapNotification()` (matches the existing fail-silent Resend pattern).

**Not touched** (per hard constraints)

- `worker/src/temperature.ts`
- `netlify/functions/resolve-bets.ts`
- `netlify/functions/place-bets.ts`
- `src/lib/execute-bet.ts`
- Option B's gates (HIGH-only, blocked_cities, 0.15–0.25 entry band)
- `netlify.toml` — schedule is registered inline via `schedule()` per existing convention; no toml change needed

## Spec corrections applied (already committed in the spec file)

| Spec location | Was | Corrected to | Why |
|---|---|---|---|
| §3.5 Migration A | `NUMERIC` | `FLOAT` | matches `bets` table convention (`entry_price`, `pnl`, `exit_price` are all FLOAT) |
| §3.5 Migration B | `bet_id BIGINT` | `bet_id UUID` | live `bets.id` is UUID, not BIGINT |
| §3.5 Migration B | `market_id TEXT` | `market_id UUID REFERENCES markets(id)` + `condition_id TEXT` snapshot | TEXT-only would lose FK integrity; condition_id snapshot lets the monitor re-fetch trades without a join |
| §3.6 algorithm | `status = 'placed'` | `status = 'OPEN'` | live values are `'OPEN' \| 'WON' \| 'LOST'` |
| §3.9 files | "extend `netlify.toml`" | not touched | every existing scheduled function uses inline `schedule()`; no toml registration needed |

## Test plan (matches §3.10 of the spec)

### 1. Migration round-trip on a Supabase branch

```sh
# Forward
psql $SUPABASE_BRANCH_URL -f supabase/migrations/010_phase1_volume_baseline_columns.sql
psql $SUPABASE_BRANCH_URL -f supabase/migrations/011_phase1_position_alerts.sql
psql $SUPABASE_BRANCH_URL -f supabase/migrations/012_phase1_volume_exit_config.sql

# Confirm
\d bets                 # → has volume_baseline, volume_baseline_set_at
\d position_alerts      # → exists, FKs to bets and markets, indexes on bet_id and alert_at
SELECT * FROM system_config WHERE key LIKE 'volume_exit_%';  # → 4 rows, volume_exit_enabled='false'

# Reverse (paste from REVERSE blocks at the bottom of each migration)
ALTER TABLE bets DROP COLUMN IF EXISTS volume_baseline;
ALTER TABLE bets DROP COLUMN IF EXISTS volume_baseline_set_at;
DROP INDEX IF EXISTS idx_position_alerts_alert_at;
DROP INDEX IF EXISTS idx_position_alerts_bet_id;
DROP TABLE IF EXISTS position_alerts;
DELETE FROM system_config WHERE key IN (
  'volume_exit_enabled',
  'volume_exit_threshold',
  'volume_exit_min_baseline_age_minutes',
  'volume_exit_max_alerts_per_day'
);

# Confirm clean
\d bets                 # → no volume_baseline columns
\d position_alerts      # → does not exist
SELECT * FROM system_config WHERE key LIKE 'volume_exit_%';  # → 0 rows
```

### 2. Local invocation against Supabase branch with one fake open bet

Setup: insert a fake open bet pointed at a real Polymarket conditionId on the branch. Set `volume_exit_enabled='true'`. Then invoke `runOnce()` directly (e.g. via a one-off script that imports `src/lib/position-monitor.ts`).

Expected behavior:

| Scenario | Setup | Expected |
|---|---|---|
| Baseline cold | `volume_baseline IS NULL` | One pass refreshes baseline (`volume_baseline_set_at` updated, value > 0 if market has trades). No `position_alerts` row inserted. `summary.baselineRefreshed >= 1`. |
| Sub-threshold spike | manually set `volume_baseline = X` such that current 10-min volume ≈ 2X | No alert inserted. `summary.alerts == 0`. |
| Above-threshold spike | manually set `volume_baseline = X` such that current 10-min volume ≈ 3.5X | One alert row inserted with `dry_run=true`, `notified=false`. Bet row unchanged except for baseline columns (which weren't refreshed this pass — baseline was fresh enough). |
| Cap reached, first hit | seed 5 `position_alerts` rows for today | Cap email sent (or attempted; logs show `[monitor] cap email sent`). All 5 rows updated to `notified=true`. `summary.capEmailSent === true`. |
| Cap reached, already emailed | seed 5 alerts already at `notified=true` | No second email. `summary.capEmailSent === false`. |

### 3. Idempotency

Invoke `runOnce()` twice in the same minute against the spike scenario above.

Expected: only one `position_alerts` row total (the second pass is suppressed by the 10-minute dedupe window in `recentDuplicateExists()`). `summary.skippedDedupe >= 1` on the second pass.

### 4. Fail-open

Mock `getRecentVolume` (or temporarily point `DATA_API_BASE` at a 500-returning URL) to throw or return errors.

Expected: function logs the error, returns `200`, no `position_alerts` rows mutated. `summary.errors > 0`. Bet rows unchanged.

## Validation plan after merge

1. Apply migrations on prod Supabase.
2. Deploy with `volume_exit_enabled='false'`. Confirm cron registers and the function returns 200 with `enabled=false scanned=0` in logs (no API calls made).
3. Flip `volume_exit_enabled` to `'true'` via Supabase dashboard.
4. Watch logs over a few hours — confirm baselines populate on `bets.volume_baseline` for all open bets.
5. Wait for **30 dry-run alerts collected** (spec §3.8 — probably 1–3 weeks at current bet volume).
6. Run the §3.8 analysis: compare `would_have_realized` (from `position_alerts.hypothetical_pnl`) vs `actual_realized` after each alerted bet eventually resolves. Apply 1.5% slippage discount to the hypothetical. If aggregate beats actual by >5% of position size → Phase 1.5 is justified. Otherwise hold or kill.

## Notes / known limitations

- **Trade API pagination not implemented.** A single call to `/trades?market=…` is capped at the API's default page size (~500). For weather markets with low trade counts this is plenty for a 24h baseline; if Phase 2 expands to busier markets, paginate via `offset`.
- **Volume metric is USD-equivalent (`sum(size × price)`).** This matches `markets.volume_usd` denomination. If we later want share-count flow specifically, swap in `sum(size)` and migrate the column comments.
- **Daily-cap day boundary is UTC.** This matches `DATE(alert_at)` server-side semantics. If you'd rather have ET-local days for the email gating, change the `isoDateUtc` derivation in `runOnce()`.
- **Cron usage:** 12/hour × 24h = 288/day ≈ 8.6k/month. Well within the Netlify Pro 125k/month invocation budget.

## Deploy

Per request: do **not** push to `main`. Branch is `feature/phase1-volume-exit-monitor`. Merge after review.

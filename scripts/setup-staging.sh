#!/usr/bin/env bash
# ============================================================
# ARBITER — Staging Environment Setup
# Creates a separate Supabase project for staging and applies
# all migrations. Use this to test the full pipeline safely.
# ============================================================

set -euo pipefail

echo "================================================================"
echo " ARBITER Staging Environment Setup"
echo "================================================================"
echo ""

# Check prerequisites
command -v supabase >/dev/null 2>&1 || { echo "Error: supabase CLI not installed. Run: brew install supabase/tap/supabase"; exit 1; }

echo "This script will:"
echo "  1. Create a new Supabase project for staging (or use existing)"
echo "  2. Apply all migrations (001-008)"
echo "  3. Seed initial config values"
echo "  4. Generate a .env.staging file"
echo ""

# ── Step 1: Project setup ────────────────────────────────────
read -p "Enter your staging Supabase project URL (or 'local' for local dev): " STAGING_URL
read -p "Enter your staging service role key: " STAGING_KEY

if [ "$STAGING_URL" = "local" ]; then
  echo "Starting local Supabase..."
  supabase start
  STAGING_URL="http://localhost:54321"
  STAGING_KEY=$(supabase status -o json | grep service_role_key | cut -d'"' -f4)
  STAGING_ANON=$(supabase status -o json | grep anon_key | cut -d'"' -f4)
else
  read -p "Enter your staging anon key: " STAGING_ANON
fi

# ── Step 2: Apply migrations ────────────────────────────────
echo ""
echo "Applying migrations..."
MIGRATION_DIR="$(dirname "$0")/../supabase/migrations"

for sql_file in $(ls "$MIGRATION_DIR"/*.sql | sort); do
  echo "  Applying: $(basename "$sql_file")"
  # Use psql if available (local), otherwise use supabase API
  if [ "$STAGING_URL" = "http://localhost:54321" ]; then
    psql "postgresql://postgres:postgres@localhost:54322/postgres" -f "$sql_file" -q 2>&1 || echo "    Warning: some statements may have failed (OK if IF NOT EXISTS)"
  else
    # For remote Supabase, use the REST API or direct connection
    echo "    → Apply manually via Supabase SQL editor or direct psql connection"
  fi
done

# ── Step 3: Seed config ──────────────────────────────────────
echo ""
echo "Seeding system config..."
SEED_SQL="
INSERT INTO system_config (key, value) VALUES
  ('paper_bankroll', '5000'),
  ('paper_trade_start_date', '$(date +%Y-%m-%d)'),
  ('total_paper_bets', '0'),
  ('paper_win_rate', '0'),
  ('live_trading_enabled', 'false'),
  ('live_kill_switch', 'true'),
  ('live_max_single_bet_usd', '25'),
  ('live_max_daily_usd', '200')
ON CONFLICT (key) DO NOTHING;
"

if [ "$STAGING_URL" = "http://localhost:54321" ]; then
  echo "$SEED_SQL" | psql "postgresql://postgres:postgres@localhost:54322/postgres" -q
fi

# ── Step 4: Generate .env.staging ────────────────────────────
ENV_FILE="$(dirname "$0")/../.env.staging"
cat > "$ENV_FILE" << EOF
# ARBITER Staging Environment
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# DO NOT COMMIT THIS FILE

NEXT_PUBLIC_SUPABASE_URL=${STAGING_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${STAGING_ANON}
SUPABASE_SERVICE_ROLE_KEY=${STAGING_KEY}

# Claude API (use same key, analyses are cheap)
ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}

# The Odds API (use same key)
ODDS_API_KEY=\${ODDS_API_KEY}

# Live trading DISABLED in staging
LIVE_TRADING_ENABLED=false
POLYMARKET_PRIVATE_KEY=

# Staging flag — functions can check this
ARBITER_ENV=staging
EOF

echo ""
echo "================================================================"
echo " Staging setup complete!"
echo "================================================================"
echo ""
echo "  .env.staging written to: $ENV_FILE"
echo ""
echo "  To run in staging mode:"
echo "    cp .env.staging .env.local"
echo "    npm run dev"
echo ""
echo "  To run functions against staging:"
echo "    export \$(cat .env.staging | xargs)"
echo "    npx tsx netlify/functions/ingest-weather.ts"
echo ""
echo "  Monitor logs for 48h to find runtime bugs that"
echo "  code review alone cannot catch."
echo "================================================================"

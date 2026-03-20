-- ============================================================
-- Migration 003: Clean up non-weather markets + verify city config
-- ============================================================

-- Step 1: Deactivate non-US cities (if not already done by migration 002)
UPDATE weather_cities SET is_active = FALSE
WHERE name IN ('London', 'Tel Aviv', 'Tokyo', 'Paris');

-- Step 2: Verify high-edge cities exist (idempotent insert)
INSERT INTO weather_cities (name, lat, lon, nws_office, nws_grid_x, nws_grid_y, timezone, is_active) VALUES
  ('Oklahoma City', 35.4676, -97.5164, 'OUN', 42, 42, 'America/Chicago', TRUE),
  ('Omaha',         41.2565, -95.9345, 'OAX', 52, 52, 'America/Chicago', TRUE),
  ('Minneapolis',   44.9778, -93.2650, 'MPX', 107, 71, 'America/Chicago', TRUE),
  ('Phoenix',       33.4484, -112.0740,'PSR', 159, 57, 'America/Phoenix', TRUE),
  ('Atlanta',       33.7490, -84.3880, 'FFC', 51, 87, 'America/New_York', TRUE)
ON CONFLICT DO NOTHING;

-- Step 3: Delete non-weather markets from the markets table
-- These are sports, politics, crypto etc. that got in via text search
DELETE FROM markets
WHERE question ~* '(nba|nfl|mlb|nhl|ncaa|ufc|mma|boxing|tennis|golf|election|president|bitcoin|ethereum|crypto|touchdown|field goal|three-pointer|home run|strikeout|assists|rebounds|rushing|passing yards|sacks|points scored|total points|super bowl|world series|stanley cup|championship|playoff|mvp|oscar|emmy|grammy)'
AND condition_id NOT IN (
  SELECT DISTINCT market_id FROM bets WHERE market_id IS NOT NULL
);

-- Step 4: Also delete markets that don't match any weather terms and have no bets
-- Be conservative: only delete if question doesn't contain any weather indicator
DELETE FROM markets
WHERE id NOT IN (
  SELECT DISTINCT market_id FROM bets WHERE market_id IS NOT NULL
)
AND id NOT IN (
  SELECT DISTINCT market_id FROM weather_analyses WHERE market_id IS NOT NULL
)
AND question !~* '(temperature|weather|°f|°c|degrees fahrenheit|degrees celsius|precipitation|rainfall|snowfall|hurricane|tropical storm|heat wave|cold snap|frost|wind chill|heat index|daily high|daily low|warmest|coldest|record high|record low)'
AND is_resolved = FALSE;

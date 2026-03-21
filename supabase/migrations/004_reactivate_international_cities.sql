-- ============================================================
-- Migration 004: Re-activate international cities + add Toronto & Seoul
-- Polymarket has 219 active temperature markets, heavily weighted
-- toward international cities. These use Open-Meteo (GFS/ECMWF/ICON)
-- for weather data — no NWS needed.
-- ============================================================

-- Step 1: Re-activate existing international cities
UPDATE weather_cities SET is_active = TRUE
WHERE name IN ('London', 'Tel Aviv', 'Tokyo', 'Paris');

-- Step 2: Add Toronto and Seoul (idempotent)
INSERT INTO weather_cities (name, lat, lon, timezone, is_active) VALUES
  ('Toronto', 43.6532, -79.3832, 'America/Toronto', TRUE),
  ('Seoul',   37.5665, 126.9780, 'Asia/Seoul', TRUE)
ON CONFLICT DO NOTHING;

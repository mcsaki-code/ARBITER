-- ============================================================
-- ARBITER Phase 1.5 — Add high-volatility cities for better edges
-- ============================================================

-- Deactivate low-edge international cities (no NWS, rarely have Polymarket markets)
UPDATE weather_cities SET is_active = false WHERE name IN ('London', 'Tel Aviv', 'Tokyo', 'Paris');

-- Add high-volatility US cities with NWS data
INSERT INTO weather_cities (name, lat, lon, nws_office, nws_grid_x, nws_grid_y, timezone) VALUES
  ('Oklahoma City', 35.4676, -97.5164, 'OUN', 47, 44, 'America/Chicago'),
  ('Omaha',         41.2565, -95.9345, 'OAX', 52, 64, 'America/Chicago'),
  ('Minneapolis',   44.9778, -93.2650, 'MPX', 109, 71, 'America/Chicago'),
  ('Phoenix',       33.4484, -112.0740,'PSR', 163, 56, 'America/Phoenix'),
  ('Atlanta',       33.7490, -84.3880, 'FFC', 51, 86, 'America/New_York')
ON CONFLICT DO NOTHING;

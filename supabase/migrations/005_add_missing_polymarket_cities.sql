-- ============================================================
-- Migration 005: Add all cities with active Polymarket temperature markets
-- These cities appear in market questions but aren't tracked yet,
-- meaning they have city_id=NULL and get skipped by analyze-weather.
-- US cities include NWS grid data; international use Open-Meteo only.
-- ============================================================

-- US cities with NWS grid points
INSERT INTO weather_cities (name, lat, lon, nws_office, nws_grid_x, nws_grid_y, timezone, is_active) VALUES
  ('Houston',        29.7604, -95.3698,  'HGX', 65, 97, 'America/Chicago', TRUE),
  ('Dallas',         32.7767, -96.7970,  'FWD', 85, 108, 'America/Chicago', TRUE),
  ('San Francisco',  37.7749, -122.4194, 'MTR', 85, 105, 'America/Los_Angeles', TRUE),
  ('Boston',         42.3601, -71.0589,  'BOX', 71, 90, 'America/New_York', TRUE),
  ('Philadelphia',   39.9526, -75.1652,  'PHI', 57, 78, 'America/New_York', TRUE),
  ('Washington DC',  38.9072, -77.0369,  'LWX', 97, 71, 'America/New_York', TRUE),
  ('Las Vegas',      36.1699, -115.1398, 'VEF', 126, 97, 'America/Los_Angeles', TRUE),
  ('Austin',         30.2672, -97.7431,  'EWX', 156, 95, 'America/Chicago', TRUE),
  ('San Antonio',    29.4241, -98.4936,  'EWX', 140, 78, 'America/Chicago', TRUE),
  ('Portland',       45.5152, -122.6784, 'PQR', 108, 83, 'America/Los_Angeles', TRUE),
  ('Nashville',      36.1627, -86.7816,  'OHX', 49, 37, 'America/Chicago', TRUE),
  ('Charlotte',      35.2271, -80.8431,  'GSP', 116, 63, 'America/New_York', TRUE),
  ('Indianapolis',   39.7684, -86.1581,  'IND', 57, 68, 'America/New_York', TRUE),
  ('Columbus',       39.9612, -82.9988,  'ILN', 80, 64, 'America/New_York', TRUE),
  ('Jacksonville',   30.3322, -81.6557,  'JAX', 73, 10, 'America/New_York', TRUE),
  ('Memphis',        35.1495, -90.0490,  'MEG', 31, 68, 'America/Chicago', TRUE),
  ('Detroit',        42.3314, -83.0458,  'DTX', 65, 33, 'America/New_York', TRUE),
  ('Milwaukee',      43.0389, -87.9065,  'MKX', 88, 66, 'America/Chicago', TRUE),
  ('Kansas City',    39.0997, -94.5786,  'EAX', 35, 33, 'America/Chicago', TRUE),
  ('St. Louis',      38.6270, -90.1994,  'LSX', 89, 73, 'America/Chicago', TRUE),
  ('Tampa',          27.9506, -82.4572,  'TBW', 70, 56, 'America/New_York', TRUE),
  ('Orlando',        28.5383, -81.3792,  'MLB', 26, 66, 'America/New_York', TRUE),
  ('Baltimore',      39.2904, -76.6122,  'LWX', 105, 67, 'America/New_York', TRUE),
  ('Pittsburgh',     40.4406, -79.9959,  'PBZ', 77, 65, 'America/New_York', TRUE),
  ('Cincinnati',     39.1031, -84.5120,  'ILN', 51, 58, 'America/New_York', TRUE),
  ('Cleveland',      41.4993, -81.6944,  'CLE', 82, 64, 'America/New_York', TRUE),
  ('Sacramento',     38.5816, -121.4944, 'STO', 44, 56, 'America/Los_Angeles', TRUE),
  ('San Diego',      32.7157, -117.1611, 'SGX', 56, 15, 'America/Los_Angeles', TRUE),
  ('Raleigh',        35.7796, -78.6382,  'RAH', 73, 57, 'America/New_York', TRUE),
  ('Salt Lake City', 40.7608, -111.8910, 'SLC', 101, 175, 'America/Denver', TRUE),
  ('New Orleans',    29.9511, -90.0715,  'LIX', 87, 77, 'America/Chicago', TRUE)
ON CONFLICT DO NOTHING;

-- International cities (Open-Meteo GFS/ECMWF/ICON only, no NWS)
INSERT INTO weather_cities (name, lat, lon, timezone, is_active) VALUES
  ('Sydney',        -33.8688, 151.2093, 'Australia/Sydney', TRUE),
  ('Dubai',          25.2048,  55.2708, 'Asia/Dubai', TRUE),
  ('Berlin',         52.5200,  13.4050, 'Europe/Berlin', TRUE),
  ('Madrid',         40.4168,  -3.7038, 'Europe/Madrid', TRUE),
  ('Rome',           41.9028,  12.4964, 'Europe/Rome', TRUE),
  ('Mumbai',         19.0760,  72.8777, 'Asia/Kolkata', TRUE),
  ('Singapore',       1.3521, 103.8198, 'Asia/Singapore', TRUE),
  ('Mexico City',    19.4326, -99.1332, 'America/Mexico_City', TRUE),
  ('Cairo',          30.0444,  31.2357, 'Africa/Cairo', TRUE),
  ('Bangkok',        13.7563, 100.5018, 'Asia/Bangkok', TRUE),
  ('Istanbul',       41.0082,  28.9784, 'Europe/Istanbul', TRUE),
  ('São Paulo',     -23.5505, -46.6333, 'America/Sao_Paulo', TRUE),
  ('Buenos Aires',  -34.6037, -58.3816, 'America/Argentina/Buenos_Aires', TRUE)
ON CONFLICT DO NOTHING;

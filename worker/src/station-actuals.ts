/**
 * Station Actuals + Resolution-Source Fidelity — Phase 1 of the reset plan.
 *
 * WHY: Polymarket temperature markets resolve against a SPECIFIC station
 * (usually the airport METAR / official NOAA record) named in each market's
 * rules. ARBITER's `weather_actuals` is an Open-Meteo grid value — close,
 * but the airport-vs-grid gap has a predictable sign and magnitude per
 * geography. This module gives us ground truth at the resolution source:
 *
 *   1. ingestStationActuals(): pulls METAR observations from
 *      aviationweather.gov (free, no key) for every station in
 *      weather_station_map and maintains daily highs in station_actuals.
 *   2. backfillResolutionSources(): fetches Gamma market descriptions for
 *      active temperature markets and extracts the resolution station so
 *      seed-guess mappings can be confirmed or corrected.
 *
 * Downstream uses: per-station bias correction (forecast point vs official
 * reading), resolution cross-checking, and honest calibration targets.
 */

import { SupabaseClient } from '@supabase/supabase-js';

const METAR_BASE = 'https://aviationweather.gov/api/data/metar';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const METAR_BATCH = 20;            // stations per request
const GAMMA_BACKFILL_LIMIT = 25;   // markets per cycle (be polite)

interface MetarOb {
  icaoId?: string;
  reportTime?: string;   // 'YYYY-MM-DD HH:MM:SS' UTC
  obsTime?: number;      // unix seconds (some responses)
  temp?: number | null;  // °C
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cToF(c: number): number { return c * 9 / 5 + 32; }

/** Local calendar date for a UTC instant in an IANA timezone. */
export function localDateFor(utcMs: number, timezone: string | null): string {
  try {
    if (timezone) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(utcMs));
    }
  } catch { /* fall through */ }
  return new Date(utcMs).toISOString().slice(0, 10);
}

export interface StationIngestResult {
  stations: number;
  obs: number;
  daysUpserted: number;
  errors: number;
}

export async function ingestStationActuals(
  supabase: SupabaseClient,
  options: { verbose?: boolean } = {}
): Promise<StationIngestResult> {
  const verbose = options.verbose ?? true;
  const log = (m: string) => { if (verbose) console.log(`[station-actuals] ${m}`); };
  let obsCount = 0, daysUpserted = 0, errors = 0;

  const { data: mapRows, error: mapErr } = await supabase
    .from('weather_station_map')
    .select('city_id, station_id, weather_cities(timezone)');
  if (mapErr || !mapRows?.length) {
    if (mapErr) { console.error(`[station-actuals] map fetch: ${mapErr.message}`); errors++; }
    return { stations: 0, obs: 0, daysUpserted, errors };
  }

  const stationMeta = new Map<string, { cityId: string; timezone: string | null }>();
  for (const row of mapRows) {
    const r = row as unknown as { city_id: string; station_id: string; weather_cities: { timezone: string | null } | null };
    stationMeta.set(r.station_id.toUpperCase(), {
      cityId: r.city_id,
      timezone: r.weather_cities?.timezone ?? null,
    });
  }
  const stationIds = [...stationMeta.keys()];

  // daily max accumulator: `${station}|${localDate}` → { maxC, n }
  const acc = new Map<string, { maxC: number; n: number }>();

  for (let i = 0; i < stationIds.length; i += METAR_BATCH) {
    const batch = stationIds.slice(i, i + METAR_BATCH);
    try {
      const url = `${METAR_BASE}?ids=${batch.join(',')}&format=json&hours=36`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'Accept': 'application/json', 'User-Agent': 'ARBITER/1.2 (+https://arbit3r.netlify.app)' },
      });
      if (!res.ok) { errors++; console.warn(`[station-actuals] HTTP ${res.status} for batch ${i / METAR_BATCH}`); continue; }
      const data = await res.json() as MetarOb[] | { metar?: MetarOb[] };
      const obs: MetarOb[] = Array.isArray(data) ? data : (data.metar ?? []);
      for (const ob of obs) {
        const sid = (ob.icaoId ?? '').toUpperCase();
        const meta = stationMeta.get(sid);
        if (!meta || ob.temp == null || !Number.isFinite(ob.temp)) continue;
        const utcMs = ob.obsTime != null
          ? ob.obsTime * 1000
          : ob.reportTime ? Date.parse(ob.reportTime.replace(' ', 'T') + (ob.reportTime.endsWith('Z') ? '' : 'Z')) : NaN;
        if (!Number.isFinite(utcMs)) continue;
        obsCount++;
        const date = localDateFor(utcMs, meta.timezone);
        const key = `${sid}|${date}`;
        const cur = acc.get(key);
        if (!cur || ob.temp > cur.maxC) acc.set(key, { maxC: ob.temp, n: (cur?.n ?? 0) + 1 });
        else cur.n++;
      }
    } catch (e) {
      errors++;
      console.warn(`[station-actuals] batch error: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(300);
  }

  if (acc.size === 0) {
    log(`No observations accumulated (stations=${stationIds.length})`);
    return { stations: stationIds.length, obs: obsCount, daysUpserted, errors };
  }

  // Merge with existing daily rows — daily max must only ratchet upward
  // within a day as new obs arrive (never down: a 36h window can miss the
  // afternoon peak of a day we already recorded fully).
  const dates = [...new Set([...acc.keys()].map((k) => k.split('|')[1]))];
  const { data: existing } = await supabase
    .from('station_actuals')
    .select('station_id, date, temp_high_c, n_obs')
    .in('date', dates);
  const existingMap = new Map<string, { c: number; n: number }>();
  for (const row of existing ?? []) {
    const r = row as { station_id: string; date: string; temp_high_c: number | null; n_obs: number | null };
    existingMap.set(`${r.station_id}|${r.date}`, { c: r.temp_high_c ?? -Infinity, n: r.n_obs ?? 0 });
  }

  const upserts: Array<Record<string, unknown>> = [];
  for (const [key, v] of acc) {
    const [sid, date] = key.split('|');
    const prev = existingMap.get(key);
    const maxC = prev ? Math.max(prev.c, v.maxC) : v.maxC;
    upserts.push({
      station_id: sid,
      city_id: stationMeta.get(sid)?.cityId ?? null,
      date,
      temp_high_c: Math.round(maxC * 10) / 10,
      temp_high_f: Math.round(cToF(maxC) * 10) / 10,
      n_obs: Math.max(prev?.n ?? 0, v.n),
      source: 'metar',
      fetched_at: new Date().toISOString(),
    });
  }
  const { error: upErr } = await supabase
    .from('station_actuals')
    .upsert(upserts, { onConflict: 'station_id,date' });
  if (upErr) { errors++; console.warn(`[station-actuals] upsert: ${upErr.message}`); }
  else daysUpserted = upserts.length;

  log(`Done: stations=${stationIds.length} obs=${obsCount} dayRows=${daysUpserted} errors=${errors}`);
  return { stations: stationIds.length, obs: obsCount, daysUpserted, errors };
}

// ──────────────────────────────────────────────────────────────────
// Resolution-source backfill: pull Gamma descriptions, extract station
// ──────────────────────────────────────────────────────────────────

/** Extract a plausible resolution station from market rules text. */
export function parseResolutionStation(description: string): string | null {
  if (!description) return null;
  const d = description.replace(/\s+/g, ' ');
  // Common patterns: "as reported at <Name> Airport (ICAO)", "station <ICAO>",
  // "METAR ... <ICAO>", "(KLGA)". ICAO codes are 4 uppercase letters.
  const near = d.match(/(?:airport|station|metar|weather)[^.]{0,80}?\(([A-Z]{4})\)/i)
    ?? d.match(/\(([A-Z]{4})\)[^.]{0,80}?(?:airport|station|metar|weather)/i)
    ?? d.match(/\bstation\s+([A-Z]{4})\b/);
  if (near) return near[1].toUpperCase();
  return null;
}

export async function backfillResolutionSources(
  supabase: SupabaseClient,
  options: { verbose?: boolean } = {}
): Promise<{ fetched: number; parsed: number; errors: number }> {
  const verbose = options.verbose ?? true;
  const log = (m: string) => { if (verbose) console.log(`[res-source] ${m}`); };
  let fetched = 0, parsed = 0, errors = 0;

  const { data: targets } = await supabase
    .from('markets')
    .select('id, gamma_market_id, city_id')
    .eq('is_active', true)
    .eq('category', 'temperature')
    .is('description', null)
    .not('gamma_market_id', 'is', null)
    .limit(GAMMA_BACKFILL_LIMIT);

  for (const m of targets ?? []) {
    const t = m as { id: string; gamma_market_id: string; city_id: string | null };
    try {
      const res = await fetch(`${GAMMA_BASE}/markets/${t.gamma_market_id}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) { errors++; continue; }
      const data = await res.json() as { description?: string };
      fetched++;
      const desc = (data.description ?? '').slice(0, 4000);
      const station = parseResolutionStation(desc);
      await supabase.from('markets').update({
        description: desc || '(empty)',
        ...(station ? { resolution_station: station } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', t.id);
      if (station) {
        parsed++;
        // Upgrade the city's station mapping when rules confirm it
        if (t.city_id) {
          await supabase.from('weather_station_map').upsert({
            city_id: t.city_id,
            station_id: station,
            confidence: 'parsed_from_rules',
            notes: `Parsed from market ${t.id} rules text 2026-06-12+`,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'city_id' });
        }
      }
    } catch (e) {
      errors++;
      console.warn(`[res-source] ${t.gamma_market_id}: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(400);
  }
  log(`Done: fetched=${fetched} stationParsed=${parsed} errors=${errors}`);
  return { fetched, parsed, errors };
}

// Rain on a 5×5 grid around the house (10/25/50 km) for the next three hours, from one
// Open-Meteo multi-location request. Port of NamMaLaew's wlm/rain_forecast.py; the dashboard
// map (public/js/rain-map.js) draws it next to the RainViewer radar.

import { logger } from './log.js';

const log = logger('rain');

export const RADII = [10, 25, 50];
const GRID_SIZE = 5;
const WINDOWS = 3;
const HOUR_MS = 3600e3;
const KM_PER_DEG = 111.32;
const TIMEOUT_MS = 15e3;
// forecast_hours counts from the current hour, so 6 still covers the next three windows when a
// 30-minute-old cache entry has crossed an hour boundary.
const FORECAST_HOURS = 6;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const fail = (message, status, code, detail = '') => Object.assign(new Error(message), { status, code, detail });
const badData = (detail) => fail('ข้อมูลพยากรณ์ฝนผิดรูปแบบ', 502, 'bad-data', detail);
const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * n×n points evenly spread over the square around the centre, row by row from north to south,
 * west to east; the middle point is the centre. Flat-earth maths is within ~1% at ≤ 50 km.
 */
export function gridPoints(lat, lon, radiusKm, n = GRID_SIZE) {
  const stepKm = (2 * radiusKm) / (n - 1);
  const half = (n - 1) / 2;
  const kmPerDegLon = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const points = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      points.push({ lat: lat + ((half - row) * stepKm) / KM_PER_DEG, lon: lon + ((col - half) * stepKm) / kmPerDegLon });
    }
  }
  return points;
}

export class RainForecast {
  constructor({ getLocation, fetchImpl = fetch, apiBase = 'https://api.open-meteo.com', ttlMs = 30 * 60e3, now = Date.now } = {}) {
    this.getLocation = getLocation;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    this.ttlMs = ttlMs;
    this.now = now;
    this.location = '';
    this.cache = new Map(); // "lat,lon,radius" -> { at, fetchedAt, points, locations }
    this.inflight = new Map(); // same key -> promise, so parallel requests share one call
  }

  /** Rain for the three one-hour windows starting with the current one. Throws an Error with a Thai message. */
  async grid(radiusKm) {
    const radius = Number(radiusKm);
    if (!RADII.includes(radius)) throw fail(`รัศมีต้องเป็น ${RADII.slice(0, -1).join(', ')} หรือ ${RADII.at(-1)} กม.`, 400, 'bad-radius');
    const loc = readLocation(this.getLocation?.());
    if (!loc) throw fail('ยังไม่ได้ใส่พิกัดบ้าน', 409, 'no-location');
    const where = `${loc.lat},${loc.lon}`;
    if (where !== this.location) {
      this.location = where;
      this.cache.clear();
    }
    const entry = await this.load(where, loc, radius);
    return buildGrid(entry, loc, radius, this.now());
  }

  async load(where, loc, radius) {
    const key = `${where},${radius}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit;
    if (!this.inflight.has(key)) {
      const job = this.fetchEntry(loc, radius)
        .then((entry) => {
          // the house may have moved while we waited; never cache the old place under the new one
          if (where === this.location) this.cache.set(key, entry);
          return entry;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return this.inflight.get(key);
  }

  async fetchEntry(loc, radius) {
    const points = gridPoints(loc.lat, loc.lon, radius);
    try {
      const body = await this.request(forecastUrl(this.apiBase, points));
      const locations = parseLocations(body, points.length);
      const at = this.now();
      return { at, fetchedAt: new Date(at).toISOString(), points, locations };
    } catch (err) {
      log.warn(`${err.message}${err.detail ? ` — ${err.detail}` : ''}`);
      throw err;
    }
  }

  async request(url) {
    let res;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw transportError(err);
    }
    if (!res.ok) {
      const reason = await res.text().catch(() => '');
      throw fail(`ดึงพยากรณ์ฝนไม่ได้ (Open-Meteo ตอบ ${res.status})`, 502, 'upstream', reason.slice(0, 200));
    }
    try {
      return await res.json();
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw transportError(err);
      throw badData('response is not JSON');
    }
  }
}

function transportError(err) {
  if (err.name === 'TimeoutError') return fail('ดึงพยากรณ์ฝนไม่ได้ (หมดเวลา)', 504, 'timeout');
  return fail('ดึงพยากรณ์ฝนไม่ได้ (เชื่อมต่อไม่ได้)', 502, 'network', err.cause?.code || err.message);
}

function readLocation(raw) {
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const lat = num(raw?.latitude);
  const lon = num(raw?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function forecastUrl(apiBase, points) {
  const lats = points.map((p) => p.lat.toFixed(5)).join(',');
  const lons = points.map((p) => wrapLon(p.lon).toFixed(5)).join(',');
  return `${apiBase}/v1/forecast?latitude=${lats}&longitude=${lons}` +
    `&hourly=precipitation&forecast_hours=${FORECAST_HOURS}&timezone=auto`;
}

// Open-Meteo answers a multi-location request with one object per location, in request order.
function parseLocations(body, count) {
  const list = Array.isArray(body) ? body : [body];
  if (list.length !== count) throw badData(`expected ${count} locations, got ${list.length}`);
  return list.map(parseLocation);
}

// Each location gets its own time zone with timezone=auto, so hours are keyed by the instant they end.
function parseLocation(item) {
  const offsetSec = item?.utc_offset_seconds ?? 0;
  const times = item?.hourly?.time;
  const values = item?.hourly?.precipitation;
  if (!Number.isFinite(offsetSec) || !Array.isArray(times) || !Array.isArray(values)) throw badData('missing hourly precipitation');
  const series = new Map();
  times.forEach((text, i) => {
    const end = parseLocalTime(text, offsetSec);
    if (!Number.isFinite(end)) throw badData(`bad time ${String(text).slice(0, 40)}`);
    const mm = values[i];
    series.set(end, typeof mm === 'number' && Number.isFinite(mm) ? mm : null);
  });
  return { offsetSec, series };
}

function parseLocalTime(text, offsetSec) {
  const m = LOCAL_TIME.exec(String(text));
  if (!m) return NaN;
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - offsetSec * 1000;
}

// Open-Meteo's hourly precipitation at time T is the total of the hour before T, so the window
// that contains `now` is the one ending at the next hour boundary (same windows as upstream).
function windowEnds(nowMs, offsetSec) {
  const offsetMs = offsetSec * 1000;
  const first = Math.floor((nowMs + offsetMs) / HOUR_MS) * HOUR_MS - offsetMs + HOUR_MS;
  return Array.from({ length: WINDOWS }, (_, i) => first + i * HOUR_MS);
}

function isoLocal(ms, offsetSec) {
  const clock = new Date(ms + offsetSec * 1000).toISOString().slice(0, 19);
  const abs = Math.abs(offsetSec);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return `${clock}${offsetSec < 0 ? '-' : '+'}${hh}:${mm}`;
}

function buildGrid({ fetchedAt, points, locations }, loc, radius, nowMs) {
  const home = locations[Math.floor(locations.length / 2)];
  const ends = windowEnds(nowMs, home.offsetSec);
  const open = ends.map((end) => home.series.has(end));
  const rainAt = (series, end) => {
    const mm = series.get(end);
    return mm === null || mm === undefined ? null : round(mm, 2);
  };
  return {
    center: { lat: loc.lat, lon: loc.lon },
    radiusKm: radius,
    cellKm: (2 * radius) / (GRID_SIZE - 1),
    times: ends.map((end, i) => (open[i] ? isoLocal(end - HOUR_MS, home.offsetSec) : null)),
    cells: points.map((p, j) => ({
      lat: round(p.lat, 5),
      lon: round(p.lon, 5),
      mm: ends.map((end, i) => (open[i] ? rainAt(locations[j].series, end) : null)),
    })),
    source: 'Open-Meteo',
    fetchedAt,
  };
}

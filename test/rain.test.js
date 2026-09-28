import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RADII, RainForecast, gridPoints } from '../src/rain.js';

const HOME = { latitude: 13.75, longitude: 100.5 };
const NOW = Date.parse('2026-09-27T17:15:00+07:00');
const MIN = 60e3;
// forecast_hours=6 from the current hour; each value is the rain of the hour *before* its time
const HOURS = ['17:00', '18:00', '19:00', '20:00', '21:00', '22:00'].map((t) => `2026-09-27T${t}`);

/** One Open-Meteo location; by default location i rains i + 0.1 × (hour index) mm. */
function place(i, { offset = 7 * 3600, times = HOURS, mm } = {}) {
  return {
    latitude: 13.75, longitude: 100.5, utc_offset_seconds: offset, timezone: 'Asia/Bangkok',
    hourly_units: { time: 'iso8601', precipitation: 'mm' },
    hourly: { time: times, precipitation: mm ?? times.map((_, h) => Math.round((i + h * 0.1) * 10) / 10) },
  };
}

/** A fake Open-Meteo that answers every request with `reply(url)` and records the calls. */
function openMeteo(reply = () => Array.from({ length: 25 }, (_, i) => place(i))) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const body = await reply(url);
    return body instanceof Response ? body : new Response(JSON.stringify(body));
  };
  return { calls, fetchImpl };
}

function setup({ reply, location = HOME, ttlMs } = {}) {
  const om = openMeteo(reply);
  const clock = { t: NOW };
  let loc = location;
  const rain = new RainForecast({ getLocation: () => loc, fetchImpl: om.fetchImpl, now: () => clock.t, ttlMs });
  return { rain, clock, calls: om.calls, moveTo: (next) => { loc = next; } };
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('gridPoints: 5×5 around the house, rows north→south, columns west→east, centre = house', () => {
  const pts = gridPoints(13.75, 100.5, 25);
  assert.equal(pts.length, 25);
  assert.ok(near(pts[12].lat, 13.75) && near(pts[12].lon, 100.5));
  assert.ok(pts[0].lat > pts[20].lat);
  assert.ok(pts[0].lon < pts[4].lon);
  for (let i = 0; i < 25; i++) {
    assert.ok(near(pts[i].lat + pts[24 - i].lat, 2 * 13.75), `point ${i} mirrors point ${24 - i}`);
    assert.ok(near(pts[i].lon + pts[24 - i].lon, 2 * 100.5));
  }
  assert.equal(gridPoints(0, 0, 10, 3).length, 9);
});

test('gridPoints: spacing follows the radius (km → degrees, longitude scaled by cos(lat))', () => {
  const lat = 13.75;
  const kmPerDegLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  for (const r of RADII) {
    const pts = gridPoints(lat, 100.5, r);
    assert.ok(near((pts[0].lat - pts[20].lat) * 111.32, 2 * r, 1e-6), 'north–south span is 2r');
    assert.ok(near((pts[4].lon - pts[0].lon) * kmPerDegLon, 2 * r, 1e-6), 'west–east span is 2r');
    assert.ok(near((pts[0].lat - pts[5].lat) * 111.32, r / 2, 1e-6), 'rows are 2r/4 apart');
    assert.ok(near((pts[1].lon - pts[0].lon) * kmPerDegLon, r / 2, 1e-6), 'columns are 2r/4 apart');
  }
  assert.deepEqual(RADII, [10, 25, 50]);
});

test('one multi-location Open-Meteo request becomes the 5×5 grid for the next 3 hours', async () => {
  const { rain, calls } = setup();
  const g = await rain.grid(25);

  assert.equal(calls.length, 1);
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].url.pathname, '/v1/forecast');
  assert.equal(q.get('latitude').split(',').length, 25);
  assert.equal(q.get('longitude').split(',').length, 25);
  assert.equal(q.get('latitude').split(',')[12], '13.75000');
  assert.equal(q.get('hourly'), 'precipitation');
  assert.equal(q.get('timezone'), 'auto');
  assert.ok(Number(q.get('forecast_hours')) >= 4);
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  assert.deepEqual(g.center, { lat: 13.75, lon: 100.5 });
  assert.equal(g.radiusKm, 25);
  assert.equal(g.cellKm, 12.5);
  assert.equal(g.source, 'Open-Meteo');
  assert.equal(g.fetchedAt, new Date(NOW).toISOString());
  assert.equal(g.cells.length, 25);
  assert.deepEqual(g.cells[12], { lat: 13.75, lon: 100.5, mm: [12.1, 12.2, 12.3] });
  assert.deepEqual(g.cells[0].mm, [0.1, 0.2, 0.3]);
  assert.ok(g.cells[0].lat > g.cells[24].lat && g.cells[0].lon < g.cells[24].lon);
});

test('picks the window that holds "now" and the two after it (17:15 → 17–18, 18–19, 19–20)', async () => {
  const { rain, clock } = setup();
  const g = await rain.grid(25);
  assert.deepEqual(g.times, ['2026-09-27T17:00:00+07:00', '2026-09-27T18:00:00+07:00', '2026-09-27T19:00:00+07:00']);
  assert.deepEqual(g.cells[5].mm, [5.1, 5.2, 5.3], 'the 17:00 value (5.0) is the 16–17 hour, already over');

  for (const [at, first] of [['17:00:00', '17:00'], ['17:59:59', '17:00'], ['18:00:00', '18:00']]) {
    clock.t = Date.parse(`2026-09-27T${at}+07:00`);
    assert.equal((await rain.grid(25)).times[0], `2026-09-27T${first}:00+07:00`, `at ${at}`);
  }
});

test('a cached grid still rolls forward with the clock', async () => {
  const { rain, clock, calls } = setup();
  clock.t = Date.parse('2026-09-27T17:50:00+07:00');
  await rain.grid(25);
  clock.t = Date.parse('2026-09-27T18:10:00+07:00');
  const g = await rain.grid(25);
  assert.equal(calls.length, 1);
  assert.equal(g.times[0], '2026-09-27T18:00:00+07:00');
  assert.deepEqual(g.cells[3].mm, [3.2, 3.3, 3.4]);
});

test('hours the API did not send are null (the map disables that button); missing values are null', async () => {
  const short = HOURS.slice(0, 3); // 17:00, 18:00, 19:00 → only 17–18 and 18–19 are known
  const { rain } = setup({
    reply: () => Array.from({ length: 25 }, (_, i) => place(i, { times: short, mm: i === 3 ? [0, null, 2] : [0, 1, 2] })),
  });
  const g = await rain.grid(10);
  assert.equal(g.times.length, 3);
  assert.equal(g.times[2], null);
  assert.ok(g.cells.every((c) => c.mm.length === 3 && c.mm[2] === null));
  assert.deepEqual(g.cells[0].mm, [1, 2, null]);
  assert.deepEqual(g.cells[3].mm, [null, 2, null]);
});

test('points in another time zone are matched by the instant, not the wall clock', async () => {
  // the north-west corner is across a border one hour ahead (UTC+8): its "19:00" is our 18:00
  const ahead = ['18:00', '19:00', '20:00', '21:00', '22:00', '23:00'].map((t) => `2026-09-27T${t}`);
  const { rain } = setup({
    reply: () => Array.from({ length: 25 }, (_, i) => (i === 0 ? place(0, { offset: 8 * 3600, times: ahead, mm: [9, 1, 2, 3, 4, 5] }) : place(i))),
  });
  const g = await rain.grid(50);
  assert.deepEqual(g.cells[0].mm, [1, 2, 3]);
  assert.equal(g.times[0], '2026-09-27T17:00:00+07:00');
});

test('caches each radius for 30 minutes, then asks Open-Meteo again', async () => {
  const { rain, clock, calls } = setup();
  await rain.grid(25);
  await rain.grid('25');
  clock.t += 29 * MIN;
  await rain.grid(25);
  assert.equal(calls.length, 1);

  await rain.grid(10);
  assert.equal(calls.length, 2, 'another radius is its own request');
  clock.t += MIN;
  const fresh = await rain.grid(25);
  assert.equal(calls.length, 3, 'refreshed after 30 minutes');
  assert.equal(fresh.fetchedAt, new Date(clock.t).toISOString());
});

test('parallel requests for the same radius share one Open-Meteo call', async () => {
  const { rain, calls } = setup();
  const [a, b] = await Promise.all([rain.grid(25), rain.grid(25)]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

test('moving the house clears the cache', async () => {
  const { rain, calls, moveTo } = setup();
  await rain.grid(25);
  moveTo({ latitude: 18.79, longitude: 98.98 });
  const g = await rain.grid(25);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get('latitude').split(',')[12], '18.79000');
  assert.deepEqual(g.center, { lat: 18.79, lon: 98.98 });
  assert.equal(g.cells[12].lat, 18.79);
});

test('only 10, 25 or 50 km — anything else is a 400 without calling Open-Meteo', async () => {
  const { rain, calls } = setup();
  for (const r of [7, 0, -25, 25.5, 'abc', '', null, undefined, 1e9]) {
    await assert.rejects(rain.grid(r), (err) => err.status === 400 && err.message === 'รัศมีต้องเป็น 10, 25 หรือ 50 กม.', `radius ${r}`);
  }
  assert.equal(calls.length, 0);
});

test('no house location yet: a Thai message, no request', async () => {
  for (const location of [null, { latitude: null, longitude: null }, { latitude: 13.75, longitude: '' }]) {
    const { rain, calls } = setup({ location });
    await assert.rejects(rain.grid(25), (err) => err.status === 409 && err.message === 'ยังไม่ได้ใส่พิกัดบ้าน');
    assert.equal(calls.length, 0);
  }
});

test('HTTP errors, timeouts, network and bad data become short Thai errors and are not cached', async () => {
  let reply = () => new Response('{"error":true,"reason":"busy"}', { status: 503 });
  const { rain, calls } = setup({ reply: (url) => reply(url) });
  await assert.rejects(rain.grid(25), (err) => err.status === 502 && err.message === 'ดึงพยากรณ์ฝนไม่ได้ (Open-Meteo ตอบ 503)');

  reply = () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  await assert.rejects(rain.grid(25), (err) => err.status === 504 && err.message === 'ดึงพยากรณ์ฝนไม่ได้ (หมดเวลา)');

  reply = () => Promise.reject(new TypeError('fetch failed'));
  await assert.rejects(rain.grid(25), { message: 'ดึงพยากรณ์ฝนไม่ได้ (เชื่อมต่อไม่ได้)' });

  for (const body of [[place(0)], new Response('<html>oops</html>'), Array.from({ length: 25 }, () => ({ hourly: {} })),
    Array.from({ length: 25 }, (_, i) => place(i, { times: ['yesterday'], mm: [1] }))]) {
    reply = () => body;
    await assert.rejects(rain.grid(25), (err) => err.status === 502 && err.message === 'ข้อมูลพยากรณ์ฝนผิดรูปแบบ');
  }

  assert.equal(calls.length, 7, 'every failure tried again instead of caching the error');
  reply = () => Array.from({ length: 25 }, (_, i) => place(i));
  assert.equal((await rain.grid(25)).cells.length, 25);
});

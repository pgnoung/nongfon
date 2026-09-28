import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aroundHome, composeHourly, HourlySummary } from '../src/hourly.js';
import { makeStore } from './helpers.js';

const NOW = Date.parse('2026-09-28T11:02:00Z'); // 18:02 in Bangkok
const TZ = 'Asia/Bangkok';

/** 5×5 rain grid (25 km); cells run north→south, west→east; index 12 is the house. */
function grid(mmAt = {}) {
  const cells = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) cells.push({ lat: 14 - r * 0.1, lon: 100.4 + c * 0.1, mm: [mmAt[r * 5 + c] ?? 0, 0, 0] });
  return { center: { lat: 13.8, lon: 100.6 }, radiusKm: 25, cellKm: 12.5, times: ['a', 'b', 'c'], cells };
}
const water = (over = {}) => ({ status: 'normal', level: 25, levelHourAgo: 25, headline: 'มีน้ำขังนอกโรงรถ', ...over });

test('around home: the heaviest rain this hour, which way and how far', () => {
  const a = aroundHome(grid({ 14: 6.2, 2: 1.1 })); // middle row, east edge
  assert.equal(a.maxMm, 6.2);
  assert.equal(a.direction, 'ตะวันออก');
  assert.equal(a.km, 25);
  assert.equal(aroundHome(grid({ 0: 2 })).direction, 'ตะวันตกเฉียงเหนือ');
  assert.equal(aroundHome(grid({ 12: 3 })).km, 0); // right over the house
  assert.equal(aroundHome(grid({})).maxMm, 0);
});

test('hourly: a calm hour is low risk and says so plainly', () => {
  const s = composeHourly({ now: NOW, timezone: TZ, water: water({ level: 5, levelHourAgo: 5, headline: 'แห้ง' }), weather: { nowMm: 0, next3hMm: 0, maxProb3h: 10 }, around: { maxMm: 0 }, news: [] });
  assert.match(s.title, /18:00/);
  assert.equal(s.risk, 'low');
  assert.match(s.text, /ไม่มีข่าวใหม่/);
});

test('hourly: water up with more rain coming is medium; rising water or a warning is high', () => {
  const rainy = { nowMm: 1.2, next3hMm: 6.5, maxProb3h: 80 };
  assert.equal(composeHourly({ now: NOW, timezone: TZ, water: water(), weather: rainy, around: { maxMm: 3 }, news: [] }).risk, 'medium');
  assert.equal(composeHourly({ now: NOW, timezone: TZ, water: water({ level: 40, levelHourAgo: 25 }), weather: rainy, around: { maxMm: 3 }, news: [] }).risk, 'high');
  assert.equal(composeHourly({ now: NOW, timezone: TZ, water: water({ status: 'warning' }), weather: null, around: null, news: null }).risk, 'high');
  // the reason says what actually drove it
  assert.match(composeHourly({ now: NOW, timezone: TZ, water: water(), weather: rainy, around: null, news: [] }).riskWhy, /อีก 6\.5 มม\./);
  assert.match(composeHourly({ now: NOW, timezone: TZ, water: water(), weather: { nowMm: 0, next3hMm: 0.1, maxProb3h: 89 }, around: null, news: [] }).riskWhy, /โอกาสฝนตก 89%/);
});

test('hourly: headlines keep their own words and source; missing data is said out loud', () => {
  const s = composeHourly({ now: NOW, timezone: TZ, water: null, weather: null, around: null, news: [{ title: 'กทม. เตือนฝนตกหนักคืนนี้', source: 'Thai PBS', at: NOW - 30 * 60e3 }] });
  assert.match(s.text, /กทม\. เตือนฝนตกหนักคืนนี้ \(Thai PBS 17:32\)/);
  assert.match(s.text, /ยังไม่มีผลตรวจ/);
  assert.match(s.text, /ไม่มีข้อมูลฝน/);
  assert.match(composeHourly({ now: NOW, timezone: TZ, water: water(), weather: null, around: null, news: null }).text, /ดึงข่าวไม่ได้/);
});

test('hourly summary: once per hour, sent silently, kept for the dashboard, off when switched off', async () => {
  const { store } = makeStore();
  store.updateSettings({ latitude: 13.8, longitude: 100.6 });
  const sent = [];
  let newsCalls = 0;
  const hs = new HourlySummary({
    store,
    weather: { refresh: async () => ({ nowMm: 0.5, next3hMm: 3, maxProb3h: 70 }) },
    rain: { grid: async () => grid({ 14: 6.2 }) },
    notifier: { send: async (m) => { sent.push(m); return {}; } },
    news: async () => { newsCalls++; if (newsCalls === 2) throw new Error('offline'); return [{ title: 'ฝนตกหนักหลายเขตในกรุงเทพฯ', source: 'ไทยรัฐ', at: NOW - 60e3 }]; },
  });
  assert.ok(await hs.maybeRun(NOW));
  assert.equal(await hs.maybeRun(NOW + 20 * 60e3), null); // same hour
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'hourly');
  assert.equal(sent[0].silent, true);
  assert.match(store.state.hourlySummary.text, /ไทยรัฐ/);
  assert.match(store.state.hourlySummary.text, /ตะวันออก/);
  assert.ok(await hs.maybeRun(NOW + 60 * 60e3)); // next hour, news offline this time
  assert.match(sent[1].text, /ดึงข่าวไม่ได้/);
  store.updateSettings({ hourlySummary: false });
  assert.equal(await hs.maybeRun(NOW + 120 * 60e3), null);
});

test('hourly summary: the latest camera picture rides along when there is one', async () => {
  const { store } = makeStore();
  const sent = [];
  const hs = new HourlySummary({ store, notifier: { send: async (m) => { sent.push(m); return {}; } }, news: async () => [], photoFor: async (r) => Buffer.from(`jpg:${r.id}`) });
  await hs.run(NOW);
  assert.equal(sent[0].photo, undefined); // no reading yet, nothing to show
  store.addReading({ id: 'r1', ts: NOW - 5 * 60e3, status: 'normal', level: 20, headline: 'แห้ง', reasons: [], cameras: [] });
  await hs.run(NOW + 60e3);
  assert.equal(typeof sent[1].photo, 'function');
  assert.equal(String(await sent[1].photo()), 'jpg:r1');
});

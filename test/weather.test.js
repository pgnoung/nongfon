import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Weather } from '../src/weather.js';
import { makeStore } from './helpers.js';

const forecast = (now, next) => ({
  current: { precipitation: now },
  hourly: {
    time: ['2026-09-27T01:00', '2026-09-27T02:00', '2026-09-27T03:00', '2026-09-27T04:00'],
    precipitation: next,
    precipitation_probability: next.map((mm) => (mm > 0 ? 80 : 5)),
  },
});

test('rain data from Open-Meteo, and "confirmed dry" only when it really is', async () => {
  const { store } = makeStore();
  let body = forecast(0, [0, 0, 0, 0]);
  let url = '';
  const w = new Weather({ store, fetchImpl: async (u) => { url = String(u); return new Response(JSON.stringify(body)); } });
  assert.equal(await w.refresh(), null); // no location yet
  assert.equal(w.get(), null);
  store.updateSettings({ latitude: 13.75, longitude: 100.5 });
  const d = await w.refresh();
  assert.match(url, /latitude=13\.75&longitude=100\.5/);
  assert.match(url, /hourly=precipitation,precipitation_probability/);
  assert.equal(d.nowMm, 0);
  assert.equal(w.confirmedDry(), true);
  body = forecast(2.4, [3, 1.5, 0.5, 0]);
  await w.refresh(true);
  assert.equal(w.data.next3hMm, 5);
  assert.equal(w.confirmedDry(), false);
});

test('network errors are kept as a message and never throw', async () => {
  const { store } = makeStore();
  store.updateSettings({ latitude: 1, longitude: 2 });
  const w = new Weather({ store, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await w.refresh(), null);
  assert.match(w.get().error, /ดึงข้อมูลฝนไม่ได้/);
  assert.equal(w.confirmedDry(), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Watcher } from '../src/watcher.js';
import { AlertPolicy } from '../src/alerts.js';
import { makeJpeg, makeStore, spy } from './helpers.js';

async function setup({ problem = null, answer } = {}) {
  const { store, dir } = makeStore();
  const pics = path.join(dir, 'pics');
  fs.mkdirSync(pics);
  fs.writeFileSync(path.join(pics, 'front.jpg'), await makeJpeg());
  const cameras = [
    { id: 'cam1', name: 'หน้าบ้าน', url: path.join(pics, 'front.jpg') },
    { id: 'cam2', name: 'โรงรถ', url: path.join(pics, 'missing.jpg') },
  ];
  store.setCameraMeta('cam1', { lines: { warning: [[0, 0.5], [1, 0.5]], critical: [[0, 0.8], [1, 0.8]] } });
  const requests = [];
  const engine = {
    name: 'fake',
    analyze: async (req) => {
      requests.push(req);
      return answer ? answer(req) : {
        ok: true, level: 100, confidence: 0.9, headline: 'น้ำถึงเส้นแดง',
        cameras: { cam1: { lineStatus: 'at_red', water: 'flooded', note: 'ถึงเส้นแดง' } },
        engine: 'fake', model: req.model, ms: 5, usage: { input: 10, output: 5 }, costUsd: 0.001,
      };
    },
  };
  const notifier = spy({ send: (m) => m, record: () => ({}) });
  const siren = spy({ sound: { ok: true }, stop: { ok: true }, unsnooze: {} });
  const alerts = new AlertPolicy({ store, notifier, siren, config: {} });
  const weather = { data: null, confirmedDry: () => false };
  const watcher = new Watcher({
    config: { cameras, ffmpegPath: 'ffmpeg' }, store, engine, alerts, weather, engineProblem: () => problem,
  });
  return { store, watcher, requests, notifier, siren, weather };
}

test('a full check: pictures saved, lines drawn in, red confirmed on the re-check', async () => {
  const t = await setup();
  const first = await t.watcher.cycle('manual');
  const r = first.reading;
  assert.equal(r.status, 'critical');
  assert.equal(first.recheckInMs, 90000);
  assert.equal(r.cameras[0].ok, true);
  assert.equal(r.cameras[0].lineStatus, 'at_red');
  assert.ok(fs.existsSync(t.store.snapshotFile(r.cameras[0].image)));
  assert.equal(r.cameras[1].ok, false);
  assert.match(r.cameras[1].error, /ไม่พบไฟล์/);
  assert.deepEqual(t.requests[0].expectedIds, ['cam1']);
  assert.equal(t.requests[0].model, 'claude-sonnet-5');
  assert.equal(t.requests[0].cacheTtl, '1h');
  assert.ok(t.requests[0].blocks.some((b) => b.type === 'image'));
  assert.equal(t.notifier.calls.filter((c) => c.name === 'send').length, 0);

  const second = await t.watcher.cycle('recheck');
  assert.equal(second.reading.recheck, true);
  const sends = t.notifier.calls.filter((c) => c.name === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].args[0].kind, 'critical');
  const photo = await sends[0].args[0].photo();
  assert.equal(photo[0], 0xff);
  assert.equal(t.store.readings.length, 2);
});

test('a missing API key is reported instead of calling Claude', async () => {
  const t = await setup({ problem: 'ยังไม่ได้ใส่ ANTHROPIC_API_KEY ใน .env' });
  const { reading } = await t.watcher.cycle('manual');
  assert.equal(reading.status, 'unknown');
  assert.match(reading.reasons[0], /ANTHROPIC_API_KEY/);
  assert.equal(t.requests.length, 0);
});

test('checks come faster while water is up and slower on confirmed dry nights', async () => {
  const t = await setup({ answer: () => ({ ok: true, level: 3, confidence: 0.9, headline: 'แห้ง', cameras: { cam1: { lineStatus: 'below_yellow', water: 'dry', note: '' } } }) });
  assert.equal(t.watcher.intervalMinutes(), 10);
  await t.watcher.cycle('manual');
  assert.equal(t.watcher.intervalMinutes(), 10); // dry but the forecast is unknown
  t.weather.confirmedDry = () => true;
  assert.equal(t.watcher.intervalMinutes(), 20);
  t.store.addReading({ ...t.store.latestReading(), id: 'w', status: 'warning' });
  assert.equal(t.watcher.intervalMinutes(), 3);
  // water past a green line (still below yellow) is watched closely too
  t.store.addReading({ ...t.store.latestReading(), id: 'g', status: 'normal', cameras: [{ id: 'cam1', ok: true, lines: { safe: [[0, 0.3], [1, 0.3]], warning: [[0, 0.5], [1, 0.5]] }, lineStatus: 'below_yellow' }] });
  assert.equal(t.watcher.intervalMinutes(), 3);
  t.store.addReading({ ...t.store.latestReading(), id: 'g2', cameras: [{ id: 'cam1', ok: true, lines: { safe: [[0, 0.3], [1, 0.3]], warning: [[0, 0.5], [1, 0.5]] }, lineStatus: 'below_green' }] });
  assert.equal(t.watcher.intervalMinutes(), 20);
  t.store.updateSettings({ adaptiveInterval: false });
  assert.equal(t.watcher.intervalMinutes(), 10);
});

test('pressing "check now" twice runs one check', async () => {
  const t = await setup();
  t.watcher.stopped = true; // don't schedule timers from this test
  const [a, b] = await Promise.all([t.watcher.runNow('manual'), t.watcher.runNow('manual')]);
  assert.equal(a, b);
  assert.equal(t.requests.length, 1);
});

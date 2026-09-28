import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { DEMO_LINES, renderDemoFrame } from '../src/camera/demo-scene.js';
import { DemoWorld, demoLineStatus, propertyLevel, waterBand } from '../src/demo.js';
import { buildAlertImage, drawLines, hasLines, linesSvg, visualLength } from '../src/camera/image.js';
import { faceSvg, MASCOT_CSS, mascotSvg, MOODS, moodFor } from '../public/js/mascot.js';
import { makeJpeg, makeStore } from './helpers.js';

test('demo: water reaches the drawn lines at the expected levels', () => {
  assert.equal(demoLineStatus('street', 0, DEMO_LINES.cam1), 'below_yellow');
  assert.equal(demoLineStatus('street', 40, DEMO_LINES.cam1), 'below_yellow');
  assert.equal(demoLineStatus('street', 60, DEMO_LINES.cam1), 'at_yellow');
  assert.equal(demoLineStatus('carport', 40, DEMO_LINES.cam2), 'below_yellow');
  assert.equal(demoLineStatus('carport', 55, DEMO_LINES.cam2), 'at_yellow');
  assert.equal(demoLineStatus('carport', 92, DEMO_LINES.cam2), 'at_red');
  assert.equal(demoLineStatus('carport', 92, { warning: [], critical: [] }), 'no_lines');
  assert.equal(waterBand('carport', 0), null);
  assert.equal(propertyLevel(50), 50);
  assert.equal(propertyLevel(90), 100);
});

test('demo: the storm cycle rises, peaks over the red line and drains', () => {
  const w = new DemoWorld({ origin: 0 });
  const cycle = 36 * 60e3;
  assert.ok(w.carportLevel(0.05 * cycle) < 5);
  assert.ok(w.carportLevel(0.6 * cycle) > 90);
  assert.ok(w.carportLevel(0.99 * cycle) < 5);
  assert.ok(w.sceneLevel('street', 0.4 * cycle) > w.sceneLevel('carport', 0.4 * cycle));
});

test('demo frames are real JPEGs; night frames are greyscale', async () => {
  const day = await renderDemoFrame('carport', { level: 60, night: false });
  const night = await renderDemoFrame('street', { level: 60, night: true, raining: true });
  const meta = await sharp(day).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1280);
  const { data } = await sharp(night).resize(8, 8).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 3) assert.ok(Math.abs(data[i] - data[i + 2]) < 6);
});

test('demo water stays behind what stands in front of it (car, step, gate posts)', async () => {
  const pixel = async (scene, level, x, y) => {
    const { data, info } = await sharp(await renderDemoFrame(scene, { level })).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const diff = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);
  // carport at 95: the car door and the step keep their paint, the open floor near the camera is under water
  assert.ok(diff(await pixel('carport', 0, 800, 540), await pixel('carport', 95, 800, 540)) < 30);
  assert.ok(diff(await pixel('carport', 0, 150, 600), await pixel('carport', 95, 150, 600)) < 30);
  assert.ok(diff(await pixel('carport', 0, 400, 600), await pixel('carport', 95, 400, 600)) > 60);
  // street at 70: the gate post stays dry-looking; the road turns water-blue and the yard floods
  assert.ok(diff(await pixel('street', 0, 96, 470), await pixel('street', 70, 96, 470)) < 30);
  assert.ok(diff(await pixel('street', 0, 640, 450), await pixel('street', 70, 640, 450)) > 30);
  assert.ok(diff(await pixel('street', 0, 640, 600), await pixel('street', 70, 640, 600)) > 60);
});

test('lines are burned into the picture the AI sees', async () => {
  const jpeg = await makeJpeg();
  assert.equal(hasLines({ warning: [[0, 0]] }), false);
  assert.equal(await drawLines(jpeg, {}), jpeg);
  const drawn = await drawLines(jpeg, { warning: [[0, 0.5], [1, 0.5]], critical: [[0, 0.9], [1, 0.9]] });
  assert.notEqual(drawn.length, jpeg.length);
  const svg = linesSvg(320, 180, { warning: [[0, 0.5], [1, 0.5]] });
  assert.match(svg, /YELLOW/);
  assert.doesNotMatch(svg, /RED/);
});

test('alert picture stacks cameras under a status banner', async () => {
  const a = await makeJpeg({ width: 640, height: 360 });
  const img = await buildAlertImage([{ name: 'หน้าบ้าน', buffer: a, lines: {} }, { name: 'โรงรถ', buffer: a, lines: {} }, { name: 'down', buffer: null }], { status: 'critical', level: 100, timeText: '02:22' });
  const meta = await sharp(img).metadata();
  assert.equal(meta.width, 1024);
  assert.ok(meta.height > 1024 * (360 / 640) * 2);
  assert.equal(await buildAlertImage([{ name: 'x', buffer: null }]), null);
  assert.equal(visualLength('หน้าบ้าน'), 6);
});

test('store: readings, events, meta and pruning', async () => {
  const { store, dir } = makeStore();
  const now = Date.now();
  store.addReading({ id: 'old', ts: now - 40 * 86400e3, status: 'normal', level: 0 });
  store.addReading({ id: 'new', ts: now, status: 'warning', level: 50 });
  store.addEvent({ id: 'e1', ts: now - 40 * 86400e3, kind: 'system', title: 'old' });
  store.addEvent({ id: 'e2', ts: now, kind: 'warning', title: 'new' });
  assert.equal(store.latestReading().id, 'new');
  assert.equal(store.getReading('old').id, 'old');
  assert.deepEqual(store.readingsSince(now - 1000).map((r) => r.id), ['new']);
  const oldSnap = store.snapshotFile('old.jpg');
  fs.writeFileSync(oldSnap, 'x');
  fs.utimesSync(oldSnap, new Date(now - 30 * 86400e3), new Date(now - 30 * 86400e3));
  fs.writeFileSync(store.snapshotFile('new.jpg'), 'x');
  store.prune(now);
  assert.deepEqual(store.readings.map((r) => r.id), ['new']);
  assert.deepEqual(store.recentEvents().map((e) => e.id), ['e2']);
  assert.equal(fs.existsSync(oldSnap), false);
  assert.equal(fs.existsSync(store.snapshotFile('new.jpg')), true);
  // survives a restart, including a torn last line
  fs.appendFileSync(`${dir}/readings.jsonl`, '{"id":"torn"');
  const { Store } = await import('../src/store.js');
  const again = new Store(dir, {}).init();
  assert.deepEqual(again.readings.map((r) => r.id), ['new']);
  assert.deepEqual(again.cameraMeta('camX'), { lines: { safe: [], warning: [], critical: [] }, note: '', refs: { day: null, night: null } });
  again.setCameraMeta('camX', { note: 'hi', refs: { night: 'n.jpg' } });
  assert.equal(new Store(dir, {}).init().cameraMeta('camX').refs.night, 'n.jpg');
});

test('mascot has every mood and maps statuses', () => {
  for (const mood of MOODS) {
    const svg = mascotSvg({ mood });
    assert.match(svg, new RegExp(`data-mood="${mood}"`));
    // every mood switches on a pair of eyes and a mouth
    assert.match(MASCOT_CSS, new RegExp(`\\.fon\\[data-mood=${mood}\\] \\.eyes-`));
    assert.match(MASCOT_CSS, new RegExp(`\\.fon\\[data-mood=${mood}\\] \\.mouth-`));
  }
  assert.equal(moodFor('critical'), 'alarm');
  assert.equal(moodFor('warning'), 'watch');
  assert.equal(moodFor('normal', { paused: true }), 'sleep');
  assert.equal(moodFor('normal', { pending: true }), 'scan');
  assert.equal(moodFor('normal', { recovered: true }), 'relief');
  assert.equal(moodFor('unknown'), 'confused');
  // the face crop hides arms so a raised hand never pokes into an avatar
  assert.match(faceSvg({}), /class="fon fon-face"/);
});

test('the green (safe) line is drawn with its own GREEN tag', async () => {
  const { LINE_COLORS } = await import('../src/camera/image.js');
  const svg = linesSvg(1000, 500, { safe: [[0, 0.3], [1, 0.3]], warning: [[0, 0.5], [1, 0.5]] });
  assert.match(svg, /GREEN/);
  assert.match(svg, /YELLOW/);
  assert.ok(svg.includes(LINE_COLORS.safe));
  assert.equal(hasLines({ safe: [[0, 0.3], [1, 0.3]] }), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrend, judge, lineStatusFor, reconcileLevel } from '../src/judge.js';
import { defaultSettings } from '../src/config.js';

const settings = defaultSettings();
const Y = [[0, 0.5], [1, 0.5]];
const R = [[0, 0.8], [1, 0.8]];
const cams = (a, b) => [
  { id: 'cam1', name: 'หน้าบ้าน', lines: a },
  { id: 'cam2', name: 'โรงรถ', lines: b },
];
const ai = (level, statuses) => ({
  ok: true,
  level,
  confidence: 0.8,
  cameras: Object.fromEntries(Object.entries(statuses).map(([id, lineStatus]) => [id, { lineStatus }])),
});
const both = new Set(['cam1', 'cam2']);

test('no lines anywhere: the overall level decides', () => {
  const c = cams({}, {});
  assert.equal(judge({ ai: ai(20, {}), cameras: c, captured: both, settings }).status, 'normal');
  assert.equal(judge({ ai: ai(55, {}), cameras: c, captured: both, settings }).status, 'warning');
  assert.equal(judge({ ai: ai(95, {}), cameras: c, captured: both, settings }).status, 'critical');
});

test('red line reached → critical, yellow → warning', () => {
  const c = cams({ warning: Y }, { warning: Y, critical: R });
  assert.equal(judge({ ai: ai(100, { cam1: 'at_yellow', cam2: 'at_red' }), cameras: c, captured: both, settings }).status, 'critical');
  const w = judge({ ai: ai(52, { cam1: 'at_yellow', cam2: 'below_yellow' }), cameras: c, captured: both, settings });
  assert.equal(w.status, 'warning');
  assert.match(w.reasons[0], /หน้าบ้าน/);
  assert.equal(judge({ ai: ai(10, { cam1: 'below_yellow', cam2: 'below_yellow' }), cameras: c, captured: both, settings }).status, 'normal');
});

test('a high overall level still warns even when lines are below', () => {
  const c = cams({}, { critical: R });
  const r = judge({ ai: ai(70, { cam2: 'below_yellow' }), cameras: c, captured: both, settings });
  assert.equal(r.status, 'warning');
});

test('with lines drawn, a high level alone never becomes critical', () => {
  const c = cams({}, { critical: R });
  assert.equal(judge({ ai: ai(99, { cam2: 'below_yellow' }), cameras: c, captured: both, settings }).status, 'warning');
});

test('a blind or broken deciding camera means unknown', () => {
  const c = cams({ warning: Y }, { critical: R });
  assert.equal(judge({ ai: ai(20, { cam1: 'below_yellow', cam2: 'cannot_tell' }), cameras: c, captured: both, settings }).status, 'unknown');
  const down = judge({ ai: ai(20, { cam1: 'below_yellow' }), cameras: c, captured: new Set(['cam1']), settings });
  assert.equal(down.status, 'unknown');
  assert.match(down.reasons[0], /ดึงภาพไม่ได้/);
  // …but a yellow crossing seen by another camera is still reported as a warning
  const w = judge({ ai: ai(55, { cam1: 'at_yellow', cam2: 'cannot_tell' }), cameras: c, captured: both, settings });
  assert.equal(w.status, 'warning');
});

test('AI failure or no pictures → unknown', () => {
  const c = cams({ warning: Y }, {});
  assert.equal(judge({ ai: { ok: false, error: 'x' }, cameras: c, captured: both, settings }).status, 'unknown');
  assert.equal(judge({ ai: ai(0, {}), cameras: c, captured: new Set(), settings }).status, 'unknown');
});

test('AI answers are sanity-checked against the lines that exist', () => {
  assert.equal(lineStatusFor({ lines: {} }, { lineStatus: 'at_red' }), 'no_lines');
  assert.equal(lineStatusFor({ lines: { warning: Y } }, { lineStatus: 'at_red' }), 'at_yellow');
  assert.equal(lineStatusFor({ lines: { critical: R } }, { lineStatus: 'at_yellow' }), 'below_yellow');
  assert.equal(lineStatusFor({ lines: { critical: R } }, { lineStatus: 'no_lines' }), 'cannot_tell');
  assert.equal(lineStatusFor({ lines: { critical: R } }, undefined), 'cannot_tell');
});

test('trend: slope per hour and time to the red line', () => {
  const now = Date.now();
  const pts = [0, 10, 20, 30].map((m) => ({ ts: now - (30 - m) * 60e3, level: 40 + m * 0.5 }));
  const t = computeTrend(pts, now);
  assert.equal(t.ratePerHour, 30);
  assert.equal(t.etaRedMin, Math.round((100 - 55) / 0.5));
  assert.equal(t.etaYellowMin, null);
  assert.equal(computeTrend(pts.slice(0, 2), now), null); // too few
  assert.equal(computeTrend(pts.map((p, i) => ({ ...p, ts: now - i * 60e3 })), now), null); // too short a span
});

test('predictive warning when the water will reach red soon', () => {
  const c = cams({}, { critical: R });
  const trend = { ratePerHour: 40, etaRedMin: 30, etaYellowMin: null };
  const r = judge({ ai: ai(35, { cam2: 'below_yellow' }), cameras: c, captured: both, settings, trend });
  assert.equal(r.status, 'warning');
  assert.equal(r.predictive, true);
  const off = judge({ ai: ai(35, { cam2: 'below_yellow' }), cameras: c, captured: both, settings: { ...settings, predictiveWarning: false }, trend });
  assert.equal(off.status, 'normal');
});

test('only a yellow line drawn: a very high overall level is still critical (upstream rule)', () => {
  const c = cams({ warning: Y }, {});
  const r = judge({ ai: ai(95, { cam1: 'below_yellow' }), cameras: c, captured: both, settings });
  assert.equal(r.status, 'critical');
  assert.match(r.reasons[0], /ยังไม่ได้ขีดเส้นแดง/);
  // …even when that yellow camera cannot see its line
  assert.equal(judge({ ai: ai(95, { cam1: 'cannot_tell' }), cameras: c, captured: both, settings }).status, 'critical');
  assert.equal(judge({ ai: ai(60, { cam1: 'below_yellow' }), cameras: c, captured: both, settings }).status, 'warning');
});

test('no lines and the AI cannot judge at all → unknown, never "normal"', () => {
  const r = judge({ ai: { ...ai(null, {}), aiStatus: 'unknown' }, cameras: cams({}, {}), captured: both, settings });
  assert.equal(r.status, 'unknown');
  assert.equal(r.level, null);
});

test('with lines, the cameras decide even when the AI gives no overall level', () => {
  const c = cams({ warning: Y }, { critical: R });
  assert.equal(judge({ ai: ai(null, { cam1: 'below_yellow', cam2: 'below_yellow' }), cameras: c, captured: both, settings }).status, 'normal');
  const w = judge({ ai: ai(null, { cam1: 'at_yellow', cam2: 'below_yellow' }), cameras: c, captured: both, settings });
  assert.equal(w.status, 'warning');
  assert.equal(w.level, 50);
});

test('a red line reached wins even if another deciding camera is down', () => {
  const c = cams({ critical: R }, { critical: R });
  const r = judge({ ai: ai(90, { cam2: 'at_red' }), cameras: c, captured: new Set(['cam2']), settings });
  assert.equal(r.status, 'critical');
});

test('the display level agrees with what the cameras see', () => {
  assert.equal(reconcileLevel(38, ['at_yellow', 'below_yellow']), 50);
  assert.equal(reconcileLevel(72, ['at_yellow']), 72);
  assert.equal(reconcileLevel(80, ['at_red']), 100);
  assert.equal(reconcileLevel(20, ['no_lines']), 20);
  assert.equal(reconcileLevel(null, ['at_yellow']), 50);
  assert.equal(reconcileLevel(null, ['below_yellow']), null);
  const c = cams({ warning: Y }, { critical: R });
  assert.equal(judge({ ai: ai(38, { cam1: 'at_yellow', cam2: 'below_yellow' }), cameras: c, captured: both, settings }).level, 50);
});

// ---------------------------------------------------------------- green (safe) line
const G = [[0, 0.3], [1, 0.3]];

test('green line: after a warning the water must go back down to the green line before it is safe', () => {
  const c = cams({ safe: G, warning: Y, critical: R }, {});
  const between = ai(35, { cam1: 'below_yellow' });
  const back = ai(20, { cam1: 'below_green' });
  // rising from normal: past green but still below yellow stays normal
  assert.equal(judge({ ai: between, cameras: c, captured: both, settings, previous: 'normal' }).status, 'normal');
  // falling after a warning: below yellow but not yet down to green holds the warning
  const hold = judge({ ai: between, cameras: c, captured: both, settings, previous: 'warning' });
  assert.equal(hold.status, 'warning');
  assert.equal(hold.receding, true);
  assert.match(hold.reasons[0], /หน้าบ้าน.*เส้นเขียว/);
  // …and after a critical as well
  assert.equal(judge({ ai: between, cameras: c, captured: both, settings, previous: 'critical' }).status, 'warning');
  // back down to the green line → safe
  const safe = judge({ ai: back, cameras: c, captured: both, settings, previous: 'warning' });
  assert.equal(safe.status, 'normal');
  assert.equal(safe.receding, false);
});

test('green line: a camera without one recovers below yellow as before', () => {
  const c = cams({ warning: Y, critical: R }, {});
  assert.equal(judge({ ai: ai(35, { cam1: 'below_yellow' }), cameras: c, captured: both, settings, previous: 'warning' }).status, 'normal');
});

test('green line: below_green only counts where a green line exists, and green alone is not an alert line', () => {
  assert.equal(lineStatusFor({ lines: { warning: Y } }, { lineStatus: 'below_green' }), 'below_yellow');
  assert.equal(lineStatusFor({ lines: { safe: G } }, { lineStatus: 'at_yellow' }), 'no_lines');
  assert.equal(lineStatusFor({ lines: { safe: G, warning: Y } }, { lineStatus: 'below_green' }), 'below_green');
});

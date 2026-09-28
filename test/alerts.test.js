import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertPolicy } from '../src/alerts.js';
import { makeStore, spy } from './helpers.js';

function setup(settings = {}) {
  const { store } = makeStore();
  store.updateSettings({ siteName: 'บ้านทดสอบ', ...settings });
  const notifier = spy({ send: (m) => ({ ...m }), record: () => ({}) });
  const siren = spy({ sound: { ok: true }, stop: { ok: true }, unsnooze: { ok: true } });
  const policy = new AlertPolicy({ store, notifier, siren, config: {} });
  let n = 0;
  const reading = (status, extra = {}) => ({
    id: `r${++n}`, ts: Date.now(), status, level: 50, headline: 'h', reasons: ['เหตุผล'],
    cameras: [{ id: 'cam1', name: 'หน้าบ้าน', ok: true }], ...extra,
  });
  const run = (status, extra = {}, judgement = {}) => {
    const r = reading(status, extra);
    return policy.afterReading(r, { judgement: { status, reasons: r.reasons, predictive: false, ...judgement }, photo: null });
  };
  const sent = () => notifier.calls.filter((c) => c.name === 'send').map((c) => c.args[0].kind);
  const sirenCalls = (name) => siren.calls.filter((c) => c.name === name);
  return { store, notifier, siren, policy, run, sent, sirenCalls };
}

test('first red sighting is re-checked before anyone is woken', async () => {
  const t = setup();
  const out = await t.run('critical');
  assert.equal(out.recheckInMs, 90000);
  assert.deepEqual(t.sent(), []);
  assert.equal(t.sirenCalls('sound').length, 0);
  assert.ok(t.store.state.pendingCritical);
  assert.notEqual(t.store.state.lastStatus, 'critical');

  const second = await t.run('critical');
  assert.equal(second.recheckInMs, undefined);
  assert.deepEqual(t.sent(), ['critical']);
  assert.equal(t.sirenCalls('sound').length, 1);
  assert.equal(t.sirenCalls('sound')[0].args[0].level, 'critical');
  assert.equal(t.store.state.lastStatus, 'critical');
  assert.equal(t.store.state.pendingCritical, null);
});

test('a re-check that is not red cancels quietly', async () => {
  const t = setup();
  await t.run('critical');
  await t.run('normal');
  assert.deepEqual(t.sent(), []);
  assert.equal(t.store.state.pendingCritical, null);
  assert.ok(t.notifier.calls.some((c) => c.name === 'record' && /ไม่ถึงเส้นแดง/.test(c.args[1])));
});

test('a blind re-check keeps the sighting pending and looks again', async () => {
  const t = setup();
  await t.run('critical');
  const out = await t.run('unknown');
  assert.equal(out.recheckInMs, 90000);
  assert.ok(t.store.state.pendingCritical);
  await t.run('critical');
  assert.deepEqual(t.sent(), ['critical']);
});

test('without confirmation the first red sighting alerts at once', async () => {
  const t = setup({ confirmCritical: false });
  await t.run('critical');
  assert.deepEqual(t.sent(), ['critical']);
});

test('critical repeats only after the repeat interval', async () => {
  const t = setup({ confirmCritical: false, criticalRepeatMinutes: 10 });
  await t.run('critical');
  await t.run('critical');
  assert.deepEqual(t.sent(), ['critical']);
  t.store.patchState({ lastCriticalAlertAt: Date.now() - 11 * 60e3 });
  await t.run('critical');
  assert.deepEqual(t.sent(), ['critical', 'critical']);
  assert.equal(t.sirenCalls('sound').length, 2);
});

test('warning is sent once when it starts; siren only if allowed', async () => {
  const t = setup();
  await t.run('warning');
  await t.run('warning');
  assert.deepEqual(t.sent(), ['warning']);
  assert.equal(t.sirenCalls('sound').length, 1);
  assert.equal(t.sirenCalls('sound')[0].args[0].level, 'warning'); // Siren decides from sirenOnWarning
  const quiet = setup({ notifyWarning: false });
  await quiet.run('warning');
  assert.deepEqual(quiet.sent(), []);
});

test('back to normal sends all-clear, stops the siren and clears the snooze', async () => {
  const t = setup({ confirmCritical: false });
  await t.run('critical');
  await t.run('normal');
  assert.deepEqual(t.sent(), ['critical', 'recovery']);
  assert.equal(t.sirenCalls('stop').length, 1);
  assert.equal(t.sirenCalls('unsnooze').length, 1);
  assert.equal(t.store.state.lastStatus, 'normal');
});

test('red → yellow tells people the water is easing and stops the siren', async () => {
  const t = setup({ confirmCritical: false });
  await t.run('critical');
  await t.run('warning');
  assert.deepEqual(t.sent(), ['critical', 'warning']);
  assert.equal(t.sirenCalls('stop').length, 1);
});

test('"can\'t see" alert after N unknown rounds, and one when sight returns', async () => {
  const t = setup({ failureThreshold: 3 });
  await t.run('unknown');
  await t.run('unknown');
  assert.deepEqual(t.sent(), []);
  await t.run('unknown');
  await t.run('unknown');
  assert.deepEqual(t.sent(), ['failure']);
  await t.run('normal');
  assert.deepEqual(t.sent(), ['failure', 'failure']);
  assert.equal(t.store.state.failureAlerted, false);
});

test('one camera down is reported once (unless every camera is down)', async () => {
  const t = setup({ failureThreshold: 2 });
  const cams = [{ id: 'cam1', name: 'หน้าบ้าน', ok: true }, { id: 'cam2', name: 'โรงรถ', ok: false, error: 'timeout' }];
  await t.run('normal', { cameras: cams });
  await t.run('normal', { cameras: cams });
  await t.run('normal', { cameras: cams });
  assert.deepEqual(t.sent(), ['camera']);
  await t.run('normal', { cameras: cams.map((c) => ({ ...c, ok: true })) });
  assert.deepEqual(t.sent(), ['camera', 'camera']);

  const all = setup({ failureThreshold: 1 });
  await all.run('unknown', { cameras: cams.map((c) => ({ ...c, ok: false })) });
  assert.deepEqual(all.sent(), ['failure']);
});

test('daily summary goes out once at the chosen hour', async () => {
  const t = setup({ dailySummaryHour: new Date().getUTCHours(), timezone: 'UTC' });
  assert.equal(await t.policy.maybeDailySummary(), true);
  assert.equal(await t.policy.maybeDailySummary(), false);
  assert.deepEqual(t.sent(), ['summary']);
  const off = setup();
  assert.equal(await off.policy.maybeDailySummary(), false);
});

test('the policy asks the siren to lift a mute after every reading', async () => {
  const t = setup({ confirmCritical: false });
  await t.run('warning');
  await t.run('unknown');
  const asked = t.sirenCalls('maybeUnmute').map((c) => c.args[0]);
  assert.deepEqual(asked, ['warning', 'unknown']);
});

test('camera-trouble alerts carry the pictures that did come in (none when every camera is down)', async () => {
  const make = () => {
    const { store } = makeStore();
    store.updateSettings({ failureThreshold: 1 });
    const notifier = spy({ send: (m) => ({ ...m }), record: () => ({}) });
    const siren = spy({ sound: { ok: true }, stop: { ok: true }, unsnooze: { ok: true } });
    return { notifier, policy: new AlertPolicy({ store, notifier, siren, config: {} }) };
  };
  const photo = async () => Buffer.from('jpg');
  const cams = [{ id: 'cam1', name: 'หน้าบ้าน', ok: true }, { id: 'cam2', name: 'โรงรถ', ok: false, error: 'timeout' }];
  const one = make();
  await one.policy.afterReading({ id: 'r1', ts: Date.now(), status: 'unknown', level: null, reasons: ['มืด'], cameras: cams }, { judgement: { status: 'unknown', reasons: ['มืด'] }, photo });
  const msgs = one.notifier.calls.filter((c) => c.name === 'send').map((c) => c.args[0]);
  assert.deepEqual(msgs.map((m) => m.kind).sort(), ['camera', 'failure']);
  assert.ok(msgs.every((m) => m.photo === photo));

  const all = make();
  await all.policy.afterReading({ id: 'r2', ts: Date.now(), status: 'unknown', level: null, reasons: ['ดับ'], cameras: cams.map((c) => ({ ...c, ok: false })) }, { judgement: { status: 'unknown', reasons: ['ดับ'] }, photo });
  const failure = all.notifier.calls.find((c) => c.name === 'send').args[0];
  assert.equal(failure.kind, 'failure');
  assert.equal(failure.photo, undefined);
});

// ---------------------------------------------------------------- yellow confirmation
test('a first yellow sighting is re-checked before anyone is told', async () => {
  const t = setup();
  const first = await t.run('warning');
  assert.equal(first.recheckInMs, 90000);
  assert.deepEqual(t.sent(), []);
  assert.equal(t.sirenCalls('sound').length, 0);
  assert.ok(t.store.state.pendingWarning);
  assert.notEqual(t.store.state.lastStatus, 'warning');
  await t.run('warning');
  assert.deepEqual(t.sent(), ['warning']);
  assert.equal(t.store.state.lastStatus, 'warning');
  assert.equal(t.store.state.pendingWarning, null);
});

test('a yellow re-check that is back to normal cancels quietly; a blind one looks again', async () => {
  const t = setup();
  await t.run('warning');
  await t.run('normal');
  assert.deepEqual(t.sent(), []);
  assert.equal(t.store.state.pendingWarning, null);
  assert.ok(t.notifier.calls.some((c) => c.name === 'record' && /ไม่ถึงเส้นเหลือง/.test(c.args[1])));
  const blind = setup();
  await blind.run('warning');
  assert.equal((await blind.run('unknown')).recheckInMs, 90000);
  await blind.run('warning');
  assert.deepEqual(blind.sent(), ['warning']);
});

test('no wait for "rising fast", for a red sighting that re-checks as yellow, or when confirmation is off', async () => {
  const fast = setup();
  await fast.run('warning', {}, { predictive: true });
  assert.deepEqual(fast.sent(), ['warning']);
  const red = setup();
  await red.run('critical');
  await red.run('warning');
  assert.deepEqual(red.sent(), ['warning']);
  const off = setup({ confirmWarning: false });
  await off.run('warning');
  assert.deepEqual(off.sent(), ['warning']);
});

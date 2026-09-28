import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Siren } from '../src/siren/siren.js';
import { makeStore, spy } from './helpers.js';

function setup(settings = {}) {
  const { store } = makeStore();
  store.updateSettings({ sirenEnabled: true, browserAlarm: true, ...settings });
  const notifier = spy({ record: () => ({}) });
  const published = [];
  const siren = new Siren({
    store, notifier, config: { secrets: { mqttUrl: 'mqtt://127.0.0.1:1883' } },
    publish: async (msg) => { published.push(JSON.parse(msg.payload).alarm); },
  });
  return { store, siren, notifier, published };
}

test('mute until the water drops: holds through the same level, lifts below it', async () => {
  const t = setup();
  t.store.patchState({ lastStatus: 'critical' });
  const out = await t.siren.muteUntilDrop();
  assert.equal(out.muteLevel, 'critical');
  assert.equal(t.siren.isSnoozed(), true);
  assert.deepEqual((await t.siren.sound({ reason: 'x', level: 'critical' })).skipped, 'snoozed');
  assert.equal(t.siren.maybeUnmute('critical'), false);
  assert.equal(t.siren.maybeUnmute('unknown'), false); // not knowing is not "the water dropped"
  assert.equal(t.siren.maybeUnmute('warning'), true);
  assert.equal(t.siren.isSnoozed(), false);
  assert.equal(t.siren.status().muteLevel, null);
  t.siren.stopAll?.();
});

test('muting during a long warning is not undone by the next warning', async () => {
  const t = setup({ sirenOnWarning: true });
  t.store.patchState({ lastStatus: 'warning' });
  assert.equal((await t.siren.muteUntilDrop()).muteLevel, 'warning');
  assert.equal(t.siren.maybeUnmute('warning'), false);
  assert.equal(t.siren.maybeUnmute('normal'), true);
});

test('with no alarm going on, a mute defaults to the critical level', async () => {
  const t = setup();
  assert.equal((await t.siren.muteUntilDrop()).muteLevel, 'critical');
  assert.equal(t.siren.maybeUnmute('warning'), true);
});

test('a timed snooze replaces a mute and unsnooze clears both', async () => {
  const t = setup();
  await t.siren.muteUntilDrop();
  await t.siren.snooze(30);
  assert.equal(t.siren.status().muteLevel, null);
  assert.ok(t.siren.status().snoozeUntil > Date.now());
  await t.siren.muteUntilDrop();
  t.siren.unsnooze();
  assert.equal(t.siren.isSnoozed(), false);
});

test('iPhone alarm via Pushover: emergency on red, cancelled when someone stops it, still ringing when the house siren times out', async () => {
  const { store } = makeStore();
  store.updateSettings({ browserAlarm: false });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(init.body) });
    return { ok: true, status: 200, json: async () => ({ status: 1, receipt: 'r123' }) };
  };
  const siren = new Siren({ store, notifier: spy({ record: () => ({}) }), config: { secrets: { pushoverToken: 'tok', pushoverUser: 'usr' } }, fetchImpl });
  assert.equal(siren.outputs().iphone, true);
  await siren.sound({ reason: 'น้ำถึงเส้นแดง', level: 'critical', seconds: 1 });
  assert.match(calls[0].url, /\/1\/messages\.json$/);
  assert.equal(calls[0].body.priority, '2');
  assert.equal(calls[0].body.retry, '30');
  assert.equal(calls[0].body.tags, 'nongfon');
  assert.equal(calls[0].body.user, 'usr');
  await siren.stop('timer'); // the house siren's own timer ended
  assert.equal(calls.length, 1, 'the phone keeps ringing until someone taps it');
  assert.equal(siren.status().ringingPhones, true);
  await siren.stop('telegram');
  assert.match(calls[1].url, /\/receipts\/cancel_by_tag\/nongfon\.json$/);
  assert.equal(calls[1].body.token, 'tok');
  assert.equal(siren.status().ringingPhones, false);
  // yellow rings the phone only when asked to
  await siren.sound({ reason: 'เหลือง', level: 'warning', seconds: 1 });
  assert.equal(calls.length, 2);
  store.updateSettings({ iphoneAlarmOnWarning: true });
  await siren.sound({ reason: 'เหลือง', level: 'warning', seconds: 1 });
  assert.equal(calls.length, 3);
  // a test rings briefly
  await siren.sound({ reason: 'ทดสอบ', seconds: 3, test: true });
  assert.equal(calls.at(-1).body.expire, '60');
  siren.stopAll?.();
});

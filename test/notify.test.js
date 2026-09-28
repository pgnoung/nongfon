import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../src/notify/index.js';
import { parseCommand, TelegramBot } from '../src/notify/telegram-bot.js';
import { criticalMessage, statusMessage } from '../src/notify/messages.js';
import { makeStore, spy } from './helpers.js';

/** fetch stand-in that records requests and answers by URL. */
function fakeFetch(route) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers || {}, body: init.body };
    calls.push(call);
    const { status = 200, json = { ok: true, result: {} } } = route(call) || {};
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const secrets = (extra = {}) => ({ telegramToken: '123:abc', lineToken: 'line-token', webhookUrl: 'https://hook.example/x', ...extra });

test('one alert fans out to Telegram (photo), LINE and webhook', async () => {
  const { store } = makeStore();
  store.updateSettings({ telegramChatId: '42', lineTo: 'broadcast' });
  const fetchImpl = fakeFetch(() => ({}));
  const n = new Notifier({ store, config: { secrets: secrets() }, fetchImpl });
  const ev = await n.send({ kind: 'critical', title: 'น้ำถึงเส้นแดง', html: '<b>สวัสดี</b> & ลาก่อน', text: 'สวัสดี & ลาก่อน', photo: async () => Buffer.from('jpg'), data: { level: 100 } });
  assert.deepEqual(Object.keys(ev.channels).sort(), ['line', 'telegram', 'webhook']);
  assert.ok(Object.values(ev.channels).every((c) => c.ok));
  const [tg, line, hook] = fetchImpl.calls;
  assert.match(tg.url, /bot123:abc\/sendPhoto$/);
  assert.ok(tg.body instanceof FormData);
  assert.equal(tg.body.get('chat_id'), '42');
  assert.equal(tg.body.get('parse_mode'), 'HTML');
  assert.match(line.url, /\/v2\/bot\/message\/broadcast$/);
  assert.equal(line.headers.Authorization, 'Bearer line-token');
  assert.equal(JSON.parse(line.body).messages[0].text, 'สวัสดี & ลาก่อน');
  assert.equal(JSON.parse(hook.body).event, 'critical');
  assert.equal(JSON.parse(hook.body).level, 100);
  assert.equal(store.recentEvents(1)[0].title, 'น้ำถึงเส้นแดง');
});

test('photo failure falls back to text; channel errors are recorded, not thrown', async () => {
  const { store } = makeStore();
  store.updateSettings({ telegramChatId: '42', lineTo: 'Uabc' });
  const fetchImpl = fakeFetch((c) => {
    if (c.url.endsWith('/sendPhoto')) return { status: 400, json: { ok: false, description: 'Bad Request: file too big' } };
    if (c.url.includes('api.line.me')) return { status: 401, json: { message: 'Authentication failed' } };
    return {};
  });
  const n = new Notifier({ store, config: { secrets: secrets({ webhookUrl: '' }) }, fetchImpl });
  const ev = await n.send({ kind: 'warning', title: 't', html: 'h', text: 't', photo: Buffer.from('x') });
  assert.equal(ev.channels.telegram.ok, true);
  assert.ok(fetchImpl.calls.some((c) => c.url.endsWith('/sendMessage')));
  assert.equal(ev.channels.line.ok, false);
  assert.match(ev.channels.line.error, /LINE_CHANNEL_ACCESS_TOKEN/);
  assert.match(fetchImpl.calls.find((c) => c.url.includes('line')).url, /message\/push$/);
});

test('channels switch off when the setting is off or the chat is missing', () => {
  const { store } = makeStore();
  const n = new Notifier({ store, config: { secrets: secrets() }, fetchImpl: fakeFetch(() => ({})) });
  assert.deepEqual(n.channels(), { telegram: false, line: false, webhook: true });
  store.updateSettings({ telegramChatId: '1', webhookEnabled: false });
  assert.deepEqual(n.channels(), { telegram: true, line: false, webhook: false });
});

test('messages escape HTML from AI text', () => {
  const ctx = { siteName: 'บ้าน <script>', timezone: 'Asia/Bangkok' };
  const m = criticalMessage(ctx, { ts: Date.now(), level: 100, headline: 'น้ำ <b>สูง</b>', reasons: ['a & b'], trend: { ratePerHour: 12, etaRedMin: 0 } });
  assert.ok(!m.html.includes('<script>'));
  assert.ok(m.html.includes('&lt;b&gt;'));
  assert.ok(m.text.includes('น้ำ <b>สูง</b>'));
  assert.match(m.html, /ตื่นเร็วค่ะ/);
  assert.match(statusMessage(ctx, null).text, /\/check/);
});

test('command parsing: slash commands, bot mentions and Thai words', () => {
  assert.deepEqual(parseCommand('/status'), { cmd: 'status', arg: '' });
  assert.deepEqual(parseCommand('/snooze@NongFonBot 30'), { cmd: 'snooze', arg: '30' });
  assert.deepEqual(parseCommand('เงียบ 45 นาที'), { cmd: 'snooze', arg: '45' });
  assert.deepEqual(parseCommand('หยุด'), { cmd: 'stop', arg: '' });
  assert.equal(parseCommand('สวัสดี').cmd, '');
});

function botSetup() {
  const { store } = makeStore();
  store.updateSettings({ telegramChatId: '42' });
  const telegram = spy({ sendMessage: async () => ({}), sendPhoto: async () => ({}), answerCallback: async () => ({}) });
  const siren = spy({ stop: { ok: true }, snooze: { ok: true }, unsnooze: { ok: true }, status: { snoozeUntil: null } });
  const watcher = spy({ runNow: async () => null });
  const bot = new TelegramBot({ store, notifier: { telegram }, siren, watcher, buildPhoto: async () => null });
  return { store, telegram, siren, watcher, bot };
}

test('strangers cannot control the siren; they are offered for binding', async () => {
  const t = botSetup();
  await t.bot.handle({ update_id: 1, message: { chat: { id: 99, first_name: 'แม่' }, text: '/stop' } });
  assert.equal(t.siren.calls.length, 0);
  assert.equal(t.store.state.telegramCandidates[0].id, 99);
  assert.match(t.telegram.calls[0].args[1], /ใช้แชทนี้/);
  await t.bot.handle({ update_id: 2, callback_query: { id: 'q', data: 'stop', message: { chat: { id: 99 } } } });
  assert.equal(t.siren.calls.length, 0);
});

test('the bound chat can stop, snooze and trigger a check', async () => {
  const t = botSetup();
  await t.bot.handle({ update_id: 1, message: { chat: { id: 42 }, text: '/stop' } });
  await t.bot.handle({ update_id: 2, callback_query: { id: 'q', data: 'snooze:60', message: { chat: { id: 42 } } } });
  await t.bot.handle({ update_id: 3, message: { chat: { id: 42 }, text: 'ตรวจ' } });
  assert.deepEqual(t.siren.calls.map((c) => c.name).filter((n) => n !== 'status'), ['stop', 'snooze']);
  assert.equal(t.siren.calls.find((c) => c.name === 'snooze').args[0], 60);
  assert.equal(t.watcher.calls[0].name, 'runNow');
  assert.ok(t.telegram.calls.some((c) => c.name === 'answerCallback'));
});

test('the recovery message says "back to the green line" when a camera has one', async () => {
  const { recoveryMessage } = await import('../src/notify/messages.js');
  const ctx = { siteName: 'บ้าน', timezone: 'Asia/Bangkok' };
  const base = { ts: Date.now(), status: 'normal', level: 20, headline: '', reasons: [] };
  const green = recoveryMessage(ctx, { ...base, cameras: [{ id: 'cam1', lines: { safe: [[0, 0.3], [1, 0.3]], warning: [[0, 0.5], [1, 0.5]] } }] });
  const plain = recoveryMessage(ctx, { ...base, cameras: [{ id: 'cam1', lines: { warning: [[0, 0.5], [1, 0.5]] } }] });
  assert.match(JSON.stringify(green), /เส้นเขียว/);
  assert.doesNotMatch(JSON.stringify(plain), /เส้นเขียว/);
});

test('LINE messages can be sent silently (hourly summaries must not wake anyone)', async () => {
  const { createLine } = await import('../src/notify/line.js');
  let body = null;
  const line = createLine({ token: 't', fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({}) }; } });
  await line.send('Uabc', 'สรุป', { silent: true });
  assert.equal(body.notificationDisabled, true);
  await line.send('Uabc', 'เตือน');
  assert.equal(body.notificationDisabled, false);
});

test('a long silent message goes out as a silent photo plus a silent follow-up text', async () => {
  const { store } = makeStore();
  store.updateSettings({ telegramChatId: '42' });
  const fetchImpl = fakeFetch(() => ({}));
  const n = new Notifier({ store, config: { secrets: { telegramToken: '123:abc' } }, fetchImpl });
  await n.send({ kind: 'hourly', title: 'สรุป', html: 'ก'.repeat(1200), text: 'x', photo: async () => Buffer.from('jpg'), silent: true });
  const [photo, follow] = fetchImpl.calls;
  assert.match(photo.url, /sendPhoto$/);
  assert.equal(photo.body.get('disable_notification'), 'true');
  assert.equal(photo.body.get('caption'), null);
  assert.match(follow.url, /sendMessage$/);
  assert.equal(JSON.parse(follow.body).disable_notification, true);
});

test('/testsiren sounds a 3-second test and says where it rings; "stop" says so when nothing is sounding', async () => {
  const t = botSetup();
  await t.bot.handle({ update_id: 1, message: { chat: { id: 42 }, text: '/testsiren' } });
  const sound = t.siren.calls.find((c) => c.name === 'sound');
  assert.equal(sound.args[0].test, true);
  assert.equal(sound.args[0].seconds, 3);
  assert.match(t.telegram.calls.at(-1).args[1], /ทดสอบไซเรน/);
  assert.match(t.telegram.calls.at(-1).args[1], /หน้าข้างเตียง/);
  await t.bot.handle({ update_id: 2, message: { chat: { id: 42 }, text: '/stop' } });
  assert.match(t.telegram.calls.at(-1).args[1], /ไม่มีไซเรนดังอยู่/);
  await t.bot.handle({ update_id: 3, callback_query: { id: 'q', data: 'stop', message: { chat: { id: 42 } } } });
  assert.match(t.telegram.calls.find((c) => c.name === 'answerCallback').args[1], /ไม่มีไซเรนดัง/);
  assert.equal(parseCommand('ทดสอบไซเรน').cmd, 'testsiren');
});

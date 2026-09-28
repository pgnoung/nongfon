import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cameraUrlProblem, formatValue, generatePassword, looksLike, maskUrl, parseCoordinates, parseEnv, upsertEnv, writeEnvFile,
} from '../scripts/lib/envfile.js';
import { checkOpenAI, checkPushover, checkTelegram, geocode } from '../scripts/lib/checks.js';
import { createScriptedIO } from '../scripts/lib/ui.js';
import { runSetup } from '../scripts/setup.js';

const TEMPLATE = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const OPENAI_KEY = `sk-proj-${'x'.repeat(40)}`;
const TG_TOKEN = `123456789:${'A'.repeat(35)}`;
const PO_TOKEN = `a${'b'.repeat(29)}`;
const PO_USER = `u${'c'.repeat(29)}`;

const fakeChecks = (over = {}) => ({
  checkOpenAI: async () => ({ ok: true, detail: 'คีย์ใช้ได้' }),
  checkAnthropic: async () => ({ ok: true, detail: 'คีย์ใช้ได้' }),
  checkTelegram: async () => ({ ok: true, detail: 'บอท @fon_bot พร้อมใช้', username: 'fon_bot' }),
  checkLine: async () => ({ ok: true, detail: 'LINE OA' }),
  checkPushover: async () => ({ ok: true, detail: 'Pushover ใช้ได้', devices: ['iphone'] }),
  geocode: async () => [{ label: 'บางใหญ่, นนทบุรี, ไทย', latitude: 13.8434, longitude: 100.3625, area: 'บางใหญ่, นนทบุรี' }],
  hasClaudeCli: () => true,
  ...over,
});

const response = (status, body) => ({ status, json: async () => body });

// ------------------------------------------------------------------ .env text

test('parseEnv reads active lines like the app loader: quotes, inline comments, later lines win', () => {
  const env = parseEnv('A=1\n# B=2\nC="two words" \nD=x # note\nE=\'it\'\nA=3\n');
  assert.deepEqual(env, { A: '3', C: 'two words', D: 'x', E: 'it' });
});

test('formatValue quotes only when needed and refuses multi-line values', () => {
  assert.equal(formatValue('rtsp://u:p@192.168.1.50:554/s1'), 'rtsp://u:p@192.168.1.50:554/s1');
  assert.equal(formatValue('บ้าน ของเรา'), "'บ้าน ของเรา'");
  assert.equal(formatValue("it's #1"), '"it\'s #1"');
  assert.equal(parseEnv(`K=${formatValue("it's #1")}`).K, "it's #1");
  assert.throws(() => formatValue('a\nb'), /บรรทัดเดียว/);
});

test('upsertEnv replaces active lines, uncomments templates in place, appends the rest, and null removes', () => {
  const before = 'AI_ENGINE=anthropic\n# OPENAI_API_KEY=\nKEEP=1\nCAMERA_2_NAME=โรงรถ\n';
  const after = upsertEnv(before, { AI_ENGINE: 'openai', OPENAI_API_KEY: 'sk-test', NEW_ONE: 'x', CAMERA_2_NAME: null });
  assert.equal(before, 'AI_ENGINE=anthropic\n# OPENAI_API_KEY=\nKEEP=1\nCAMERA_2_NAME=โรงรถ\n'); // input untouched
  const lines = after.trim().split('\n');
  assert.equal(lines[0], 'AI_ENGINE=openai');
  assert.equal(lines[1], 'OPENAI_API_KEY=sk-test'); // same place as the template
  assert.equal(lines[2], 'KEEP=1');
  assert.ok(!after.includes('CAMERA_2_NAME'));
  assert.equal(lines.at(-1), 'NEW_ONE=x');
  assert.deepEqual(parseEnv(after), { AI_ENGINE: 'openai', OPENAI_API_KEY: 'sk-test', KEEP: '1', NEW_ONE: 'x' });
});

test('writeEnvFile writes atomically and owner-only', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nongfon-env-'));
  const file = path.join(dir, '.env');
  writeEnvFile(file, 'A=1\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'A=1\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['.env']);
  fs.rmSync(dir, { recursive: true });
});

// ------------------------------------------------------------------ small checks

test('generatePassword gives a readable fon-xxxx-xxxx-xxxx without look-alike letters', () => {
  const pw = generatePassword((n) => Buffer.from(Array.from({ length: n }, (_, i) => i * 7)));
  assert.match(pw, /^fon-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
  assert.notEqual(generatePassword(), generatePassword());
});

test('parseCoordinates accepts "lat, lng" and Google Maps links, rejects the rest', () => {
  assert.deepEqual(parseCoordinates(' 13.84341, 100.36251 '), { latitude: 13.8434, longitude: 100.3625 });
  assert.deepEqual(parseCoordinates('https://www.google.com/maps/place/x/@13.7563,100.5018,15z'), { latitude: 13.7563, longitude: 100.5018 });
  assert.equal(parseCoordinates('บางใหญ่'), null);
  assert.equal(parseCoordinates('95, 10'), null);
});

test('camera links: rtsp/http only, never a public internet IP; passwords are masked for display', () => {
  const isPublicHost = (h) => h === '203.0.113.9';
  assert.equal(cameraUrlProblem('rtsp://admin:pw@192.168.1.50:554/stream1', { isPublicHost }), null);
  assert.equal(cameraUrlProblem('http://localhost:1984/api/frame.jpeg?src=cam', { isPublicHost }), null);
  assert.match(cameraUrlProblem('ftp://192.168.1.50/x', { isPublicHost }), /rtsp/);
  assert.match(cameraUrlProblem('rtsp://203.0.113.9/live', { isPublicHost }), /LAN/);
  assert.match(cameraUrlProblem('not a link', { isPublicHost }), /ลิงก์ไม่ถูกต้อง/);
  assert.equal(maskUrl('rtsp://admin:s3cr#t@192.168.1.50:554/stream1'), 'rtsp://admin:••••@192.168.1.50:554/stream1');
  assert.equal(maskUrl('http://192.168.1.51/cgi-bin/snapshot.cgi'), 'http://192.168.1.51/cgi-bin/snapshot.cgi');
});

test('looksLike spots the common copy-paste mistakes', () => {
  assert.ok(looksLike.openaiKey(OPENAI_KEY));
  assert.ok(!looksLike.openaiKey('sk-short'));
  assert.ok(looksLike.telegramToken(TG_TOKEN));
  assert.ok(!looksLike.telegramToken('123456789'));
  assert.ok(looksLike.pushoverKey(PO_TOKEN));
  assert.ok(!looksLike.pushoverKey(`${PO_TOKEN}x`));
  assert.ok(looksLike.claudeOauth(`sk-ant-oat01-${'y'.repeat(30)}`));
});

// ------------------------------------------------------------------ online checks (fake network)

test('checkOpenAI maps the provider answers to plain Thai', async () => {
  assert.equal((await checkOpenAI('k', 'gpt-6-luna', { fetchImpl: async () => response(200, {}) })).ok, true);
  assert.match((await checkOpenAI('k', 'gpt-6-luna', { fetchImpl: async () => response(401, {}) })).detail, /ไม่ถูกต้อง/);
  assert.match((await checkOpenAI('k', 'gpt-6-luna', { fetchImpl: async () => response(404, {}) })).detail, /gpt-6-luna/);
  assert.match((await checkOpenAI('k', 'gpt-6-luna', { fetchImpl: async () => response(429, {}) })).detail, /เครดิต/);
  const offline = await checkOpenAI('k', 'gpt-6-luna', { fetchImpl: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); } });
  assert.match(offline.detail, /ENOTFOUND/);
});

test('checkTelegram returns the bot username; checkPushover explains a user key pasted as the app token', async () => {
  const tg = await checkTelegram(TG_TOKEN, { fetchImpl: async () => response(200, { ok: true, result: { username: 'fon_bot' } }) });
  assert.equal(tg.username, 'fon_bot');
  const po = await checkPushover(PO_USER, PO_USER, { fetchImpl: async () => response(400, { status: 0, errors: ['application token is invalid'] }) });
  assert.equal(po.ok, false);
  assert.match(po.detail, /ขึ้นต้นด้วย a/);
});

test('geocode tries Open-Meteo first, then OpenStreetMap for Thai names', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('open-meteo')) return response(200, { generationtime_ms: 0.2 });
    return response(200, [{ display_name: 'บางใหญ่, จังหวัดนนทบุรี, ประเทศไทย', lat: '13.84341', lon: '100.36251' }]);
  };
  const found = await geocode('บางใหญ่', { fetchImpl });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /nominatim/);
  assert.deepEqual(found[0], { label: 'บางใหญ่, จังหวัดนนทบุรี, ประเทศไทย', latitude: 13.8434, longitude: 100.3625, area: 'บางใหญ่ นนทบุรี' });
});

// ------------------------------------------------------------------ the wizard

test('full wizard: OpenAI + one camera + Telegram + area → a complete .env, and no secret is ever printed', async () => {
  const log = [];
  const io = createScriptedIO({
    ai: 'openai', openai_key: OPENAI_KEY, camera_mode: 'url',
    camera_name: ['หน้าบ้าน', ''], camera_url: 'rtsp://admin:camPass1@192.168.1.50:554/stream1', camera_more: false,
    telegram: true, telegram_token: TG_TOKEN, line: false, pushover: false,
    site_name: 'บ้านสวน', place: 'บางใหญ่', place_pick: '0', password_mode: 'auto',
  }, { log });
  const { text, env } = await runSetup({ io, envText: TEMPLATE, checks: fakeChecks(), firstRun: true, pickPort: async () => 8080 });
  assert.equal(env.AI_ENGINE, 'openai');
  assert.equal(env.AI_MODEL, 'gpt-6-luna');
  assert.equal(env.OPENAI_API_KEY, OPENAI_KEY);
  assert.equal(env.CAMERA_1_NAME, 'หน้าบ้าน');
  assert.equal(env.CAMERA_1_URL, 'rtsp://admin:camPass1@192.168.1.50:554/stream1');
  assert.equal(env.CAMERA_2_NAME, undefined); // the template's second camera slot is cleared
  assert.equal(env.TELEGRAM_BOT_TOKEN, TG_TOKEN);
  assert.equal(env.SITE_NAME, 'บ้านสวน');
  assert.equal(env.LATITUDE, '13.8434');
  assert.equal(env.NEWS_QUERY, 'น้ำท่วม บางใหญ่');
  assert.match(env.DASHBOARD_PASSWORD, /^fon-/);
  assert.equal(env.DEMO, undefined);
  assert.equal(env.PORT, undefined); // 8080 was free
  const printed = log.join('\n');
  for (const secret of [OPENAI_KEY, TG_TOKEN, 'camPass1']) assert.ok(!printed.includes(secret), `printed ${secret.slice(0, 8)}…`);
  assert.ok(printed.includes(env.DASHBOARD_PASSWORD)); // the generated password is shown once, on purpose
  assert.ok(!text.includes('# ---- ค่าจากตัวช่วยติดตั้งน้องฝน')); // every key found its documented place in the template
  assert.ok(text.indexOf('SITE_NAME=') < text.indexOf('# CF_ACCESS_TEAM_DOMAIN'));
});

test('wizard without a key yet: demo mode, no camera questions, and a busy 8080 moves the port', async () => {
  const io = createScriptedIO({ ai: 'demo', telegram: false, line: false, pushover: false, place: '', password_mode: 'auto' });
  const { env } = await runSetup({ io, envText: TEMPLATE, checks: fakeChecks(), firstRun: true, pickPort: async () => 8081 });
  assert.equal(env.DEMO, '1');
  assert.equal(env.PORT, '8081');
  assert.equal(env.CAMERA_1_URL, '');
});

test('a key the provider rejects is re-asked, and can be kept on purpose', async () => {
  let n = 0;
  const checks = fakeChecks({ checkOpenAI: async () => (++n === 1 ? { ok: false, detail: 'คีย์ไม่ถูกต้อง' } : { ok: true, detail: 'ok' }) });
  const second = `sk-proj-${'z'.repeat(40)}`;
  const io = createScriptedIO({ ai: 'openai', openai_key: [OPENAI_KEY, second], openai_key_keep_anyway: false, camera_mode: 'web', telegram: false, line: false, pushover: false, password_mode: 'auto' });
  const { env } = await runSetup({ io, envText: TEMPLATE, checks });
  assert.equal(env.OPENAI_API_KEY, second);
});

test('--secrets mode asks only for keys of what is already configured, and keeps what exists', async () => {
  const envText = `${TEMPLATE}\nAI_ENGINE=anthropic\nDASHBOARD_PASSWORD=already-set-pw\nTELEGRAM_BOT_TOKEN=${TG_TOKEN}\n`;
  const log = [];
  const io = createScriptedIO({ anthropic_key: `sk-ant-api03-${'q'.repeat(40)}`, telegram_token: '', line_token: '', pushover_token: '', pushover_user: '', keep_password: true }, { log });
  const { env, updates } = await runSetup({ io, envText, checks: fakeChecks(), secretsOnly: true });
  assert.equal(env.ANTHROPIC_API_KEY, `sk-ant-api03-${'q'.repeat(40)}`);
  assert.equal(env.TELEGRAM_BOT_TOKEN, TG_TOKEN); // Enter kept it
  assert.equal(env.DASHBOARD_PASSWORD, 'already-set-pw');
  assert.equal(updates.CAMERA_1_URL, undefined); // cameras are not part of --secrets
  assert.ok(!log.join('\n').includes('ขั้น 3/6'));
});

// ------------------------------------------------------------------ set-env (for an AI agent)

test('set-env takes plain settings and refuses anything that holds a secret', async () => {
  const { parseArgs } = await import('../scripts/set-env.js');
  assert.deepEqual(parseArgs(['AI_ENGINE=openai', 'SITE_NAME=บ้าน สวน', '--unset', 'DEMO']).updates, { AI_ENGINE: 'openai', SITE_NAME: 'บ้าน สวน', DEMO: null });
  for (const bad of ['OPENAI_API_KEY=sk-x', 'TELEGRAM_BOT_TOKEN=1:x', 'DASHBOARD_PASSWORD=x', 'CAMERA_1_URL=rtsp://a:b@192.168.1.5/', 'PUSHOVER_USER=u1', 'MQTT_URL=mqtt://u:p@h']) {
    assert.match(parseArgs([bad]).error, /npm run secrets/, bad);
  }
  assert.match(parseArgs(['AI_ENGINE=gpt']).error, /openai/);
  assert.match(parseArgs(['PORT=80']).error, /1024/);
  assert.match(parseArgs(['LATITUDE=abc']).error, /ละติจูด/);
  assert.match(parseArgs(['--unset', 'OPENAI_API_KEY']).error, /ไม่ได้/);
  assert.match(parseArgs([]).error, /ยังไม่ได้บอก/);
});

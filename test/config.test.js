import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { camerasFromEnv, coerceSetting, loadConfig, loadEnvFile, resolveSettings, sanitizeSettingsPatch } from '../src/config.js';
import { tmpDir } from './helpers.js';

test('coerceSetting checks types and ranges', () => {
  assert.deepEqual(coerceSetting('intervalMinutes', '15'), { value: 15 });
  assert.ok(coerceSetting('intervalMinutes', '0').error);
  assert.ok(coerceSetting('intervalMinutes', 'abc').error);
  assert.deepEqual(coerceSetting('paused', 'yes'), { value: true });
  assert.deepEqual(coerceSetting('paused', false), { value: false });
  assert.deepEqual(coerceSetting('aiEffort', 'high'), { value: 'high' });
  assert.ok(coerceSetting('aiEffort', 'max').error);
  assert.deepEqual(coerceSetting('latitude', ''), { value: null });
  assert.deepEqual(coerceSetting('latitude', '13.75'), { value: 13.75 });
  assert.ok(coerceSetting('latitude', '120').error);
  assert.ok(coerceSetting('mqttOnPayload', '{bad json').error);
  assert.deepEqual(coerceSetting('mqttOnPayload', ' {"alarm":true} '), { value: '{"alarm":true}' });
  assert.ok(coerceSetting('timezone', 'Mars/Olympus').error);
  assert.deepEqual(coerceSetting('timezone', 'Asia/Bangkok'), { value: 'Asia/Bangkok' });
  assert.ok(coerceSetting('nope', 1).error);
});

test('settings resolve dashboard → .env → default', () => {
  const env = { INTERVAL_MINUTES: '5', AI_MODEL: 'claude-haiku-4-5', TELEGRAM_CHAT_ID: '123' };
  const s = resolveSettings({ intervalMinutes: 7 }, env);
  assert.equal(s.intervalMinutes, 7); // dashboard wins
  assert.equal(s.aiModel, 'claude-haiku-4-5'); // from env
  assert.equal(s.telegramChatId, '123');
  assert.equal(s.warnLevel, 50); // default
  // invalid stored values are ignored instead of breaking start-up
  assert.equal(resolveSettings({ intervalMinutes: 9999 }, {}).intervalMinutes, 10);
});

test('sanitizeSettingsPatch collects every error', () => {
  const { values, errors } = sanitizeSettingsPatch({ warnLevel: 40, criticalLevel: 500, bogus: 1 });
  assert.deepEqual(values, { warnLevel: 40 });
  assert.equal(errors.length, 2);
});

test('cameras come from numbered env pairs', () => {
  const cams = camerasFromEnv({
    CAMERA_1_NAME: 'หน้าบ้าน', CAMERA_1_URL: 'rtsp://a:b@1.2.3.4/s',
    CAMERA_3_URL: 'http://cam/snap.jpg?src=x&y=1',
  });
  assert.deepEqual(cams, [
    { id: 'cam1', name: 'หน้าบ้าน', url: 'rtsp://a:b@1.2.3.4/s' },
    { id: 'cam3', name: 'กล้อง 3', url: 'http://cam/snap.jpg?src=x&y=1' },
  ]);
});

test('loadEnvFile understands quotes, comments and export, never overrides', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    '# comment',
    'NF_T1=plain value # trailing comment',
    'export NF_T2="quoted # not a comment"',
    "NF_T3='single'",
    'NF_T4=already',
    'not a line',
  ].join('\n'));
  process.env.NF_T4 = 'kept';
  assert.equal(loadEnvFile(file), true);
  assert.equal(process.env.NF_T1, 'plain value');
  assert.equal(process.env.NF_T2, 'quoted # not a comment');
  assert.equal(process.env.NF_T3, 'single');
  assert.equal(process.env.NF_T4, 'kept');
  assert.equal(loadEnvFile(path.join(dir, 'missing')), false);
});

test('loadConfig: demo mode uses cartoon cameras, demo engine and a default password', () => {
  const c = loadConfig({ argv: ['--demo'], env: {} });
  assert.equal(c.demo, true);
  assert.equal(c.engine, 'demo');
  assert.equal(c.cameras.length, 2);
  assert.equal(c.secrets.dashboardPassword, 'demo');
  const real = loadConfig({ argv: [], env: { AI_ENGINE: 'claude-code', CAMERA_1_URL: 'file:///x.jpg' } });
  assert.equal(real.engine, 'claude-code');
  assert.equal(real.secrets.dashboardPassword, '');
});

test('--image swaps a camera source for a photo, or adds one', async () => {
  const { camerasWithImages, loadConfig } = await import('../src/config.js');
  const cams = [{ id: 'cam1', name: 'หน้าบ้าน', url: 'rtsp://x' }];
  const out = camerasWithImages(cams, ['cam1=/tmp/a.jpg', 'side=/tmp/b.jpg']);
  assert.deepEqual(out.map((c) => [c.id, c.name, c.url]), [['cam1', 'หน้าบ้าน', '/tmp/a.jpg'], ['side', 'side', '/tmp/b.jpg']]);
  assert.equal(cams[0].url, 'rtsp://x'); // original untouched
  assert.throws(() => camerasWithImages(cams, ['nope']), /กล้อง=ไฟล์/);
  const cfg = loadConfig({ argv: ['--once', '--dry-run', '--image', 'cam1=/tmp/a.jpg'], env: { CAMERA_1_URL: 'rtsp://cam', CAMERA_1_NAME: 'หน้าบ้าน' } });
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.cameras[0].url, '/tmp/a.jpg');
});

test('the OpenAI key can come from the macOS Keychain (never from a file) when the env has none', async () => {
  const { loadKeychainSecret } = await import('../src/config.js');
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); return 'sk-test-123\n'; };
  const env = { OPENAI_KEYCHAIN_SERVICE: 'nongfon/OPENAI_API_KEY', OPENAI_KEYCHAIN_ACCOUNT: 'me' };
  assert.equal(loadKeychainSecret(env, { exec, platform: 'darwin' }), true);
  assert.equal(env.OPENAI_API_KEY, 'sk-test-123');
  assert.deepEqual(calls[0], ['/usr/bin/security', 'find-generic-password', '-a', 'me', '-s', 'nongfon/OPENAI_API_KEY', '-w']);
  // an explicit key wins, other systems and a missing item are harmless
  const set = { OPENAI_API_KEY: 'sk-env', OPENAI_KEYCHAIN_SERVICE: 'x' };
  assert.equal(loadKeychainSecret(set, { exec, platform: 'darwin' }), false);
  assert.equal(set.OPENAI_API_KEY, 'sk-env');
  assert.equal(loadKeychainSecret({ OPENAI_KEYCHAIN_SERVICE: 'x' }, { exec, platform: 'linux' }), false);
  const missing = { OPENAI_KEYCHAIN_SERVICE: 'x' };
  assert.equal(loadKeychainSecret(missing, { exec: () => { throw new Error('not found'); }, platform: 'darwin' }), false);
  assert.equal(missing.OPENAI_API_KEY, undefined);
});

test('a background service can read the OpenAI key from an owner-only file', async () => {
  const { loadSecretFile } = await import('../src/config.js');
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'nf-key-'));
  const file = path.join(dir, 'openai.key');
  fs.writeFileSync(file, 'sk-file-456\n', { mode: 0o600 });
  const env = { OPENAI_API_KEY_FILE: file };
  assert.equal(loadSecretFile(env), true);
  assert.equal(env.OPENAI_API_KEY, 'sk-file-456');
  const set = { OPENAI_API_KEY: 'sk-env', OPENAI_API_KEY_FILE: file };
  assert.equal(loadSecretFile(set), false);
  assert.equal(set.OPENAI_API_KEY, 'sk-env');
  assert.equal(loadSecretFile({ OPENAI_API_KEY_FILE: path.join(dir, 'missing') }), false);
});

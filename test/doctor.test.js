import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkAi, checkAlerts, checkAutostart, checkCameras, checkDeps, checkEnvFile, checkFfmpeg, checkLocation, checkNode, checkPassword, checkServer,
} from '../scripts/doctor.js';
import { autostartFile } from '../scripts/lib/autostart-file.js';
import { linuxUnit, macPlist, windowsStartupCmd } from '../scripts/autostart.js';

test('Node 22+ passes, older fails with the installer as the fix', () => {
  assert.equal(checkNode('22.23.3').status, 'ok');
  const old = checkNode('20.11.0');
  assert.equal(old.status, 'fail');
  assert.match(old.fix, /ตัวติดตั้ง/);
});

test('missing packages are named', async () => {
  assert.equal((await checkDeps(async () => ({}))).status, 'ok');
  const r = await checkDeps(async (name) => { if (name === 'sharp') throw new Error('x'); return {}; });
  assert.equal(r.status, 'fail');
  assert.equal(r.detail, 'sharp');
});

test('ffmpeg: a working binary is ok, a missing one is only a warning (http cameras still work)', () => {
  assert.equal(checkFfmpeg({ env: { FFMPEG_PATH: '/x/ffmpeg' }, run: () => ({ status: 0, stdout: 'ffmpeg version 7.1\n' }) }).status, 'ok');
  const r = checkFfmpeg({ env: { FFMPEG_PATH: '/x/ffmpeg' }, run: () => ({ status: null, error: new Error('ENOENT') }) });
  assert.equal(r.status, 'warn');
  assert.match(r.fix, /ffmpeg-static/);
});

test('.env: missing fails, readable by others warns, owner-only passes', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nongfon-doc-'));
  const file = path.join(dir, '.env');
  assert.equal(checkEnvFile(file).status, 'fail');
  fs.writeFileSync(file, 'A=1\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.equal(checkEnvFile(file).status, 'warn');
  fs.chmodSync(file, 0o600);
  assert.equal(checkEnvFile(file).status, 'ok');
  fs.rmSync(dir, { recursive: true });
});

test('dashboard password: missing, too short, fine', () => {
  assert.equal(checkPassword({}).status, 'fail');
  assert.equal(checkPassword({ DASHBOARD_PASSWORD: 'short' }).status, 'warn');
  assert.equal(checkPassword({ DASHBOARD_PASSWORD: 'fon-abcd-efgh-jkmn' }).status, 'ok');
});

test('AI: demo is informational, a missing key fails, a configured engine passes', () => {
  assert.equal(checkAi({ demo: true, engine: 'demo', secrets: {} }).status, 'info');
  assert.equal(checkAi({ demo: false, engine: 'openai', secrets: { openaiKey: '' } }).status, 'fail');
  assert.equal(checkAi({ demo: false, engine: 'openai', secrets: { openaiKey: 'sk-x' } }).status, 'ok');
});

test('cameras are counted from .env and the dashboard, and never show a password', () => {
  const none = checkCameras({ demo: false, cameras: [] }, []);
  assert.equal(none.status, 'warn');
  const r = checkCameras({ demo: false, cameras: [{ name: 'หน้าบ้าน', url: 'rtsp://admin:pw123@192.168.1.50/s1' }] }, [{ name: 'สวน', url: 'http://192.168.1.51/snap.jpg' }]);
  assert.equal(r.status, 'ok');
  assert.match(r.title, /2 ตัว/);
  assert.ok(!r.detail.includes('pw123'));
});

test('alerts: none warns, a Telegram bot without a chat asks to bind it, bound passes', () => {
  assert.equal(checkAlerts({}, {}).status, 'warn');
  const unbound = checkAlerts({ TELEGRAM_BOT_TOKEN: 't' }, {});
  assert.equal(unbound.status, 'warn');
  assert.match(unbound.fix, /ใช้แชทนี้/);
  const ok = checkAlerts({ TELEGRAM_BOT_TOKEN: 't', PUSHOVER_TOKEN: 'a', PUSHOVER_USER: 'u' }, { telegramChatId: '-100' });
  assert.equal(ok.status, 'ok');
  assert.match(ok.title, /Telegram, iPhone/);
});

test('location comes from the dashboard settings or .env', () => {
  assert.equal(checkLocation({}, {}).status, 'warn');
  assert.equal(checkLocation({ LATITUDE: '13.8' }, {}).status, 'ok');
  assert.equal(checkLocation({}, { latitude: 13.8 }).status, 'ok');
});

test('server: /healthz answering means running; no answer means not started', async () => {
  const up = await checkServer(8080, async () => ({ ok: true, json: async () => ({ ok: true, lastCheck: null }) }));
  assert.equal(up.status, 'ok');
  const down = await checkServer(8080, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(down.status, 'warn');
});

test('autostart files live where each system looks for them', () => {
  assert.equal(autostartFile('darwin', '/Users/me', {}), '/Users/me/Library/LaunchAgents/com.nongfon.autostart.plist');
  assert.match(autostartFile('win32', 'C:\\Users\\me', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }), /Startup.NongFon\.cmd$/);
  assert.equal(autostartFile('linux', '/home/me', {}), '/home/me/.config/systemd/user/nongfon.service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nongfon-auto-'));
  assert.equal(checkAutostart(path.join(dir, 'x.plist')).status, 'info');
  fs.writeFileSync(path.join(dir, 'x.plist'), '');
  assert.equal(checkAutostart(path.join(dir, 'x.plist')).status, 'ok');
  fs.rmSync(dir, { recursive: true });
});

test('autostart entries run the app through Terminal (macOS), minimised PowerShell (Windows) or systemd (Linux)', () => {
  const plist = macPlist('/Users/me/nongfon & co');
  assert.match(plist, /<string>\/usr\/bin\/open<\/string>\s*<string>-a<\/string>\s*<string>Terminal<\/string>/);
  assert.ok(plist.includes('/Users/me/nongfon &amp; co/install/autostart-mac.command'));
  assert.match(windowsStartupCmd('C:\\nongfon'), /nongfon\.ps1" start -NoBrowser\r\n$/);
  assert.match(linuxUnit('/home/me/nongfon'), /ExecStart=\/usr\/bin\/env bash "\/home\/me\/nongfon\/install\/nongfon\.sh" start --no-browser/);
  assert.match(linuxUnit('/home/John Doe/nongfon'), /bash "\/home\/John Doe\/nongfon\/install\/nongfon\.sh" start/); // a space in the path stays one argument
});

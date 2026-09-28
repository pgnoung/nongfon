#!/usr/bin/env node
// น้องฝน health check — what is ready, what is missing, and the one next step for each.
// Never prints a key, token or camera password.
//
//   npm run doctor                 offline checks (fast, free)
//   npm run doctor -- --online     also asks each provider if the keys work and grabs one picture per camera
//   npm run doctor -- --json       machine-readable (for an AI agent)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadEnvFile, loadKeychainSecret, loadSecretFile } from '../src/config.js';
import { resolveFfmpeg } from '../src/camera/ffmpeg-path.js';
import { engineProblem } from '../src/ai/index.js';
import * as onlineChecks from './lib/checks.js';
import { addSecret } from '../src/log.js';
import { maskUrl } from './lib/envfile.js';
import { autostartFile } from './lib/autostart-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', info: 'ℹ️ ' };
const item = (status, title, detail = '', fix = '') => ({ status, title, detail, fix });
// fixes the owner can always run: the double-click menu works even when Node lives only in .runtime/
const SECRETS_FIX = 'ดับเบิลคลิกตัวเปิดน้องฝน → เมนู 3 (หรือ npm run secrets)';
const SETUP_FIX = 'ดับเบิลคลิกตัวเปิดน้องฝน → เมนู 2 (หรือ npm run setup)';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function checkNode(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  return major >= 22 ? item('ok', `Node.js ${version}`) : item('fail', `Node.js ${version} เก่าไป`, 'ต้องใช้ 22 ขึ้นไป', 'รันตัวติดตั้งน้องฝนอีกครั้ง (จะลง Node ให้ในโฟลเดอร์นี้)');
}

export async function checkDeps(load = (name) => import(name)) {
  const missing = [];
  for (const name of ['sharp', '@anthropic-ai/sdk']) {
    try {
      await load(name);
    } catch {
      missing.push(name);
    }
  }
  return missing.length
    ? item('fail', 'ยังติดตั้งส่วนประกอบไม่ครบ', missing.join(', '), 'รันตัวติดตั้งอีกครั้ง หรือพิมพ์ npm ci')
    : item('ok', 'ส่วนประกอบครบ (sharp, AI SDK)');
}

export function checkFfmpeg({ env = process.env, run = spawnSync } = {}) {
  const bin = resolveFfmpeg({ env });
  const r = run(bin, ['-version'], { encoding: 'utf8', timeout: 15000 });
  if (r.status === 0) return item('ok', 'ffmpeg พร้อม (ใช้กับกล้อง RTSP)', String(r.stdout).split('\n')[0].slice(0, 60));
  return item('warn', 'ยังไม่มี ffmpeg', 'กล้องที่ใช้ลิงก์ rtsp:// ต้องมี · ลิงก์ภาพนิ่ง http:// ใช้ได้เลย', 'รันตัวติดตั้งอีกครั้ง หรือพิมพ์ npm install --no-save ffmpeg-static');
}

export function checkEnvFile(file, { platform = process.platform } = {}) {
  if (!fs.existsSync(file)) return item('fail', 'ยังไม่มีไฟล์ตั้งค่า .env', '', SETUP_FIX);
  if (platform === 'win32') return item('ok', 'มีไฟล์ตั้งค่า .env');
  const mode = fs.statSync(file).mode & 0o777;
  return mode & 0o077
    ? item('warn', 'ไฟล์ .env คนอื่นในเครื่องอ่านได้', `สิทธิ์ ${mode.toString(8)}`, 'พิมพ์ chmod 600 .env')
    : item('ok', 'มีไฟล์ตั้งค่า .env (อ่านได้เฉพาะผู้ใช้นี้)');
}

export function checkPassword(env) {
  const pw = env.DASHBOARD_PASSWORD || '';
  if (!pw) return item('fail', 'ยังไม่ได้ตั้งรหัสผ่านหน้าเว็บ', '', SECRETS_FIX);
  if (pw.length < 8) return item('warn', 'รหัสผ่านหน้าเว็บสั้นไป', `${pw.length} ตัว`, `ตั้งใหม่อย่างน้อย 8 ตัว: ${SECRETS_FIX}`);
  return item('ok', 'ตั้งรหัสผ่านหน้าเว็บแล้ว');
}

export function checkAi(config) {
  if (config.demo) return item('info', 'โหมดสาธิต (AI จำลอง ไม่เสียเงิน)', '', `พร้อมใช้จริงเมื่อไหร่: ${SETUP_FIX} แล้วเลือก AI`);
  const problem = engineProblem(config);
  return problem ? item('fail', 'สมอง AI ยังไม่พร้อม', problem, SECRETS_FIX) : item('ok', `สมอง AI: ${config.engine}`);
}

export function checkCameras(config, userCameras) {
  const cams = config.demo ? config.cameras : [...config.cameras, ...userCameras];
  if (!cams.length) return item('warn', 'ยังไม่มีกล้อง', '', 'เปิดหน้าเว็บ → ตั้งค่า → กล้อง → “ค้นหากล้องในบ้าน”');
  return item('ok', `กล้อง ${cams.length} ตัว`, cams.map((c) => `${c.name} (${maskUrl(c.url)})`).join(' · '));
}

export function checkAlerts(env, settings) {
  const chat = settings.telegramChatId || env.TELEGRAM_CHAT_ID;
  const parts = [];
  if (env.TELEGRAM_BOT_TOKEN) parts.push(chat ? 'Telegram' : 'Telegram (ยังไม่ได้ผูกแชท)');
  if (env.LINE_CHANNEL_ACCESS_TOKEN) parts.push('LINE');
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) parts.push('iPhone (Pushover)');
  if (env.MQTT_URL || env.SIREN_WEBHOOK_ON_URL) parts.push('ไซเรน');
  if (!parts.length) return item('warn', 'ยังไม่มีช่องทางปลุก', '', `ตั้ง Telegram: ${SECRETS_FIX} แล้วในหน้าเว็บ ตั้งค่า → Telegram → “ใช้แชทนี้”`);
  if (env.TELEGRAM_BOT_TOKEN && !chat) return item('warn', `ช่องทางปลุก: ${parts.join(', ')}`, '', 'ทักบอทใน Telegram แล้วในหน้าเว็บ ตั้งค่า → Telegram → กด “ใช้แชทนี้”');
  return item('ok', `ช่องทางปลุก: ${parts.join(', ')}`);
}

export function checkLocation(env, settings) {
  const lat = settings.latitude ?? env.LATITUDE;
  return lat !== undefined && lat !== null && lat !== ''
    ? item('ok', 'ตั้งพิกัดดูฝนแล้ว')
    : item('warn', 'ยังไม่ได้ตั้งพิกัดดูฝน', 'ไม่มีเรดาร์/พยากรณ์ฝนรอบบ้าน และตรวจถี่เท่าเดิมทุกคืน', 'หน้าเว็บ → ตั้งค่า → บ้านของเรา → พิกัด');
}

export async function checkServer(port, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    if (res.ok && body.ok) return item('ok', `น้องฝนเปิดอยู่ที่ http://localhost:${port}`, body.lastCheck ? `ตรวจล่าสุด ${new Date(body.lastCheck).toLocaleString('th-TH')}` : 'ยังไม่ได้ตรวจรอบแรก');
  } catch {
    /* not running */
  }
  return item('warn', 'น้องฝนยังไม่ได้เปิด', `พอร์ต ${port}`, 'ดับเบิลคลิก NongFon-mac.command / NongFon-windows.bat หรือพิมพ์ npm start');
}

export function checkAutostart(file = autostartFile()) {
  return fs.existsSync(file)
    ? item('ok', 'เปิดเองอัตโนมัติเมื่อเปิดเครื่อง')
    : item('info', 'ยังไม่ได้ตั้งให้เปิดเองเมื่อเปิดเครื่อง', '', 'ดับเบิลคลิกตัวเปิดน้องฝน → เมนู 5 (หรือ npm run autostart -- on)');
}

async function onlineItems(config, env, checks) {
  const out = [];
  const keyCheck = {
    openai: () => checks.checkOpenAI(config.secrets.openaiKey, env.AI_MODEL && /^gpt-/.test(env.AI_MODEL) ? env.AI_MODEL : 'gpt-6-luna'),
    anthropic: () => checks.checkAnthropic(config.secrets.anthropicKey, env.AI_MODEL || 'claude-sonnet-5'),
  }[config.engine];
  if (!config.demo && keyCheck && !engineProblem(config)) {
    const r = await keyCheck();
    out.push(item(r.ok ? 'ok' : 'fail', `ทดสอบคีย์ AI กับผู้ให้บริการ`, r.detail, r.ok ? '' : SECRETS_FIX));
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    const r = await checks.checkTelegram(env.TELEGRAM_BOT_TOKEN);
    out.push(item(r.ok ? 'ok' : 'fail', 'ทดสอบบอท Telegram', r.detail, r.ok ? '' : SECRETS_FIX));
  }
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) {
    const r = await checks.checkPushover(env.PUSHOVER_TOKEN, env.PUSHOVER_USER);
    out.push(item(r.ok ? 'ok' : 'fail', 'ทดสอบ Pushover', r.detail, r.ok ? '' : SECRETS_FIX));
  }
  return out;
}

async function cameraShots(config, userCameras) {
  if (config.demo) return [];
  const { grabFrame } = await import('../src/camera/capture.js');
  const ctx = { ffmpegPath: config.ffmpegPath, httpTool: config.httpTool, timeoutMs: 20000 };
  const out = [];
  for (const cam of [...config.cameras, ...userCameras]) {
    try {
      const buf = await grabFrame(cam, ctx);
      out.push(item('ok', `ดึงภาพจาก “${cam.name}” ได้`, `${Math.round(buf.length / 1024)} KB`));
    } catch (err) {
      out.push(item('fail', `ดึงภาพจาก “${cam.name}” ไม่ได้`, err.message, 'เช็กลิงก์/รหัสกล้อง ในหน้าเว็บ ตั้งค่า → กล้อง → ทดสอบ'));
    }
  }
  return out;
}

export async function runDoctor({ root = ROOT, online = false, checks = onlineChecks, fetchImpl = fetch } = {}) {
  const envFile = path.join(root, '.env');
  loadEnvFile(envFile);
  if (!loadKeychainSecret()) loadSecretFile(); // same key sources as src/main.js
  const env = process.env;
  const config = loadConfig({ argv: [], env });
  const settings = readJson(path.join(config.dataDir, 'settings.json'), {});
  const userCameras = readJson(path.join(config.dataDir, 'user-cameras.json'), []);
  for (const cam of userCameras) { // mask dashboard-added camera passwords too, like src/config.js does for .env cameras
    try {
      const u = new URL(cam.url);
      if (u.password) addSecret(decodeURIComponent(u.password));
    } catch {
      /* not a link */
    }
  }
  const items = [
    checkNode(),
    await checkDeps(),
    checkFfmpeg({ env }),
    checkEnvFile(envFile),
    checkPassword(env),
    checkAi(config),
    checkCameras(config, userCameras),
    checkAlerts(env, settings),
    checkLocation(env, settings),
    await checkServer(config.port, fetchImpl),
    checkAutostart(),
  ];
  if (online) items.push(...(await onlineItems(config, env, checks)), ...(await cameraShots(config, userCameras)));
  return items;
}

async function main() {
  const argv = process.argv.slice(2);
  const items = await runDoctor({ online: argv.includes('--online') });
  const failed = items.filter((i) => i.status === 'fail').length;
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: failed === 0, items }, null, 2));
  } else {
    console.log('\n☔ น้องฝนตรวจความพร้อม\n');
    for (const i of items) {
      console.log(`${ICON[i.status]} ${i.title}${i.detail ? ` — ${i.detail}` : ''}`);
      if (i.fix && i.status !== 'ok') console.log(`   → ${i.fix}`);
    }
    const warned = items.filter((i) => i.status === 'warn').length;
    console.log(`\n${failed ? `ยังต้องแก้ ${failed} ข้อ` : 'พร้อมใช้งานค่ะ'}${warned ? ` · ควรทำเพิ่ม ${warned} ข้อ` : ''}\n`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`ตรวจไม่สำเร็จ: ${err.message}`);
    process.exit(1);
  });
}

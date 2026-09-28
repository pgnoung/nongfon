#!/usr/bin/env node
// น้องฝน setup wizard — asks one step at a time in Thai, checks every key online, and writes .env
// (readable by this user only). Nothing leaves the machine except the checks with each provider.
//
//   npm run setup                full wizard (6 steps)
//   npm run setup -- --secrets   keys and tokens only (an AI agent already wrote the rest of .env)

import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { ipv4ToInt, isPrivateHost } from '../src/net/lan.js';
import * as onlineChecks from './lib/checks.js';
import {
  cameraUrlProblem, generatePassword, looksLike, maskUrl, parseCoordinates, parseEnv, readEnvFile, upsertEnv, writeEnvFile,
} from './lib/envfile.js';
import { createScriptedIO, createTerminalIO } from './lib/ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CAMERAS = 12;
const isPublicHost = (host) => ipv4ToInt(host) !== null && !isPrivateHost(host);

// ------------------------------------------------------------------ small building blocks

/** Ask for a secret until it looks right and (optionally) passes an online check. '' = skip. */
async function askSecret(io, id, question, { looksRight, check, keep }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const value = await io.secret(id, keep ? `${question} (Enter = ใช้ค่าเดิม)` : `${question} (Enter = ข้าม)`);
    if (!value) return keep || '';
    if (looksRight && !looksRight(value)) {
      io.say('  ❌ รูปแบบไม่ตรง ลองคัดลอกใหม่ทั้งบรรทัดนะคะ');
      continue;
    }
    if (!check) return value;
    io.say('  … กำลังตรวจกับผู้ให้บริการ');
    const result = await check(value);
    io.say(`  ${result.ok ? '✅' : '❌'} ${result.detail}`);
    if (result.ok) return value;
    const useAnyway = await io.confirm(`${id}_keep_anyway`, '  ใช้ค่านี้ไปก่อนไหมคะ? (n = วางใหม่)', { defaultValue: false });
    if (useAnyway) return value;
  }
  io.say('  ข้ามไปก่อนนะคะ ค่อยใส่ใหม่ได้: ดับเบิลคลิกตัวเปิดน้องฝน → เมนู 3 (หรือ npm run secrets)');
  return keep || '';
}

export function freePort(start = 8080, { tries = 20, host = '0.0.0.0' } = {}) {
  const probe = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
  return (async () => {
    for (let port = start; port < start + tries; port++) if (await probe(port)) return port;
    return start;
  })();
}

function hasClaudeCli() {
  const r = spawnSync(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['--version'], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0;
}

// ------------------------------------------------------------------ the six steps

async function stepLocal(io) {
  io.say('\nขั้น 1/6 · ติดตั้งในเครื่องนี้ (local) เพื่อความปลอดภัย');
  io.say('  • น้องฝนทำงานในเครื่องนี้เครื่องเดียว ภาพกล้อง รหัสกล้อง และคีย์ทั้งหมดเก็บในโฟลเดอร์นี้');
  io.say('  • ที่ออกนอกบ้านมีแค่ ภาพที่ส่งให้ AI ดู กับข้อความแจ้งเตือนตามช่องทางที่คุณเลือก');
  io.say('  • หน้าเว็บเปิดได้เฉพาะใน Wi-Fi บ้าน ถ้าอยากดูจากข้างนอก ค่อยต่อ Tailscale ทีหลังได้');
  const ok = await io.confirm('always_on', 'เครื่องนี้เปิดทิ้งไว้ได้ทั้งคืน และอยู่ใน Wi-Fi/LAN เดียวกับกล้องใช่ไหมคะ?', { defaultValue: true });
  if (!ok) io.say('  ลองก่อนได้เลยค่ะ แต่ตอนเครื่องปิดหรือหลับ น้องฝนจะเฝ้าไม่ได้ ใช้งานจริงแนะนำเครื่องที่เปิดตลอด เช่น Mac mini หรือ mini PC');
  return {};
}

const AI_CHOICES = [
  { value: 'openai', label: 'มีคีย์ OpenAI (GPT) — ถูกสุด ราว 170 บาท/เดือน สำหรับกล้อง 3 ตัว ตรวจทุก 10 นาที [แนะนำ]' },
  { value: 'anthropic', label: 'มีคีย์ Claude API (Anthropic)' },
  { value: 'claude-code', label: 'จ่ายแพ็กเกจ Claude Pro/Max อยู่แล้ว (ใช้ผ่าน Claude Code ไม่เสียค่า API เพิ่ม)' },
  { value: 'demo', label: 'ยังไม่มี — ขอลองโหมดสาธิตก่อน (กล้องภาพวาด + AI จำลอง ไม่เสียเงิน)' },
];

async function stepAi(io, env, checks, { secretsOnly = false } = {}) {
  io.say(`\n${secretsOnly ? 'คีย์ AI' : 'ขั้น 2/6 · สมองของน้องฝน (AI ที่ดูภาพกล้อง)'}`);
  const demo = env.DEMO && env.DEMO !== '0';
  const current = secretsOnly ? (env.AI_ENGINE || 'openai') : (demo ? 'demo' : (env.AI_ENGINE || 'openai'));
  const engine = secretsOnly ? current : await io.choose('ai', 'มี API key หรือแพ็กเกจ AI แล้วหรือยังคะ?', AI_CHOICES, { defaultValue: current });
  if (engine === 'demo') {
    io.say('  ได้ค่ะ เปิดโหมดสาธิตให้ก่อน พร้อมใช้จริงเมื่อไหร่ ดับเบิลคลิกตัวเปิดน้องฝน → เมนู 2 นะคะ');
    return { DEMO: '1' };
  }
  if (engine === 'openai') {
    if (!env.OPENAI_API_KEY) io.say('  ยังไม่มีคีย์? platform.openai.com/api-keys → Create new secret key แล้วเติมเครดิต $5 ที่ Billing');
    const model = env.AI_MODEL && /^gpt-/.test(env.AI_MODEL) ? env.AI_MODEL : 'gpt-6-luna';
    const key = await askSecret(io, 'openai_key', 'วาง OpenAI API key (ขึ้นต้น sk-) · ตัวอักษรจะไม่แสดงบนจอ', {
      looksRight: looksLike.openaiKey, check: (k) => checks.checkOpenAI(k, model), keep: env.OPENAI_API_KEY,
    });
    return { AI_ENGINE: 'openai', AI_MODEL: model, OPENAI_API_KEY: key || null, DEMO: null };
  }
  if (engine === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) io.say('  ยังไม่มีคีย์? console.anthropic.com → API Keys → Create Key แล้วเติมเครดิต');
    const model = env.AI_MODEL && /^claude-/.test(env.AI_MODEL) ? env.AI_MODEL : 'claude-sonnet-5';
    const key = await askSecret(io, 'anthropic_key', 'วาง Claude API key (ขึ้นต้น sk-ant-api) · ตัวอักษรจะไม่แสดงบนจอ', {
      looksRight: looksLike.anthropicKey, check: (k) => checks.checkAnthropic(k, model), keep: env.ANTHROPIC_API_KEY,
    });
    return { AI_ENGINE: 'anthropic', AI_MODEL: model, ANTHROPIC_API_KEY: key || null, DEMO: null };
  }
  if (!checks.hasClaudeCli()) io.say('  ⚠️ ยังไม่พบคำสั่ง claude ในเครื่องนี้ — ติดตั้ง Claude Code ก่อน (code.claude.com) แล้วเปิดตัวช่วยตั้งค่าอีกครั้ง (ตัวเปิดน้องฝน → เมนู 2)');
  io.say('  เปิด Terminal อีกหน้าต่าง พิมพ์  claude setup-token  ล็อกอินให้เสร็จ แล้วคัดลอกโทเคนที่ขึ้นต้น sk-ant-oat');
  const token = await askSecret(io, 'claude_token', 'วางโทเคน Claude (sk-ant-oat…) · ตัวอักษรจะไม่แสดงบนจอ', {
    looksRight: looksLike.claudeOauth, keep: env.CLAUDE_CODE_OAUTH_TOKEN,
  });
  return { AI_ENGINE: 'claude-code', CLAUDE_CODE_OAUTH_TOKEN: token || null, DEMO: null };
}

async function stepCameras(io, env) {
  io.say('\nขั้น 3/6 · กล้องวงจรปิด');
  const mode = await io.choose('camera_mode', 'จะเพิ่มกล้องแบบไหนคะ?', [
    { value: 'web', label: 'ให้น้องฝนค้นหากล้องในบ้านให้ ในหน้าเว็บทีหลัง (กดปุ่มแล้วใส่รหัสกล้อง) [แนะนำ]' },
    { value: 'url', label: 'มีลิงก์ RTSP / ลิงก์ภาพนิ่งของกล้องอยู่แล้ว ใส่ตอนนี้เลย' },
  ], { defaultValue: 'web' });
  if (mode === 'web') {
    io.say('  โอเคค่ะ เปิดหน้าเว็บแล้วไปที่ ตั้งค่า → กล้อง → “ค้นหากล้องในบ้าน”');
    return {};
  }
  io.say('  ลิงก์มีรหัสกล้องอยู่ด้วย เก็บในไฟล์ .env เครื่องนี้เท่านั้นนะคะ ตัวอย่าง rtsp://admin:รหัส@192.168.1.50:554/stream1');
  const updates = {};
  let count = 0;
  while (count < MAX_CAMERAS) {
    const i = count + 1;
    const name = await io.ask('camera_name', `  ชื่อกล้องตัวที่ ${i} (Enter = พอแล้ว)`, { defaultValue: i === 1 ? 'หน้าบ้าน' : '' });
    if (!name) break;
    const url = await io.ask('camera_url', `  ลิงก์ของ “${name}”`);
    const problem = url ? cameraUrlProblem(url, { isPublicHost }) : 'ยังไม่ได้ใส่ลิงก์';
    if (problem) {
      io.say(`  ❌ ${problem}`);
      if (!(await io.confirm('camera_retry', '  ลองใส่กล้องตัวนี้ใหม่ไหมคะ?', { defaultValue: true }))) break;
      continue;
    }
    Object.assign(updates, { [`CAMERA_${i}_NAME`]: name, [`CAMERA_${i}_URL`]: url.trim() });
    io.say(`  ✅ ${name}: ${maskUrl(url)}`);
    count = i;
    if (!(await io.confirm('camera_more', '  เพิ่มอีกตัวไหมคะ?', { defaultValue: false }))) break;
  }
  // clear leftover slots from the template or an older setup
  for (let i = count + 1; i <= MAX_CAMERAS; i++) {
    if (env[`CAMERA_${i}_NAME`] !== undefined || env[`CAMERA_${i}_URL`] !== undefined) Object.assign(updates, { [`CAMERA_${i}_NAME`]: null, [`CAMERA_${i}_URL`]: null });
  }
  return updates;
}

async function stepTelegram(io, env, checks, { ask = true } = {}) {
  const want = !ask || await io.confirm('telegram', 'ใช้ Telegram ปลุกไหมคะ? (ฟรี ส่งรูปกล้อง + มีปุ่มหยุดไซเรน) [แนะนำ]', { defaultValue: true });
  if (!want) return {};
  if (!env.TELEGRAM_BOT_TOKEN) io.say('  สร้างบอท: ทัก @BotFather ใน Telegram → /newbot → ตั้งชื่อ → คัดลอกโทเคนบอท');
  let username = '';
  const token = await askSecret(io, 'telegram_token', 'วางโทเคนบอท Telegram', {
    looksRight: looksLike.telegramToken,
    check: async (t) => { const r = await checks.checkTelegram(t); username = r.username || ''; return r; },
    keep: env.TELEGRAM_BOT_TOKEN,
  });
  if (token && token !== env.TELEGRAM_BOT_TOKEN) {
    io.say(`  ต่อไป: เปิดแชทกับ ${username ? `@${username}` : 'บอท'} แล้วกด Start (หรือเชิญบอทเข้ากลุ่มครอบครัวแล้วพิมพ์ /start)`);
    io.say('  แล้วในหน้าเว็บ ตั้งค่า → Telegram → กด “ใช้แชทนี้” → ส่งข้อความทดสอบ');
  }
  return token ? { TELEGRAM_BOT_TOKEN: token } : {};
}

async function stepLine(io, env, checks, { ask = true } = {}) {
  const want = !ask || await io.confirm('line', 'ใช้ LINE OA ปลุกด้วยไหมคะ? (ต้องมี LINE OA ของตัวเอง)', { defaultValue: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN) });
  if (!want) return {};
  const token = await askSecret(io, 'line_token', 'วาง Channel access token (LINE Developers → Messaging API)', {
    looksRight: looksLike.lineToken, check: (t) => checks.checkLine(t), keep: env.LINE_CHANNEL_ACCESS_TOKEN,
  });
  return token ? { LINE_CHANNEL_ACCESS_TOKEN: token } : {};
}

async function stepPushover(io, env, checks, { ask = true } = {}) {
  const want = !ask || await io.confirm('pushover', 'อยากให้ iPhone ดังปลุกแม้ปิดเสียงไหมคะ? (แอป Pushover ทดลองฟรี 30 วัน แล้วจ่ายครั้งเดียว $4.99)', { defaultValue: Boolean(env.PUSHOVER_TOKEN) });
  if (!want) return {};
  if (!env.PUSHOVER_TOKEN) {
    io.say('  1) ลงแอป Pushover Notifications ใน iPhone แล้วสมัครบัญชี · อนุญาต Critical Alerts');
    io.say('  2) ยืนยันอีเมลจาก Pushover ก่อน (ไม่งั้นสร้างแอปไม่ได้)');
    io.say('  3) pushover.net → Create an Application/API Token → ตั้งชื่อ “น้องฝน” → ได้ API Token (ขึ้นต้น a)');
    io.say('  4) User Key อยู่มุมขวาบนของ pushover.net (ขึ้นต้น u)');
  }
  const token = await askSecret(io, 'pushover_token', 'วาง API Token ของแอปน้องฝน', { looksRight: looksLike.pushoverKey, keep: env.PUSHOVER_TOKEN });
  const user = await askSecret(io, 'pushover_user', 'วาง User Key', { looksRight: looksLike.pushoverKey, keep: env.PUSHOVER_USER });
  if (token && user) {
    const r = await checks.checkPushover(token, user);
    io.say(`  ${r.ok ? '✅' : '❌'} ${r.detail}`);
  }
  return token && user ? { PUSHOVER_TOKEN: token, PUSHOVER_USER: user } : {};
}

async function stepAlerts(io, env, checks) {
  io.say('\nขั้น 4/6 · ช่องทางปลุก (เลือกได้หลายช่อง)');
  return {
    ...(await stepTelegram(io, env, checks)),
    ...(await stepLine(io, env, checks)),
    ...(await stepPushover(io, env, checks)),
  };
}

async function stepHome(io, env, checks) {
  io.say('\nขั้น 5/6 · บ้านของคุณ (ใช้ดูฝนรอบบ้าน และข่าวน้ำท่วมแถวบ้าน)');
  const siteName = await io.ask('site_name', 'ชื่อบ้าน (ขึ้นในข้อความเตือน)', { defaultValue: env.SITE_NAME || 'บ้านของเรา' });
  io.say('  ใส่แค่ระดับย่าน/อำเภอก็พอ ไม่ต้องละเอียดถึงบ้าน พิกัดเก็บในเครื่องนี้ ใช้ถามพยากรณ์ฝนเท่านั้น');
  const place = await io.ask('place', 'ย่าน/อำเภอ (เช่น Bang Yai หรือ บางใหญ่ นนทบุรี) หรือวางพิกัด/ลิงก์ Google Maps · Enter = ข้าม');
  const updates = { SITE_NAME: siteName };
  if (!place) return updates;
  const coords = parseCoordinates(place);
  if (coords) return { ...updates, LATITUDE: String(coords.latitude), LONGITUDE: String(coords.longitude) };
  const found = await checks.geocode(place).catch(() => []);
  if (!found.length) {
    io.say('  หาไม่เจอค่ะ ลองพิมพ์ชื่อภาษาอังกฤษ หรือวางพิกัดจาก Google Maps ก็ได้ — ตอนนี้ข้ามไปก่อน ตั้งในหน้าเว็บทีหลังได้');
    return updates;
  }
  const pick = await io.choose('place_pick', '  ใช่ที่ไหนคะ?', [
    ...found.map((f, i) => ({ value: String(i), label: `${f.label} (${f.latitude}, ${f.longitude})` })),
    { value: 'none', label: 'ไม่ใช่ทั้งหมด — ข้ามไปก่อน' },
  ], { defaultValue: '0' });
  if (pick === 'none') return updates;
  const spot = found[Number(pick)];
  const area = /[฀-๿]/.test(place) ? place.trim() : spot.area;
  return { ...updates, LATITUDE: String(spot.latitude), LONGITUDE: String(spot.longitude), ...(area ? { NEWS_QUERY: `น้ำท่วม ${area}` } : {}) };
}

async function stepPassword(io, env, { secretsOnly = false } = {}) {
  io.say(`\n${secretsOnly ? 'รหัสผ่านหน้าเว็บ' : 'ขั้น 6/6 · รหัสผ่านหน้าเว็บ'}`);
  if (env.DASHBOARD_PASSWORD && await io.confirm('keep_password', 'มีรหัสผ่านหน้าเว็บอยู่แล้ว ใช้ต่อไหมคะ?', { defaultValue: true })) return {};
  const mode = await io.choose('password_mode', 'ตั้งรหัสผ่านหน้าเว็บแบบไหนคะ?', [
    { value: 'auto', label: 'สร้างรหัสที่เดายากให้เลย [แนะนำ]' },
    { value: 'own', label: 'ตั้งเอง' },
  ], { defaultValue: 'auto' });
  if (mode === 'own') {
    for (;;) {
      const first = await io.secret('password', 'ตั้งรหัส (อย่างน้อย 8 ตัว)');
      if (first.length < 8) { io.say('  สั้นไปค่ะ ขออย่างน้อย 8 ตัว'); continue; }
      const again = await io.secret('password_again', 'พิมพ์ซ้ำอีกครั้ง');
      if (first === again) return { DASHBOARD_PASSWORD: first };
      io.say('  สองครั้งไม่ตรงกัน ลองใหม่นะคะ');
    }
  }
  const pw = generatePassword();
  io.say(`  🔑 รหัสผ่านหน้าเว็บคือ  ${pw}`);
  io.say('     จดไว้ หรือเปิดดูได้ในไฟล์ .env บรรทัด DASHBOARD_PASSWORD');
  return { DASHBOARD_PASSWORD: pw };
}

// ------------------------------------------------------------------ the whole run

/** env with the updates applied; a null update removes the key. */
function applyUpdates(env, updates) {
  const merged = { ...env, ...updates };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null && v !== undefined));
}

function summarize(env) {
  const cams = Object.keys(env).filter((k) => /^CAMERA_\d+_URL$/.test(k) && env[k]).length;
  const demo = env.DEMO && env.DEMO !== '0';
  const brain = demo ? 'โหมดสาธิต (AI จำลอง)' : `${env.AI_ENGINE || 'anthropic'}${env.AI_MODEL ? ` · ${env.AI_MODEL}` : ''}`;
  const keyOk = demo || Boolean({ openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY, 'claude-code': env.CLAUDE_CODE_OAUTH_TOKEN }[env.AI_ENGINE || 'anthropic']);
  return [
    `  ${keyOk ? '✅' : '⚠️ '} สมอง AI: ${brain}${keyOk ? '' : ' — ยังไม่มีคีย์'}`,
    `  ${cams ? '✅' : '•'} กล้องใน .env: ${cams ? `${cams} ตัว` : 'ยังไม่มี (เพิ่มในหน้าเว็บได้)'}`,
    `  ${env.TELEGRAM_BOT_TOKEN ? '✅' : '•'} Telegram · ${env.LINE_CHANNEL_ACCESS_TOKEN ? '✅' : '•'} LINE · ${env.PUSHOVER_TOKEN ? '✅' : '•'} iPhone (Pushover)`,
    `  ${env.LATITUDE ? '✅' : '•'} พิกัดสำหรับดูฝน${env.LATITUDE ? `: ${env.LATITUDE}, ${env.LONGITUDE}` : ': ยังไม่ได้ตั้ง'}`,
    `  ${env.DASHBOARD_PASSWORD ? '✅' : '⚠️ '} รหัสผ่านหน้าเว็บ · พอร์ต ${env.PORT || 8080}`,
  ];
}

/**
 * Run the wizard. Returns { text, env } with the new .env text; writing it is the caller's job.
 * secretsOnly: keys, tokens and the dashboard password only (for an AI agent's guided setup).
 */
export async function runSetup({ io, envText, checks = { ...onlineChecks, hasClaudeCli }, secretsOnly = false, firstRun = false, pickPort = freePort }) {
  const env = parseEnv(envText);
  io.say('☔ สวัสดีค่ะ น้องฝนเองนะคะ จะพาตั้งค่าทีละขั้น (กด Enter = ใช้ค่าที่แนะนำ)');
  const steps = secretsOnly
    ? [
      () => stepAi(io, env, checks, { secretsOnly: true }),
      () => stepTelegram(io, env, checks, { ask: false }),
      () => stepLine(io, env, checks, { ask: false }),
      () => stepPushover(io, env, checks, { ask: false }),
      (cur) => stepPassword(io, cur, { secretsOnly: true }),
    ]
    : [
      () => stepLocal(io),
      () => stepAi(io, env, checks),
      (cur) => (cur.DEMO === '1' ? {} : stepCameras(io, env)),
      () => stepAlerts(io, env, checks),
      () => stepHome(io, env, checks),
      (cur) => stepPassword(io, cur),
    ];
  let updates = {};
  for (const step of steps) {
    updates = { ...updates, ...(await step(applyUpdates(env, updates))) };
  }
  if (firstRun && !env.PORT && !secretsOnly) {
    const port = await pickPort(8080);
    if (port !== 8080) updates = { ...updates, PORT: String(port) };
  }
  const text = upsertEnv(envText, updates);
  const finalEnv = parseEnv(text);
  io.say('\nสรุปค่ะ');
  for (const line of summarize(finalEnv)) io.say(line);
  return { text, env: finalEnv, updates };
}

async function main() {
  const argv = process.argv.slice(2);
  const secretsOnly = argv.includes('--secrets');
  const envFile = path.join(ROOT, '.env');
  const answersFile = process.env.NONGFON_SETUP_ANSWERS;
  const io = answersFile ? createScriptedIO(JSON.parse(fs.readFileSync(answersFile, 'utf8'))) : createTerminalIO();
  if (!answersFile && !io.interactive) {
    console.error('ตัวช่วยตั้งค่าต้องรันในหน้าต่าง Terminal ที่พิมพ์ตอบได้ค่ะ — ดับเบิลคลิก NongFon-mac.command / NongFon-windows.bat หรือเปิด Terminal แล้วพิมพ์ npm run setup');
    process.exit(2);
  }
  const firstRun = !fs.existsSync(envFile);
  const envText = readEnvFile(envFile, path.join(ROOT, '.env.example'));
  const { text } = await runSetup({ io, envText, secretsOnly, firstRun });
  const save = await io.confirm('save', '\nบันทึกลงไฟล์ .env ไหมคะ?', { defaultValue: true });
  if (!save) {
    io.say('ยังไม่ได้บันทึกค่ะ เริ่มใหม่ได้ทุกเมื่อ: ดับเบิลคลิกตัวเปิดน้องฝน → เมนู 2 (หรือ npm run setup)');
    if (answersFile) for (const line of io.log) console.log(line);
    return;
  }
  writeEnvFile(envFile, text);
  io.say(`💾 บันทึกแล้ว: ${envFile} (เปิดอ่านได้เฉพาะผู้ใช้เครื่องนี้)`);
  io.say('ต่อไป: เปิดน้องฝน (ดับเบิลคลิก NongFon-mac.command / NongFon-windows.bat หรือ npm start) แล้วตรวจความพร้อมด้วย npm run doctor');
  if (answersFile) for (const line of io.log) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`ตั้งค่าไม่สำเร็จ: ${err.message}`);
    process.exit(1);
  });
}

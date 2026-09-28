#!/usr/bin/env node
// น้องฝนเฝ้าบ้าน — start everything.
//   node src/main.js             watch + dashboard
//   node src/main.js --demo      try it with cartoon cameras and a pretend AI
//   node src/main.js --once      one check, print the result, exit
//   node src/main.js --once --image cam1=/path/a.jpg   check real photos instead of a camera
//   node src/main.js --dry-run   decide as usual but send nothing and sound nothing
//   node src/main.js --test-telegram | --test-siren

import os from 'node:os';
import { loadConfig, loadEnvFile, loadKeychainSecret, loadSecretFile } from './config.js';
import { Store } from './store.js';
import { logger } from './log.js';
import { Notifier } from './notify/index.js';
import { TelegramBot } from './notify/telegram-bot.js';
import { Siren } from './siren/siren.js';
import { Weather } from './weather.js';
import { HourlySummary } from './hourly.js';
import { RainForecast } from './rain.js';
import { AlertPolicy } from './alerts.js';
import { Watcher } from './watcher.js';
import { createEngine, engineProblem } from './ai/index.js';
import { createHub, createWebServer } from './web/server.js';
import { LiveHub } from './camera/live.js';
import { applyCameras } from './camera/registry.js';
import { DemoWorld, demoBackfill } from './demo.js';
import { DEMO_ART_VERSION, DEMO_LINES } from './camera/demo-scene.js';

const log = logger('main');
const argv = process.argv.slice(2);

loadEnvFile('.env');
if (loadKeychainSecret()) log.info('ใช้คีย์ OpenAI จาก Keychain ของเครื่องนี้');
else if (loadSecretFile()) log.info('ใช้คีย์ OpenAI จากไฟล์ลับของเครื่องนี้');
const config = loadConfig({ argv });
const store = new Store(config.dataDir).init();

if (config.demo && !store.state.demoSeeded) {
  store.updateSettings({
    siteName: 'บ้านตัวอย่าง (โหมดสาธิต)',
    siteDescription: 'บ้านชั้นเดียว กล้องหน้าบ้านมองเห็นถนนและประตูรั้ว กล้องโรงรถมองเห็นพื้นโรงรถ รถ และบันไดทางขึ้นบ้าน น้ำมักท่วมถนนก่อนแล้วไหลเข้าทางประตูรั้ว ถ้าน้ำถึงหน้าบันไดถือว่าอันตราย',
    intervalMinutes: 1, fastIntervalMinutes: 1, relaxedIntervalMinutes: 2,
    latitude: 13.7563, longitude: 100.5018,
    confirmDelaySeconds: 20, criticalRepeatMinutes: 5, browserAlarm: true,
  });
  for (const [id, lines] of Object.entries(DEMO_LINES)) store.setCameraMeta(id, { lines });
  store.patchState({ demoSeeded: true, demoArtVersion: DEMO_ART_VERSION });
} else if (config.demo && store.state.demoArtVersion !== DEMO_ART_VERSION) {
  // the demo pictures were repainted: move the seeded lines to where the ground is now
  for (const [id, lines] of Object.entries(DEMO_LINES)) store.setCameraMeta(id, { lines });
  store.patchState({ demoArtVersion: DEMO_ART_VERSION });
}

// merge the cameras the owner added in the UI (real mode only; demo uses its two cartoon cameras)
if (!config.demo) applyCameras(config, store);

const hub = createHub();
const notifier = new Notifier({ store, config });
const siren = new Siren({ store, config, broadcast: hub.broadcast, notifier });
const weather = new Weather({ store });
const rain = new RainForecast({ getLocation: () => store.settings });
// photoFor runs after start-up, so `watcher` (declared below) exists by then
const hourly = new HourlySummary({ store, weather, rain, notifier, broadcast: hub.broadcast, photoFor: (r) => watcher.photoForReading(r) });
const world = config.demo ? new DemoWorld({ timezone: store.settings.timezone, origin: store.state.demoOrigin }) : null;
if (world && !store.state.demoOrigin) store.patchState({ demoOrigin: world.origin });
const engine = createEngine(config, { world, lineLookup: (id) => store.cameraMeta(id).lines });
// live CCTV view: nothing runs until someone opens a live picture
const live = new LiveHub({
  ffmpegPath: config.ffmpegPath,
  httpTool: config.httpTool,
  getCamera: (id) => config.cameras.find((c) => c.id === id) || null,
  demoFrame: world ? (cam) => world.frame(cam) : null,
});
const alerts = new AlertPolicy({ store, notifier, siren, config });
const watcher = new Watcher({
  config, store, engine, alerts, weather, world, broadcast: hub.broadcast, engineProblem: () => engineProblem(config),
});
const bot = new TelegramBot({ store, notifier, siren, watcher, buildPhoto: (r) => watcher.photoForReading(r) });

if (config.dryRun) {
  // Everything is decided and logged as usual, but nothing leaves the machine.
  notifier.send = async (msg) => {
    log.info(`[ทดลอง ไม่ส่งจริง] ${msg.title}\n${msg.text || ''}`);
    return notifier.record(msg.kind, `[ทดลอง] ${msg.title}`, msg.text || '', { readingId: msg.readingId || null });
  };
  siren.sound = async ({ reason } = {}) => {
    log.info(`[ทดลอง ไม่เปิดไซเรนจริง] ${reason || ''}`);
    return { skipped: 'dry-run' };
  };
}

function lanUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
  }
  return urls;
}

async function main() {
  if (argv.includes('--test-telegram')) {
    const chat = store.settings.telegramChatId;
    if (!notifier.telegram || !chat) throw new Error('ต้องมี TELEGRAM_BOT_TOKEN และ TELEGRAM_CHAT_ID ก่อน');
    await notifier.telegram.sendMessage(chat, '🧪 ทดสอบจาก <b>น้องฝนเฝ้าบ้าน</b> ☔ พร้อมปลุกแล้วค่ะ');
    log.info('ส่งข้อความทดสอบแล้ว');
    return;
  }
  if (argv.includes('--test-siren')) {
    const r = await siren.sound({ reason: 'ทดสอบ', seconds: 3, test: true });
    log.info(`สั่งเปิดไซเรนแล้ว: ${JSON.stringify(r.result)}`);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    await siren.stop('auto');
    return;
  }
  if (argv.includes('--once')) {
    if (!config.cameras.length) throw new Error('ยังไม่มีกล้อง — ใส่ CAMERA_1_NAME / CAMERA_1_URL ในไฟล์ .env ก่อน (หรือลอง npm run check -- --demo)');
    await weather.refresh();
    const { reading } = await watcher.cycle('manual');
    console.log(JSON.stringify({
      status: reading.status, level: reading.level, levelFromAi: reading.levelRaw, aiStatus: reading.aiStatus,
      headline: reading.headline, distance: reading.distance, reasons: reading.reasons,
      cameras: reading.cameras.map((c) => ({ name: c.name, ok: c.ok, line: c.lineStatus, water: c.water, coverage: c.coverage, note: c.note, error: c.error })),
      ai: reading.ai,
    }, null, 2));
    return;
  }

  // ---- long-running mode
  if (!config.cameras.length) log.warn('ยังไม่มีกล้อง — ใส่ CAMERA_1_NAME / CAMERA_1_URL ในไฟล์ .env (หรือรัน npm run demo เพื่อลองก่อน)');
  const problem = engineProblem(config);
  if (problem) log.warn(`AI: ${problem}`);
  if (!config.secrets.dashboardPassword) log.warn('ยังไม่ได้ตั้ง DASHBOARD_PASSWORD — หน้าเว็บจะยังไม่เปิดให้ใช้ (การเฝ้าและแจ้งเตือนยังทำงาน)');
  const ch = notifier.channels();
  if (!ch.telegram && !ch.line && !ch.webhook) log.warn('ยังไม่มีช่องทางแจ้งเตือน — ตั้ง Telegram หรือ LINE ในหน้าตั้งค่า');

  await siren.recover();
  if (config.demo) {
    const n = await demoBackfill({ store, cameras: config.cameras, settings: store.settings });
    if (n) log.info(`สร้างข้อมูลตัวอย่างย้อนหลัง ${n} รายการ`);
  }

  const { server } = createWebServer({ config, store, watcher, siren, notifier, weather, rain, bot, hub, live, engineProblem: () => engineProblem(config) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  weather.refresh().catch(() => {});
  const weatherTimer = setInterval(() => weather.refresh().catch(() => {}), 10 * 60e3);
  const summaryTimer = setInterval(() => {
    alerts.maybeDailySummary().catch((err) => log.warn(err.message));
    hourly.maybeRun().catch((err) => log.warn(`สรุปรายชั่วโมง: ${err.message}`));
  }, 60e3);
  watcher.start(config.demo ? 1500 : 5000);
  if (!config.dryRun) bot.start();

  console.log(`\n  ☔ น้องฝนเฝ้าบ้าน พร้อมแล้ว${config.demo ? ' (โหมดสาธิต)' : ''}`);
  for (const url of lanUrls(config.port)) console.log(`     ${url}`);
  if (config.demo && !process.env.DASHBOARD_PASSWORD) console.log('     รหัสผ่านหน้าเว็บ (สาธิต): demo');
  console.log(`     กล้อง ${config.cameras.length} ตัว · AI: ${config.engine} · ข้อมูลอยู่ที่ ${config.dataDir}\n`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info(`ได้รับ ${signal} กำลังปิด…`);
    watcher.stop();
    bot.stop();
    clearInterval(weatherTimer);
    clearInterval(summaryTimer);
    for (const res of hub.clients) res.end();
    live.stopAll(); // ends open MJPEG responses (else server.close() waits) and stops ffmpeg
    if (siren.status().on) await siren.stop('auto').catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// A stray rejected promise must not take the night watch down with it — log it and keep watching.
process.on('unhandledRejection', (err) => log.error(`unhandled: ${err?.stack || err}`));

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});

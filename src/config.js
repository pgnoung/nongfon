// Configuration: deployment values and secrets come from the environment (.env),
// everything a household tunes day to day lives in data/settings.json and is edited
// from the dashboard. Resolution order for a setting: dashboard → .env → default.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFfmpeg } from './camera/ffmpeg-path.js';
import { addSecret } from './log.js';
import { parseBool } from './util.js';

/** Minimal .env reader (KEY=value, optional quotes, # comments). Never overrides real env vars. */
/**
 * On a Mac service (launchd), read OPENAI_API_KEY from the login Keychain instead of a file:
 * set OPENAI_KEYCHAIN_SERVICE (+ OPENAI_KEYCHAIN_ACCOUNT). An explicit OPENAI_API_KEY wins.
 * Returns true when a key was loaded. The value is never logged.
 */
export function loadKeychainSecret(env = process.env, { exec = execFileSync, platform = process.platform } = {}) {
  const service = env.OPENAI_KEYCHAIN_SERVICE;
  if (env.OPENAI_API_KEY || !service || platform !== 'darwin') return false;
  const args = ['find-generic-password', ...(env.OPENAI_KEYCHAIN_ACCOUNT ? ['-a', env.OPENAI_KEYCHAIN_ACCOUNT] : []), '-s', service, '-w'];
  try {
    const value = String(exec('/usr/bin/security', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    if (!value) return false;
    env.OPENAI_API_KEY = value;
    return true;
  } catch {
    return false;
  }
}

/** A launchd daemon cannot reach the login Keychain: read OPENAI_API_KEY from an owner-only file instead. */
export function loadSecretFile(env = process.env) {
  const file = env.OPENAI_API_KEY_FILE;
  if (env.OPENAI_API_KEY || !file) return false;
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!value) return false;
    env.OPENAI_API_KEY = value;
    return true;
  } catch {
    return false;
  }
}

export function loadEnvFile(file = '.env') {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    let value = rest.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

/**
 * Every dashboard-editable setting. `env` names the .env key that seeds it.
 * type: string | text | int | float | bool | enum
 */
export const SETTINGS = {
  // บ้านของเรา
  siteName: { type: 'string', default: 'บ้านของเรา', max: 60, env: 'SITE_NAME' },
  siteDescription: { type: 'text', default: '', max: 2000, env: 'SITE_DESCRIPTION' },
  timezone: { type: 'timezone', default: 'Asia/Bangkok', env: 'TIMEZONE' },
  latitude: { type: 'float', default: null, nullable: true, min: -90, max: 90, env: 'LATITUDE' },
  longitude: { type: 'float', default: null, nullable: true, min: -180, max: 180, env: 'LONGITUDE' },

  // AI
  aiModel: { type: 'string', default: 'claude-sonnet-5', max: 80, env: 'AI_MODEL' },
  aiEffort: { type: 'enum', default: 'medium', options: ['low', 'medium', 'high'], env: 'AI_EFFORT' },
  imageMaxEdge: { type: 'int', default: 1280, min: 480, max: 2576, env: 'IMAGE_MAX_EDGE' },
  useReferenceImages: { type: 'bool', default: true },

  // รอบการตรวจ
  intervalMinutes: { type: 'int', default: 10, min: 1, max: 120, env: 'INTERVAL_MINUTES' },
  adaptiveInterval: { type: 'bool', default: true },
  fastIntervalMinutes: { type: 'int', default: 3, min: 1, max: 60 },
  relaxedIntervalMinutes: { type: 'int', default: 20, min: 1, max: 180 },
  paused: { type: 'bool', default: false },

  // เกณฑ์ตัดสิน
  warnLevel: { type: 'int', default: 50, min: 1, max: 100 },
  criticalLevel: { type: 'int', default: 90, min: 1, max: 100 },
  confirmCritical: { type: 'bool', default: true },
  confirmWarning: { type: 'bool', default: true },
  confirmDelaySeconds: { type: 'int', default: 90, min: 20, max: 600 },
  criticalRepeatMinutes: { type: 'int', default: 10, min: 1, max: 120 },
  failureThreshold: { type: 'int', default: 3, min: 1, max: 20 },
  predictiveWarning: { type: 'bool', default: true },
  predictiveMinutes: { type: 'int', default: 60, min: 10, max: 240 },

  // แจ้งเตือน
  telegramEnabled: { type: 'bool', default: true },
  telegramChatId: { type: 'string', default: '', max: 40, env: 'TELEGRAM_CHAT_ID' },
  lineEnabled: { type: 'bool', default: true },
  lineTo: { type: 'string', default: '', max: 80, env: 'LINE_TO' },
  webhookEnabled: { type: 'bool', default: true },
  notifyWarning: { type: 'bool', default: true },
  notifyRecovery: { type: 'bool', default: true },
  notifyFailure: { type: 'bool', default: true },
  dailySummaryHour: { type: 'int', default: null, nullable: true, min: 0, max: 23, env: 'DAILY_SUMMARY_HOUR' },
  hourlySummary: { type: 'bool', default: true },
  newsQuery: { type: 'string', default: 'น้ำท่วม กรุงเทพ', max: 120, env: 'NEWS_QUERY' },

  // ไซเรน
  sirenEnabled: { type: 'bool', default: false, env: 'SIREN_ENABLED' },
  sirenSeconds: { type: 'int', default: 60, min: 1, max: 900 },
  sirenOnWarning: { type: 'bool', default: false },
  mqttTopic: { type: 'string', default: 'zigbee2mqtt/Siren/set', max: 200, env: 'MQTT_TOPIC' },
  mqttOnPayload: { type: 'json', default: '{"alarm":true}', max: 500, env: 'MQTT_ON_PAYLOAD' },
  mqttOffPayload: { type: 'json', default: '{"alarm":false}', max: 500, env: 'MQTT_OFF_PAYLOAD' },
  browserAlarm: { type: 'bool', default: true },
  browserAlarmOnWarning: { type: 'bool', default: false },
  iphoneAlarm: { type: 'bool', default: true },
  iphoneAlarmOnWarning: { type: 'bool', default: false },

  // เก็บข้อมูล
  snapshotRetentionDays: { type: 'int', default: 7, min: 1, max: 90, env: 'SNAPSHOT_RETENTION_DAYS' },
  historyDays: { type: 'int', default: 30, min: 1, max: 365 },
};

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Coerce one value to the setting's type. Returns { value } or { error }. */
export function coerceSetting(key, raw) {
  const spec = SETTINGS[key];
  if (!spec) return { error: `ไม่รู้จักค่า ${key}` };
  if ((raw === null || raw === '' || raw === undefined) && spec.nullable) return { value: null };
  switch (spec.type) {
    case 'bool':
      return { value: parseBool(raw) };
    case 'int':
    case 'float': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `${key} ต้องเป็นตัวเลข` };
      const v = spec.type === 'int' ? Math.round(n) : n;
      if (v < spec.min || v > spec.max) return { error: `${key} ต้องอยู่ระหว่าง ${spec.min}–${spec.max}` };
      return { value: v };
    }
    case 'enum':
      if (!spec.options.includes(raw)) return { error: `${key} ต้องเป็น ${spec.options.join(' / ')}` };
      return { value: raw };
    case 'timezone':
      if (!isValidTimeZone(raw)) return { error: `ไม่รู้จักเขตเวลา ${raw}` };
      return { value: String(raw) };
    case 'json': {
      const s = String(raw ?? '').trim();
      if (s.length > spec.max) return { error: `${key} ยาวเกิน ${spec.max} ตัวอักษร` };
      try {
        JSON.parse(s);
      } catch {
        return { error: `${key} ต้องเป็น JSON ที่ถูกต้อง เช่น {"alarm":true}` };
      }
      return { value: s };
    }
    default: {
      const s = String(raw ?? '').trim();
      if (s.length > spec.max) return { error: `${key} ยาวเกิน ${spec.max} ตัวอักษร` };
      return { value: s };
    }
  }
}

export function defaultSettings() {
  return Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, s.default]));
}

/** Settings seeded from .env (only keys that are set and valid). */
export function settingsFromEnv(env = process.env) {
  const out = {};
  for (const [key, spec] of Object.entries(SETTINGS)) {
    if (!spec.env || env[spec.env] === undefined || env[spec.env] === '') continue;
    const r = coerceSetting(key, env[spec.env]);
    if (!r.error) out[key] = r.value;
  }
  return out;
}

export function resolveSettings(stored = {}, env = process.env) {
  const merged = { ...defaultSettings(), ...settingsFromEnv(env) };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in SETTINGS)) continue;
    const r = coerceSetting(key, value);
    if (!r.error) merged[key] = r.value;
  }
  return merged;
}

/** Validate a partial update from the dashboard. */
export function sanitizeSettingsPatch(patch) {
  const values = {};
  const errors = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    const r = coerceSetting(key, raw);
    if (r.error) errors.push(r.error);
    else values[key] = r.value;
  }
  return { values, errors };
}

/** Cameras come from CAMERA_1_NAME / CAMERA_1_URL … CAMERA_12_*. */
export function camerasFromEnv(env = process.env) {
  const cams = [];
  for (let i = 1; i <= 12; i++) {
    const url = (env[`CAMERA_${i}_URL`] || '').trim();
    if (!url) continue;
    const name = (env[`CAMERA_${i}_NAME`] || '').trim() || `กล้อง ${i}`;
    cams.push({ id: `cam${i}`, name, url });
  }
  return cams;
}

/**
 * `--image cam1=/path/a.jpg` (repeatable) swaps a camera's source for a picture or
 * folder — handy for trying the AI on real photos before a camera is wired up.
 */
export function camerasWithImages(cameras, specs) {
  const out = cameras.map((c) => ({ ...c }));
  for (const spec of specs) {
    const i = spec.indexOf('=');
    const id = i > 0 ? spec.slice(0, i).trim() : '';
    const file = i > 0 ? spec.slice(i + 1).trim() : '';
    if (!/^[\w-]{1,32}$/.test(id) || !file) throw new Error(`--image ต้องเป็นรูปแบบ กล้อง=ไฟล์ เช่น cam1=/path/a.jpg (ได้ "${spec}")`);
    const cam = out.find((c) => c.id === id);
    if (cam) cam.url = file;
    else out.push({ id, name: id, url: file });
  }
  return out;
}

function argValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined) values.push(argv[++i]);
  return values;
}

export const DEMO_CAMERAS = [
  { id: 'cam1', name: 'หน้าบ้าน', url: 'demo:street' },
  { id: 'cam2', name: 'โรงรถ', url: 'demo:carport' },
];

/** Load everything the process needs at start-up. */
export function loadConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const demo = argv.includes('--demo') || parseBool(env.DEMO);
  const root = process.cwd();
  const dataDir = path.resolve(root, env.DATA_DIR || (demo ? 'data-demo' : 'data'));
  const engine = demo ? 'demo' : (env.AI_ENGINE || 'anthropic').toLowerCase();

  const secrets = {
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    openaiKey: env.OPENAI_API_KEY || '',
    claudeOauth: env.CLAUDE_CODE_OAUTH_TOKEN || '',
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    lineToken: env.LINE_CHANNEL_ACCESS_TOKEN || '',
    mqttUrl: env.MQTT_URL || '',
    mqttUsername: env.MQTT_USERNAME || '',
    mqttPassword: env.MQTT_PASSWORD || '',
    webhookUrl: env.WEBHOOK_URL || '',
    sirenOnUrl: env.SIREN_WEBHOOK_ON_URL || '',
    sirenOffUrl: env.SIREN_WEBHOOK_OFF_URL || '',
    pushoverToken: env.PUSHOVER_TOKEN || '',
    pushoverUser: env.PUSHOVER_USER || '',
    dashboardPassword: env.DASHBOARD_PASSWORD || (demo ? 'demo' : ''),
    dashboardSecret: env.DASHBOARD_SECRET || '',
  };
  for (const value of Object.values(secrets)) addSecret(value);

  const images = argValues(argv, '--image');
  let cameras = demo ? DEMO_CAMERAS : camerasFromEnv(env);
  if (images.length) cameras = camerasWithImages(cameras, images);
  for (const cam of cameras) {
    try {
      const u = new URL(cam.url);
      if (u.password) addSecret(decodeURIComponent(u.password));
    } catch {
      /* file paths are not URLs */
    }
  }

  return {
    demo,
    dryRun: argv.includes('--dry-run'),
    engine,
    dataDir,
    port: Number(env.PORT) || 8080,
    host: env.HOST || '0.0.0.0',
    ffmpegPath: resolveFfmpeg({ env }),
    // curl = fetch snapshot links with macOS /usr/bin/curl (for a launchd service blocked from the LAN)
    httpTool: String(env.HTTP_TOOL || '').toLowerCase() === 'curl' ? 'curl' : 'fetch',
    // Cloudflare Access in front (team domain + application AUD tag): its signed login replaces the password
    cfAccess: { teamDomain: env.CF_ACCESS_TEAM_DOMAIN || '', aud: env.CF_ACCESS_AUD || '' },
    claudeBin: env.CLAUDE_BIN || 'claude',
    // `cameras` is the live list (env + cameras added in the UI); `baseCameras` is the .env part it is rebuilt from.
    baseCameras: cameras.slice(),
    cameras,
    secrets,
  };
}

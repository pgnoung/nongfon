// Dashboard web server: pages, JSON API and a live event stream. Plain node:http.

import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Auth, sessionSecret } from './auth.js';
import { SETTINGS, sanitizeSettingsPatch } from '../config.js';
import { effectiveModel, ENGINES } from '../ai/index.js';
import { createAccessVerifier } from './cfaccess.js';
import { frameMetrics } from '../camera/image.js';
import { captureCamera } from '../camera/capture.js';
import { applyCameras } from '../camera/registry.js';
import { brandFromPorts, brandOptions, discover, lanHosts, onvifPortsFor, resolveOnvif, sweepHosts, templateUrls, withCredentials as withCreds } from '../camera/onvif.js';
import { assertLanHost } from '../net/lan.js';
import { postWebhook } from '../notify/webhook.js';
import { dailyStats } from '../alerts.js';
import { clamp, dayKey, fileStamp } from '../util.js';
import { addSecret, logger } from '../log.js';

const log = logger('web');
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const SAFE_NAME = /^[\w.-]+\.jpg$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp',
};
const PAGES = {
  '/': { file: 'overview', title: 'หน้าหลัก' },
  '/cameras': { file: 'cameras', title: 'ดูกล้อง' },
  '/history': { file: 'history', title: 'ย้อนหลัง' },
  '/lines': { file: 'lines', title: 'ขีดเส้นเตือน' },
  '/settings': { file: 'settings', title: 'ตั้งค่า' },
  '/bedside': { file: 'bedside', title: 'โหมดข้างเตียง' },
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  // the rain map loads OpenStreetMap tiles and RainViewer radar in the browser; nothing else leaves the house
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org https://tilecache.rainviewer.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.rainviewer.com; font-src 'self'; media-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// ------------------------------------------------------------------ live events
export function createHub() {
  const clients = new Set();
  return {
    clients,
    broadcast(event, data = {}) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) res.write(msg);
    },
    add(req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
    },
  };
}

// ------------------------------------------------------------------ helpers
function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}
const json = (res, status, obj, extra = {}) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('ข้อมูลใหญ่เกินไป'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON ไม่ถูกต้อง'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

/** Sort key for an IPv4 string (unknown → last). */
function ipOrder(host) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host || '');
  return m ? ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0 : 2 ** 32;
}

export function maskUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '****';
    for (const key of [...u.searchParams.keys()]) {
      if (/pass|pwd|token|secret|key|auth|sig/i.test(key)) u.searchParams.set(key, '****');
    }
    return decodeURI(u.toString());
  } catch {
    return raw;
  }
}

function sourceKind(url) {
  if (url.startsWith('demo:')) return 'demo';
  if (/^rtsps?:/i.test(url)) return 'rtsp';
  if (/^https?:/i.test(url)) return 'http';
  if (url.startsWith('ffmpeg:')) return 'ffmpeg';
  return 'file';
}

export function cleanLine(points) {
  if (!Array.isArray(points)) return [];
  const pts = points
    .slice(0, 40)
    .filter((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)))
    .map(([x, y]) => [Math.round(clamp(x, 0, 1) * 1e4) / 1e4, Math.round(clamp(y, 0, 1) * 1e4) / 1e4]);
  return pts.length >= 2 ? pts : [];
}

function downsample(points, max = 480) {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / max);
  const out = [];
  for (let i = 0; i < points.length; i += size) {
    const bucket = points.slice(i, i + size);
    // keep the highest level in each bucket so peaks survive
    out.push(bucket.reduce((a, b) => ((b.l ?? -1) > (a.l ?? -1) ? b : a)));
  }
  return out;
}

/** Short hash of the long-cached files' sizes and times: changes whenever one of them changes. */
function assetStamp() {
  const h = crypto.createHash('sha1');
  for (const rel of ['img/icons.svg', 'img/favicon.svg', 'img/fon/manifest.json']) {
    try {
      const st = fs.statSync(path.join(PUBLIC_DIR, rel));
      h.update(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      /* missing file: nothing to version */
    }
  }
  return h.digest('hex').slice(0, 10);
}

// ------------------------------------------------------------------ server
export function createWebServer(app) {
  const { config, store, watcher, siren, notifier, weather, rain, bot, hub, live, engineProblem } = app;
  const auth = new Auth({ password: config.secrets.dashboardPassword, secret: sessionSecret(config) });
  // Cloudflare Access (family email login) in front: a valid Access assertion stands in for the password
  const access = app.accessVerifier ?? createAccessVerifier(config.cfAccess || {});
  const accessSeen = new Map(); // email → last time it was logged
  const viaAccess = async (req) => {
    const token = access && req.headers['cf-access-jwt-assertion'];
    const claims = token ? await access.verify(String(token)).catch(() => null) : null;
    const who = claims?.email || claims?.sub || '';
    if (who && Date.now() - (accessSeen.get(who) || 0) > 3600e3) {
      accessSeen.set(who, Date.now());
      log.info(`เปิดหน้าเว็บผ่าน Cloudflare Access: ${who}`);
    }
    return claims;
  };
  const safeNext = (value) => (value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/');
  const layout = () => fs.readFileSync(path.join(PUBLIC_DIR, 'layout.html'), 'utf8');

  // Long-cached assets (the icon sprite) carry a version, so an update never shows stale icons.
  const assetVersion = assetStamp();
  function renderPage(file, title, name) {
    const content = fs.readFileSync(path.join(PUBLIC_DIR, 'pages', `${file}.html`), 'utf8');
    return layout()
      .replaceAll('{{title}}', title)
      .replaceAll('{{page}}', name)
      .replace('{{content}}', content)
      .replaceAll('{{demo}}', config.demo ? 'true' : 'false')
      .replaceAll('{{v}}', assetVersion)
      .replaceAll('/static/img/icons.svg#', `/static/img/icons.svg?v=${assetVersion}#`);
  }

  // ---------------------------------------------------------------- data builders
  function cameraList() {
    const latest = store.latestReading();
    return config.cameras.map((c) => {
      const last = latest?.cameras?.find((x) => x.id === c.id) || null;
      return {
        id: c.id, name: c.name, source: sourceKind(c.url), url: maskUrl(c.url),
        meta: store.cameraMeta(c.id),
        last: last ? { ok: last.ok, image: last.image || null, error: last.error || null, ts: latest.ts, night: last.night } : null,
      };
    });
  }

  function health(now) {
    const rows = store.readingsSince(now - 24 * 3600e3);
    const ok = rows.filter((r) => r.status !== 'unknown');
    const ms = rows.map((r) => r.ai?.ms).filter((n) => Number.isFinite(n));
    const conf = ok.map((r) => r.confidence).filter((n) => Number.isFinite(n));
    const cameras = config.cameras.map((c) => {
      const entries = rows.map((r) => r.cameras?.find((x) => x.id === c.id)).filter(Boolean);
      const good = entries.filter((e) => e.ok);
      const lastEntry = entries[entries.length - 1];
      return {
        id: c.id, name: c.name,
        okPct: entries.length ? Math.round((good.length / entries.length) * 100) : null,
        ok: lastEntry ? lastEntry.ok : null,
        error: lastEntry && !lastEntry.ok ? lastEntry.error : null,
      };
    });
    return {
      checks: rows.length,
      okPct: rows.length ? Math.round((ok.length / rows.length) * 100) : null,
      avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
      avgConfidence: conf.length ? Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 100) : null,
      cameras,
      telegram: bot?.health || null,
    };
  }

  function costs(now) {
    const tz = store.settings.timezone;
    const days = {};
    for (const r of store.readingsSince(now - 8 * 86400e3)) {
      if (typeof r.ai?.costUsd !== 'number') continue;
      const k = dayKey(new Date(r.ts), tz);
      days[k] = (days[k] || 0) + r.ai.costUsd;
    }
    const s24 = dailyStats(store, now);
    const byDay = Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-7).map(([day, usd]) => ({ day, usd: Math.round(usd * 1e4) / 1e4 }));
    return {
      today: Math.round((days[dayKey(new Date(now), tz)] || 0) * 1e4) / 1e4,
      last24h: s24.costUsd === null ? null : Math.round(s24.costUsd * 1e4) / 1e4,
      projected30d: s24.costUsd === null ? null : Math.round(s24.costUsd * 30 * 100) / 100,
      perCheck: s24.checks && s24.costUsd !== null ? Math.round((s24.costUsd / s24.checks) * 1e5) / 1e5 : null,
      subscription: s24.subscription,
      simulated: store.latestReading()?.ai?.simulated || false,
      byDay,
    };
  }

  function setupChecklist() {
    const s = store.settings;
    const ch = notifier.channels();
    const cams = config.cameras;
    const redLines = cams.some((c) => store.cameraMeta(c.id).lines.critical.length >= 2);
    const anyLines = cams.some((c) => { const l = store.cameraMeta(c.id).lines; return l.critical.length >= 2 || l.warning.length >= 2; });
    const out = siren.outputs();
    return [
      { key: 'cameras', done: cams.length > 0, title: 'ต่อกล้อง', hint: 'ใส่ CAMERA_1_NAME / CAMERA_1_URL ในไฟล์ .env' },
      { key: 'ai', done: !engineProblem(), title: 'เชื่อม AI', hint: engineProblem() || 'พร้อมแล้ว' },
      { key: 'lines', done: redLines, title: 'ขีดเส้นแดง', hint: anyLines ? 'มีเส้นเหลืองแล้ว แนะนำให้ขีดเส้นแดงจุดที่อันตรายด้วย' : 'ไปที่หน้า “ขีดเส้น” แล้ววาดเส้นเหลือง/แดงบนภาพจริง' },
      { key: 'notify', done: ch.telegram || ch.line || ch.webhook, title: 'ช่องทางแจ้งเตือน', hint: 'Telegram หรือ LINE อย่างน้อย 1 ช่องทาง' },
      { key: 'site', done: (s.siteDescription || '').trim().length >= 20, title: 'เล่าเรื่องบ้านให้ AI ฟัง', hint: 'บอกว่ากล้องไหนเห็นอะไร น้ำมักมาทางไหน' },
      { key: 'siren', done: (out.mqtt || out.webhook) && s.sirenEnabled, optional: true, title: 'ไซเรนปลุก (ไม่บังคับ)', hint: 'MQTT/Zigbee, webhook หรือเปิดโหมดข้างเตียงบนมือถือ/แท็บเล็ต' },
    ];
  }

  function statusPayload() {
    const now = Date.now();
    const latest = store.latestReading();
    const st = store.state;
    return {
      now,
      site: { name: store.settings.siteName, timezone: store.settings.timezone, latitude: store.settings.latitude, longitude: store.settings.longitude },
      demo: config.demo,
      engine: { id: config.engine, label: ENGINES[config.engine] || config.engine, model: effectiveModel(config, store.settings.aiModel), problem: engineProblem() },
      latest,
      lastStatus: st.lastStatus || null,
      pending: st.pendingCritical || null,
      unknownStreak: st.unknownStreak || 0,
      next: { at: watcher.nextAt, running: Boolean(watcher.current), paused: store.settings.paused, intervalMin: watcher.intervalMinutes() },
      siren: siren.status(),
      health: health(now),
      cost: costs(now),
      weather: weather.get(),
      hourly: store.state.hourlySummary || null,
      channels: notifier.channels(),
      setup: setupChecklist(),
      alerts: store.recentEvents(40).filter((e) => e.kind !== 'hourly').slice(0, 8), // hourly roll-ups have their own card
      settings: {
        warnLevel: store.settings.warnLevel, criticalLevel: store.settings.criticalLevel,
        browserAlarm: store.settings.browserAlarm, browserAlarmOnWarning: store.settings.browserAlarmOnWarning,
      },
    };
  }

  // ---------------------------------------------------------------- API routes
  const api = {
    'GET /api/status': () => statusPayload(),

    'GET /api/series': (req, url) => {
      const hours = clamp(Number(url.searchParams.get('hours')) || 24, 1, 24 * 30);
      const since = Date.now() - hours * 3600e3;
      const cams = config.cameras.map((c) => ({ id: c.id, name: c.name }));
      const points = store.readingsSince(since).map((r) => ({
        t: r.ts,
        l: r.status === 'unknown' ? null : r.level,
        s: r.status,
        r: typeof r.rain?.nowMm === 'number' ? r.rain.nowMm : null,
        c: cams.map((cam) => r.cameras?.find((x) => x.id === cam.id)?.coverage ?? null),
      }));
      return { hours, cameras: cams, points: downsample(points), warnLevel: store.settings.warnLevel, criticalLevel: store.settings.criticalLevel };
    },

    'GET /api/quality': (req, url) => {
      const hours = clamp(Number(url.searchParams.get('hours')) || 24, 1, 24 * 30);
      const cams = config.cameras.map((c) => ({ id: c.id, name: c.name }));
      const points = store.readingsSince(Date.now() - hours * 3600e3).map((r) => ({
        t: r.ts,
        q: cams.map((cam) => {
          const m = r.cameras?.find((x) => x.id === cam.id);
          return m?.ok && m.metrics ? { b: m.metrics.brightness, s: m.metrics.sharpness, n: Boolean(m.night) } : null;
        }),
      }));
      return { hours, cameras: cams, points: points.length > 480 ? points.filter((_, i) => i % Math.ceil(points.length / 480) === 0) : points };
    },

    'GET /api/readings': (req, url) => {
      const before = Number(url.searchParams.get('before')) || Infinity;
      const limit = clamp(Number(url.searchParams.get('limit')) || 36, 1, 200);
      const status = url.searchParams.get('status');
      const out = [];
      for (let i = store.readings.length - 1; i >= 0 && out.length < limit; i--) {
        const r = store.readings[i];
        if (r.ts >= before) continue;
        if (status && status !== 'all' && r.status !== status) continue;
        out.push(r);
      }
      return { readings: out, more: out.length === limit };
    },

    'GET /api/live': () => (live ? live.stats() : { streams: [] }),

    // rain forecast grid for the map (cached 30 min per radius; errors carry .status: 400/409/502/504)
    'GET /api/rain-forecast': (req, url) => (rain ? rain.grid(url.searchParams.get('radius') || 25) : [404, { ok: false, error: 'ยังไม่ได้เปิดใช้แผนที่ฝน' }]),

    'GET /api/alerts': (req, url) => ({ alerts: store.recentEvents(clamp(Number(url.searchParams.get('limit')) || 100, 1, 500)) }),

    'GET /api/cameras': () => ({ cameras: cameraList() }),

    'GET /api/settings': () => ({
      values: store.settings,
      schema: Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, { type: v.type, min: v.min, max: v.max, options: v.options, nullable: Boolean(v.nullable) }])),
      secrets: Object.fromEntries(Object.entries(config.secrets).map(([k, v]) => [k, Boolean(v)])),
      engine: { id: config.engine, label: ENGINES[config.engine], model: effectiveModel(config, store.settings.aiModel), problem: engineProblem() },
      cameras: cameraList().map(({ id, name, source, url }) => ({ id, name, source, url })),
      telegram: { candidates: store.state.telegramCandidates || [], health: bot?.health || null },
      demo: config.demo,
    }),

    'POST /api/settings': async (req) => {
      const body = await readBody(req);
      const { values, errors } = sanitizeSettingsPatch(body);
      if (errors.length) return [400, { ok: false, errors }];
      if ('warnLevel' in values || 'criticalLevel' in values) {
        const w = values.warnLevel ?? store.settings.warnLevel;
        const c = values.criticalLevel ?? store.settings.criticalLevel;
        if (w >= c) return [400, { ok: false, errors: ['เกณฑ์เตือนต้องต่ำกว่าเกณฑ์อันตราย'] }];
      }
      store.updateSettings(values);
      if ('latitude' in values || 'longitude' in values) weather.refresh(true).catch(() => {});
      if ('paused' in values) notifier.record('system', values.paused ? 'หยุดตรวจชั่วคราว' : 'กลับมาตรวจตามปกติ');
      hub.broadcast('status', {});
      return { ok: true, values: store.settings };
    },

    'POST /api/run': () => {
      if (!config.cameras.length) return [400, { ok: false, error: 'ยังไม่มีกล้อง — ต่อกล้องในหน้าตั้งค่าก่อน' }];
      watcher.runNow('manual').catch((err) => log.error(err));
      return { ok: true };
    },

    // ---- camera finder: find cameras on the LAN, work out each one's link, add it live ----
    'POST /api/cameras/discover': async () => {
      // ONVIF WS-Discovery and a quick knock on camera ports across the home /24, side by side
      const [found, knocked] = await Promise.all([
        discover({ timeoutMs: 4500 }).catch(() => []),
        sweepHosts(lanHosts()).catch(() => []),
      ]);
      const byHost = new Map();
      for (const c of found) {
        if (c.host) byHost.set(c.host, { host: c.host, port: c.port, name: c.name || '', brand: c.brand || '', note: '', via: 'onvif' });
      }
      for (const k of knocked) {
        const hint = brandFromPorts(k.open);
        if (!hint) continue;
        const cam = byHost.get(k.host);
        if (cam) {
          if (!cam.brand) cam.brand = hint.brand;
          if (hint.note) cam.note = hint.note;
        } else {
          byHost.set(k.host, { host: k.host, port: hint.port, name: '', brand: hint.brand, note: hint.note, via: 'ports' });
        }
      }
      const known = new Set(config.cameras.map((c) => { try { return new URL(c.url.replace(/^ffmpeg:/, '')).hostname; } catch { return ''; } }));
      const cameras = [...byHost.values()]
        .sort((a, b) => (ipOrder(a.host) - ipOrder(b.host)))
        .map((c) => ({ ...c, brand: c.brand || 'generic', brands: brandOptions(c.brand || 'generic'), connected: known.has(c.host) }));
      return { ok: true, cameras };
    },
    'POST /api/cameras/probe': async (req) => cameraFinder.probe(await readBody(req)),
    'POST /api/cameras/add': async (req) => cameraFinder.add(await readBody(req)),
    'POST /api/cameras/remove': async (req) => cameraFinder.remove(await readBody(req)),

    'POST /api/siren/stop': async () => siren.stop('user'),
    'POST /api/siren/test': async () => siren.sound({ reason: 'ทดสอบไซเรน', seconds: 3, test: true }),
    'POST /api/siren/snooze': async (req) => {
      const body = await readBody(req);
      return siren.snooze(clamp(Number(body.minutes) || 60, 5, 720), 'user');
    },
    'POST /api/siren/mute': async () => siren.muteUntilDrop('user'),
    'POST /api/siren/unsnooze': () => siren.unsnooze('user'),

    'POST /api/test/telegram': async () => {
      const chatId = store.settings.telegramChatId;
      if (!notifier.telegram) return [400, { ok: false, error: 'ยังไม่ได้ใส่ TELEGRAM_BOT_TOKEN ใน .env' }];
      if (!chatId) return [400, { ok: false, error: 'ยังไม่ได้เลือกแชท — ทักบอทแล้วกด “ใช้แชทนี้”' }];
      const sent = await notifier.telegram.sendMessage(chatId, '🧪 ทดสอบจาก <b>น้องฝนเฝ้าบ้าน</b> ☔ ถ้าเห็นข้อความนี้ แปลว่าพร้อมปลุกแล้วค่ะ');
      return { ok: true, messageId: sent?.message_id ?? null, chat: sent?.chat?.title || null };
    },
    'POST /api/test/line': async () => {
      if (!notifier.line) return [400, { ok: false, error: 'ยังไม่ได้ใส่ LINE_CHANNEL_ACCESS_TOKEN ใน .env' }];
      if (!store.settings.lineTo) return [400, { ok: false, error: 'ยังไม่ได้ใส่ผู้รับ (User ID หรือ broadcast)' }];
      await notifier.line.send(store.settings.lineTo, '🧪 ทดสอบจากน้องฝนเฝ้าบ้าน ☔ ถ้าเห็นข้อความนี้ แปลว่าพร้อมแจ้งเตือนแล้วค่ะ');
      return { ok: true };
    },
    'POST /api/test/webhook': async () => {
      if (!config.secrets.webhookUrl) return [400, { ok: false, error: 'ยังไม่ได้ใส่ WEBHOOK_URL ใน .env' }];
      await postWebhook(config.secrets.webhookUrl, { event: 'test', title: 'ทดสอบ webhook', text: 'ทดสอบจากน้องฝนเฝ้าบ้าน', site: store.settings.siteName, time: new Date().toISOString() });
      return { ok: true };
    },

    'POST /api/telegram/bind': async (req) => {
      const { chatId } = await readBody(req);
      const known = (store.state.telegramCandidates || []).find((c) => String(c.id) === String(chatId));
      if (!known) return [400, { ok: false, error: 'ไม่พบแชทนี้ — ทักบอทอีกครั้งแล้วรีเฟรชหน้า' }];
      store.updateSettings({ telegramChatId: String(known.id), telegramEnabled: true });
      store.patchState({ telegramCandidates: (store.state.telegramCandidates || []).filter((c) => String(c.id) !== String(chatId)) });
      await notifier.telegram?.sendMessage(known.id, '✅ เชื่อมแชทนี้กับ <b>น้องฝนเฝ้าบ้าน</b> แล้วค่ะ ส่ง /help เพื่อดูคำสั่ง').catch(() => {});
      return { ok: true, chatId: String(known.id) };
    },
  };

  // ---- camera finder ------------------------------------------------------
  // Try each candidate link by actually pulling one frame; the first that works is the answer.
  async function firstWorkingUrl(candidates) {
    const tried = [];
    for (const cand of candidates) {
      try {
        const shot = await captureCamera({ id: 'probe', name: 'probe', url: cand.url }, { ffmpegPath: config.ffmpegPath, maxEdge: 1280, attempts: 1, timeoutMs: 12000 });
        const preview = await sharp(shot.buffer).resize({ width: 480 }).jpeg({ quality: 70 }).toBuffer();
        return { ok: true, cand, width: shot.width, height: shot.height, sample: `data:image/jpeg;base64,${preview.toString('base64')}`, tried };
      } catch (err) {
        tried.push({ label: cand.label, url: maskUrl(cand.url), error: err.message });
      }
    }
    return { ok: false, tried };
  }

  const cameraFinder = {
    // Log in to one camera and return the link that pulls a picture, plus a sample frame. Saves nothing.
    async probe(body) {
      const host = String(body.host || '').trim();
      assertLanHost(host);
      const username = String(body.username || '').trim();
      const password = String(body.password ?? '');
      const port = clamp(Number(body.port) || 80, 1, 65535);
      const brand = String(body.brand || 'generic');
      const channel = clamp(Number(body.channel) || 1, 1, 32);
      if (password) addSecret(password);

      const candidates = [];
      let deviceInfo = null;
      let onvifError = null;
      // ONVIF on the given port, then the brand's usual one (Tapo 2020, Foscam 888), then 80
      for (const p of onvifPortsFor(brand, port)) {
        try {
          const resolved = await resolveOnvif({ host, port: p, username, password });
          deviceInfo = resolved.deviceInfo;
          for (const c of resolved.candidates) {
            if (c.streamUri) candidates.push({ label: `ONVIF ภาพ ${c.width ? `${c.width}×${c.height}` : ''}`.trim(), url: withCreds(c.streamUri, username, password), kind: 'rtsp' });
            if (c.snapshotUri) candidates.push({ label: 'ONVIF ภาพนิ่ง', url: withCreds(c.snapshotUri, username, password), kind: 'http' });
          }
          onvifError = null;
          break;
        } catch (err) {
          onvifError = err.message;
          if (err.code === 'auth') break; // the camera answered and refused the login: another port will not help
        }
      }
      // brand templates as a fallback (and as extra options if ONVIF gave nothing that worked)
      for (const t of templateUrls({ brand, host, username, password, channel })) candidates.push(t);

      const seen = new Set();
      const unique = candidates.filter((c) => !seen.has(c.url) && seen.add(c.url));
      const result = await firstWorkingUrl(unique);
      if (!result.ok) {
        return { ok: false, error: onvifError || 'ยังต่อกล้องไม่ได้ — ตรวจชื่อผู้ใช้/รหัสผ่าน หรือเลือกยี่ห้อให้ตรง', deviceInfo, tried: result.tried };
      }
      const snap = unique.find((c) => c.kind === 'http' && c.url !== result.cand.url);
      return {
        ok: true,
        url: result.cand.url,
        urlMasked: maskUrl(result.cand.url),
        snapshotUrl: snap ? snap.url : '',
        kind: result.cand.kind,
        width: result.width,
        height: result.height,
        sample: result.sample,
        deviceInfo,
      };
    },

    // Save a verified camera and make it live now (no restart).
    async add(body) {
      const url = String(body.url || '').trim();
      if (!/^(rtsps?|https?):\/\//i.test(url) && !url.startsWith('ffmpeg:')) return [400, { ok: false, error: 'ลิงก์ต้องเป็น rtsp:// หรือ http://' }];
      try {
        const u = new URL(url.replace(/^ffmpeg:/, ''));
        assertLanHost(u.hostname);
        if (u.password) addSecret(decodeURIComponent(u.password));
      } catch (err) {
        if (err.status) return [400, { ok: false, error: err.message }];
      }
      const snapshotUrl = String(body.snapshotUrl || '').trim();
      const check = await firstWorkingUrl([{ label: 'ตรวจก่อนบันทึก', url }]);
      if (!check.ok) return [400, { ok: false, error: `ลิงก์นี้ยังดึงภาพไม่ได้: ${check.tried[0]?.error || ''}` }];
      const camera = store.addUserCamera({ name: body.name, url, snapshotUrl });
      reloadCameras();
      notifier.record('system', `เพิ่มกล้อง ${camera.name}`, `ต่อกล้องใหม่ผ่านหน้าตั้งค่า (${maskUrl(url)})`);
      return { ok: true, camera: { id: camera.id, name: camera.name, url: maskUrl(url) }, cameras: cameraList() };
    },

    remove(body) {
      const id = String(body.id || '');
      if (!/^u\d+$/.test(id)) return [400, { ok: false, error: 'ลบได้เฉพาะกล้องที่เพิ่มในหน้านี้ (กล้องใน .env ให้แก้ไฟล์)' }];
      if (!store.removeUserCamera(id)) return [404, { ok: false, error: 'ไม่พบกล้องนี้' }];
      reloadCameras();
      return { ok: true, cameras: cameraList() };
    },
  };

  function reloadCameras() {
    applyCameras(config, store);
    live?.stopAll?.(); // a removed camera's live source must not linger
    watcher.runNow('manual').catch(() => {});
  }

  // routes with a camera id
  async function cameraRoute(method, id, action, req) {
    const cam = config.cameras.find((c) => c.id === id);
    if (!cam) return [404, { ok: false, error: 'ไม่พบกล้องนี้' }];
    if (method === 'POST' && action === 'lines') {
      const body = await readBody(req);
      const meta = store.setCameraMeta(id, { lines: { safe: cleanLine(body.safe), warning: cleanLine(body.warning), critical: cleanLine(body.critical) } });
      notifier.record('system', `บันทึกเส้นของกล้อง ${cam.name}`, `เขียว ${meta.lines.safe.length} จุด · เหลือง ${meta.lines.warning.length} จุด · แดง ${meta.lines.critical.length} จุด`);
      return { ok: true, meta };
    }
    if (method === 'POST' && action === 'note') {
      const body = await readBody(req);
      return { ok: true, meta: store.setCameraMeta(id, { note: String(body.note || '').slice(0, 300) }) };
    }
    if (method === 'POST' && action === 'snapshot') {
      return { ok: true, ...(await watcher.snapshot(id)) };
    }
    if (method === 'POST' && action === 'reference') {
      const body = await readBody(req);
      const image = String(body.image || '');
      if (!SAFE_NAME.test(image) || !image.includes(`_${id}`)) return [400, { ok: false, error: 'เลือกภาพของกล้องนี้ก่อน' }];
      const src = store.snapshotFile(image);
      let buffer;
      try {
        buffer = await fsp.readFile(src);
      } catch {
        return [404, { ok: false, error: 'ไม่พบไฟล์ภาพ (อาจถูกลบตามรอบเก็บข้อมูลแล้ว)' }];
      }
      let kind = body.kind;
      if (kind !== 'day' && kind !== 'night') kind = (await frameMetrics(buffer)).night ? 'night' : 'day';
      const name = `ref_${id}_${kind}_${fileStamp(new Date(), store.settings.timezone)}.jpg`;
      await fsp.writeFile(store.refFile(name), buffer);
      const old = store.cameraMeta(id).refs[kind];
      const meta = store.setCameraMeta(id, { refs: { [kind]: name } });
      if (old && SAFE_NAME.test(old)) await fsp.unlink(store.refFile(old)).catch(() => {});
      return { ok: true, kind, meta };
    }
    if (method === 'DELETE' && (action === 'reference/day' || action === 'reference/night')) {
      const kind = action.split('/')[1];
      const old = store.cameraMeta(id).refs[kind];
      const meta = store.setCameraMeta(id, { refs: { [kind]: null } });
      if (old && SAFE_NAME.test(old)) await fsp.unlink(store.refFile(old)).catch(() => {});
      return { ok: true, meta };
    }
    return [404, { ok: false, error: 'ไม่พบคำสั่งนี้' }];
  }

  // ---------------------------------------------------------------- static
  async function serveFile(res, file, cache = 'public, max-age=300') {
    try {
      const data = await fsp.readFile(file);
      send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': cache });
    } catch {
      send(res, 404, 'not found');
    }
  }

  // ---------------------------------------------------------------- dispatcher
  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const method = req.method;

    if (p === '/healthz') return json(res, 200, { ok: true, lastCheck: store.latestReading()?.ts || null });

    if (p.startsWith('/static/')) {
      const rel = path.normalize(p.slice('/static/'.length)).replace(/^([.][.][/\\])+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      const template = file.startsWith(path.join(PUBLIC_DIR, 'pages') + path.sep) || file === path.join(PUBLIC_DIR, 'layout.html');
      if (!file.startsWith(PUBLIC_DIR + path.sep) || template) return send(res, 404, 'not found');
      const long = /\.(woff2|png|svg|webp)$/.test(file) ? 'public, max-age=604800' : 'no-cache';
      return serveFile(res, file, long);
    }
    if (p === '/favicon.ico' || p === '/favicon.svg') return serveFile(res, path.join(PUBLIC_DIR, 'img', 'favicon.svg'), 'public, max-age=604800');
    if (p === '/manifest.webmanifest') return serveFile(res, path.join(PUBLIC_DIR, 'manifest.webmanifest'));

    if (!auth.enabled) {
      return send(res, 503, renderPage('setup-password', 'ตั้งรหัสผ่าน', 'login'), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }

    if (p === '/login') {
      if (method === 'GET' && (await viaAccess(req))) {
        res.writeHead(303, { Location: safeNext(url.searchParams.get('next')) });
        return res.end();
      }
      if (method === 'GET') return send(res, 200, renderPage('login', 'เข้าสู่ระบบ', 'login'), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
      if (method === 'POST') {
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'origin ไม่ถูกต้อง' });
        const ip = clientIp(req);
        if (!auth.allowAttempt(ip)) return json(res, 429, { ok: false, error: 'ลองผิดหลายครั้งเกินไป รอ 5 นาทีแล้วลองใหม่' });
        const body = await readBody(req, 4096).catch(() => ({}));
        if (!auth.check(ip, String(body.password || ''))) return json(res, 401, { ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
        return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(auth.issue(), req) });
      }
    }
    if (p === '/logout') {
      // through Access, also end the Access session (otherwise the next visit logs straight back in)
      res.writeHead(303, { Location: (await viaAccess(req)) ? '/cdn-cgi/access/logout' : '/login', 'Set-Cookie': auth.clearCookie() });
      return res.end();
    }

    // check the Access assertion first (when present) so every family visit is logged, then the cookie
    const accessUser = await viaAccess(req);
    if (!accessUser && !auth.isLoggedIn(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { ok: false, error: 'กรุณาเข้าสู่ระบบ' });
      res.writeHead(303, { Location: `/login?next=${encodeURIComponent(p)}` });
      return res.end();
    }

    if (PAGES[p] && method === 'GET') {
      const page = PAGES[p];
      return send(res, 200, renderPage(page.file, page.title, page.file), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }

    const one = p.match(/^\/api\/readings\/([\w-]+)$/);
    if (one && method === 'GET') {
      const reading = store.getReading(one[1]);
      return reading ? json(res, 200, { ok: true, reading }) : json(res, 404, { ok: false, error: 'ไม่พบผลตรวจนี้' });
    }
    const photo = p.match(/^\/api\/readings\/([\w-]+)\/photo\.jpg$/);
    if (photo && method === 'GET') {
      const reading = store.getReading(photo[1]);
      if (!reading) return send(res, 404, 'not found');
      const buf = await watcher.photoForReading(reading).catch(() => null);
      if (!buf) return send(res, 404, 'no picture');
      return send(res, 200, buf, 'image/jpeg', { 'Cache-Control': 'private, max-age=3600' });
    }

    // live view: one shared MJPEG source per camera; frame.jpg is the "snapshot now" / polling fallback
    const camLive = p.match(/^\/api\/cameras\/([\w-]+)\/(live\.mjpeg|frame\.jpg)$/);
    if (camLive && method === 'GET') {
      if (!live) return json(res, 404, { ok: false, error: 'ยังไม่ได้เปิดใช้การดูสด' });
      const [, id, what] = camLive;
      if (what === 'live.mjpeg') {
        const outcome = live.attach(id, req, res);
        if (outcome === 'unknown') return json(res, 404, { ok: false, error: 'ไม่พบกล้องนี้' });
        if (outcome === 'busy') {
          return json(res, 503, { ok: false, error: `ดูสดพร้อมกันได้สูงสุด ${live.maxStreams} กล้อง ปิดกล้องอื่นก่อนแล้วลองใหม่` }, { 'Retry-After': '10' });
        }
        return; // streaming until the viewer leaves
      }
      try {
        return send(res, 200, await live.frame(id), 'image/jpeg', { 'Cache-Control': 'no-store' });
      } catch (err) {
        return json(res, err.code === 'unknown' ? 404 : 502, { ok: false, error: err.message });
      }
    }

    const snap = p.match(/^\/(snap|ref)\/([^/]+)$/);
    if (snap && method === 'GET') {
      if (!SAFE_NAME.test(snap[2])) return send(res, 404, 'not found');
      const file = snap[1] === 'snap' ? store.snapshotFile(snap[2]) : store.refFile(snap[2]);
      return serveFile(res, file, 'private, max-age=86400');
    }

    if (p === '/api/events' && method === 'GET') return hub.add(req, res);

    if (p.startsWith('/api/')) {
      if (method !== 'GET' && !sameOrigin(req)) return json(res, 403, { ok: false, error: 'origin ไม่ถูกต้อง' });
      if (method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) {
        return json(res, 415, { ok: false, error: 'ต้องส่งเป็น JSON' });
      }
      try {
        let result;
        const camMatch = p.match(/^\/api\/cameras\/([\w-]+)\/(lines|note|snapshot|reference(?:\/day|\/night)?)$/);
        if (camMatch) result = await cameraRoute(method, camMatch[1], camMatch[2], req);
        else {
          const fn = api[`${method} ${p}`];
          if (!fn) return json(res, 404, { ok: false, error: 'ไม่พบ API นี้' });
          result = await fn(req, url);
        }
        if (Array.isArray(result)) return json(res, result[0], result[1]);
        return json(res, 200, result);
      } catch (err) {
        const status = err.status || 500;
        if (status === 500) log.warn(`${method} ${p}: ${err.message}`);
        return json(res, status, { ok: false, error: err.message });
      }
    }
    send(res, 404, 'not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(err);
      if (!res.headersSent) send(res, 500, 'server error');
      else res.end();
    });
  });
  return { server, auth };
}

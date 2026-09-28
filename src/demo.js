// Demo mode: a pretend rain storm on two cartoon cameras, plus a pretend AI that
// reads the water against whatever lines are drawn. Lets people try everything
// (dashboard, line editor, alerts, siren) with no camera and no API key.

import { renderDemoFrame, waterEdges, DEMO_LINES } from './camera/demo-scene.js';
import { hourOf, fileStamp, randomId } from './util.js';
import { costUsd } from './ai/result.js';

const CYCLE_MIN = 36; // one storm every 36 minutes

/** Carport-scene water level (0 dry … 100 floor fully covered) over a storm cycle. */
function stormCurve(phase) {
  if (phase < 0.12) return 2;
  if (phase < 0.55) {
    const x = (phase - 0.12) / 0.43;
    return 2 + 93 * (x * x * (3 - 2 * x));
  }
  if (phase < 0.64) return 95;
  const x = (phase - 0.64) / 0.36;
  return 95 * (1 - x) ** 1.6;
}

export class DemoWorld {
  /** origin: when the current storm cycle began (kept in state so restarts continue the same storm). */
  constructor({ timezone = 'Asia/Bangkok', origin = null, start = Date.now(), startPhase = 0.3 } = {}) {
    this.timezone = timezone;
    this.origin = origin ?? start - startPhase * CYCLE_MIN * 60e3;
  }

  phase(t = Date.now()) {
    return (((t - this.origin) / (CYCLE_MIN * 60e3)) % 1 + 1) % 1;
  }

  carportLevel(t) {
    return stormCurve(this.phase(t));
  }

  /** Street water rises earlier than the carport. */
  sceneLevel(scene, t) {
    const c = this.carportLevel(t);
    if (scene === 'carport') return c;
    return c < 3 ? 0 : Math.min(100, c * 1.15 + 8);
  }

  raining(t) {
    const p = this.phase(t);
    return p > 0.08 && p < 0.6;
  }

  /** Pretend rain gauge (mm/h) that follows the storm, for the rain bars on the chart. */
  rainMm(t = Date.now()) {
    if (!this.raining(t)) return 0;
    const p = (this.phase(t) - 0.08) / 0.52;
    return Math.round((4 + 26 * Math.sin(Math.PI * p) ** 2) * 10) / 10;
  }

  night(t) {
    const h = hourOf(new Date(t), this.timezone);
    return h >= 19 || h < 6;
  }

  async frame(camera, t = Date.now()) {
    const scene = camera.url.replace('demo:', '');
    const stamp = fileStamp(new Date(t), this.timezone);
    const timeText = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
    return renderDemoFrame(scene, { level: this.sceneLevel(scene, t), raining: this.raining(t), night: this.night(t), timeText });
  }
}

// ----- pretend AI -------------------------------------------------------------

/** y-range (0-1, top→bottom) that water covers in a demo scene at a scene level. */
export function waterBand(scene, level) {
  const edges = waterEdges(scene, level);
  return edges && [edges[0] / 720, edges[1] / 720];
}

function touches(band, points) {
  if (!band || !points || points.length < 2) return false;
  return points.some(([, y]) => y >= band[0] && y <= band[1]);
}

export function demoLineStatus(scene, level, lines) {
  const hasY = (lines.warning || []).length >= 2;
  const hasR = (lines.critical || []).length >= 2;
  if (!hasY && !hasR) return 'no_lines';
  const band = waterBand(scene, level);
  if (hasR && touches(band, lines.critical)) return 'at_red';
  if (hasY && touches(band, lines.warning)) return 'at_yellow';
  return 'below_yellow';
}

function demoNote(scene, level, status) {
  if (level <= 2) return 'พื้นแห้ง ไม่มีน้ำขัง';
  if (status === 'at_red') return 'ขอบน้ำถึงเส้นแดงแล้ว น้ำนิ่งเป็นแผ่นเดียวกัน';
  if (status === 'at_yellow') return scene === 'street' ? 'ขอบน้ำถึงเส้นเหลืองที่ประตูรั้วแล้ว' : 'ขอบน้ำเลยเส้นเหลืองเข้ามา ยังไม่ถึงเส้นแดง';
  if (scene === 'street') {
    if (level < 20) return 'ถนนเปียก มีน้ำขังเป็นแอ่งริมถนน';
    if (level < 35) return 'น้ำท่วมผิวถนนบางส่วน ยังห่างประตูรั้ว';
    return 'น้ำท่วมถนนเต็มแนว ขอบน้ำเข้าใกล้ประตูรั้ว';
  }
  return level < 20 ? 'มีน้ำซึมเข้ามาใต้ประตูเล็กน้อย' : 'น้ำไหลเข้ามาจากประตู ยังไม่ถึงเส้นเหลือง';
}

/** Share of visible ground under water in a demo scene. */
export function demoCoverage(scene, level) {
  if (level <= 2) return 0;
  const share = scene === 'street' ? Math.min(100, level * 1.6) : Math.min(100, level * 0.9);
  return Math.round(share);
}

function demoDistance(level) {
  if (level >= 100) return 'ถึงเส้นแดงแล้ว';
  if (level <= 0) return 'ห่างเส้นแดงมาก พื้นแห้ง';
  return `ต่ำกว่าเส้นแดงราว ${Math.max(5, Math.round((100 - level) * 0.6))} ซม.`;
}

/** Property level on the 0 (dry) · 50 (yellow) · 100 (red) scale, from the carport truth. */
export function propertyLevel(carport) {
  if (carport <= 2) return 0;
  return Math.round(Math.min(100, carport <= 50 ? carport : 50 + (carport - 50) * 1.25));
}

function headlineFor(level, statuses) {
  if (statuses.includes('at_red')) return 'น้ำถึงเส้นแดงในโรงรถแล้ว';
  if (statuses.includes('at_yellow')) return 'น้ำถึงเส้นเหลืองแล้ว ยังไม่ถึงเส้นแดง';
  if (level <= 0) return 'บ้านแห้งสนิท ไม่มีน้ำขัง';
  if (level < 25) return 'มีน้ำขังบนถนนเล็กน้อย ยังห่างเส้นเหลือง';
  return 'น้ำท่วมถนนหน้าบ้าน แต่ยังไม่ถึงเส้นเหลือง';
}

export function createDemoEngine({ world, lineLookup }) {
  async function analyze(req) {
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 700));
    const t = req.capturedAt || Date.now();
    const cameras = {};
    const statuses = [];
    for (const id of req.expectedIds) {
      const cam = req.cameraById[id];
      const scene = cam.url.replace('demo:', '');
      const level = world.sceneLevel(scene, t);
      const lineStatus = demoLineStatus(scene, level, lineLookup(id));
      statuses.push(lineStatus);
      cameras[id] = {
        lineStatus,
        water: level <= 2 ? 'dry' : level < 15 ? 'puddles' : 'flooded',
        coverage: demoCoverage(scene, level),
        note: demoNote(scene, level, lineStatus),
      };
    }
    const level = propertyLevel(world.carportLevel(t));
    const usage = { input: 1450, output: 420, cacheRead: 2280, cacheWrite5m: 0, cacheWrite1h: 0 };
    return {
      ok: true,
      level,
      aiStatus: statuses.includes('at_red') ? 'critical' : statuses.includes('at_yellow') || level >= 50 ? 'warning' : 'normal',
      distance: demoDistance(level),
      confidence: world.night(t) ? 0.74 : 0.9,
      headline: headlineFor(level, statuses),
      cameras,
      engine: 'demo',
      model: req.model,
      ms: Date.now() - started,
      usage,
      costUsd: costUsd(req.model, usage),
      simulated: true,
    };
  }
  return { name: 'demo', analyze };
}

// ----- make the dashboard look lived-in on first start --------------------------

/** 24 h of past readings (pictures for the last few hours) so charts are not empty. */
export async function demoBackfill({ store, cameras, settings, now = Date.now(), hours = 24 }) {
  if (store.readings.length) return 0;
  const step = 10 * 60e3;
  const world = new DemoWorld({ timezone: settings.timezone });
  const withPictures = now - 3 * 3600e3;
  const past = (t) => {
    // a storm last night that peaked around 9 h ago, then a new rise starting now
    const h = (now - t) / 3600e3;
    const bump = 64 * Math.exp(-(((h - 9) / 3.2) ** 2));
    const tail = h < 1.2 ? 18 * (1 - h / 1.2) : 0;
    return Math.max(0, bump + tail + (Math.sin(t / 7e5) + 1) * 1.5);
  };
  let n = 0;
  for (let t = now - hours * 3600e3; t < now - step / 2; t += step) {
    const carport = past(t);
    const level = propertyLevel(carport);
    const readingCams = [];
    for (const cam of cameras) {
      const scene = cam.url.replace('demo:', '');
      const sceneLevel = scene === 'carport' ? carport : carport < 3 ? 0 : Math.min(100, carport * 1.15 + 8);
      const lines = DEMO_LINES[cam.id] || { warning: [], critical: [] };
      const lineStatus = demoLineStatus(scene, sceneLevel, lines);
      let image = null;
      if (t >= withPictures) {
        const stamp = fileStamp(new Date(t), settings.timezone);
        image = `${stamp}_${cam.id}.jpg`;
        const buf = await renderDemoFrame(scene, { level: sceneLevel, night: world.night(t), raining: carport > 8, timeText: stamp });
        const { default: sharp } = await import('sharp');
        await sharp(buf).resize({ width: 960 }).jpeg({ quality: 78 }).toFile(store.snapshotFile(image));
      }
      readingCams.push({
        id: cam.id, name: cam.name, ok: true, image, night: world.night(t), lines,
        metrics: { brightness: world.night(t) ? 58 + Math.round(Math.sin(t / 9e5) * 6) : 148 + Math.round(Math.sin(t / 9e5) * 10), contrast: 55, sharpness: world.night(t) ? 1.4 : 2.2 }, lineStatus,
        water: sceneLevel <= 2 ? 'dry' : 'flooded', coverage: demoCoverage(scene, sceneLevel), note: demoNote(scene, sceneLevel, lineStatus),
      });
    }
    const statuses = readingCams.map((c) => c.lineStatus);
    const status = statuses.includes('at_red') ? 'critical' : statuses.includes('at_yellow') || level >= settings.warnLevel ? 'warning' : 'normal';
    const usage = { input: 1450, output: 420, cacheRead: 2280 };
    const shown = statuses.includes('at_red') ? Math.max(level, 100) : statuses.includes('at_yellow') ? Math.max(level, 50) : level;
    store.addReading({
      id: randomId('r'), ts: t, status, level: shown, levelRaw: level, aiStatus: status, distance: demoDistance(level),
      confidence: 0.86, headline: headlineFor(level, statuses), reasons: [],
      rain: { nowMm: carport > 8 ? Math.round((carport / 12 + Math.abs(Math.sin(t / 4e5)) * 3) * 10) / 10 : 0, next3hMm: 0 },
      trend: null, cameras: readingCams, trigger: 'schedule',
      ai: { engine: 'demo', model: settings.aiModel, ms: 900, usage, costUsd: costUsd(settings.aiModel, usage), simulated: true },
    });
    n++;
  }
  return n;
}

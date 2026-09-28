// Plain-file storage: small JSON files for settings/state, JSON Lines for history.
// Everything lives in DATA_DIR so a backup is just a folder copy.

import fs from 'node:fs';
import path from 'node:path';
import { resolveSettings } from './config.js';
import { logger } from './log.js';

const log = logger('store');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`อ่าน ${path.basename(file)} ไม่ได้ ใช้ค่าเริ่มต้นแทน: ${err.message}`);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a torn last line after a power cut — skip it */
    }
  }
  return rows;
}

const EMPTY_META = () => ({ lines: { safe: [], warning: [], critical: [] }, note: '', refs: { day: null, night: null } });

export class Store {
  constructor(dataDir, env = process.env) {
    this.dir = dataDir;
    this.env = env;
    this.snapDir = path.join(dataDir, 'snapshots');
    this.refDir = path.join(dataDir, 'refs');
    this.files = {
      settings: path.join(dataDir, 'settings.json'),
      cameras: path.join(dataDir, 'cameras.json'),
      userCameras: path.join(dataDir, 'user-cameras.json'),
      state: path.join(dataDir, 'state.json'),
      readings: path.join(dataDir, 'readings.jsonl'),
      events: path.join(dataDir, 'events.jsonl'),
    };
  }

  init() {
    for (const dir of [this.dir, this.snapDir, this.refDir]) fs.mkdirSync(dir, { recursive: true });
    this.storedSettings = readJson(this.files.settings, {});
    this.settings = resolveSettings(this.storedSettings, this.env);
    this.cameraMetas = readJson(this.files.cameras, {});
    this.userCameras = readJson(this.files.userCameras, []);
    this.state = readJson(this.files.state, {});
    this.readings = readJsonl(this.files.readings).sort((a, b) => a.ts - b.ts);
    this.events = readJsonl(this.files.events).sort((a, b) => a.ts - b.ts);
    return this;
  }

  // ---- settings -------------------------------------------------------
  updateSettings(values) {
    this.storedSettings = { ...this.storedSettings, ...values };
    writeJsonAtomic(this.files.settings, this.storedSettings);
    this.settings = resolveSettings(this.storedSettings, this.env);
    return this.settings;
  }

  // ---- per-camera lines, notes and reference photos ---------------------
  cameraMeta(id) {
    const meta = this.cameraMetas[id] || {};
    const base = EMPTY_META();
    return {
      lines: { ...base.lines, ...(meta.lines || {}) },
      note: meta.note || '',
      refs: { ...base.refs, ...(meta.refs || {}) },
    };
  }

  setCameraMeta(id, patch) {
    const current = this.cameraMeta(id);
    const next = {
      lines: patch.lines ? { ...current.lines, ...patch.lines } : current.lines,
      note: patch.note !== undefined ? patch.note : current.note,
      refs: patch.refs ? { ...current.refs, ...patch.refs } : current.refs,
    };
    this.cameraMetas[id] = next;
    writeJsonAtomic(this.files.cameras, this.cameraMetas);
    return next;
  }

  // ---- cameras added from the UI (kept apart from CAMERA_* in .env) --------
  listUserCameras() {
    return this.userCameras.map((c) => ({ ...c }));
  }

  /** Add a camera the owner connected through the finder. `url` already carries any credentials. */
  addUserCamera({ name, url, snapshotUrl = '' }) {
    const used = new Set([...this.userCameras.map((c) => c.id)]);
    let n = 1;
    while (used.has(`u${n}`)) n += 1;
    const camera = { id: `u${n}`, name: String(name || `กล้อง ${n}`).slice(0, 60), url: String(url), snapshotUrl: String(snapshotUrl || ''), addedAt: Date.now() };
    this.userCameras = [...this.userCameras, camera];
    writeJsonAtomic(this.files.userCameras, this.userCameras);
    return camera;
  }

  removeUserCamera(id) {
    const before = this.userCameras.length;
    this.userCameras = this.userCameras.filter((c) => c.id !== id);
    if (this.userCameras.length === before) return false;
    writeJsonAtomic(this.files.userCameras, this.userCameras);
    return true;
  }

  // ---- runtime state ------------------------------------------------------
  patchState(patch) {
    this.state = { ...this.state, ...patch };
    writeJsonAtomic(this.files.state, this.state);
    return this.state;
  }

  // ---- readings -------------------------------------------------------------
  addReading(reading) {
    this.readings.push(reading);
    fs.appendFileSync(this.files.readings, JSON.stringify(reading) + '\n');
    return reading;
  }

  latestReading() {
    return this.readings[this.readings.length - 1] || null;
  }

  getReading(id) {
    for (let i = this.readings.length - 1; i >= 0; i--) if (this.readings[i].id === id) return this.readings[i];
    return null;
  }

  readingsSince(ts) {
    let lo = 0;
    let hi = this.readings.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.readings[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return this.readings.slice(lo);
  }

  // ---- alert / activity log ---------------------------------------------
  addEvent(event) {
    this.events.push(event);
    fs.appendFileSync(this.files.events, JSON.stringify(event) + '\n');
    return event;
  }

  recentEvents(limit = 50) {
    return this.events.slice(-limit).reverse();
  }

  // ---- housekeeping ---------------------------------------------------------
  prune(now = Date.now()) {
    const { historyDays, snapshotRetentionDays } = this.settings;
    const historyCut = now - historyDays * 86400e3;
    const snapCut = now - snapshotRetentionDays * 86400e3;

    const keepReadings = this.readings.filter((r) => r.ts >= historyCut);
    if (keepReadings.length !== this.readings.length) {
      this.readings = keepReadings;
      this.#rewrite(this.files.readings, keepReadings);
    }
    const keepEvents = this.events.filter((e) => e.ts >= historyCut);
    if (keepEvents.length !== this.events.length) {
      this.events = keepEvents;
      this.#rewrite(this.files.events, keepEvents);
    }

    let removed = 0;
    for (const name of fs.readdirSync(this.snapDir)) {
      const file = path.join(this.snapDir, name);
      try {
        if (fs.statSync(file).mtimeMs < snapCut) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        /* already gone */
      }
    }
    if (removed) log.info(`ลบภาพเก่าเกิน ${snapshotRetentionDays} วัน ${removed} ไฟล์`);
  }

  #rewrite(file, rows) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    fs.renameSync(tmp, file);
  }

  snapshotFile(name) {
    return path.join(this.snapDir, name);
  }

  refFile(name) {
    return path.join(this.refDir, name);
  }
}

// The watch loop: capture every camera → draw the lines → ask Claude → decide →
// store → alert. Checks more often while water is up or rising, less often when
// the forecast confirms a dry night.

import fs from 'node:fs/promises';
import { captureCamera } from './camera/capture.js';
import { buildAlertImage, drawLines } from './camera/image.js';
import { buildContent } from './ai/prompt.js';
import { failedResult } from './ai/result.js';
import { computeTrend, judge, lineStatusFor, reconcileLevel } from './judge.js';
import { fileStamp, randomId, thaiTime } from './util.js';
import { logger } from './log.js';

const log = logger('watch');
const SAFE_NAME = /^[\w.-]+\.jpg$/;

export class Watcher {
  constructor({ config, store, engine, alerts, weather, broadcast = () => {}, world = null, engineProblem = () => null }) {
    this.config = config;
    this.store = store;
    this.engine = engine;
    this.alerts = alerts;
    this.weather = weather;
    this.broadcast = broadcast;
    this.world = world;
    this.engineProblem = engineProblem;
    this.timer = null;
    this.nextAt = null;
    this.current = null;
    this.lastPrune = 0;
    this.stopped = false;
  }

  get cameras() {
    return this.config.cameras;
  }

  captureContext() {
    return {
      ffmpegPath: this.config.ffmpegPath,
      httpTool: this.config.httpTool,
      maxEdge: this.store.settings.imageMaxEdge,
      timeoutMs: 20000,
      demoFrame: this.world ? (cam) => this.world.frame(cam) : null,
    };
  }

  // ---------------------------------------------------------------- scheduling
  intervalMinutes() {
    const s = this.store.settings;
    if (!s.adaptiveInterval) return s.intervalMinutes;
    const latest = this.store.latestReading();
    if (!latest) return s.intervalMinutes;
    const rising = latest.trend && latest.trend.ratePerHour >= 4;
    // water past a green line but not yet at yellow: watch closely so yellow is caught early
    const pastGreen = (latest.cameras || []).some((c) => c.lineStatus === 'below_yellow' && (c.lines?.safe || []).length >= 2);
    if (latest.status === 'warning' || latest.status === 'critical' || rising || pastGreen || this.store.state.pendingCritical) {
      return Math.min(s.fastIntervalMinutes, s.intervalMinutes);
    }
    const dryNow = latest.status === 'normal' && latest.level !== null && latest.level <= 10;
    if (dryNow && this.weather?.confirmedDry()) return Math.max(s.relaxedIntervalMinutes, s.intervalMinutes);
    return s.intervalMinutes;
  }

  schedule(ms, trigger = 'schedule') {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => this.run(trigger).catch((err) => log.error(err)), ms);
  }

  start(firstDelayMs = 3000) {
    this.stopped = false;
    this.schedule(firstDelayMs);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.nextAt = null;
  }

  /** Run a check right away (or join the one already running). */
  runNow(trigger = 'manual') {
    return this.run(trigger);
  }

  run(trigger = 'schedule') {
    if (this.current) return this.current;
    this.current = (async () => {
      let recheckInMs = null;
      try {
        if (this.store.settings.paused && (trigger === 'schedule' || trigger === 'recheck')) return null;
        const out = await this.cycle(trigger);
        recheckInMs = out.recheckInMs ?? null;
        return out.reading;
      } finally {
        this.current = null;
        if (recheckInMs) {
          log.info(`นัดตรวจซ้ำอีก ${Math.round(recheckInMs / 1000)} วินาที เพื่อยืนยันก่อนแจ้ง`);
          this.schedule(recheckInMs, 'recheck');
        } else {
          this.schedule(this.store.settings.paused ? 60e3 : this.intervalMinutes() * 60e3);
        }
        this.broadcast('status', {});
      }
    })();
    return this.current;
  }

  // ---------------------------------------------------------------- one check
  async cycle(trigger) {
    const s = this.store.settings;
    const started = Date.now();
    const recheck = Boolean(this.store.state.pendingCritical);
    this.broadcast('checking', { trigger, at: started });
    const stamp = fileStamp(new Date(started), s.timezone);

    // 1. pictures — one at a time through curl: an NVR answers HTTP 500 to snapshot requests that overlap
    const shoot = async (cam) => {
      try {
        const frame = await captureCamera(cam, this.captureContext());
        const image = `${stamp}_${cam.id}.jpg`;
        await fs.writeFile(this.store.snapshotFile(image), frame.buffer);
        return { cam, ok: true, frame, image };
      } catch (err) {
        return { cam, ok: false, error: err.message };
      }
    };
    const shots = [];
    if (this.config.httpTool === 'curl') for (const cam of this.cameras) shots.push(await shoot(cam));
    else shots.push(...(await Promise.all(this.cameras.map(shoot))));

    // 2. what Claude sees: pictures with the lines drawn in, plus dry-weather references
    const aiCams = [];
    for (const shot of shots) {
      const meta = this.store.cameraMeta(shot.cam.id);
      const entry = { id: shot.cam.id, name: shot.cam.name, url: shot.cam.url, lines: meta.lines, note: meta.note };
      if (shot.ok) {
        entry.frame = {
          buffer: await drawLines(shot.frame.buffer, meta.lines),
          night: shot.frame.metrics.night,
          timeText: thaiTime(new Date(started), s.timezone),
        };
        if (s.useReferenceImages) entry.reference = await this.#reference(meta.refs, shot.frame.metrics.night);
      }
      aiCams.push(entry);
    }
    const okIds = shots.filter((x) => x.ok).map((x) => x.cam.id);

    // 3. ask Claude
    let ai;
    const problem = this.engineProblem();
    if (!okIds.length) ai = failedResult('ไม่มีภาพให้วิเคราะห์');
    else if (problem) ai = failedResult(problem);
    else {
      const { blocks, staticCount } = buildContent({ siteName: s.siteName, siteDescription: s.siteDescription, cameras: aiCams });
      ai = await this.engine.analyze({
        model: s.aiModel,
        effort: s.aiEffort,
        blocks,
        staticCount,
        cacheTtl: this.intervalMinutes() * 60 < 290 ? '5m' : '1h',
        expectedIds: okIds,
        cameraById: Object.fromEntries(this.cameras.map((c) => [c.id, c])),
        capturedAt: started,
      });
    }

    // 4. decide — the trend uses the same line-reconciled level the gauge shows
    const camsForJudge = aiCams.map((c) => ({ id: c.id, name: c.name, lines: c.lines }));
    const captured = new Set(okIds);
    const lineStatuses = ai.ok ? camsForJudge.map((c) => (captured.has(c.id) ? lineStatusFor(c, ai.cameras?.[c.id]) : 'down')) : [];
    const shownLevel = ai.ok ? reconcileLevel(ai.level, lineStatuses) : null;
    const history = this.store.readingsSince(started - 70 * 60e3).map((r) => ({ ts: r.ts, level: r.status === 'unknown' ? null : r.level }));
    const trend = shownLevel !== null ? computeTrend([...history, { ts: started, level: shownLevel }], started) : null;
    const judgement = judge({ ai, cameras: camsForJudge, captured, settings: s, trend, previous: this.store.state.lastStatus || 'normal' });

    // 5. store
    const reading = {
      id: randomId('r'),
      ts: started,
      status: judgement.status,
      level: judgement.level ?? null,
      levelRaw: ai.ok ? ai.level : null,
      aiStatus: ai.ok ? ai.aiStatus || null : null,
      distance: ai.ok ? ai.distance || '' : '',
      confidence: ai.ok ? ai.confidence : 0,
      headline: ai.ok ? ai.headline : '',
      reasons: judgement.reasons,
      predictive: judgement.predictive || false,
      receding: judgement.receding || false,
      trend,
      trigger,
      recheck,
      cameras: shots.map((shot) => {
        const meta = this.store.cameraMeta(shot.cam.id);
        const base = { id: shot.cam.id, name: shot.cam.name, ok: shot.ok, lines: meta.lines };
        if (!shot.ok) return { ...base, error: shot.error, lineStatus: 'down' };
        const seen = ai.ok ? ai.cameras[shot.cam.id] : null;
        return {
          ...base,
          image: shot.image,
          night: shot.frame.metrics.night,
          metrics: { brightness: shot.frame.metrics.brightness, contrast: shot.frame.metrics.contrast, sharpness: shot.frame.metrics.sharpness },
          lineStatus: ai.ok ? lineStatusFor({ lines: meta.lines }, seen) : 'cannot_tell',
          water: seen?.water || null,
          coverage: seen?.coverage ?? null,
          note: seen?.note || '',
        };
      }),
      ai: {
        engine: ai.engine || this.engine?.name, model: ai.model || s.aiModel, ms: ai.ms ?? null, usage: ai.usage || null,
        costUsd: ai.costUsd ?? null, error: ai.ok ? null : ai.error, subscription: Boolean(ai.subscription), simulated: Boolean(ai.simulated),
      },
      rain: this.world
        ? { nowMm: this.world.rainMm(started), next3hMm: null }
        : this.weather?.data ? { nowMm: this.weather.data.nowMm, next3hMm: this.weather.data.next3hMm } : null,
    };
    this.store.addReading(reading);
    log.info(`ผลตรวจ: ${reading.status} ระดับ ${reading.level ?? '–'} (${Date.now() - started} ms)${reading.ai.error ? ` — ${reading.ai.error}` : ''}`);

    // 6. alert
    const frames = shots.map((shot) => ({ name: shot.cam.name, buffer: shot.ok ? shot.frame.buffer : null, lines: this.store.cameraMeta(shot.cam.id).lines }));
    const photo = () => buildAlertImage(frames, { status: reading.status, level: reading.level, timeText: thaiTime(new Date(started), s.timezone) });
    let out = {};
    try {
      out = await this.alerts.afterReading(reading, { judgement, photo });
    } catch (err) {
      log.error('ระบบแจ้งเตือนผิดพลาด', err);
    }

    this.broadcast('reading', { id: reading.id, status: reading.status, level: reading.level });
    if (Date.now() - this.lastPrune > 3600e3) {
      this.lastPrune = Date.now();
      try {
        this.store.prune();
      } catch (err) {
        log.warn(`ล้างข้อมูลเก่าไม่สำเร็จ: ${err.message}`);
      }
    }
    return { reading, recheckInMs: out.recheckInMs };
  }

  async #reference(refs, night) {
    const pick = (night ? refs.night || refs.day : refs.day || refs.night) || null;
    if (!pick || !SAFE_NAME.test(pick)) return null;
    try {
      const buffer = await fs.readFile(this.store.refFile(pick));
      return { buffer, kind: pick === refs.night ? 'night' : 'day' };
    } catch {
      return null;
    }
  }

  /** Alert picture for any stored reading (used by Telegram /status). */
  async photoForReading(reading) {
    const frames = [];
    for (const cam of reading.cameras || []) {
      let buffer = null;
      if (cam.ok && cam.image && SAFE_NAME.test(cam.image)) buffer = await fs.readFile(this.store.snapshotFile(cam.image)).catch(() => null);
      frames.push({ name: cam.name, buffer, lines: cam.lines });
    }
    return buildAlertImage(frames, { status: reading.status, level: reading.level, timeText: thaiTime(new Date(reading.ts), this.store.settings.timezone) });
  }

  /** Fresh picture for the line editor, without analysing it. */
  async snapshot(camId) {
    const cam = this.cameras.find((c) => c.id === camId);
    if (!cam) throw new Error('ไม่พบกล้องนี้');
    const frame = await captureCamera(cam, { ...this.captureContext(), attempts: 1 });
    const image = `${fileStamp(new Date(), this.store.settings.timezone)}_${cam.id}_live.jpg`;
    await fs.writeFile(this.store.snapshotFile(image), frame.buffer);
    return { image, width: frame.width, height: frame.height, metrics: frame.metrics };
  }
}

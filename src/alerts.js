// When to wake people up, and when to stay quiet.
//
//  • yellow line reached (or water rising fast)  → one message when it starts
//  • red line reached                            → re-check after a short delay first
//                                                   (stops false alarms from glare/IR),
//                                                   then message + siren, repeated while it lasts
//  • back to normal                              → "all clear" + siren off + snooze cleared
//  • can't see for N rounds / a camera is down   → one message, and one when it's back

import { STATUS_TH } from './judge.js';
import {
  ALERT_BUTTONS, cameraBackMessage, cameraDownMessage, criticalMessage, failureMessage,
  failureRecoveredMessage, hasGreenLine, recoveryMessage, summaryMessage, warningMessage,
} from './notify/messages.js';
import { dayKey, hourOf, thaiTime } from './util.js';

export class AlertPolicy {
  constructor({ store, notifier, siren, config }) {
    this.store = store;
    this.notifier = notifier;
    this.siren = siren;
    this.config = config;
  }

  ctx() {
    const s = this.store.settings;
    return { siteName: s.siteName, timezone: s.timezone, publicUrl: process.env.PUBLIC_URL || '' };
  }

  #payload(reading) {
    return {
      status: reading.status, level: reading.level, headline: reading.headline, reasons: reading.reasons,
      readingId: reading.id, cameras: (reading.cameras || []).map((c) => ({ name: c.name, ok: c.ok, line: c.lineStatus, note: c.note })),
    };
  }

  #withLink(msg) {
    const url = this.ctx().publicUrl;
    if (!url) return msg;
    return { html: `${msg.html}\n🔗 ${url}`, text: `${msg.text}\n${url}` };
  }

  /**
   * Called after every stored reading.
   * cameras: reading.cameras ([{ id, name, ok, error }]); photo: lazy alert-image builder.
   * Returns { recheckInMs } when a red-line sighting needs confirming.
   */
  async afterReading(reading, { judgement, photo }) {
    const s = this.store.settings;
    const st = this.store.state;
    const now = Date.now();
    const ctx = this.ctx();
    const status = judgement.status;
    const last = st.lastStatus || 'normal';
    const out = {};

    let pending = st.pendingCritical || null;
    const maxPendingAge = Math.max(3 * s.confirmDelaySeconds * 1000, 2 * s.intervalMinutes * 60e3);
    if (pending && now - pending.since > maxPendingAge) {
      pending = null; // the re-check never happened (restart) — don't let an old sighting confirm a new one
      this.store.patchState({ pendingCritical: null });
    }
    let pendingW = st.pendingWarning || null;
    if (pendingW && now - pendingW.since > maxPendingAge) {
      pendingW = null;
      this.store.patchState({ pendingWarning: null });
    }

    if (status === 'critical') {
      if (pendingW) this.store.patchState({ pendingWarning: null });
      if (s.confirmCritical && !pending && last !== 'critical') {
        this.store.patchState({ pendingCritical: { since: now, readingId: reading.id } });
        this.notifier.record('pending', 'เห็นน้ำถึงเส้นแดง — ขอตรวจซ้ำเพื่อยืนยันก่อนปลุก', reading.headline || '', { readingId: reading.id });
        out.recheckInMs = s.confirmDelaySeconds * 1000;
      } else {
        this.store.patchState({ pendingCritical: null });
        const repeat = last === 'critical';
        const due = now - (st.lastCriticalAlertAt || 0) >= s.criticalRepeatMinutes * 60e3;
        if (!repeat || due) {
          const msg = this.#withLink(criticalMessage(ctx, reading, { repeat }));
          await this.notifier.send({
            kind: 'critical', title: repeat ? 'น้ำยังอยู่ที่เส้นแดง (เตือนซ้ำ)' : 'น้ำถึงเส้นแดง', ...msg,
            photo, buttons: ALERT_BUTTONS, readingId: reading.id, data: this.#payload(reading),
          });
          this.store.patchState({ lastCriticalAlertAt: now });
          await this.siren.sound({ reason: 'น้ำถึงเส้นแดง', level: 'critical' });
        }
        this.store.patchState({ lastStatus: 'critical' });
      }
    } else if (status === 'unknown' && (pending || pendingW)) {
      // The re-check could not see: keep the sighting pending and look again soon.
      // (It expires after maxPendingAge; the "can't see" alert covers a camera that stays blind.)
      this.notifier.record('pending', 'ตรวจซ้ำแล้วมองไม่ชัด — ขอดูอีกรอบ', judgement.reasons?.[0] || '', { readingId: reading.id });
      if (now - (pending || pendingW).since < 3 * s.confirmDelaySeconds * 1000) out.recheckInMs = s.confirmDelaySeconds * 1000;
    } else {
      if (pending) {
        this.store.patchState({ pendingCritical: null });
        this.notifier.record('pending', `ตรวจซ้ำแล้ว ไม่ถึงเส้นแดง (ผล: ${STATUS_TH[status]})`, 'ไม่ปลุก เพราะภาพรอบแรกอาจหลอกตา', { readingId: reading.id });
      }
      // First yellow sighting (not "rising fast", not a red sighting that re-checked as yellow):
      // look again before telling anyone — glare and rain on the lens fool a single frame.
      const confirmYellow = status === 'warning' && last !== 'warning' && last !== 'critical'
        && s.confirmWarning && !judgement.predictive && !pendingW && !pending;
      if (confirmYellow) {
        this.store.patchState({ pendingWarning: { since: now, readingId: reading.id } });
        this.notifier.record('pending', 'เห็นน้ำถึงเส้นเหลือง — ขอตรวจซ้ำเพื่อยืนยันก่อนแจ้ง', reading.headline || '', { readingId: reading.id });
        out.recheckInMs = s.confirmDelaySeconds * 1000;
      } else if (status === 'warning') {
        if (pendingW) this.store.patchState({ pendingWarning: null });
        if (last === 'critical') {
          if (s.notifyWarning) {
            const msg = this.#withLink(warningMessage(ctx, reading, { easing: true }));
            await this.notifier.send({ kind: 'warning', title: 'น้ำลดลงต่ำกว่าเส้นแดง', ...msg, photo, buttons: ALERT_BUTTONS, readingId: reading.id, data: this.#payload(reading) });
          }
          await this.siren.stop('auto');
        } else if (last !== 'warning') {
          if (s.notifyWarning) {
            const msg = this.#withLink(warningMessage(ctx, reading, { predictive: judgement.predictive }));
            await this.notifier.send({
              kind: 'warning', title: judgement.predictive ? 'น้ำขึ้นเร็ว' : 'น้ำถึงเส้นเหลือง', ...msg,
              photo, buttons: ALERT_BUTTONS, readingId: reading.id, data: this.#payload(reading),
            });
          }
          await this.siren.sound({ reason: judgement.predictive ? 'น้ำขึ้นเร็ว' : 'น้ำถึงเส้นเหลือง', level: 'warning' });
        }
        this.store.patchState({ lastStatus: 'warning' });
      } else if (status === 'normal') {
        if (pendingW) {
          this.store.patchState({ pendingWarning: null });
          this.notifier.record('pending', 'ตรวจซ้ำแล้ว ไม่ถึงเส้นเหลือง', 'ไม่แจ้ง เพราะภาพรอบแรกอาจหลอกตา', { readingId: reading.id });
        }
        if (last === 'warning' || last === 'critical') {
          if (s.notifyRecovery) {
            const msg = this.#withLink(recoveryMessage(ctx, reading));
            await this.notifier.send({ kind: 'recovery', title: hasGreenLine(reading) ? 'น้ำลงถึงเส้นเขียว ปลอดภัยแล้ว' : 'น้ำกลับสู่ปกติ', ...msg, photo, readingId: reading.id, data: this.#payload(reading) });
          }
          await this.siren.stop('auto');
          this.siren.unsnooze('auto');
        }
        this.store.patchState({ lastStatus: 'normal' });
      }
    }

    // A mute taken at a level lifts once the water is below that level (unknown keeps it).
    this.siren.maybeUnmute?.(status);

    await this.#trackFailures(reading, judgement, photo);
    return out;
  }

  async #trackFailures(reading, judgement, photo = null) {
    const s = this.store.settings;
    const st = this.store.state;
    const ctx = this.ctx();
    const status = judgement.status;
    // show what the cameras did see; with every camera down there is nothing to show
    const pics = photo && (reading.cameras || []).some((c) => c.ok) ? { photo } : {};

    const streak = status === 'unknown' ? (st.unknownStreak || 0) + 1 : 0;
    this.store.patchState({ unknownStreak: streak });
    if (status === 'unknown' && streak >= s.failureThreshold && !st.failureAlerted) {
      if (s.notifyFailure) {
        const msg = failureMessage(ctx, streak, judgement.reasons?.[0]);
        await this.notifier.send({ kind: 'failure', title: `มองไม่เห็น ${streak} รอบติดกัน`, ...msg, ...pics, readingId: reading.id, data: this.#payload(reading) });
      }
      this.store.patchState({ failureAlerted: true });
    } else if (status !== 'unknown' && st.failureAlerted) {
      if (s.notifyFailure) {
        await this.notifier.send({ kind: 'failure', title: 'กลับมามองเห็นแล้ว', ...failureRecoveredMessage(ctx), ...pics, readingId: reading.id });
      }
      this.store.patchState({ failureAlerted: false });
    }

    const cams = reading.cameras || [];
    const allDown = cams.length > 0 && cams.every((c) => !c.ok);
    const down = { ...(st.cameraDown || {}) };
    const alerted = { ...(st.cameraAlerted || {}) };
    for (const cam of cams) {
      if (cam.ok) {
        if (alerted[cam.id]) {
          if (s.notifyFailure) await this.notifier.send({ kind: 'camera', title: `กล้อง ${cam.name} กลับมาแล้ว`, ...cameraBackMessage(ctx, cam), ...pics });
          delete alerted[cam.id];
        }
        down[cam.id] = 0;
      } else {
        down[cam.id] = (down[cam.id] || 0) + 1;
        if (!allDown && down[cam.id] >= s.failureThreshold && !alerted[cam.id]) {
          if (s.notifyFailure) await this.notifier.send({ kind: 'camera', title: `กล้อง ${cam.name} ดึงภาพไม่ได้`, ...cameraDownMessage(ctx, cam, down[cam.id], cam.error), ...pics });
          alerted[cam.id] = true;
        }
      }
    }
    this.store.patchState({ cameraDown: down, cameraAlerted: alerted });
  }

  /** Once a day at the chosen hour: a short "still here" summary. */
  async maybeDailySummary(now = Date.now()) {
    const s = this.store.settings;
    if (s.dailySummaryHour === null || s.dailySummaryHour === undefined) return false;
    const today = dayKey(new Date(now), s.timezone);
    if (hourOf(new Date(now), s.timezone) !== s.dailySummaryHour || this.store.state.lastSummaryDay === today) return false;
    this.store.patchState({ lastSummaryDay: today });
    const msg = summaryMessage(this.ctx(), dailyStats(this.store, now));
    await this.notifier.send({ kind: 'summary', title: 'สรุปประจำวัน', ...msg, silent: true });
    return true;
  }
}

export function dailyStats(store, now = Date.now()) {
  const since = now - 24 * 3600e3;
  const rows = store.readingsSince(since);
  const ok = rows.filter((r) => r.status !== 'unknown');
  let max = null;
  for (const r of ok) if (r.level !== null && (max === null || r.level > max.level)) max = r;
  const costs = rows.map((r) => r.ai?.costUsd).filter((c) => typeof c === 'number');
  const alerts = store.events.filter((e) => e.ts >= since && ['critical', 'warning'].includes(e.kind)).length;
  const latest = rows[rows.length - 1];
  return {
    checks: rows.length,
    successPct: rows.length ? Math.round((ok.length / rows.length) * 100) : 0,
    maxLevel: max ? max.level : null,
    maxAt: max ? thaiTime(new Date(max.ts), store.settings.timezone) : '',
    status: latest?.status || null,
    alerts,
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    subscription: rows.some((r) => r.ai?.subscription),
  };
}

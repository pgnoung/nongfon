// The things that make noise: a Zigbee siren via MQTT, any HTTP-controlled plug
// or Home Assistant script via webhook, the dashboard's bedside alarm in a browser, and
// iPhones through Pushover (emergency priority + iOS Critical Alerts: rings even on silent).

import { mqttPublish } from './mqtt.js';
import { STATUS_RANK, STATUS_TH } from '../judge.js';
import { logger } from '../log.js';

const log = logger('siren');
const WHO = { user: 'สั่งจากหน้าเว็บ', telegram: 'สั่งจาก Telegram', snooze: 'งดเสียงชั่วคราว', mute: 'งดเสียงจนกว่าน้ำจะลด' };
const PUSHOVER_API = 'https://api.pushover.net/1';
const PUSHOVER_TAG = 'nongfon';
// stops that end only the house siren: its own timer, and tidying up after a restart —
// phones keep ringing until someone taps them, presses stop, or the water drops
const HOUSE_ONLY = new Set(['timer', 'recover']);

export class Siren {
  /**
   * broadcast(event, data) pushes live updates to open dashboards (bedside mode).
   */
  constructor({ store, config, broadcast = () => {}, notifier, fetchImpl = fetch, publish = mqttPublish }) {
    this.store = store;
    this.config = config;
    this.broadcast = broadcast;
    this.notifier = notifier;
    this.fetchImpl = fetchImpl;
    this.publish = publish;
    this.offTimer = null;
  }

  outputs() {
    const { mqttUrl, sirenOnUrl, pushoverToken, pushoverUser } = this.config.secrets;
    return {
      mqtt: Boolean(mqttUrl), webhook: Boolean(sirenOnUrl), browser: Boolean(this.store.settings.browserAlarm),
      iphone: Boolean(pushoverToken && pushoverUser),
    };
  }

  status() {
    const st = this.store.state;
    const now = Date.now();
    return {
      on: Boolean(st.sirenUntil && st.sirenUntil > now),
      until: st.sirenUntil && st.sirenUntil > now ? st.sirenUntil : null,
      reason: st.sirenReason || null,
      snoozeUntil: st.snoozeUntil && st.snoozeUntil > now ? st.snoozeUntil : null,
      muteLevel: st.muteLevel || null,
      ringingPhones: Boolean(st.iphoneRinging),
      outputs: this.outputs(),
      enabled: this.store.settings.sirenEnabled,
    };
  }

  /** Silenced either for a while (snooze) or until the water drops (mute). */
  isSnoozed() {
    const st = this.store.state;
    return Boolean((st.snoozeUntil && st.snoozeUntil > Date.now()) || st.muteLevel);
  }

  async #mqtt(on) {
    const s = this.store.settings;
    const { mqttUrl, mqttUsername, mqttPassword } = this.config.secrets;
    await this.publish({
      url: mqttUrl, username: mqttUsername, password: mqttPassword,
      topic: s.mqttTopic, payload: on ? s.mqttOnPayload : s.mqttOffPayload, qos: 1,
    });
  }

  async #webhook(on, reason) {
    const url = on ? this.config.secrets.sirenOnUrl : this.config.secrets.sirenOffUrl;
    if (!url) return;
    const method = (process.env.SIREN_WEBHOOK_METHOD || 'POST').toUpperCase();
    const init = { method, signal: AbortSignal.timeout(10000) };
    if (method !== 'GET') {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify({ siren: on ? 'on' : 'off', reason });
    }
    const res = await this.fetchImpl(url, init);
    await res.body?.cancel();
    if (!res.ok) throw new Error(`ไซเรน webhook ตอบ HTTP ${res.status}`);
  }

  /** Switch the physical outputs; returns { mqtt: {ok,error}, webhook: {…} }. */
  /** Pushover: on = emergency message that repeats every 30 s until tapped; off = cancel ours by tag. */
  async #iphone(on, { reason = '', test = false } = {}) {
    const { pushoverToken: token, pushoverUser: user } = this.config.secrets;
    const s = this.store.settings;
    const what = reason || 'น้ำถึงเส้นแดง';
    const body = on
      ? new URLSearchParams({
        token, user, priority: '2', retry: '30', sound: 'siren', tags: PUSHOVER_TAG,
        expire: String(test ? 60 : Math.min(10800, Math.max(60, s.criticalRepeatMinutes * 60))),
        title: test ? 'ทดสอบไซเรน น้องฝน' : `🚨 น้องฝน: ${what}`,
        message: `${s.siteName}: ${what} · แตะเพื่อรับทราบ`,
      })
      : new URLSearchParams({ token });
    const url = on ? `${PUSHOVER_API}/messages.json` : `${PUSHOVER_API}/receipts/cancel_by_tag/${PUSHOVER_TAG}.json`;
    const res = await this.fetchImpl(url, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 1) throw new Error(`Pushover ${res.status}: ${(data.errors || []).join(', ') || 'ตอบกลับผิดรูปแบบ'}`);
    this.store.patchState({ iphoneRinging: on });
    return data.receipt || null;
  }

  async #switch(on, reason, { physical = true } = {}) {
    const out = this.outputs();
    const result = {};
    if (physical && out.mqtt) {
      try {
        await this.#mqtt(on);
        result.mqtt = { ok: true };
      } catch (err) {
        result.mqtt = { ok: false, error: err.message };
      }
    }
    if (physical && (on ? out.webhook : this.config.secrets.sirenOffUrl)) {
      try {
        await this.#webhook(on, reason);
        result.webhook = { ok: true };
      } catch (err) {
        result.webhook = { ok: false, error: err.message };
      }
    }
    for (const [k, r] of Object.entries(result)) {
      if (!r.ok) log.warn(`สั่งไซเรน (${k}) ${on ? 'เปิด' : 'ปิด'} ไม่สำเร็จ: ${r.error}`);
    }
    return result;
  }

  /**
   * Sound the alarm for `seconds`. level = 'critical' | 'warning' decides which
   * outputs are allowed (settings sirenOnWarning / browserAlarmOnWarning).
   */
  async sound({ reason, level = 'critical', seconds, test = false } = {}) {
    const s = this.store.settings;
    const secs = seconds || s.sirenSeconds;
    if (!test && this.isSnoozed()) {
      this.notifier?.record('siren', 'ไซเรนถูกงดเสียงอยู่ — ไม่ได้เปิด', reason || '');
      return { skipped: 'snoozed' };
    }
    const physical = test || (s.sirenEnabled && (level === 'critical' || s.sirenOnWarning));
    const browser = test || (s.browserAlarm && (level === 'critical' || s.browserAlarmOnWarning));
    const iphone = this.outputs().iphone && (test || (s.iphoneAlarm && (level === 'critical' || s.iphoneAlarmOnWarning)));
    if (!physical && !browser && !iphone) return { skipped: 'disabled' };

    const until = Date.now() + secs * 1000;
    this.store.patchState({ sirenUntil: until, sirenReason: reason || level });
    if (browser) this.broadcast('siren', { on: true, until, reason, level, test });
    const result = await this.#switch(true, reason, { physical });
    if (iphone) {
      try {
        result.iphone = { ok: true, receipt: await this.#iphone(true, { reason, test }) };
      } catch (err) {
        result.iphone = { ok: false, error: err.message };
        log.warn(`สั่ง iPhone ดังไม่สำเร็จ: ${err.message}`);
      }
    }
    clearTimeout(this.offTimer);
    this.offTimer = setTimeout(() => this.stop('timer').catch(() => {}), secs * 1000);
    this.offTimer.unref?.();
    if (!test) {
      const outs = [physical && this.outputs().mqtt && 'MQTT', physical && this.outputs().webhook && 'webhook', browser && 'หน้าเว็บ', iphone && 'iPhone'].filter(Boolean);
      this.notifier?.record('siren', `เปิดไซเรน ${secs} วินาที`, `${reason || ''} · ${outs.join(', ') || 'ไม่มีอุปกรณ์'}`, { channels: result });
    }
    return { ok: true, until, result };
  }

  async stop(by = 'user') {
    clearTimeout(this.offTimer);
    const wasOn = this.status().on;
    this.store.patchState({ sirenUntil: null, sirenReason: null });
    this.broadcast('siren', { on: false, by });
    const result = await this.#switch(false, by, { physical: true });
    if (!HOUSE_ONLY.has(by) && this.outputs().iphone && this.store.state.iphoneRinging) {
      try {
        await this.#iphone(false);
        result.iphone = { ok: true };
      } catch (err) {
        result.iphone = { ok: false, error: err.message };
        log.warn(`สั่ง iPhone หยุดดังไม่สำเร็จ: ${err.message}`);
      }
    }
    if (wasOn && by !== 'auto' && !HOUSE_ONLY.has(by)) this.notifier?.record('siren', 'ปิดไซเรนแล้ว', WHO[by] || WHO.user);
    return { ok: true, result };
  }

  async snooze(minutes, by = 'user') {
    const until = Date.now() + minutes * 60e3;
    this.store.patchState({ snoozeUntil: until, muteLevel: null });
    await this.stop('snooze');
    this.notifier?.record('siren', `งดเสียงไซเรน ${minutes} นาที`, WHO[by] || WHO.user);
    this.broadcast('status', {});
    return { ok: true, snoozeUntil: until };
  }

  /**
   * Silence the siren until a reading drops below the level it was muted at
   * (upstream "mute until water drops"). Messages keep going out meanwhile.
   * Muting during a long warning is therefore not undone by the next warning.
   */
  async muteUntilDrop(by = 'user') {
    const last = this.store.state.lastStatus;
    const muteLevel = last === 'warning' || last === 'critical' ? last : 'critical';
    this.store.patchState({ muteLevel, snoozeUntil: null });
    await this.stop('mute');
    this.notifier?.record('siren', `งดเสียงไซเรนจนกว่าน้ำจะลดต่ำกว่าระดับ${STATUS_TH[muteLevel]}`, WHO[by] || WHO.user);
    this.broadcast('status', {});
    return { ok: true, muteLevel };
  }

  /** Called after every reading: lift a mute once the water is below the muted level. */
  maybeUnmute(status) {
    const muteLevel = this.store.state.muteLevel;
    if (!muteLevel || !(status in STATUS_RANK)) return false; // unknown keeps the mute
    if (STATUS_RANK[status] >= STATUS_RANK[muteLevel]) return false;
    this.store.patchState({ muteLevel: null });
    this.notifier?.record('siren', 'ยกเลิกงดเสียงอัตโนมัติ', `น้ำลดต่ำกว่าระดับ${STATUS_TH[muteLevel]}แล้ว (ผลล่าสุด: ${STATUS_TH[status]})`);
    this.broadcast('status', {});
    return true;
  }

  unsnooze(by = 'user') {
    const st = this.store.state;
    if (!st.snoozeUntil && !st.muteLevel) return { ok: true };
    this.store.patchState({ snoozeUntil: null, muteLevel: null });
    if (by !== 'auto') this.notifier?.record('siren', 'ยกเลิกงดเสียงไซเรน', WHO[by] || '');
    this.broadcast('status', {});
    return { ok: true };
  }

  /** After a crash mid-alarm, make sure nothing keeps screaming. */
  async recover() {
    if (this.store.state.sirenUntil) {
      log.info('พบไซเรนค้างจากรอบก่อน สั่งปิดให้');
      await this.stop('recover');
    }
  }
}

// Rain around the house from Open-Meteo (free, no key). Used to show rain on the
// dashboard and to decide when it is safe to check less often.

import { logger } from './log.js';

const log = logger('weather');
const REFRESH_MS = 20 * 60e3;

export class Weather {
  constructor({ store, fetchImpl = fetch, apiBase = 'https://api.open-meteo.com' }) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    this.data = null;
    this.error = null;
    this.fetchedAt = 0;
    this.key = '';
  }

  enabled() {
    const { latitude, longitude } = this.store.settings;
    return latitude !== null && longitude !== null && latitude !== undefined && longitude !== undefined;
  }

  async refresh(force = false) {
    if (!this.enabled()) {
      this.data = null;
      return null;
    }
    const { latitude, longitude } = this.store.settings;
    const key = `${latitude},${longitude}`;
    if (!force && key === this.key && Date.now() - this.fetchedAt < REFRESH_MS) return this.data;
    const url = `${this.apiBase}/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      '&current=precipitation&hourly=precipitation,precipitation_probability&forecast_hours=6&timezone=auto';
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const hours = (body.hourly?.time || []).map((t, i) => ({
        time: t,
        mm: Number(body.hourly.precipitation?.[i] ?? 0),
        prob: Number(body.hourly.precipitation_probability?.[i] ?? 0),
      }));
      this.data = {
        at: Date.now(),
        nowMm: Number(body.current?.precipitation ?? 0),
        next3hMm: Math.round(hours.slice(0, 3).reduce((a, h) => a + h.mm, 0) * 10) / 10,
        maxProb3h: Math.max(0, ...hours.slice(0, 3).map((h) => h.prob)),
        hours,
      };
      this.error = null;
      this.key = key;
      this.fetchedAt = Date.now();
    } catch (err) {
      this.error = `ดึงข้อมูลฝนไม่ได้ (${err.name === 'TimeoutError' ? 'หมดเวลา' : err.message})`;
      log.warn(this.error);
      this.fetchedAt = Date.now() - REFRESH_MS + 5 * 60e3; // try again in ~5 minutes
    }
    return this.data;
  }

  /** True only when we positively know it is dry now and for the next 3 hours. */
  confirmedDry() {
    if (!this.data || Date.now() - this.data.at > 90 * 60e3) return false;
    return this.data.nowMm < 0.1 && this.data.next3hMm < 1 && this.data.maxProb3h < 50;
  }

  get() {
    return this.enabled() ? { data: this.data, error: this.error } : null;
  }
}

// Every hour: a short roll-up of the water at home, the rain now and around the house, and the
// latest flood headlines. Rule-based on purpose — no AI call, so it costs nothing and cannot
// invent anything; headlines are quoted as published, with their outlet and time.

import { STATUS_TH } from './judge.js';
import { logger } from './log.js';
import { fetchNews } from './news.js';
import { dayKey, hourOf, thaiTime } from './util.js';

const log = logger('hourly');
const AROUND_KM = 25;
const DIRS = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
export const RISK_TH = { low: 'ต่ำ', medium: 'ปานกลาง', high: 'สูง' };
const RISK_ICON = { low: '🟢', medium: '🟡', high: '🔴' };

const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const round1 = (n) => Math.round(n * 10) / 10;

/** Heaviest rain on the rain grid in the current hour, which way it is from the house and how far. */
export function aroundHome(grid) {
  if (!grid?.cells?.length) return null;
  const n = Math.round(Math.sqrt(grid.cells.length));
  const mid = (n - 1) / 2;
  const step = grid.cellKm ?? (2 * grid.radiusKm) / (n - 1);
  const cells = grid.cells.map((cell, i) => ({
    mm: Number(cell.mm?.[0] ?? 0) || 0,
    east: ((i % n) - mid) * step,
    north: (mid - Math.floor(i / n)) * step,
  }));
  const wetCells = cells.filter((c) => c.mm >= 0.5).length;
  const top = cells.reduce((a, c) => (c.mm > a.mm ? c : a), { mm: 0, east: 0, north: 0 });
  if (top.mm <= 0) return { maxMm: 0, direction: '', km: null, wetCells };
  const km = Math.round(Math.hypot(top.east, top.north));
  const bearing = ((Math.atan2(top.east, top.north) * 180) / Math.PI + 360) % 360;
  return { maxMm: round1(top.mm), direction: km === 0 ? '' : DIRS[Math.round(bearing / 45) % 8], km, wetCells };
}

function assessRisk({ water, weather, around }) {
  const level = water?.level ?? null;
  const rise = level !== null && water?.levelHourAgo !== null && water?.levelHourAgo !== undefined ? level - water.levelHourAgo : 0;
  const wet = level !== null && level >= 20;
  const next3h = weather?.next3hMm ?? 0;
  const near = around?.maxMm ?? 0;
  if (water?.status === 'critical' || water?.status === 'warning') return { level: 'high', why: `ตอนนี้สถานะ “${STATUS_TH[water.status]}”` };
  if (rise >= 10) return { level: 'high', why: `น้ำขึ้น ${rise} ในชั่วโมงเดียว` };
  if (wet && next3h >= 15) return { level: 'high', why: `มีน้ำขังอยู่แล้ว และคาดว่าฝนจะตกอีก ${next3h} มม. ใน 3 ชม.` };
  if (rise >= 4) return { level: 'medium', why: `น้ำกำลังขึ้น (+${rise} ในชั่วโมงเดียว)` };
  if (wet && next3h >= 2) return { level: 'medium', why: `มีน้ำขังอยู่แล้ว และคาดว่าฝนจะตกอีก ${next3h} มม. ใน 3 ชม.` };
  if (wet && (weather?.nowMm ?? 0) >= 0.5) return { level: 'medium', why: 'มีน้ำขังอยู่แล้ว และฝนยังตกอยู่' };
  if (wet && (weather?.maxProb3h ?? 0) >= 60) return { level: 'medium', why: `มีน้ำขังอยู่แล้ว และมีโอกาสฝนตก ${weather.maxProb3h}% ใน 3 ชม.` };
  if (near >= 5) return { level: 'medium', why: `มีกลุ่มฝนหนัก ${near} มม. ใกล้บ้าน` };
  return { level: 'low', why: wet ? 'มีน้ำขัง แต่ไม่มีฝนเพิ่ม' : 'ไม่มีน้ำขัง และไม่มีฝนหนักใกล้บ้าน' };
}

function waterLine(water) {
  if (!water) return 'น้ำ: ยังไม่มีผลตรวจจากกล้อง';
  const { status, level, levelHourAgo, headline } = water;
  let delta = '';
  if (level !== null && level !== undefined && levelHourAgo !== null && levelHourAgo !== undefined) {
    const d = level - levelHourAgo;
    delta = d > 0 ? ` (ขึ้น ${d} จากชั่วโมงก่อน)` : d < 0 ? ` (ลง ${-d} จากชั่วโมงก่อน)` : ' (เท่าชั่วโมงก่อน)';
  }
  return `น้ำ: ${STATUS_TH[status] || status} · ระดับ ${level ?? '–'}/100${delta}${headline ? ` · ${headline}` : ''}`;
}

function rainLine(weather) {
  if (!weather) return 'ฝนที่บ้าน: ไม่มีข้อมูลฝน (ยังไม่ได้ใส่พิกัดบ้าน หรือดึงข้อมูลไม่ได้)';
  return `ฝนที่บ้าน: ตอนนี้ ${round1(weather.nowMm ?? 0)} มม./ชม. · 3 ชม.ข้างหน้ารวม ${round1(weather.next3hMm ?? 0)} มม. (โอกาสตกสูงสุด ${weather.maxProb3h ?? 0}%)`;
}

function aroundLine(around) {
  if (!around) return `ฝนรอบบ้าน ${AROUND_KM} กม.: ไม่มีข้อมูล`;
  if (around.maxMm < 0.5) return `ฝนรอบบ้าน ${AROUND_KM} กม.: ชั่วโมงนี้ไม่มีกลุ่มฝน`;
  const where = around.km === 0 ? 'อยู่เหนือบ้านพอดี' : `ทาง${around.direction} ห่างราว ${around.km} กม.`;
  return `ฝนรอบบ้าน ${AROUND_KM} กม.: หนักสุด ${around.maxMm} มม./ชม. ${where}`;
}

function newsLines(news, timezone) {
  if (news === null || news === undefined) return ['ข่าว: ดึงข่าวไม่ได้รอบนี้'];
  if (!news.length) return ['ข่าว: ไม่มีข่าวใหม่เรื่องน้ำท่วมใน 6 ชม.'];
  return ['ข่าวล่าสุด:', ...news.map((n) => `• ${n.title} (${n.source || 'ไม่ระบุแหล่ง'} ${thaiTime(new Date(n.at), timezone)})`)];
}

/** facts → { title, risk, riskWhy, lines[], text, html }. Pure, so it is easy to test. */
export function composeHourly({ now, timezone, water, weather, around, news }) {
  const title = `สรุปรายชั่วโมง ${String(hourOf(new Date(now), timezone)).padStart(2, '0')}:00`;
  const risk = assessRisk({ water, weather, around });
  const riskLine = `ความเสี่ยงชั่วโมงหน้า: ${RISK_TH[risk.level]} — ${risk.why}`;
  const lines = [waterLine(water), rainLine(weather), aroundLine(around), ...newsLines(news, timezone), riskLine];
  const source = 'ที่มา: กล้องที่บ้าน · พยากรณ์ฝน Open-Meteo · Google News';
  return {
    title,
    risk: risk.level,
    riskWhy: risk.why,
    lines,
    text: [`🕐 ${title}`, ...lines, source].join('\n'),
    html: [`🕐 <b>${esc(title)}</b> ${RISK_ICON[risk.level]}`, ...lines.map(esc), `<i>${esc(source)}</i>`].join('\n'),
  };
}

export class HourlySummary {
  /** photoFor(reading) → JPEG Buffer: the same camera picture the alerts use. */
  constructor({ store, weather = null, rain = null, notifier, broadcast = () => {}, news = fetchNews, photoFor = null, now = Date.now }) {
    this.store = store;
    this.photoFor = photoFor;
    this.weather = weather;
    this.rain = rain;
    this.notifier = notifier;
    this.broadcast = broadcast;
    this.news = news;
    this.now = now;
  }

  hourKey(ms) {
    const tz = this.store.settings.timezone;
    return `${dayKey(new Date(ms), tz)}T${String(hourOf(new Date(ms), tz)).padStart(2, '0')}`;
  }

  /** Runs at most once per clock hour while the setting is on. */
  async maybeRun(now = this.now()) {
    if (!this.store.settings.hourlySummary) return null;
    const key = this.hourKey(now);
    if (this.store.state.lastHourlyKey === key) return null;
    this.store.patchState({ lastHourlyKey: key }); // claim the hour first, so a slow run never repeats
    return this.run(now);
  }

  async run(now = this.now()) {
    const s = this.store.settings;
    const [weather, around, news] = await Promise.all([
      this.weather ? Promise.resolve(this.weather.refresh()).catch(() => null) : null,
      this.rain ? this.rain.grid(AROUND_KM).then(aroundHome).catch(() => null) : null,
      Promise.resolve()
        .then(() => this.news(s.newsQuery, { now }))
        .catch((err) => {
          log.warn(`ดึงข่าวไม่ได้: ${err.message}`);
          return null;
        }),
    ]);
    const summary = composeHourly({ now, timezone: s.timezone, water: this.waterFacts(now), weather, around, news });
    this.store.patchState({ hourlySummary: { at: now, title: summary.title, risk: summary.risk, lines: summary.lines, text: summary.text } });
    const latest = this.store.latestReading();
    const pics = this.photoFor && latest ? { photo: () => this.photoFor(latest) } : {};
    await this.notifier.send({ kind: 'hourly', title: summary.title, html: summary.html, text: summary.text, silent: true, ...pics });
    this.broadcast('status', {});
    return summary;
  }

  /** Latest reading plus the level about an hour earlier (the reading closest to 60 minutes ago). */
  waterFacts(now) {
    const latest = this.store.latestReading();
    if (!latest) return null;
    const target = now - 60 * 60e3;
    const past = this.store.readingsSince(now - 75 * 60e3)
      .filter((r) => r.ts <= now - 45 * 60e3 && r.status !== 'unknown' && r.level !== null && r.level !== undefined)
      .reduce((best, r) => (!best || Math.abs(r.ts - target) < Math.abs(best.ts - target) ? r : best), null);
    return {
      status: latest.status,
      level: latest.status === 'unknown' ? null : latest.level,
      levelHourAgo: past ? past.level : null,
      headline: latest.headline || '',
    };
  }
}

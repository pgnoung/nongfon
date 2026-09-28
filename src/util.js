import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function randomId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function parts(date, timeZone, options) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

/** "2026-09-27" in the given time zone. */
export function dayKey(date, timeZone) {
  const p = parts(date, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hour of day 0-23 in the given time zone. */
export function hourOf(date, timeZone) {
  return Number(parts(date, timeZone, { hour: '2-digit' }).hour);
}

/** "20260927-022228" — used in snapshot file names. */
export function fileStamp(date, timeZone) {
  const p = parts(date, timeZone, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

/** Thai clock time, e.g. "02:22". */
export function thaiTime(date, timeZone) {
  return new Intl.DateTimeFormat('th-TH', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Thai date + time, e.g. "27 ก.ย. 2569 02:22". */
export function thaiDateTime(date, timeZone) {
  const d = new Intl.DateTimeFormat('th-TH', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  return `${d} ${thaiTime(date, timeZone)}`;
}

/** "15 นาที", "2 ชม. 5 นาที" */
export function thaiDuration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ชม. ${rest} นาที` : `${h} ชม.`;
}

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(value).trim().toLowerCase());
}

/** Constant-time string comparison (for passwords/tokens). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Cut text at a word boundary so AI notes stay short in chats and on the dashboard. */
export function shorten(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max - 1);
  return s.slice(0, cut > max * 0.6 ? cut : max - 1) + '…';
}

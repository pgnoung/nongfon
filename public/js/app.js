// Shared helpers for every dashboard page.
import { faceSvg, mascotSvg } from './mascot.js';

export const STATUS = {
  normal: { th: 'ปกติ', say: 'น้ำยังปกติ นอนต่อได้เลยนะคะ', emoji: '💧' },
  warning: { th: 'เฝ้าระวัง', say: 'น้ำเริ่มมาแล้ว น้องฝนจับตาอยู่ใกล้ๆ นะคะ', emoji: '⚠️' },
  critical: { th: 'อันตราย', say: 'น้ำถึงเส้นแดงแล้ว! ตื่นเร็วค่ะ', emoji: '🚨' },
  unknown: { th: 'มองไม่ชัด', say: 'น้องฝนมองไม่ค่อยเห็น ขอดูอีกรอบนะคะ', emoji: '🌫️' },
  pending: { th: 'กำลังยืนยัน', say: 'เหมือนน้ำจะถึงเส้นแดง ขอสแกนซ้ำให้ชัวร์ก่อนนะคะ', emoji: '⏳' },
  paused: { th: 'พักการตรวจ', say: 'ตอนนี้พักการตรวจอยู่ค่ะ', emoji: '⏸️' },
};

export const LINE_TH = {
  no_lines: 'ยังไม่ได้ขีดเส้น',
  below_green: 'ไม่เกินเส้นเขียว',
  below_yellow: 'ยังไม่ถึงเส้น',
  at_yellow: 'ถึงเส้นเหลือง',
  at_red: 'ถึงเส้นแดง',
  cannot_tell: 'มองไม่เห็นขอบน้ำ',
  down: 'ดึงภาพไม่ได้',
};
export const LINE_STATUS_CLASS = { at_red: 'critical', at_yellow: 'warning', below_green: 'normal', below_yellow: 'normal', cannot_tell: 'unknown', down: 'unknown', no_lines: 'paused' };

/** A camera's line label; water past a green line (still below yellow) says so. */
export function lineLabel(status, lines) {
  if (status === 'below_yellow' && (lines?.safe || []).length >= 2) return 'เลยเส้นเขียวแล้ว';
  return LINE_TH[status] || status || '–';
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let tz = 'Asia/Bangkok';
export function setTimeZone(zone) {
  if (zone) tz = zone;
}
export const fmtTime = (ts) => new Intl.DateTimeFormat('th-TH', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
export const fmtDate = (ts) => new Intl.DateTimeFormat('th-TH', { timeZone: tz, day: 'numeric', month: 'short', year: '2-digit' }).format(ts);
export const fmtDay = (ts) => new Intl.DateTimeFormat('th-TH', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(ts);
export const dayKey = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);

export function ago(ts, now = Date.now()) {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'เมื่อสักครู่';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ชม.ที่แล้ว`;
  return `${Math.round(h / 24)} วันที่แล้ว`;
}

export function inMinutes(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((ts - now) / 1000));
  if (s < 60) return `${s} วินาที`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} นาที` : `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
}

export function duration(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} นาที`;
  return m % 60 ? `${Math.floor(m / 60)} ชม. ${m % 60} นาที` : `${m / 60} ชม.`;
}

export const usd = (n, digits = 2) => (n === null || n === undefined ? '–' : `$${Number(n).toFixed(digits)}`);

export function statusOf(payload) {
  if (!payload) return 'unknown';
  if (payload.next?.paused) return 'paused';
  if (payload.pending) return 'pending';
  return payload.latest?.status || 'unknown';
}

export function sticker(status, { soft = false, label } = {}) {
  const s = STATUS[status] || STATUS.unknown;
  return `<span class="sticker ${soft ? 'soft ' : ''}s-${status}">${esc(label || s.th)}</span>`;
}

const ASSET_V = document.documentElement.dataset.v || '';

export function icon(name, cls = 'i') {
  return `<svg class="${cls}" aria-hidden="true"><use href="/static/img/icons.svg${ASSET_V ? `?v=${ASSET_V}` : ''}#i-${name}"/></svg>`;
}

/** Dashed green/yellow/red lines drawn over a picture (coordinates are 0–1). */
export function linesSvg(lines = {}) {
  const part = (pts, color) => {
    if (!pts || pts.length < 2) return '';
    const d = pts.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' ');
    return `<polyline points="${d}" fill="none" stroke="#10123a" stroke-opacity=".55" stroke-width="7" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="3.5" stroke-dasharray="12 7" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
  };
  return `<svg class="lines" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">${part(lines.safe, '#3DF5A0')}${part(lines.warning, '#FFD60A')}${part(lines.critical, '#FF3358')}</svg>`;
}

// ---------------------------------------------------------------- network
export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = '{}';
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('กรุณาเข้าสู่ระบบ');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || (data.errors || []).join(' · ') || `ผิดพลาด (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

/** Live updates from the server; reconnects on its own. */
export function listen(handlers) {
  let es;
  let lastBeat = Date.now();
  const connect = () => {
    es = new EventSource('/api/events');
    for (const [name, fn] of Object.entries(handlers)) {
      if (name === 'open' || name === 'error') continue;
      es.addEventListener(name, (e) => {
        lastBeat = Date.now();
        let data = {};
        try {
          data = JSON.parse(e.data || '{}');
        } catch {
          /* ignore */
        }
        fn(data);
      });
    }
    es.onopen = () => {
      lastBeat = Date.now();
      handlers.open?.();
    };
    es.onerror = () => handlers.error?.();
  };
  connect();
  return { get lastBeat() { return lastBeat; }, close: () => es?.close() };
}

// ---------------------------------------------------------------- ui bits
export function toast(message, { bad = false, ms = 3200 } = {}) {
  const zone = $('.toast-zone');
  if (!zone) return;
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  zone.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Run an async action from a button with a busy state and a toast. */
export async function withBusy(button, fn, { ok, fail } = {}) {
  if (button) {
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
  }
  try {
    const out = await fn();
    if (ok) toast(typeof ok === 'function' ? ok(out) : ok);
    return out;
  } catch (err) {
    toast(`${fail ? `${fail}: ` : ''}${err.message}`, { bad: true, ms: 6000 });
    return null;
  } finally {
    if (button) {
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
  }
}

// ---------------------------------------------------------------- น้องฝน (vector now, official art when it arrives)
let artPromise = null;
/** Moods that have official raster art, from public/img/fon/manifest.json ({} when there is none yet). */
export function fonArt() {
  if (!artPromise) {
    artPromise = fetch(`/static/img/fon/manifest.json${ASSET_V ? `?v=${ASSET_V}` : ''}`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return artPromise;
}

/**
 * Put น้องฝน into `el` and return { setMood }. Uses the raster image for a mood when the
 * manifest lists one, and the vector drawing otherwise (so art can arrive one mood at a time).
 */
export function mountMascot(el, { mood = 'happy', size = 220, idSuffix = 'm' } = {}) {
  el.innerHTML = mascotSvg({ mood, size, idSuffix });
  const svg = el.querySelector('.fon');
  let current = mood;
  let art = {};
  const apply = () => {
    const file = art[current];
    let img = el.querySelector('img.fon-img');
    svg.setAttribute('data-mood', current);
    if (file && /^[\w.-]+\.(webp|png)$/.test(file)) {
      if (!img) {
        img = document.createElement('img');
        img.className = 'fon-img';
        img.alt = 'น้องฝน';
        el.append(img);
      }
      img.src = `/static/img/fon/${file}${ASSET_V ? `?v=${ASSET_V}` : ''}`;
      img.hidden = false;
      svg.style.display = 'none';
    } else {
      if (img) img.hidden = true;
      svg.style.display = '';
    }
  };
  fonArt().then((a) => {
    art = a && typeof a === 'object' ? a : {};
    apply();
  });
  return {
    setMood(next) {
      if (next === current) return;
      current = next;
      apply();
    },
  };
}

/** น้องฝน's round avatar in `el` (the vector face until the raster avatar is known). */
export function mountAvatar(el, { size = 44, idSuffix = 'a' } = {}) {
  el.innerHTML = faceSvg({ size, idSuffix });
  fonArt().then((art) => {
    const file = [art.avatar, art.face].find((f) => f && /^[\w.-]+\.(webp|png)$/.test(f));
    if (file) el.innerHTML = `<img src="/static/img/fon/${esc(file)}${ASSET_V ? `?v=${ASSET_V}` : ''}" alt="" width="${size}" height="${size}" decoding="async">`;
  });
}

export function initChrome() {
  const page = document.body.dataset.page;
  for (const a of $$('.nav a')) if (a.dataset.nav === page) a.setAttribute('aria-current', 'page');
  const face = $('[data-mascot-face]');
  if (face) mountAvatar(face, { size: 44, idSuffix: 'brand' });
  if (document.body.dataset.demo === 'true') $('[data-demo-ribbon]')?.removeAttribute('hidden');
  $('[data-theme-toggle]')?.addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('nf-theme', next);
    } catch {
      /* ignore */
    }
  });
}

export function setSiteName(name) {
  const chip = $('[data-site-name]');
  if (chip && name) {
    chip.textContent = name;
    chip.hidden = false;
  }
}

export function rainHtml(count = 18) {
  let out = '<div class="rain" aria-hidden="true">';
  for (let i = 0; i < count; i++) {
    out += `<i style="left:${(i * 97) % 100}%;animation-duration:${(0.9 + ((i * 37) % 10) / 10).toFixed(2)}s;animation-delay:${((i * 53) % 20) / 10}s"></i>`;
  }
  return out + '</div>';
}

export function waterHtml() {
  // a smooth sine (T repeats the mirrored control point); 4 periods per half width so the drift loops seamlessly
  const wave = (y, amp) => {
    let d = `M0 ${y} Q 50 ${y - amp} 100 ${y}`;
    for (let x = 200; x <= 1600; x += 100) d += ` T ${x} ${y}`;
    return `${d} V 100 H 0 Z`;
  };
  return `<div class="hero-water" aria-hidden="true"><svg class="w1" viewBox="0 0 1600 100" preserveAspectRatio="none"><path d="${wave(40, 18)}"/></svg><svg class="w2" viewBox="0 0 1600 100" preserveAspectRatio="none"><path d="${wave(58, 14)}"/></svg></div>`;
}

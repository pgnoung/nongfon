// Charts drawn as plain SVG in CSS pixels (labels stay readable on phones).
//  • renderLevelChart: water level area + the yellow/red lines, rain bars (mm/h), and
//    each camera's flooded share of the ground (dashed) — the upstream "WATER LEVEL" panel.
//  • renderQualityChart: brightness and sharpness per camera, night (infrared) shaded —
//    the upstream "IMAGE QUALITY" panel; it explains why a night reading was hard.
import { STATUS, esc, fmtDate, fmtTime } from './app.js';

const M = { l: 36, r: 40, t: 14, b: 28 };
// cameras: one blue family that still tells apart (teal, indigo, deep blue, sky, periwinkle, sea); never red or amber,
// which belong to the owner's lines
export const CAM_COLORS = ['#0E9FB8', '#5B55D6', '#1D4E9E', '#3FA9EE', '#8A83E6', '#0F7A8C'];
const STATUS_COLOR = { normal: '#2FBF8A', warning: '#F5A524', critical: '#D12C50', unknown: '#8F9BD8' };

function frame(el, hours, now) {
  const W = Math.round(Math.min(1100, Math.max(300, el.clientWidth || 720)));
  const H = W < 520 ? 220 : 260;
  const t0 = now - hours * 3600e3;
  const x = (t) => M.l + ((t - t0) / (now - t0)) * (W - M.l - M.r);
  return { W, H, t0, x };
}

function timeTicks({ W, H, t0, x }, hours, now) {
  let stepH = hours <= 6 ? 1 : hours <= 24 ? 3 : hours <= 72 ? 12 : 24;
  if (W < 520) stepH *= 2;
  const first = Math.ceil(t0 / (stepH * 3600e3)) * stepH * 3600e3;
  let out = '';
  for (let t = first; t <= now; t += stepH * 3600e3) {
    out += `<text class="axis-text" x="${x(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(stepH >= 24 ? fmtDate(t) : fmtTime(t))}</text>`;
  }
  return out;
}

function hover(el, svgEl, W, H, points, x, yOf, label) {
  const tip = el.querySelector('.chart-tip');
  const line = el.querySelector('[data-hover]');
  const dot = el.querySelector('[data-hover-dot]');
  const move = (clientX) => {
    const rect = svgEl.getBoundingClientRect();
    const vx = ((clientX - rect.left) / rect.width) * W;
    let best = points[0];
    for (const p of points) if (Math.abs(x(p.t) - vx) < Math.abs(x(best.t) - vx)) best = p;
    const px = x(best.t);
    line.setAttribute('x1', px);
    line.setAttribute('x2', px);
    line.setAttribute('visibility', 'visible');
    const py = yOf(best);
    if (py !== null) {
      dot.setAttribute('cx', px);
      dot.setAttribute('cy', py);
      dot.setAttribute('visibility', 'visible');
    } else dot.setAttribute('visibility', 'hidden');
    tip.innerHTML = label(best);
    tip.hidden = false;
    tip.style.left = `${Math.min(88, Math.max(12, (px / W) * 100))}%`;
    tip.style.top = `${((py ?? H - M.b) / H) * 100}%`;
  };
  const hide = () => {
    tip.hidden = true;
    line.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  };
  svgEl.addEventListener('pointermove', (e) => move(e.clientX));
  svgEl.addEventListener('pointerdown', (e) => move(e.clientX));
  svgEl.addEventListener('pointerleave', hide);
}

/** points: [{ t, l, s, r, c: [coverage per camera] }] · cameras: [{ id, name }] */
export function renderLevelChart(el, { points, hours, cameras = [], now = Date.now() }) {
  const f = frame(el, hours, now);
  const { W, H, x } = f;
  const maxY = Math.max(110, ...points.map((p) => p.l ?? 0));
  const y = (v) => M.t + (1 - v / maxY) * (H - M.t - M.b);
  const rainMax = Math.max(10, ...points.map((p) => p.r ?? 0));
  const rainH = (mm) => (mm / rainMax) * (H - M.t - M.b) * 0.42;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟระดับน้ำ ${hours} ชั่วโมงล่าสุด">
    <defs><linearGradient id="waterGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7FB8F7" stop-opacity=".7"/><stop offset="1" stop-color="#7FB8F7" stop-opacity=".08"/></linearGradient></defs>`;
  for (const v of [0, 25, 50, 75, 100]) {
    svg += `<line class="grid-line" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-text" x="${M.l - 7}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  svg += timeTicks(f, hours, now);

  // rain bars (right axis, mm/h)
  const withRain = points.filter((p) => typeof p.r === 'number' && p.r > 0);
  if (withRain.length) {
    const bw = Math.max(2, Math.min(10, ((W - M.l - M.r) / Math.max(points.length, 1)) * 0.7));
    for (const p of withRain) {
      const h = rainH(p.r);
      svg += `<rect class="rain-bar" x="${(x(p.t) - bw / 2).toFixed(1)}" y="${(y(0) - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"/>`;
    }
    svg += `<text class="axis-text" x="${W - M.r + 6}" y="${(y(0) - rainH(rainMax) + 4).toFixed(1)}">${Math.round(rainMax)}</text><text class="axis-text" x="${W - M.r + 6}" y="${y(0) + 4}">0</text>`;
  }

  // water level area, in continuous runs of known levels
  const runs = [];
  let run = [];
  for (const p of points) {
    if (p.l === null || p.l === undefined) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length) runs.push(run);
  for (const r of runs) {
    if (r.length === 1) {
      svg += `<circle cx="${x(r[0].t)}" cy="${y(r[0].l)}" r="3" fill="#2F6FD0"/>`;
      continue;
    }
    const d = r.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.l).toFixed(1)}`).join(' ');
    svg += `<path class="area" d="${d} L${x(r[r.length - 1].t).toFixed(1)} ${y(0)} L${x(r[0].t).toFixed(1)} ${y(0)} Z"/><path class="line" d="${d}"/>`;
  }

  // flooded share per camera (dashed)
  cameras.forEach((cam, ci) => {
    const pts = points.filter((p) => typeof p.c?.[ci] === 'number');
    if (pts.length < 2) return;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.c[ci]).toFixed(1)}`).join(' ');
    svg += `<path class="cov-line" d="${d}" stroke="${CAM_COLORS[ci % CAM_COLORS.length]}"/>`;
  });

  // the owner's lines on top
  svg += `<line class="ref-y" x1="${M.l}" x2="${W - M.r}" y1="${y(50)}" y2="${y(50)}"/><text class="ref-label" x="${W - M.r - 4}" y="${y(50) - 6}" text-anchor="end" fill="#B07F00">เส้นเหลือง</text>`;
  svg += `<line class="ref-r" x1="${M.l}" x2="${W - M.r}" y1="${y(100)}" y2="${y(100)}"/><text class="ref-label" x="${W - M.r - 4}" y="${y(100) - 6}" text-anchor="end" fill="#D12C50">เส้นแดง</text>`;
  if (points.length <= 240) {
    for (const p of points) {
      if (p.l === null || p.l === undefined) svg += `<circle cx="${x(p.t)}" cy="${y(0)}" r="3.5" fill="${STATUS_COLOR.unknown}"/>`;
      else if (p.s === 'warning' || p.s === 'critical') svg += `<circle cx="${x(p.t)}" cy="${y(p.l)}" r="4" fill="${STATUS_COLOR[p.s]}" stroke="#fff" stroke-width="1.2"/>`;
    }
  }
  svg += `<line class="hover-line" data-hover x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" visibility="hidden"/><circle data-hover-dot r="5.5" fill="#fff" stroke="#2F6FD0" stroke-width="3" visibility="hidden"/></svg>`;

  el.innerHTML = `${svg}<div class="chart-tip" hidden></div>${points.length ? '' : '<p class="empty">ยังไม่มีข้อมูลในช่วงนี้ค่ะ</p>'}`;
  if (!points.length) return;
  hover(el, el.querySelector('svg'), W, H, points, x, (p) => (p.l === null || p.l === undefined ? null : y(p.l)), (p) => {
    const bits = [`<b>${esc(fmtTime(p.t))}</b>`, p.l === null || p.l === undefined ? 'มองไม่ชัด' : `ระดับ ${p.l}`, esc(STATUS[p.s]?.th || '')];
    if (typeof p.r === 'number') bits.push(`ฝน ${p.r} มม./ชม.`);
    cameras.forEach((cam, ci) => {
      if (typeof p.c?.[ci] === 'number') bits.push(`${esc(cam.name)} ท่วม ${p.c[ci]}%`);
    });
    return bits.join(' · ');
  });
}

/** points: [{ t, q: [{ b, s, n } | null per camera] }] */
export function renderQualityChart(el, { points, hours, cameras = [], now = Date.now() }) {
  const f = frame(el, hours, now);
  const { W, H, x } = f;
  const yB = (v) => M.t + (1 - v / 255) * (H - M.t - M.b);
  const sMax = Math.max(1, ...points.flatMap((p) => p.q.map((q) => q?.s ?? 0))) * 1.15;
  const yS = (v) => M.t + (1 - v / sMax) * (H - M.t - M.b);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="คุณภาพภาพจากกล้อง ${hours} ชั่วโมงล่าสุด">`;
  // night (infrared) shading from the first camera that reports it
  let nightStart = null;
  const bands = [];
  for (const p of points) {
    const night = p.q.some((q) => q?.n);
    if (night && nightStart === null) nightStart = p.t;
    if (!night && nightStart !== null) {
      bands.push([nightStart, p.t]);
      nightStart = null;
    }
  }
  if (nightStart !== null) bands.push([nightStart, points[points.length - 1]?.t ?? now]);
  for (const [a, b] of bands) svg += `<rect x="${x(a).toFixed(1)}" y="${M.t}" width="${Math.max(2, x(b) - x(a)).toFixed(1)}" height="${H - M.t - M.b}" fill="#3F63C8" opacity=".09"/>`;
  for (const v of [0, 64, 128, 192, 255]) {
    svg += `<line class="grid-line" x1="${M.l}" x2="${W - M.r}" y1="${yB(v)}" y2="${yB(v)}"/><text class="axis-text" x="${M.l - 7}" y="${yB(v) + 4}" text-anchor="end">${v}</text>`;
  }
  svg += `<text class="axis-text" x="${W - M.r + 6}" y="${yS(sMax / 1.15) + 4}">${(sMax / 1.15).toFixed(1)}</text><text class="axis-text" x="${W - M.r + 6}" y="${yS(0) + 4}">0</text>`;
  svg += timeTicks(f, hours, now);
  cameras.forEach((cam, ci) => {
    const color = CAM_COLORS[ci % CAM_COLORS.length];
    const pts = points.filter((p) => p.q[ci]);
    if (pts.length < 2) return;
    const b = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${yB(p.q[ci].b).toFixed(1)}`).join(' ');
    const s = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${yS(p.q[ci].s).toFixed(1)}`).join(' ');
    svg += `<path d="${b}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/><path d="${s}" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="4 4" opacity=".85"/>`;
  });
  svg += `<line class="hover-line" data-hover x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" visibility="hidden"/><circle data-hover-dot r="4.5" fill="#fff" stroke="#1D4E9E" stroke-width="2.5" visibility="hidden"/></svg>`;
  el.innerHTML = `${svg}<div class="chart-tip" hidden></div>${points.length ? '' : '<p class="empty">ยังไม่มีภาพในช่วงนี้ค่ะ</p>'}`;
  if (!points.length) return;
  hover(el, el.querySelector('svg'), W, H, points, x, (p) => (p.q[0] ? yB(p.q[0].b) : null), (p) => [
    `<b>${esc(fmtTime(p.t))}</b>`,
    ...cameras.map((cam, ci) => (p.q[ci] ? `${esc(cam.name)}: สว่าง ${p.q[ci].b} · คม ${p.q[ci].s}${p.q[ci].n ? ' · 🌙' : ''}` : `${esc(cam.name)}: ไม่มีภาพ`)),
  ].join(' · '));
}

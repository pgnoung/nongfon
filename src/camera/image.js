// Image work with sharp: normalise frames, measure quality, draw the alert lines,
// and build the picture that goes out with an alert.

import fs from 'node:fs';
import sharp from 'sharp';
import { escapeHtml } from '../util.js';
import { faceSvg } from '../../public/js/mascot.js';

const AVATAR = new URL('../../public/img/fon/avatar.webp', import.meta.url);

// safe = the green line: once the water is back down to it, the flood is over.
export const LINE_COLORS = { safe: '#3DF5A0', warning: '#FFD60A', critical: '#FF3358' };
const LINE_TAGS = { safe: 'GREEN', warning: 'YELLOW', critical: 'RED' };
const THAI_FONTS = "'Loma', 'Garuda', 'Noto Sans Thai', 'Thonburi', 'Leelawadee UI', 'Tahoma', sans-serif";

/** Auto-rotate, shrink to maxEdge on the long side, re-encode as JPEG. */
export async function normalizeFrame(buffer, maxEdge = 1280) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/**
 * brightness 0-255, contrast = luma std-dev (≈0 for a flat grey frame),
 * sharpness = libvips estimate, night = the camera is in IR/greyscale mode.
 */
export async function frameMetrics(buffer) {
  const grey = await sharp(buffer).greyscale().stats();
  const full = await sharp(buffer).stats();
  const { data, info } = await sharp(buffer).resize(48, 48, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sat = 0;
  const px = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1] ?? r;
    const b = data[i + 2] ?? r;
    sat += Math.max(r, g, b) - Math.min(r, g, b);
  }
  return {
    brightness: Math.round(grey.channels[0].mean),
    contrast: Math.round(grey.channels[0].stdev * 10) / 10,
    sharpness: Math.round((full.sharpness ?? 0) * 100) / 100,
    night: sat / px < 9,
  };
}

/** A frame that is one flat colour (decoder hiccup, lens cap, dead stream). */
export function isBlank(metrics) {
  return metrics.contrast < 5;
}

function pointsAttr(points, w, h) {
  return points.map(([x, y]) => `${(x * w).toFixed(1)},${(y * h).toFixed(1)}`).join(' ');
}

/** SVG overlay with the dashed green (safe), yellow (warning) and red (critical) lines. */
export function linesSvg(width, height, lines = {}, { labels = true } = {}) {
  const stroke = Math.max(3, Math.round(width / 240));
  const font = Math.max(12, Math.round(width / 70));
  let body = '';
  for (const kind of ['safe', 'warning', 'critical']) {
    const pts = (lines[kind] || []).filter((p) => Array.isArray(p) && p.length === 2);
    if (pts.length < 2) continue;
    const color = LINE_COLORS[kind];
    const attr = pointsAttr(pts, width, height);
    body += `<polyline points="${attr}" fill="none" stroke="#10123a" stroke-opacity="0.6" stroke-width="${stroke + 4}" stroke-linejoin="round" stroke-linecap="round"/>`;
    body += `<polyline points="${attr}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-dasharray="${stroke * 4} ${stroke * 2.5}" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (labels) {
      const [lx, ly] = pts.reduce((a, b) => (b[0] < a[0] ? b : a));
      const text = LINE_TAGS[kind];
      const tw = Math.round(font * (text.length * 0.68 + 0.9));
      const x = Math.min(Math.max(2, lx * width), width - tw - 2);
      const y = Math.min(Math.max(2, ly * height - font * 1.9), height - font * 1.7);
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${tw}" height="${Math.round(font * 1.5)}" rx="${Math.round(font * 0.4)}" fill="${color}" stroke="#10123a" stroke-width="2"/>`;
      body += `<text x="${(x + tw / 2).toFixed(1)}" y="${(y + font * 1.1).toFixed(1)}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${font}" text-anchor="middle" fill="#10123a">${text}</text>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

export function hasLines(lines = {}) {
  return ['safe', 'warning', 'critical'].some((k) => (lines[k] || []).length >= 2);
}

/** Burn the alert lines into a JPEG (what the AI sees). */
export async function drawLines(buffer, lines, options) {
  if (!hasLines(lines)) return buffer;
  const { width, height } = await sharp(buffer).metadata();
  const svg = linesSvg(width, height, lines, options);
  return sharp(buffer).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer();
}

/** Characters that take horizontal space (Thai vowel/tone marks stack, they don't). */
export function visualLength(text) {
  return [...String(text)].filter((ch) => !/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/.test(ch)).length;
}

const faceCache = new Map();
/** น้องฝน's round avatar as a PNG, for the corner of alert pictures (the drawn face if the art file is missing). */
export async function mascotFace(size) {
  if (!faceCache.has(size)) {
    const source = fs.existsSync(AVATAR) ? fs.readFileSync(AVATAR) : Buffer.from(faceSvg({ size, idSuffix: 'alert' }));
    faceCache.set(size, await sharp(source).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
  }
  return faceCache.get(size);
}

// Status colours of the น้องเก้า universe (text colour chosen for contrast on each fill).
const BANNER = {
  normal: { fill: '#2FBF8A', text: '#22304F', word: 'NORMAL · ปกติ' },
  warning: { fill: '#F5A524', text: '#22304F', word: 'WARNING · เฝ้าระวัง' },
  critical: { fill: '#D12C50', text: '#ffffff', word: 'CRITICAL · น้ำถึงเส้นแดง' },
  pending: { fill: '#82EBFD', text: '#22304F', word: 'CHECKING · กำลังตรวจซ้ำ' },
  unknown: { fill: '#B9C3EE', text: '#22304F', word: 'UNKNOWN · มองไม่ชัด' },
};

/**
 * One picture for Telegram: a coloured status banner, then every camera
 * (with its lines) stacked — two cameras vertically, more in a grid.
 * frames: [{ name, buffer, lines }]
 */
export async function buildAlertImage(frames, { status = 'unknown', level = null, timeText = '', width = 1024 } = {}) {
  const usable = frames.filter((f) => f.buffer);
  if (!usable.length) return null;
  const cols = usable.length <= 2 ? 1 : 2;
  const cellW = Math.floor(width / cols);
  const cells = [];
  for (const f of usable) {
    const withLines = await drawLines(f.buffer, f.lines || {}, { labels: true });
    const { data, info } = await sharp(withLines).resize({ width: cellW }).jpeg({ quality: 84 }).toBuffer({ resolveWithObject: true });
    cells.push({ name: f.name, data, h: info.height });
  }
  const rows = [];
  for (let i = 0; i < cells.length; i += cols) rows.push(cells.slice(i, i + cols));
  const bannerH = Math.round(width / 11);
  const rowHeights = rows.map((r) => Math.max(...r.map((c) => c.h)));
  const totalH = bannerH + rowHeights.reduce((a, b) => a + b, 0);
  const b = BANNER[status] || BANNER.unknown;
  const levelText = level === null || level === undefined ? '' : `ระดับ ${Math.round(level)}`;
  const fs = Math.round(bannerH * 0.38);
  const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bannerH}">
    <rect width="${width}" height="${bannerH}" fill="${b.fill}"/>
    <circle cx="${bannerH * 0.58}" cy="${bannerH / 2}" r="${bannerH * 0.44}" fill="#ffffff" fill-opacity="0.9"/>
    <text x="${bannerH * 1.15}" y="${bannerH * 0.63}" font-family="${THAI_FONTS}" font-weight="700" font-size="${fs}" fill="${b.text}">${escapeHtml(b.word)}</text>
    <text x="${width - bannerH * 0.3}" y="${bannerH * 0.63}" text-anchor="end" font-family="${THAI_FONTS}" font-weight="700" font-size="${fs}" fill="${b.text}">${escapeHtml([levelText, timeText].filter(Boolean).join(' · '))}</text>
  </svg>`;

  const face = await mascotFace(Math.round(bannerH * 0.8));
  const layers = [
    { input: Buffer.from(banner), top: 0, left: 0 },
    { input: face, top: Math.round(bannerH * 0.1), left: Math.round(bannerH * 0.18) },
  ];
  let y = bannerH;
  rows.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      layers.push({ input: cell.data, top: y, left: ci * cellW });
      const tag = Math.round(cellW / 36);
      const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${tag * 2}">
        <rect x="8" y="8" rx="${tag * 0.6}" width="${Math.round(tag * (visualLength(cell.name) * 0.62 + 1.4))}" height="${Math.round(tag * 1.5)}" fill="#ffffff" fill-opacity="0.92" stroke="#3E4C74" stroke-width="2"/>
        <text x="${8 + tag * 0.7}" y="${8 + tag * 1.08}" font-family="${THAI_FONTS}" font-weight="700" font-size="${tag}" fill="#22304F">${escapeHtml(cell.name)}</text>
      </svg>`;
      layers.push({ input: Buffer.from(label), top: y, left: ci * cellW });
    });
    y += rowHeights[ri];
  });

  return sharp({ create: { width, height: totalH, channels: 3, background: '#0E1730' } })
    .composite(layers)
    .jpeg({ quality: 84 })
    .toBuffer();
}

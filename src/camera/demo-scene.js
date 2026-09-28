// Demo-mode "camera" pictures, so anyone can try the whole system (dashboard, line editor, alerts)
// before buying or wiring a camera. Each camera is a hand-painted scene (./demo-art, the น้องฝน art
// package) with the water, rain and camera stamp drawn on top, so the level can move smoothly.
// level 0 = dry … 100 = water deep in the carport. night renders like an IR camera.

import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const W = 1280;
const H = 720;
const ART = new URL('./demo-art/', import.meta.url);

/** Where the ground is in each painting (px on the 1280×720 frame). */
export const SCENE_GEOMETRY = {
  // the road fills first (its far edge climbs from the curb to the far sidewalk), then water spreads over the yard
  street: { curb: 520, roadTop: 305, near: 720, roadFullAt: 35 },
  // water comes in under the gate and spreads over the floor toward the camera
  carport: { floorTop: 268, floorSpan: 420 },
};

/** [far edge, near edge] of the water in px at a scene level, or null when the ground is dry. */
export function waterEdges(scene, level) {
  if (level <= 2) return null;
  if (scene === 'carport') {
    const g = SCENE_GEOMETRY.carport;
    return [g.floorTop, g.floorTop + (Math.min(level, 100) / 100) * g.floorSpan];
  }
  const g = SCENE_GEOMETRY.street;
  const cover = Math.min(1, level / g.roadFullAt);
  const top = g.curb - cover * (g.curb - g.roadTop);
  const front = level <= g.roadFullAt ? g.curb : g.curb + ((Math.min(level, 100) - g.roadFullAt) / (100 - g.roadFullAt)) * (g.near - g.curb);
  return [top, front];
}

/** Wavy water edge from x0 to x1 (either direction) as an SVG path starting with M. */
function wave(x0, x1, y, amp, step, phase = 0) {
  const n = Math.max(1, Math.ceil(Math.abs(x1 - x0) / step));
  let d = '';
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const yy = y + Math.sin(i * 0.9 + phase) * amp;
    d += `${i ? ' L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)}`;
  }
  return d;
}

function rainLayer(seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let lines = '';
  for (let i = 0; i < 140; i++) {
    const x = rnd() * (W + 200) - 100;
    const y = rnd() * H;
    const len = 18 + rnd() * 26;
    lines += `<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x - len * 0.35).toFixed(0)}" y2="${(y + len).toFixed(0)}"/>`;
  }
  return `<g stroke="#ffffff" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round">${lines}</g>`;
}

function stamp(label, timeText) {
  return `<g font-family="DejaVu Sans Mono, Menlo, monospace" font-size="22" font-weight="700">
    <text x="22" y="38" fill="#000" fill-opacity="0.5">${label}</text><text x="20" y="36" fill="#fff">${label}</text>
    <text x="${W - 20}" y="${H - 18}" text-anchor="end" fill="#000" fill-opacity="0.5">${timeText}</text>
    <text x="${W - 22}" y="${H - 20}" text-anchor="end" fill="#fff">${timeText}</text></g>`;
}

/** Flood water painted in the scene's style: a murky blue body, a paler far edge and soft light on the surface. */
function waterSvg(scene, level, night) {
  const e = waterEdges(scene, level);
  if (!e) return '';
  const [top, front] = e;
  const deep = night ? '#1E3444' : '#4F7FA6';
  const edge = night ? '#3B5A6B' : '#9CC7E4';
  const body = `${wave(0, W, top, 4, 40)} L${W} ${front} ${wave(W, 0, front, 3, 40, 1.3).replace('M', 'L')} Z`;
  const glints = [0.28, 0.62]
    .map((f, i) => top + (front - top) * f)
    .filter((y) => y - top > 14 && front - y > 10)
    .map((y, i) => `<path d="${wave(80 + i * 60, W - 120 - i * 40, y, 2.5, 55, i * 1.7)}" stroke="#ffffff" stroke-opacity="${night ? 0.55 : 0.45}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="w" x1="0" y1="${top}" x2="0" y2="${Math.max(front, top + 1)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${edge}"/><stop offset="1" stop-color="${deep}"/></linearGradient></defs>
    <path d="${body}" fill="url(#w)" fill-opacity="${night ? 0.62 : 0.7}"/>
    <path d="${wave(0, W, top, 4, 40)}" stroke="#ffffff" stroke-opacity="${night ? 0.7 : 0.6}" stroke-width="3" fill="none"/>
    ${glints}
  </svg>`;
}

const cache = new Map();
function art(file) {
  if (!cache.has(file)) cache.set(file, readFileSync(new URL(file, ART)));
  return cache.get(file);
}

const SCENES = { street: 'street', carport: 'carport' };
const RAIN_SEED = { street: 7, carport: 11 };

/** Render one demo camera frame as a JPEG buffer. */
export async function renderDemoFrame(scene, { level = 0, raining = false, night = false, timeText = '' } = {}) {
  const name = SCENES[scene] || 'street';
  const layers = [];
  const water = waterSvg(name, level, night);
  if (water) {
    // everything that stands in front of the water (gate, posts, plant, car, step) is cut out of it
    const cut = await sharp(Buffer.from(water)).composite([{ input: art(`${name}-occluders.png`), blend: 'dest-out' }]).png().toBuffer();
    layers.push({ input: cut });
  }
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${raining ? rainLayer(RAIN_SEED[name]) : ''}${stamp(name, timeText)}</svg>`;
  layers.push({ input: Buffer.from(overlay) });
  let img = sharp(art(`${name}.jpg`)).resize(W, H).composite(layers);
  if (night) {
    // Mimic an IR night picture: greyscale, a little brighter in the middle, dark corners.
    const vignette = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="v" cx="0.5" cy="0.55" r="0.75"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#v)"/></svg>`;
    const grey = await img.png().toBuffer().then((b) => sharp(b).greyscale().linear(1.1, -18).png().toBuffer());
    img = sharp(grey).composite([{ input: Buffer.from(vignette) }]);
  }
  return img.jpeg({ quality: 82 }).toBuffer();
}

/** Where each demo line sits on the demo level scale. */
export const DEMO_LINE_LEVELS = { cam1: { warning: 52 }, cam2: { warning: 50, critical: 90 } };

/** A hand-drawn-looking line (0-1 points) across the frame at the water's near edge for `level`. */
function lineAt(scene, level, xs, wobble) {
  const y = waterEdges(scene, level)[1] / H;
  return xs.map((x, i) => [x, Math.round((y + wobble[i % wobble.length]) * 1000) / 1000]);
}

/** Lines that match the pictures above, used to seed demo mode. */
export const DEMO_LINES = {
  cam1: {
    warning: lineAt('street', DEMO_LINE_LEVELS.cam1.warning, [0.04, 0.35, 0.66, 0.97], [0.004, -0.002, -0.002, 0.004]),
    critical: [],
  },
  cam2: {
    warning: lineAt('carport', DEMO_LINE_LEVELS.cam2.warning, [0.02, 0.5, 0.97], [0.003, -0.002, 0.003]),
    critical: lineAt('carport', DEMO_LINE_LEVELS.cam2.critical, [0.2, 0.55, 0.92], [0.003, -0.002, 0.003]),
  },
};

/** Bumped when the demo pictures move their ground, so an old demo store re-seeds its lines. */
export const DEMO_ART_VERSION = 2;

// The rain gauge beside น้องฝน: a measuring cylinder on the same 0–110 scale the AI
// reports on (0 dry · 50 the owner's yellow line · 100 the red line). The water is a
// group that slides up and down with a transform, so a new reading reads as "the
// water rose" instead of a number swap.

const BOTTOM = 306;
const TOP = 46;
const MAX = 110;
const X0 = 27;
const X1 = 75;

export const levelY = (level) => BOTTOM - (Math.max(0, Math.min(MAX, level)) / MAX) * (BOTTOM - TOP);

let seq = 0;

export function gaugeSvg() {
  const id = `rg${++seq}`;
  const ticks = [];
  for (let v = 0; v <= MAX; v += 10) {
    const y = levelY(v).toFixed(1);
    const major = v % 50 === 0;
    ticks.push(`<line class="rg-tick" x1="${X0}" x2="${X0 + (major ? 12 : 7)}" y1="${y}" y2="${y}"/>`);
    if (major) ticks.push(`<text class="rg-num" x="20" y="${(+y + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`);
  }
  const line = (level, kind, word) => {
    const y = levelY(level).toFixed(1);
    return `<line class="rg-line ${kind}" x1="${X0 - 2}" x2="${X1 + 2}" y1="${y}" y2="${y}"/>
      <g class="rg-tag ${kind}" transform="translate(84 ${(+y - 10).toFixed(1)})"><rect width="${word === 'แดง' ? 34 : 46}" height="20" rx="10"/><text x="${word === 'แดง' ? 17 : 23}" y="14" text-anchor="middle">${word}</text></g>`;
  };
  return `<svg class="rg" viewBox="0 0 132 330" role="img" aria-label="ถังวัดระดับน้ำ" data-gauge>
    <defs><clipPath id="${id}-clip"><rect x="${X0}" y="${TOP - 8}" width="${X1 - X0}" height="${BOTTOM - TOP + 8}" rx="11"/></clipPath></defs>
    <rect class="rg-glass" x="${X0 - 3}" y="${TOP - 10}" width="${X1 - X0 + 6}" height="${BOTTOM - TOP + 14}" rx="14"/>
    <g clip-path="url(#${id}-clip)">
      <g class="rg-water" data-water style="transform:translateY(${BOTTOM}px)">
        <rect class="rg-water-body" x="${X0}" y="0" width="${X1 - X0}" height="${BOTTOM - TOP + 20}"/>
        <path class="rg-water-top" d="M${X0} 0 Q${X0 + 12} -5 ${(X0 + X1) / 2} 0 T${X1} 0 L${X1} 6 L${X0} 6 Z"/>
        <g class="rg-level" data-level-tag transform="translate(${(X0 + X1) / 2 - 17} 10)"><rect width="34" height="20" rx="10"/><text x="17" y="14.5" text-anchor="middle" data-level-text>–</text></g>
      </g>
    </g>
    ${ticks.join('')}
    ${line(50, 'y', 'เหลือง')}${line(100, 'r', 'แดง')}
    <rect class="rg-shine" x="${X0 + 5}" y="${TOP}" width="5" height="${BOTTOM - TOP - 20}" rx="2.5"/>
    <ellipse class="rg-glass" cx="${(X0 + X1) / 2}" cy="${TOP - 10}" rx="${(X1 - X0) / 2 + 3}" ry="6"/>
    <rect class="rg-glass" x="${X0 - 9}" y="${BOTTOM + 2}" width="${X1 - X0 + 18}" height="10" rx="5"/>
  </svg>`;
}

/** Move the water to `level` (null = unknown: drained, with a "?" tag). */
export function setGauge(root, level) {
  const water = root.querySelector('[data-water]');
  const text = root.querySelector('[data-level-text]');
  if (!water || !text) return;
  const known = level !== null && level !== undefined && Number.isFinite(Number(level));
  const y = known ? levelY(Number(level)) : BOTTOM - 4;
  water.style.transform = `translateY(${y.toFixed(1)}px)`;
  text.textContent = known ? String(Math.round(level)) : '?';
  // keep the tag readable when the water is nearly empty or over the top
  const tag = root.querySelector('[data-level-tag]');
  if (tag) tag.setAttribute('transform', `translate(${(X0 + X1) / 2 - 17} ${known && Number(level) < 12 ? -26 : 10})`);
  root.querySelector('svg')?.setAttribute('aria-label', known ? `ถังวัดระดับน้ำ: ระดับ ${Math.round(level)} จาก 100` : 'ถังวัดระดับน้ำ: ยังไม่รู้ระดับ');
}

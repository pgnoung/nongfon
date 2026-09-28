// Turn whatever an engine returned into one checked shape, and price the call.

import { LEVEL_STATUS, LINE_STATUS, WATER } from './prompt.js';
import { clamp, shorten } from '../util.js';

// USD per million tokens (Anthropic and OpenAI list prices, read 2026-09-23).
// cacheRead is the multiplier on input. Specific names before prefixes.
const PRICES = [
  { match: /^claude-fable-5-1/, input: 10, output: 50, cacheRead: 0.025 },
  { match: /^claude-mythos-5-1/, input: 10, output: 50, cacheRead: 0.025 },
  { match: /^claude-fable-5/, input: 10, output: 50, cacheRead: 0.1 },
  { match: /^claude-opus-5-5/, input: 4, output: 20, cacheRead: 0.05 },
  { match: /^claude-opus-5/, input: 5, output: 25, cacheRead: 0.1 },
  { match: /^claude-opus-4-[5-8]/, input: 5, output: 25, cacheRead: 0.1 },
  { match: /^claude-sonnet-5/, input: 2, output: 10, cacheRead: 0.1 },
  { match: /^claude-sonnet-4/, input: 3, output: 15, cacheRead: 0.1 },
  { match: /^claude-haiku-4-5/, input: 1, output: 5, cacheRead: 0.1 },
  { match: /^gpt-6-luna/, input: 0.1, output: 0.5, cacheRead: 0.1 },
  { match: /^gpt-6-sol/, input: 2, output: 10, cacheRead: 0.1 },
  { match: /^gpt-6-astra/, input: 10, output: 50, cacheRead: 0.1 },
  { match: /^gpt-5\.6-luna/, input: 0.2, output: 1.2, cacheRead: 0.1 },
  { match: /^gpt-5\.6-terra/, input: 2, output: 12, cacheRead: 0.1 },
  { match: /^gpt-5\.6-sol/, input: 4, output: 20, cacheRead: 0.1 },
  { match: /^gpt-4o-mini/, input: 0.15, output: 0.6, cacheRead: 0.5 },
  { match: /^gpt-4o/, input: 2.5, output: 10, cacheRead: 0.5 },
  { match: /^gpt-4\.1-mini/, input: 0.4, output: 1.6, cacheRead: 0.25 },
  { match: /^gpt-4\.1/, input: 2, output: 8, cacheRead: 0.25 },
  { match: /^gpt-5-mini/, input: 0.25, output: 2, cacheRead: 0.1 },
  { match: /^gpt-5/, input: 1.25, output: 10, cacheRead: 0.1 },
  { match: /^o4-mini/, input: 1.1, output: 4.4, cacheRead: 0.25 },
];

export function priceFor(model) {
  return PRICES.find((p) => p.match.test(model)) || null;
}

/** usage = { input, output, cacheRead, cacheWrite5m, cacheWrite1h } in tokens. */
export function costUsd(model, usage) {
  const p = priceFor(model);
  if (!p || !usage) return null;
  const inRate = p.input / 1e6;
  const cost =
    (usage.input || 0) * inRate +
    (usage.cacheWrite5m || 0) * inRate * 1.25 +
    (usage.cacheWrite1h || 0) * inRate * 2 +
    (usage.cacheRead || 0) * inRate * p.cacheRead +
    (usage.output || 0) * (p.output / 1e6);
  return Math.round(cost * 1e6) / 1e6;
}

export function failedResult(error, extra = {}) {
  return { ok: false, error, level: null, aiStatus: null, distance: '', confidence: 0, headline: '', cameras: {}, ...extra };
}

function percent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(clamp(n, 0, 100)) : null;
}

/**
 * Validate/clamp the model's JSON. expectedIds = cameras we sent pictures for.
 * When the model says it cannot judge the water at all (level_status "unknown"),
 * level becomes null so nothing downstream mistakes its placeholder 0 for "dry".
 */
export function normalizeResult(raw, expectedIds) {
  if (!raw || typeof raw !== 'object') return failedResult('AI ตอบกลับมาในรูปแบบที่อ่านไม่ได้');
  const byId = {};
  for (const cam of Array.isArray(raw.cameras) ? raw.cameras : []) {
    if (!cam || !expectedIds.includes(cam.id)) continue;
    byId[cam.id] = {
      lineStatus: LINE_STATUS.includes(cam.line_status) ? cam.line_status : 'cannot_tell',
      water: WATER.includes(cam.water) ? cam.water : 'dry',
      coverage: percent(cam.coverage_pct),
      note: shorten(cam.note_th || '', 140),
    };
  }
  for (const id of expectedIds) {
    if (!byId[id]) byId[id] = { lineStatus: 'cannot_tell', water: 'dry', coverage: null, note: 'AI ไม่ได้รายงานกล้องนี้' };
  }
  const aiStatus = LEVEL_STATUS.includes(raw.level_status) ? raw.level_status : null;
  const level = aiStatus === 'unknown' ? null : percent(raw.level);
  const confidence = Number(raw.confidence);
  return {
    ok: true,
    level,
    aiStatus,
    distance: shorten(raw.distance_th || '', 60),
    confidence: Number.isFinite(confidence) ? Math.round(clamp(confidence > 1 ? confidence / 100 : confidence, 0, 1) * 100) / 100 : 0,
    headline: shorten(raw.headline_th || '', 120),
    cameras: byId,
  };
}

/** Pull the first JSON object out of free text (fallback when no structured output field). */
export function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

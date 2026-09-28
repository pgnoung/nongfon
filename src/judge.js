// Decide the household status from what the AI saw and the lines the owner drew.
// Lines always win over the AI's overall level number, because the lines are the
// owner's own definition of "worrying" (yellow) and "dangerous" (red).
//
// Order (follows the upstream NamMaLaew rules, safer where they differ):
//   1. no picture at all, or the AI failed                       → unknown
//   2. any camera sees the water at a red line                   → critical
//   3. no red line anywhere and level ≥ criticalLevel            → critical
//      (with a red line drawn, the number alone is capped at warning)
//   4. yellow line reached, or level ≥ warnLevel                 → warning reasons
//   5. a deciding camera is down/blind                           → unknown (warning if 4 found something)
//   6. no lines and the AI could not judge at all                → unknown
//   7. after a warning or critical, a camera with a green line holds the warning until
//      the water is back down to green (hysteresis: no flapping around the yellow line)
//   8. otherwise normal, or a predictive warning when rising fast

import { thaiDuration } from './util.js';

export const STATUS_TH = {
  normal: 'ปกติ',
  warning: 'เฝ้าระวัง',
  critical: 'อันตราย',
  unknown: 'มองไม่ชัด',
};

/** How serious a status is; unknown has no rank on purpose (it is "we don't know"). */
export const STATUS_RANK = { normal: 0, warning: 1, critical: 2 };

// Fixed points of the 0–100 scale the AI is asked to use.
const SCALE_YELLOW = 50;
const SCALE_RED = 100;

const count = (pts) => (Array.isArray(pts) ? pts.length : 0);

/** Least-squares slope of level over the last `windowMin` minutes. */
export function computeTrend(points, now = Date.now(), windowMin = 60) {
  const recent = points.filter((p) => p.level !== null && p.level !== undefined && p.ts >= now - windowMin * 60e3);
  if (recent.length < 3) return null;
  const spanMin = (recent[recent.length - 1].ts - recent[0].ts) / 60e3;
  if (spanMin < 12) return null;
  const xs = recent.map((p) => (p.ts - recent[0].ts) / 60e3);
  const ys = recent.map((p) => p.level);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (!den) return null;
  const slope = num / den; // level points per minute
  const current = ys[ys.length - 1];
  const rising = slope > 0.05;
  return {
    ratePerHour: Math.round(slope * 600) / 10,
    etaYellowMin: rising && current < SCALE_YELLOW ? Math.round((SCALE_YELLOW - current) / slope) : null,
    etaRedMin: rising ? Math.max(0, Math.round((SCALE_RED - current) / slope)) : null,
    samples: recent.length,
  };
}

/** The AI's per-camera answer, sanity-checked against the lines that really exist. */
export function lineStatusFor(camera, aiCamera) {
  const hasY = count(camera.lines?.warning) >= 2;
  const hasR = count(camera.lines?.critical) >= 2;
  const hasG = count(camera.lines?.safe) >= 2;
  if (!hasY && !hasR) return 'no_lines'; // a green line alone never raises or clears an alert
  let s = aiCamera?.lineStatus || 'cannot_tell';
  if (s === 'no_lines') s = 'cannot_tell';
  if (s === 'below_green' && !hasG) s = 'below_yellow';
  if (s === 'at_red' && !hasR) s = 'at_yellow';
  if (s === 'at_yellow' && !hasY) s = 'below_yellow';
  return s;
}

/**
 * The level shown on gauges and charts. A camera that sees the water at a line
 * pins the number to at least that line's point on the scale, so the gauge never
 * says "below yellow" while a camera says "at yellow". Never lowers the AI's number.
 */
export function reconcileLevel(level, lineStatuses) {
  if (level === null || level === undefined) {
    if (lineStatuses.includes('at_red')) return SCALE_RED;
    if (lineStatuses.includes('at_yellow')) return SCALE_YELLOW;
    return null;
  }
  if (lineStatuses.includes('at_red')) return Math.max(level, SCALE_RED);
  if (lineStatuses.includes('at_yellow')) return Math.max(level, SCALE_YELLOW);
  return level;
}

function result(status, reasons, level, predictive = false, receding = false) {
  return { status, reasons, predictive, receding, level };
}

/**
 * ai:       normalised engine result ({ ok, error, level, aiStatus, cameras: {id: {lineStatus}} })
 * cameras:  [{ id, name, lines }]
 * captured: Set of camera ids that produced a picture this round
 * previous: the last alerted status ('normal' | 'warning' | 'critical'), for the green-line hysteresis
 * Returns { status, reasons[], predictive, receding, level } — level is the reconciled display level.
 */
export function judge({ ai, cameras, captured, settings, trend = null, previous = 'normal' }) {
  if (!cameras.some((c) => captured.has(c.id))) {
    return result('unknown', ['ดึงภาพจากกล้องไม่ได้เลยสักตัว'], null);
  }
  if (!ai?.ok) {
    return result('unknown', [ai?.error || 'AI วิเคราะห์ภาพไม่สำเร็จ'], null);
  }

  const info = cameras.map((c) => ({
    ...c,
    hasY: count(c.lines?.warning) >= 2,
    hasR: count(c.lines?.critical) >= 2,
    hasG: count(c.lines?.safe) >= 2,
    line: captured.has(c.id) ? lineStatusFor(c, ai.cameras?.[c.id]) : 'down',
  }));
  const rawLevel = ai.level ?? null;
  const level = reconcileLevel(rawLevel, info.map((c) => c.line));
  const anyLines = info.some((c) => c.hasY || c.hasR);
  const anyRed = info.some((c) => c.hasR);

  // 2. the owner's red line reached anywhere
  const atRed = info.filter((c) => c.line === 'at_red');
  if (atRed.length) {
    return result('critical', atRed.map((c) => `${c.name}: ขอบน้ำถึงเส้นแดงแล้ว`), level);
  }

  // 3. no red line to judge by: the overall number may declare danger on its own
  if (!anyRed && rawLevel !== null && rawLevel >= settings.criticalLevel) {
    const why = anyLines ? 'ยังไม่ได้ขีดเส้นแดง' : 'ยังไม่ได้ขีดเส้น';
    return result('critical', [`ระดับน้ำโดยรวม ${rawLevel} ถึงเกณฑ์อันตราย ${settings.criticalLevel} (${why})`], level);
  }

  // 4. yellow line, or a high overall number
  const reasons = [];
  const atYellow = info.filter((c) => c.line === 'at_yellow');
  reasons.push(...atYellow.map((c) => `${c.name}: ขอบน้ำถึงเส้นเหลืองแล้ว`));
  if (rawLevel !== null && rawLevel >= settings.warnLevel && !atYellow.length) {
    const tail = anyLines ? '' : ' (ยังไม่ได้ขีดเส้น)';
    reasons.push(`ระดับน้ำโดยรวม ${rawLevel} ถึงเกณฑ์เตือน ${settings.warnLevel}${tail}`);
  }

  // 5. cameras whose lines decide: the ones with a red line, or (if none) the ones with a yellow line
  if (anyLines) {
    const deciding = anyRed ? info.filter((c) => c.hasR) : info.filter((c) => c.hasY);
    const blind = deciding.filter((c) => c.line === 'down' || c.line === 'cannot_tell');
    if (blind.length) {
      // A deciding camera that cannot see means we cannot promise it is safe.
      const why = blind.map((c) => (c.line === 'down' ? `${c.name}: ดึงภาพไม่ได้` : `${c.name}: มองไม่เห็นขอบน้ำที่เส้น`));
      // …but something worrying seen elsewhere is still worth a warning.
      if (reasons.length) return result('warning', [...reasons, ...why], level);
      return result('unknown', why, level);
    }
  } else if (rawLevel === null) {
    // 6. no lines to lean on and the AI could not judge the water
    return result('unknown', ['AI มองภาพไม่ชัดพอจะบอกระดับน้ำ'], null);
  }

  if (reasons.length) return result('warning', reasons, level);

  // 7. going down after a warning: safe only once the water is back at the green line
  if (previous === 'warning' || previous === 'critical') {
    const notBack = info.filter((c) => c.hasG && c.line === 'below_yellow');
    if (notBack.length) {
      return result('warning', notBack.map((c) => `${c.name}: น้ำลดลงแล้ว แต่ยังไม่ลงถึงเส้นเขียว`), level, false, true);
    }
  }
  return withPrediction(result('normal', reasons, level), trend, settings);
}

function withPrediction(res, trend, settings) {
  if (!settings.predictiveWarning || !trend || trend.etaRedMin === null) return res;
  if (trend.ratePerHour >= 8 && trend.etaRedMin <= settings.predictiveMinutes) {
    return {
      ...res,
      status: 'warning',
      reasons: [`น้ำขึ้นเร็ว (+${trend.ratePerHour}/ชม.) คาดว่าจะถึงเส้นแดงในอีกราว ${thaiDuration(trend.etaRedMin)}`],
      predictive: true,
    };
  }
  return res;
}

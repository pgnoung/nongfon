// Everything น้องฝน says in chat apps. Telegram gets light HTML; LINE and
// webhooks get the same words as plain text.

import { STATUS_TH } from '../judge.js';
import { escapeHtml as esc, thaiDateTime, thaiDuration, thaiTime } from '../util.js';

const SIGN = '— น้องฝน ☔';

function levelText(level) {
  return level === null || level === undefined ? 'ระดับ –' : `ระดับ ${Math.round(level)}/100`;
}

function trendLine(trend) {
  if (!trend || trend.ratePerHour === undefined) return '';
  if (trend.ratePerHour >= 2) {
    const eta = trend.etaRedMin !== null && trend.etaRedMin !== undefined ? ` · ถึงเส้นแดงราว ${thaiDuration(trend.etaRedMin)}` : '';
    return `📈 น้ำกำลังขึ้น +${trend.ratePerHour}/ชม.${eta}`;
  }
  if (trend.ratePerHour <= -2) return `📉 น้ำกำลังลด ${trend.ratePerHour}/ชม.`;
  return '➖ ระดับน้ำทรงตัว';
}

function bullets(lines) {
  return lines.filter(Boolean).map((l) => `• ${esc(l)}`).join('\n');
}

/** Build { html, text } from lines of already-escaped HTML. */
function pack(htmlLines) {
  const html = htmlLines.filter((l) => l !== '' && l !== null && l !== undefined).join('\n');
  const text = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return { html, text };
}

function header(ctx, reading) {
  return `🏠 ${esc(ctx.siteName)} · ${levelText(reading.level)} · ${thaiTime(new Date(reading.ts), ctx.timezone)}`;
}

export function criticalMessage(ctx, reading, { repeat = false } = {}) {
  return pack([
    repeat ? '🚨 <b>น้ำยังอยู่ที่เส้นแดง!</b> (เตือนซ้ำ)' : '🚨 <b>น้ำถึงเส้นแดงแล้ว! ตื่นเร็วค่ะ</b>',
    header(ctx, reading),
    reading.headline ? esc(reading.headline) : '',
    bullets(reading.reasons || []),
    trendLine(reading.trend),
    SIGN,
  ]);
}

export function warningMessage(ctx, reading, { predictive = false, easing = false } = {}) {
  let title = '⚠️ <b>น้ำถึงเส้นเหลืองแล้ว</b> น้องฝนจับตาดูใกล้ๆ อยู่นะคะ';
  if (predictive) title = '⚠️ <b>น้ำขึ้นเร็ว</b> อาจถึงเส้นแดงเร็วๆ นี้';
  if (easing) title = '🟡 <b>น้ำลดลงต่ำกว่าเส้นแดงแล้ว</b> แต่ยังต้องเฝ้าระวัง';
  return pack([title, header(ctx, reading), reading.headline ? esc(reading.headline) : '', bullets(reading.reasons || []), trendLine(reading.trend), SIGN]);
}

/** Does any camera in this reading have a green (safe) line? Recovery then means "back down to green". */
export function hasGreenLine(reading) {
  return (reading?.cameras || []).some((c) => (c.lines?.safe || []).length >= 2);
}

export function recoveryMessage(ctx, reading) {
  return pack([
    hasGreenLine(reading) ? '✅ <b>น้ำลงถึงเส้นเขียวแล้ว ปลอดภัย</b> นอนต่อได้เลยค่ะ' : '✅ <b>น้ำลดแล้ว กลับสู่ระดับปกติ</b> นอนต่อได้เลยค่ะ',
    header(ctx, reading),
    reading.headline ? esc(reading.headline) : '',
    SIGN,
  ]);
}

export function failureMessage(ctx, streak, reason) {
  return pack([
    `📷 <b>น้องฝนมองไม่เห็นมา ${streak} รอบติดกัน</b>`,
    `🏠 ${esc(ctx.siteName)} · ${thaiDateTime(new Date(), ctx.timezone)}`,
    reason ? `สาเหตุล่าสุด: ${esc(reason)}` : '',
    'ช่วงนี้ถ้าฝนตกหนัก ลองเปิดกล้องดูเองด้วยนะคะ',
    SIGN,
  ]);
}

export function failureRecoveredMessage(ctx) {
  return pack([`👀 <b>น้องฝนกลับมามองเห็นแล้ว</b> เฝ้าต่อตามปกติค่ะ`, `🏠 ${esc(ctx.siteName)} · ${thaiDateTime(new Date(), ctx.timezone)}`, SIGN]);
}

export function cameraDownMessage(ctx, camera, streak, error) {
  return pack([
    `📷 <b>กล้อง ${esc(camera.name)} ดึงภาพไม่ได้ ${streak} รอบติดกัน</b>`,
    error ? `สาเหตุ: ${esc(error)}` : '',
    'กล้องอื่นยังเฝ้าต่อ แต่ถ้ากล้องนี้มีเส้นแดง น้องฝนจะตัดสินได้ไม่เต็มที่',
    SIGN,
  ]);
}

export function cameraBackMessage(ctx, camera) {
  return pack([`📷 <b>กล้อง ${esc(camera.name)} กลับมาแล้ว</b>`, SIGN]);
}

export function statusMessage(ctx, reading, extra = {}) {
  if (!reading) return pack(['ยังไม่มีผลการตรวจเลยค่ะ ลองส่ง /check', SIGN]);
  const status = STATUS_TH[reading.status] || reading.status;
  const cams = (reading.cameras || []).map((c) => `• ${esc(c.name)}: ${c.ok ? esc(c.note || lineStatusTh(c.lineStatus)) : `ดึงภาพไม่ได้ (${esc(c.error || '')})`}`);
  return pack([
    `💧 <b>สถานะ: ${status}</b> · ${levelText(reading.level)}`,
    `🏠 ${esc(ctx.siteName)} · ตรวจล่าสุด ${thaiDateTime(new Date(reading.ts), ctx.timezone)}`,
    reading.headline ? esc(reading.headline) : '',
    cams.join('\n'),
    trendLine(reading.trend),
    extra.pending ? '⏳ กำลังตรวจซ้ำเพื่อยืนยันเส้นแดง' : '',
    extra.snoozeUntil ? `😴 งดเสียงไซเรนถึง ${thaiTime(new Date(extra.snoozeUntil), ctx.timezone)}` : '',
    extra.muteLevel ? `😴 งดเสียงไซเรนจนกว่าน้ำจะลดต่ำกว่าระดับ${STATUS_TH[extra.muteLevel] || ''}` : '',
    extra.paused ? '⏸ ตอนนี้หยุดตรวจชั่วคราวอยู่' : '',
    SIGN,
  ]);
}

export function lineStatusTh(s) {
  return {
    no_lines: 'ยังไม่ได้ขีดเส้น',
    below_yellow: 'ยังไม่ถึงเส้น',
    at_yellow: 'ถึงเส้นเหลือง',
    at_red: 'ถึงเส้นแดง',
    cannot_tell: 'มองไม่เห็นขอบน้ำ',
    down: 'ดึงภาพไม่ได้',
  }[s] || s || '';
}

export function summaryMessage(ctx, s) {
  return pack([
    `🌙 <b>สรุปประจำวัน</b> · ${esc(ctx.siteName)}`,
    `ตรวจ ${s.checks} ครั้ง · สำเร็จ ${s.successPct}%`,
    s.maxLevel !== null ? `ระดับสูงสุด ${s.maxLevel}/100 (${esc(s.maxAt)})` : 'ยังไม่มีผลที่อ่านได้',
    `สถานะตอนนี้: ${esc(STATUS_TH[s.status] || s.status || '–')}`,
    s.alerts ? `แจ้งเตือนไป ${s.alerts} ครั้ง` : 'วันนี้ไม่มีเรื่องต้องปลุกค่ะ',
    s.costUsd !== null ? `ค่า AI 24 ชม. ≈ $${s.costUsd.toFixed(2)}${s.subscription ? ' (เทียบเท่า ใช้แพ็กเกจ)' : ''}` : '',
    'น้องฝนยังเฝ้าอยู่นะคะ 💙',
  ]);
}

export function helpMessage() {
  return pack([
    '☔ <b>น้องฝนเฝ้าบ้าน</b> สั่งได้แบบนี้ค่ะ',
    '/status — ดูสถานะล่าสุด + รูป',
    '/check — ตรวจเดี๋ยวนี้',
    '/stop — หยุดไซเรน',
    '/mute — งดเสียงไซเรนจนกว่าน้ำจะลด (ข้อความเตือนยังส่ง)',
    '/snooze 60 — งดเสียงไซเรน 60 นาที',
    '/resume — ยกเลิกงดเสียง',
    '/testsiren — ทดสอบไซเรน 3 วินาที (ดังที่หน้าข้างเตียง)',
    'หรือพิมพ์ไทยก็ได้: สถานะ · ตรวจ · หยุด · งดจนน้ำลด · เงียบ',
  ]);
}

export const ALERT_BUTTONS = [
  [
    { text: '🔕 หยุดไซเรน', callback_data: 'stop' },
    { text: '😴 งดเสียงจนน้ำลด', callback_data: 'mute' },
  ],
  [
    { text: '⏱ งด 1 ชม.', callback_data: 'snooze:60' },
    { text: '🔄 ตรวจอีกรอบ', callback_data: 'check' },
  ],
];

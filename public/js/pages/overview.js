// ภาพรวม: น้องฝนบอกว่าน้ำเป็นยังไงในประโยคเดียว + ถังวัดน้ำ + กล้องวงจรปิด + เรื่องราวคืนนี้
import {
  $, $$, STATUS, ago, api, duration, esc, fmtTime, icon, inMinutes, initChrome, listen, mountMascot, setSiteName,
  setTimeZone, statusOf, sticker, toast, usd, withBusy,
} from '../app.js';
import { moodFor } from '../mascot.js';
import { gaugeSvg, setGauge } from '../gauge.js';
import { CAM_COLORS, renderLevelChart, renderQualityChart } from '../chart.js';
import { createTile } from '../camtile.js';

initChrome();

const consoleEl = $('[data-console]');
const mascot = mountMascot($('[data-mascot]'), { mood: 'happy', size: 212, idSuffix: 'hero' });
$('[data-gauge]').innerHTML = gaugeSvg();

let state = null;
let range = 24;
let checking = false;
let rainMap = null;
const tiles = new Map();

const EVENT_ICON = { critical: '🚨', warning: '⚠️', recovery: '✅', failure: '📷', camera: '📷', siren: '🔔', pending: '⏳', summary: '🌙', hourly: '🕐', system: '⚙️' };
const CHANNEL_TH = { telegram: 'Telegram', line: 'LINE', webhook: 'Webhook', mqtt: 'MQTT' };

async function load() {
  try {
    state = await api('/api/status');
  } catch (err) {
    toast(err.message, { bad: true });
    return;
  }
  setTimeZone(state.site.timezone);
  setSiteName(state.site.name);
  render();
}

function render() {
  renderConsole();
  renderSetup();
  renderCams();
  renderTrend();
  renderHealth();
  renderCost();
  renderEvents();
  renderHourly();
  mountRain();
}

// ------------------------------------------------------------------ console
function recovered() {
  const e = (state.alerts || []).find((x) => ['recovery', 'critical', 'warning'].includes(x.kind));
  return e?.kind === 'recovery' && Date.now() - e.ts < 30 * 60e3;
}

function renderConsole() {
  const latest = state.latest;
  const status = statusOf(state);
  consoleEl.dataset.status = status;
  mascot.setMood(moodFor(latest?.status, {
    paused: state.next.paused, pending: Boolean(state.pending), checking, recovered: status === 'normal' && recovered(),
  }));

  const s = STATUS[status] || STATUS.unknown;
  let say = s.say;
  if (!['paused', 'pending'].includes(status) && latest?.headline) say = latest.headline;
  if (!latest) say = state.engine.problem ? 'ยังเชื่อม AI ไม่ได้ ดูหน้าตั้งค่าหน่อยนะคะ' : 'ยังไม่มีผลตรวจ กด “ตรวจเดี๋ยวนี้” ได้เลยค่ะ';
  let small = '';
  if (checking) small = 'กำลังถ่ายภาพและให้ AI ดูให้อยู่นะคะ…';
  else if (latest?.reasons?.length) small = latest.reasons.join(' · ');
  else if (status === 'normal') small = s.say;
  else if (latest?.ai?.error) small = latest.ai.error;
  $('[data-bubble]').innerHTML = `${esc(say)}<small>${esc(small) || '&nbsp;'}</small>`;

  const level = latest && latest.status !== 'unknown' ? latest.level : null;
  $('[data-level]').innerHTML = `${level ?? '–'}<sub>/100</sub>`;
  $('[data-sticker]').innerHTML = sticker(status);
  const dist = latest?.distance && latest.status !== 'unknown' ? latest.distance : '';
  const conf = latest?.confidence ? `AI มั่นใจ ${Math.round(latest.confidence * 100)}%` : '';
  $('[data-distance]').textContent = [dist, conf].filter(Boolean).join(' · ');
  setGauge($('[data-gauge]'), level);

  const siren = state.siren;
  $('[data-alarm]').hidden = !siren.on;
  if (siren.on) $('[data-alarm-text]').textContent = `ไซเรนกำลังดัง${siren.reason ? ` — ${siren.reason}` : ''}`;
  $('[data-stop]').hidden = !siren.on;
  const silenced = Boolean(siren.snoozeUntil || siren.muteLevel);
  $('[data-mute]').hidden = silenced;
  $('[data-snooze]').hidden = silenced;
  $('[data-unsnooze]').hidden = !silenced;
  $('[data-run] span').textContent = checking ? 'กำลังตรวจ…' : 'ตรวจเดี๋ยวนี้';
  $('[data-run]').toggleAttribute('aria-busy', checking);
  renderMeta();
}

function renderMeta() {
  if (!state) return;
  const latest = state.latest;
  const bits = [];
  if (latest) bits.push(`${icon('clock')}ตรวจล่าสุด <b>${esc(fmtTime(latest.ts))}</b> (${esc(ago(latest.ts))})`);
  if (state.next.paused) bits.push(`${icon('pause')}พักการตรวจอยู่`);
  else if (state.next.running || checking) bits.push('<span class="spinner" aria-hidden="true"></span>กำลังตรวจ');
  else if (state.next.at) bits.push(`${icon('play')}รอบถัดไปอีก <b>${esc(inMinutes(state.next.at))}</b> (ทุก ${state.next.intervalMin} นาที)`);
  if (state.siren.snoozeUntil) bits.push(`${icon('zzz')}งดเสียงถึง ${esc(fmtTime(state.siren.snoozeUntil))}`);
  if (state.siren.muteLevel) bits.push(`${icon('mute')}งดเสียงจนน้ำลดต่ำกว่าระดับ${esc(STATUS[state.siren.muteLevel]?.th || '')}`);
  $('[data-meta]').innerHTML = bits.map((b) => `<span>${b}</span>`).join('');
}

// ------------------------------------------------------------------ setup checklist
function renderSetup() {
  const items = state.setup;
  const required = items.filter((i) => !i.optional);
  const ready = required.filter((i) => i.done).length;
  $('[data-setup]').hidden = ready === required.length && !state.demo;
  $('[data-setup-count]').textContent = `พร้อมแล้ว ${ready}/${required.length}`;
  $('[data-setup-bar]').style.transform = `scaleX(${ready / required.length})`;
  const links = { cameras: '/settings#cameras', ai: '/settings#ai', lines: '/lines', notify: '/settings#telegram', site: '/settings#home', siren: '/settings#siren' };
  $('[data-setup-list]').innerHTML = items.filter((i) => !i.done).map((i) => `
    <li><span class="tick">${icon('check')}</span><div><b><a href="${links[i.key]}">${esc(i.title)}</a></b><span>${esc(i.hint)}</span></div></li>`).join('');
  $('[data-setup-done]').innerHTML = items.filter((i) => i.done).map((i) => `<span class="chip ok">${icon('check')}${esc(i.title)}</span>`).join('');
}

// ------------------------------------------------------------------ cameras
function renderCams() {
  const wrap = $('[data-cams]');
  const latest = state.latest;
  const cams = state.health.cameras;
  if (!cams.length) {
    wrap.innerHTML = `<div class="card cams-empty"><h3>ยังไม่มีกล้อง</h3>
      <p class="muted small">ใส่ <span class="code">CAMERA_1_NAME</span> และ <span class="code">CAMERA_1_URL</span> ในไฟล์ .env แล้วเริ่มโปรแกรมใหม่ — วิธีหาลิงก์กล้องแต่ละยี่ห้ออยู่ใน docs/cameras.md</p></div>`;
    return;
  }
  cams.forEach((c, i) => {
    if (!tiles.has(c.id)) {
      const tile = createTile(c, i);
      tiles.set(c.id, tile);
      wrap.append(tile.el);
    }
    const tile = tiles.get(c.id);
    tile.update(latest?.cameras?.find((x) => x.id === c.id) || null, latest?.ts);
    tile.scanning(checking);
  });
}

// ------------------------------------------------------------------ stats
function renderTrend() {
  const t = state.latest?.trend;
  const el = $('[data-trend]');
  if (!t) {
    el.innerHTML = '<p class="big-num">–</p><p class="muted small">ต้องมีผลตรวจต่อเนื่องสัก 15 นาทีก่อน น้องฝนถึงจะบอกแนวโน้มได้ค่ะ</p>';
    return;
  }
  const up = t.ratePerHour >= 2;
  const down = t.ratePerHour <= -2;
  const word = up ? 'กำลังขึ้น' : down ? 'กำลังลด' : 'ทรงตัว';
  const eta = up && t.etaRedMin !== null ? `ถึงเส้นแดงในราว <b>${esc(duration(t.etaRedMin))}</b>` : up && t.etaYellowMin !== null ? `ถึงเส้นเหลืองในราว <b>${esc(duration(t.etaYellowMin))}</b>` : '';
  el.innerHTML = `<p class="big-num">${t.ratePerHour > 0 ? '+' : ''}${t.ratePerHour}<small>/ชม.</small></p>
    <p>${up ? '📈' : down ? '📉' : '➖'} น้ำ${word}</p><p class="muted small">${eta || `จาก ${t.samples} ผลตรวจในชั่วโมงล่าสุด`}</p>`;
}

function renderHealth() {
  const h = state.health;
  const cams = h.cameras.map((c) => `<span class="chip ${c.ok === false ? 'bad' : c.ok ? 'ok' : ''}" title="${esc(c.error || '')}">${c.ok === false ? icon('x') : icon('check')}${esc(c.name)}${c.okPct !== null ? ` ${c.okPct}%` : ''}</span>`).join('');
  const tg = h.telegram && state.channels.telegram ? `<span class="chip ${h.telegram.ok === false ? 'bad' : h.telegram.ok ? 'ok' : ''}">Telegram ${h.telegram.ok === false ? 'ขัดข้อง' : h.telegram.ok ? 'พร้อม' : '…'}</span>` : '';
  $('[data-health]').innerHTML = `<dl class="kv">
      <dt>ตรวจไปแล้ว</dt><dd>${h.checks} ครั้ง</dd>
      <dt>อ่านผลได้</dt><dd>${h.okPct ?? '–'}%</dd>
      <dt>ความมั่นใจเฉลี่ย</dt><dd>${h.avgConfidence ?? '–'}%</dd>
      <dt>เวลาวิเคราะห์เฉลี่ย</dt><dd>${h.avgMs ? `${(h.avgMs / 1000).toFixed(1)} วิ` : '–'}</dd>
    </dl><div class="stat-chips">${cams}${tg}</div>`;
}

function renderCost() {
  const c = state.cost;
  const note = c.simulated ? 'ตัวเลขจำลองในโหมดสาธิต' : c.subscription ? 'ใช้แพ็กเกจ Claude — เป็นค่าเทียบเท่า ไม่ได้เก็บเงินเพิ่ม' : `โมเดล ${state.engine.model}`;
  $('[data-cost]').innerHTML = `<p class="big-num">${usd(c.today)}<small>วันนี้</small></p>
    <dl class="kv"><dt>24 ชม. ล่าสุด</dt><dd>${usd(c.last24h)}</dd><dt>ต่อการตรวจ 1 ครั้ง</dt><dd>${usd(c.perCheck, 4)}</dd><dt>ประมาณ 30 วัน</dt><dd>${usd(c.projected30d)}</dd></dl>
    <p class="muted small">${esc(note)}</p>`;
}

function renderEvents() {
  const list = state.alerts || [];
  $('[data-events]').innerHTML = list.length ? list.map((e) => {
    const chans = Object.entries(e.channels || {}).map(([k, r]) => `<span class="chip ${r.ok ? 'ok' : 'bad'}" title="${esc(r.error || '')}">${esc(CHANNEL_TH[k] || k)} ${r.ok ? '✓' : '✗'}</span>`).join('');
    const sub = e.text && !['critical', 'warning', 'recovery'].includes(e.kind) ? `<span>${esc(e.text.split('\n')[0].slice(0, 120))}</span>` : '';
    return `<li><span class="ev-ico ${esc(e.kind)}" aria-hidden="true">${EVENT_ICON[e.kind] || '•'}</span>
      <div><div class="ev-title">${esc(e.title)}</div><div class="ev-sub">${sub}${chans}</div></div>
      <time datetime="${new Date(e.ts).toISOString()}">${esc(fmtTime(e.ts))}</time></li>`;
  }).join('') : '<li class="empty">ยังเงียบสงบ ไม่มีอะไรต้องแจ้งค่ะ</li>';
}

// ------------------------------------------------------------------ hourly roll-up
const RISK = { low: ['normal', 'ความเสี่ยงต่ำ'], medium: ['warning', 'ความเสี่ยงปานกลาง'], high: ['critical', 'ความเสี่ยงสูง'] };
function renderHourly() {
  const el = $('[data-hourly]');
  const h = state.hourly;
  if (!h) {
    el.innerHTML = '<p class="muted small">น้องฝนจะสรุปน้ำที่บ้าน ฝน และข่าวน้ำท่วมให้ทุกต้นชั่วโมงค่ะ</p>';
    return;
  }
  const [cls, label] = RISK[h.risk] || ['unknown', 'ไม่ทราบ'];
  el.innerHTML = `<p class="small">${sticker(cls, { soft: true, label })} <span class="muted">${esc(h.title)} · เมื่อ ${esc(fmtTime(h.at))}</span></p>
    <ul class="hourly-lines">${(h.lines || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

// ------------------------------------------------------------------ rain map
async function mountRain() {
  const el = $('[data-rain]');
  const { latitude: lat, longitude: lon } = state.site;
  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    rainMap?.destroy?.();
    rainMap = null;
    el.innerHTML = '<p class="muted small">ใส่พิกัดบ้านใน <a href="/settings#home">ตั้งค่า</a> แล้วน้องฝนจะแสดงเรดาร์ฝนและพยากรณ์ 3 ชั่วโมงรอบบ้าน และตรวจห่างขึ้นในคืนที่ฟ้าโปร่งเพื่อประหยัดค่า AI</p>';
    return;
  }
  if (rainMap) return;
  rainMap = { pending: true };
  try {
    const { mountRainMap } = await import('../rain-map.js');
    rainMap = await mountRainMap(el, { lat, lon, radiusKm: 25, timeZone: state.site.timezone, fetchGrid: (r) => api(`/api/rain-forecast?radius=${r}`) });
  } catch (err) {
    rainMap = null;
    el.innerHTML = `<p class="muted small">แสดงแผนที่ฝนไม่ได้: ${esc(err.message)}</p>`;
  }
}

// ------------------------------------------------------------------ charts
let series = null;
let quality = null;
async function loadSeries() {
  try {
    [series, quality] = await Promise.all([api(`/api/series?hours=${range}`), api(`/api/quality?hours=${range}`)]);
    drawCharts();
  } catch (err) {
    $('[data-chart]').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function drawCharts() {
  if (series) {
    renderLevelChart($('[data-chart]'), { points: series.points, hours: series.hours, cameras: series.cameras });
    const legend = $('[data-legend]');
    legend.querySelectorAll('[data-cov-legend]').forEach((n) => n.remove());
    series.cameras.forEach((c, i) => legend.insertAdjacentHTML('beforeend', `<span data-cov-legend><i style="border-color:${CAM_COLORS[i % CAM_COLORS.length]}"></i>${esc(c.name)} พื้นที่น้ำท่วม %</span>`));
  }
  if (quality) {
    renderQualityChart($('[data-quality]'), { points: quality.points, hours: quality.hours, cameras: quality.cameras });
    $('[data-quality-legend]').innerHTML = quality.cameras.map((c, i) => `<span><i style="border-color:${CAM_COLORS[i % CAM_COLORS.length]};border-top-style:solid"></i>${esc(c.name)} ความสว่าง</span><span><i style="border-color:${CAM_COLORS[i % CAM_COLORS.length]}"></i>ความคมชัด (แกนขวา)</span>`).join('') + '<span><i style="border:0;height:10px;background:#3F63C8;opacity:.22"></i>ช่วงอินฟราเรด (กลางคืน)</span>';
  }
}

// ------------------------------------------------------------------ actions
$('[data-run]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  await api('/api/run', { method: 'POST' });
  checking = true;
  renderConsole();
  for (const t of tiles.values()) t.scanning(true);
}, { ok: 'เริ่มตรวจแล้ว รอผลสักครู่นะคะ' }));
$('[data-stop]').addEventListener('click', (e) => withBusy(e.currentTarget, () => api('/api/siren/stop', { method: 'POST' }), { ok: 'ปิดไซเรนแล้วค่ะ' }).then(load));
$('[data-mute]').addEventListener('click', (e) => withBusy(e.currentTarget, () => api('/api/siren/mute', { method: 'POST' }), { ok: 'งดเสียงไซเรนจนกว่าน้ำจะลด (ข้อความเตือนยังส่งตามปกติ)' }).then(load));
$('[data-snooze]').addEventListener('click', (e) => withBusy(e.currentTarget, () => api('/api/siren/snooze', { method: 'POST', body: { minutes: 60 } }), { ok: 'งดเสียงไซเรน 1 ชม. (ข้อความยังส่งตามปกติ)' }).then(load));
$('[data-unsnooze]').addEventListener('click', (e) => withBusy(e.currentTarget, () => api('/api/siren/unsnooze', { method: 'POST' }), { ok: 'เปิดเสียงเตือนคืนแล้ว' }).then(load));

for (const b of $$('[data-range]')) {
  b.addEventListener('click', () => {
    range = Number(b.dataset.range);
    for (const x of $$('[data-range]')) x.setAttribute('aria-pressed', String(x === b));
    loadSeries();
  });
}

// live views stop when the page is hidden (no one watching, no reason to keep ffmpeg busy)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') for (const t of tiles.values()) if (t.isLive()) t.setLive(false);
});

// ------------------------------------------------------------------ live updates
let pending = null;
const reload = () => {
  clearTimeout(pending);
  pending = setTimeout(load, 250);
};
listen({
  status: reload,
  siren: reload,
  checking: () => {
    checking = true;
    if (state) renderConsole();
    for (const t of tiles.values()) t.scanning(true);
  },
  reading: () => {
    checking = false;
    load();
    loadSeries();
  },
});
let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 200);
});
setInterval(renderMeta, 1000);
setInterval(load, 60000);
load();
loadSeries();

import {
  $, $$, LINE_STATUS_CLASS, STATUS, api, dayKey, esc, fmtDay, fmtTime, icon, initChrome, lineLabel, linesSvg, setSiteName,
  setTimeZone, sticker, toast, usd,
} from '../app.js';

initChrome();

let filter = 'all';
let oldest = null;
const byId = new Map();
const TRIGGER_TH = { schedule: 'ตามรอบ', manual: 'กดจากหน้าเว็บ', telegram: 'สั่งจาก Telegram', recheck: 'ตรวจซ้ำยืนยันเส้นแดง' };
const EVENT_ICON = { critical: '🚨', warning: '⚠️', recovery: '✅', failure: '📷', camera: '📷', siren: '🔔', pending: '⏳', summary: '🌙', hourly: '🕐', system: '⚙️' };
const CHANNEL_TH = { telegram: 'Telegram', line: 'LINE', webhook: 'Webhook', mqtt: 'MQTT' };

function lineSticker(c) {
  const cls = LINE_STATUS_CLASS[c.lineStatus] || 'unknown';
  return sticker(cls === 'paused' ? 'unknown' : cls, { soft: true, label: lineLabel(c.lineStatus, c.lines) });
}

function card(r) {
  const imgs = (r.cameras || []).filter((c) => c.ok && c.image).slice(0, 2);
  const thumbs = imgs.length
    ? imgs.map((c) => `<img src="/snap/${encodeURIComponent(c.image)}" alt="" loading="lazy">`).join('')
    : '<div class="noimg">ไม่มีภาพ (ลบตามรอบเก็บข้อมูล)</div>';
  const level = r.status === 'unknown' || r.level === null ? '–' : r.level;
  return `<button class="r-card" type="button" data-id="${esc(r.id)}" aria-label="ผลตรวจเวลา ${esc(fmtTime(r.ts))} ${esc(STATUS[r.status]?.th || '')}">
    <div class="r-thumbs">${thumbs}</div>
    <div class="r-row"><time>${esc(fmtTime(r.ts))}</time>${sticker(r.status, { soft: true })}<span class="lv">${level}</span></div>
    <p class="r-head">${esc(r.headline || r.reasons?.[0] || r.ai?.error || '')}</p>
  </button>`;
}

async function loadReadings(reset = false) {
  if (reset) {
    oldest = null;
    $('[data-readings]').innerHTML = '';
  }
  const q = new URLSearchParams({ limit: '48', status: filter });
  if (oldest) q.set('before', String(oldest));
  let data;
  try {
    data = await api(`/api/readings?${q}`);
  } catch (err) {
    toast(err.message, { bad: true });
    return;
  }
  const wrap = $('[data-readings]');
  if (reset && !data.readings.length) {
    wrap.innerHTML = '<p class="empty">ยังไม่มีผลตรวจในหมวดนี้ค่ะ</p>';
  }
  // group into days, continuing the last day group if it is already on screen
  let lastDay = wrap.lastElementChild?.dataset?.day || null;
  let grid = wrap.lastElementChild?.querySelector?.('.readings') || null;
  for (const r of data.readings) {
    byId.set(r.id, r);
    const day = dayKey(r.ts);
    if (day !== lastDay) {
      const section = document.createElement('section');
      section.dataset.day = day;
      section.innerHTML = `<h2 class="day-head">${esc(fmtDay(r.ts))}</h2><div class="readings"></div>`;
      wrap.append(section);
      grid = section.querySelector('.readings');
      lastDay = day;
    }
    grid.insertAdjacentHTML('beforeend', card(r));
    oldest = r.ts;
  }
  $('[data-more]').hidden = !data.more;
}

async function loadAlerts() {
  let data;
  try {
    data = await api('/api/alerts?limit=300');
  } catch (err) {
    toast(err.message, { bad: true });
    return;
  }
  $('[data-alerts]').innerHTML = data.alerts.length ? data.alerts.map((e) => {
    const chans = Object.entries(e.channels || {}).map(([k, r]) => `<span class="chip ${r.ok ? 'ok' : 'bad'}" title="${esc(r.error || '')}">${esc(CHANNEL_TH[k] || k)} ${r.ok ? '✓ ส่งแล้ว' : `✗ ${esc(r.error || 'ไม่สำเร็จ')}`}</span>`).join('');
    const open = e.readingId ? `<button class="btn small soft" type="button" data-open-reading="${esc(e.readingId)}">ดูผลตรวจ</button>` : '';
    return `<li><span class="ev-ico ${esc(e.kind)}" aria-hidden="true">${EVENT_ICON[e.kind] || '•'}</span>
      <div><div class="ev-title">${esc(e.title)}</div>
      ${e.text ? `<div class="ev-sub" style="white-space:pre-line">${esc(e.text)}</div>` : ''}
      <div class="ev-sub">${chans}${open}</div></div>
      <time datetime="${new Date(e.ts).toISOString()}">${esc(fmtDay(e.ts))}<br>${esc(fmtTime(e.ts))}</time></li>`;
  }).join('') : '<li class="empty">ยังไม่มีการแจ้งเตือนค่ะ</li>';
}

const AI_STATUS_TH = { normal: 'ปกติ', warning: 'เฝ้าระวัง', critical: 'อันตราย', unknown: 'มองไม่ออก' };

function camDetail(c, i) {
  const pic = c.ok && c.image
    ? `<div class="frame-inner"><img src="/snap/${encodeURIComponent(c.image)}" alt="ภาพจากกล้อง${esc(c.name)}">${linesSvg(c.lines)}</div><div class="hud" aria-hidden="true"></div>${c.night ? '<div class="hud-bl">🌙 IR</div>' : ''}`
    : `<div class="noimg" style="position:relative;aspect-ratio:16/9">${esc(c.error || 'ไม่มีภาพ')}</div>`;
  const cov = typeof c.coverage === 'number' ? `<span class="coverage"><i style="--p:${c.coverage}%"></i>ท่วม ${c.coverage}%</span>` : '';
  return `<article class="cam">
      <div class="cam-top"><span class="cam-id">CAM ${String(i + 1).padStart(2, '0')}</span><h3>${esc(c.name)}</h3><span class="spacer"></span>${c.ok ? lineSticker(c) : sticker('unknown', { soft: true, label: 'ดึงภาพไม่ได้' })}</div>
      <div class="frame">${pic}</div>
      <div class="cam-foot"><p class="small">${esc(c.note || '')}</p>${cov}</div>
    </article>`;
}

function showDetail(r) {
  $('[data-detail-title]').textContent = `ผลตรวจ ${fmtTime(r.ts)} · ${fmtDay(r.ts)}`;
  const cams = (r.cameras || []).map(camDetail).join('');
  const ai = r.ai || {};
  const u = ai.usage || {};
  const tokens = ai.usage ? `${(u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite5m || 0) + (u.cacheWrite1h || 0)} เข้า / ${u.output || 0} ออก${u.cacheRead ? ` (cache ${u.cacheRead})` : ''}` : '–';
  const hasPhoto = (r.cameras || []).some((c) => c.ok && c.image);
  $('[data-detail-body]').innerHTML = `
    <div class="detail-top">${sticker(r.status)}<span class="big-num">${r.status === 'unknown' || r.level === null ? '–' : r.level}<small>/100</small></span>
      ${r.distance ? `<span class="chip">${esc(r.distance)}</span>` : ''}
      ${r.confidence ? `<span class="chip">มั่นใจ ${Math.round(r.confidence * 100)}%</span>` : ''}<span class="chip">${esc(TRIGGER_TH[r.trigger] || r.trigger || '')}</span>
      ${r.aiStatus ? `<span class="chip" title="สิ่งที่ AI คิดเอง ก่อนเทียบกับเส้นของเจ้าของบ้าน">AI ว่า: ${esc(AI_STATUS_TH[r.aiStatus] || r.aiStatus)}</span>` : ''}</div>
    ${r.headline ? `<p class="bubble" style="max-width:none;margin-left:10px">${esc(r.headline)}</p>` : ''}
    ${r.reasons?.length ? `<ul style="margin:0;padding-left:1.2em">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="wall-grid">${cams}</div>
    ${hasPhoto ? `<details><summary class="small">ภาพรวมแบบที่ส่งไปแจ้งเตือน</summary><figure class="detail-photo" style="margin:10px 0 0"><img src="/api/readings/${encodeURIComponent(r.id)}/photo.jpg" alt="ภาพรวมทุกกล้องพร้อมแถบสถานะ" loading="lazy"></figure></details>` : ''}
    <dl class="kv" style="max-width:520px">
      <dt>ผู้วิเคราะห์</dt><dd>${esc(ai.engine || '–')}${ai.simulated ? ' (จำลอง)' : ''}</dd>
      <dt>โมเดล</dt><dd>${esc(ai.model || '–')}</dd>
      <dt>เวลาที่ใช้</dt><dd>${ai.ms ? `${(ai.ms / 1000).toFixed(1)} วินาที` : '–'}</dd>
      <dt>โทเคน</dt><dd>${esc(tokens)}</dd>
      <dt>ค่าใช้จ่าย</dt><dd>${usd(ai.costUsd, 4)}${ai.subscription ? ' (เทียบเท่า)' : ''}</dd>
      ${ai.error ? `<dt>ข้อผิดพลาด</dt><dd class="error-text">${esc(ai.error)}</dd>` : ''}
    </dl>`;
  // each picture keeps its own shape so the drawn lines stay on the right spot (CSP: no inline handlers)
  for (const img of $$('[data-detail-body] .frame-inner img')) {
    const fit = () => img.naturalWidth && img.parentNode.style.setProperty('--ar', `${img.naturalWidth} / ${img.naturalHeight}`);
    if (img.complete) fit();
    else img.addEventListener('load', fit, { once: true });
  }
  $('[data-detail]').showModal();
}

// ------------------------------------------------------------------ wiring
function selectTab(name) {
  for (const b of $$('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== name;
  if (name === 'alerts') loadAlerts();
}
for (const b of $$('[data-tab]')) b.addEventListener('click', () => {
  history.replaceState(null, '', b.dataset.tab === 'alerts' ? '#alerts' : '#');
  selectTab(b.dataset.tab);
});
for (const b of $$('[data-filter]')) {
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    for (const x of $$('[data-filter]')) x.setAttribute('aria-pressed', String(x === b));
    loadReadings(true);
  });
}
$('[data-more]').addEventListener('click', () => loadReadings(false));
$('[data-readings]').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-id]');
  const r = btn && byId.get(btn.dataset.id);
  if (r) showDetail(r);
});
$('[data-alerts]').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-open-reading]');
  if (!btn) return;
  const id = btn.dataset.openReading;
  const r = byId.get(id) || (await api(`/api/readings/${encodeURIComponent(id)}`).then((d) => d.reading).catch(() => null));
  if (r) showDetail(r);
  else toast('ไม่พบผลตรวจนี้ (อาจถูกลบตามรอบเก็บข้อมูลแล้ว)', { bad: true });
});
$('[data-detail-close]').addEventListener('click', () => $('[data-detail]').close());
$('[data-detail]').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

(async () => {
  try {
    const status = await api('/api/status');
    setTimeZone(status.site.timezone);
    setSiteName(status.site.name);
  } catch {
    /* keep defaults */
  }
  await loadReadings(true);
  if (location.hash === '#alerts') selectTab('alerts');
  const deep = new URLSearchParams(location.search).get('r');
  if (deep) {
    const r = byId.get(deep) || (await api(`/api/readings/${encodeURIComponent(deep)}`).then((d) => d.reading).catch(() => null));
    if (r) showDetail(r);
  }
})();

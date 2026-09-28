// One CCTV monitor tile: the latest snapshot (or the live stream), the owner's lines on
// top, a scouter-style HUD, and what น้องฝน saw in that camera. Built once per camera and
// updated in place, so a live stream is never restarted by a routine refresh.
import { LINE_STATUS_CLASS, api, esc, fmtTime, icon, lineLabel, linesSvg, sticker, toast } from './app.js';

const LIVE_LIMIT_MS = 14 * 60e3; // the server ends a live view after 15 min; stop just before
const WATCH_MS = 5000;

// A browser <img> never reports a live stream that dies after its first frame (the picture just
// freezes), so while anything is live we ask the server which streams are really running.
const watched = new Set();
let watchTimer = null;
async function watchStreams() {
  let stats;
  try {
    stats = await api('/api/live');
  } catch {
    return; // offline for a moment: keep what we have
  }
  for (const tile of watched) {
    if (!tile.isLive() || Date.now() - tile.liveSince() < WATCH_MS) continue;
    const s = stats.streams?.find((x) => x.id === tile.cam.id);
    if (!s || s.running === false) {
      tile.setLive(false);
      toast(`ภาพสดกล้อง${tile.cam.name}หลุด${s?.error ? `: ${s.error}` : ''} — กดดูสดใหม่ได้เลยค่ะ`, { bad: true, ms: 7000 });
    }
  }
}
function watch(tile, on) {
  if (on) watched.add(tile);
  else watched.delete(tile);
  if (watched.size && !watchTimer) watchTimer = setInterval(watchStreams, WATCH_MS);
  if (!watched.size && watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

const pad = (n) => String(n).padStart(2, '0');

export function createTile(cam, index) {
  const el = document.createElement('article');
  el.className = 'cam';
  el.dataset.cam = cam.id;
  el.innerHTML = `
    <div class="cam-top"><span class="cam-id">CAM ${pad(index + 1)}</span><h3>${esc(cam.name)}</h3><span class="spacer"></span><span data-line></span></div>
    <div class="frame" data-frame>
      <div class="frame-inner" data-inner>
        <img data-img alt="ภาพจากกล้อง${esc(cam.name)}" hidden>
        <div data-lines></div>
      </div>
      <div class="noimg" data-noimg>${icon('cctv')}<span>ยังไม่มีภาพ</span></div>
      <div class="hud" aria-hidden="true"></div>
      <div class="hud-tr" data-hud-tr></div>
      <div class="hud-bl" data-hud-bl aria-hidden="true"></div>
      <div class="hud-br">
        <button class="frame-btn" type="button" data-live aria-pressed="false" aria-label="ดูสดกล้อง${esc(cam.name)}" title="ดูสด">${icon('live')}</button>
        <button class="frame-btn" type="button" data-lines-toggle aria-pressed="true" aria-label="แสดงเส้นเตือน" title="แสดง/ซ่อนเส้น">${icon('lines')}</button>
        <button class="frame-btn" type="button" data-expand aria-label="ดูเต็มจอ ${esc(cam.name)}" title="เต็มจอ">${icon('expand')}</button>
      </div>
    </div>
    <div class="cam-foot"><p data-note class="small"></p><span class="coverage" data-cov hidden></span></div>`;

  const $ = (s) => el.querySelector(s);
  const img = $('[data-img]');
  const inner = $('[data-inner]');
  const frame = $('[data-frame]');
  const liveBtn = $('[data-live]');
  let snapSrc = '';
  let live = false;
  let liveTimer = null;
  let liveSince = 0;
  let lastTs = null;
  let self = null;

  img.addEventListener('load', () => {
    if (img.naturalWidth && img.naturalHeight) {
      inner.style.setProperty('--ar', `${img.naturalWidth} / ${img.naturalHeight}`);
      inner.style.setProperty('--arn', String(img.naturalWidth / img.naturalHeight));
    }
    img.hidden = false;
    $('[data-noimg]').hidden = true;
  });
  img.addEventListener('error', () => {
    if (live) {
      setLive(false);
      toast(`ดูสดกล้อง${cam.name}ไม่ได้ — กล้องอาจไม่ตอบ หรือเปิดดูสดพร้อมกันหลายจอเกินไป ลองใหม่อีกครั้งนะคะ`, { bad: true, ms: 6000 });
    } else if (snapSrc) {
      img.hidden = true;
      $('[data-noimg]').hidden = false;
      $('[data-noimg] span').textContent = 'ภาพนี้ถูกลบตามรอบเก็บข้อมูลแล้ว';
    }
  });

  function hudTopRight() {
    $('[data-hud-tr]').innerHTML = live
      ? '<span class="live-dot">LIVE</span>'
      : lastTs ? `<span class="snap-tag">ภาพ ${esc(fmtTime(lastTs))}</span>` : '';
  }

  function setLive(on) {
    live = on;
    clearTimeout(liveTimer);
    liveBtn.setAttribute('aria-pressed', String(on));
    liveBtn.title = on ? 'หยุดดูสด' : 'ดูสด';
    liveBtn.innerHTML = icon(on ? 'stop' : 'live');
    liveSince = on ? Date.now() : 0;
    watch(self, on);
    if (on) {
      img.src = `/api/cameras/${encodeURIComponent(cam.id)}/live.mjpeg?t=${Date.now()}`;
      liveTimer = setTimeout(() => {
        setLive(false);
        toast(`หยุดดูสดกล้อง${cam.name}อัตโนมัติ (ครบ 15 นาที) กดดูสดต่อได้เลยค่ะ`);
      }, LIVE_LIMIT_MS);
    } else {
      // an empty src closes the stream connection before we show the snapshot again
      img.removeAttribute('src');
      if (snapSrc) img.src = snapSrc;
    }
    hudTopRight();
    el.dispatchEvent(new CustomEvent('live-change', { bubbles: true, detail: { id: cam.id, live: on } }));
  }

  liveBtn.addEventListener('click', () => setLive(!live));
  $('[data-lines-toggle]').addEventListener('click', (e) => {
    const on = frame.classList.toggle('hide-lines');
    e.currentTarget.setAttribute('aria-pressed', String(!on));
  });
  $('[data-expand]').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => toast('เบราว์เซอร์นี้เปิดเต็มจอไม่ได้', { bad: true }));
  });

  /** reading: the camera's entry in the latest reading ({ ok, image, lines, lineStatus, note, coverage, night, error }) */
  function update(reading, ts, fallbackLines) {
    lastTs = ts || null;
    const lines = reading?.lines || fallbackLines || {};
    $('[data-lines]').innerHTML = linesSvg(lines);
    const status = reading?.ok === false ? 'down' : reading?.lineStatus;
    const cls = LINE_STATUS_CLASS[status] || 'unknown';
    $('[data-line]').innerHTML = status ? sticker(cls === 'paused' ? 'unknown' : cls, { soft: true, label: lineLabel(status, lines) }) : '';
    const note = reading?.ok === false ? `ดึงภาพไม่ได้: ${reading.error || 'กล้องไม่ตอบ'}` : reading?.note || (reading ? '' : 'ยังไม่มีผลตรวจจากกล้องนี้');
    $('[data-note]').textContent = note;
    const cov = $('[data-cov]');
    if (typeof reading?.coverage === 'number') {
      cov.hidden = false;
      cov.innerHTML = `<i style="--p:${Math.max(0, Math.min(100, reading.coverage))}%"></i>ท่วม ${reading.coverage}%`;
      cov.title = 'พื้นที่ที่มองเห็นซึ่งมีน้ำขัง';
    } else cov.hidden = true;
    $('[data-hud-bl]').textContent = reading?.night ? '🌙 IR' : '';
    const next = reading?.ok && reading.image ? `/snap/${encodeURIComponent(reading.image)}` : '';
    if (next !== snapSrc) {
      snapSrc = next;
      if (!live) {
        if (snapSrc) img.src = snapSrc;
        else {
          img.hidden = true;
          $('[data-noimg]').hidden = false;
          $('[data-noimg] span').textContent = reading?.ok === false ? 'ดึงภาพไม่ได้' : 'ยังไม่มีภาพ';
        }
      }
    }
    hudTopRight();
  }

  function scanning(on) {
    frame.classList.toggle('scanning', Boolean(on));
  }

  self = { el, update, setLive, isLive: () => live, liveSince: () => liveSince, scanning, cam };
  return self;
}

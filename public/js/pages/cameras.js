// ดูกล้อง: จอ CCTV ทุกกล้อง ดูสดพร้อมเส้นเตือน และผลที่น้องฝนเห็นล่าสุด
import { $, $$, api, esc, fmtTime, initChrome, listen, setSiteName, setTimeZone, statusOf, sticker, toast, withBusy } from '../app.js';
import { createTile } from '../camtile.js';

initChrome();

// The server runs up to 4 streams, but a browser keeps only ~6 connections per site and the
// event stream and page requests need some, so a page opens at most 3 live pictures by itself.
const MAX_LIVE = 3;
const tiles = new Map();
let state = null;
let wantLive = true; // what the viewer asked for with the "all" button
let resumeOnShow = [];

function render() {
  const wall = $('[data-wall]');
  const cams = state.health.cameras;
  if (!cams.length) {
    wall.innerHTML = `<div class="card cams-empty"><h2>ยังไม่มีกล้อง</h2><p class="muted small">ใส่ <span class="code">CAMERA_1_NAME</span> และ <span class="code">CAMERA_1_URL</span> ในไฟล์ .env แล้วเริ่มโปรแกรมใหม่</p></div>`;
    return;
  }
  const latest = state.latest;
  cams.forEach((c, i) => {
    if (!tiles.has(c.id)) {
      const tile = createTile(c, i);
      tiles.set(c.id, tile);
      wall.append(tile.el);
      if (wantLive && i < MAX_LIVE) tile.setLive(true);
    }
    tiles.get(c.id).update(latest?.cameras?.find((x) => x.id === c.id) || null, latest?.ts);
  });
  const status = statusOf(state);
  $('[data-strip]').innerHTML = `${sticker(status)}${latest ? `<span>ระดับ <b>${latest.status === 'unknown' ? '–' : latest.level ?? '–'}</b>/100 · ตรวจล่าสุด ${esc(fmtTime(latest.ts))}</span>` : ''}`;
  syncAllButton();
}

function syncAllButton() {
  const anyLive = [...tiles.values()].some((t) => t.isLive());
  const btn = $('[data-all-live]');
  btn.setAttribute('aria-pressed', String(anyLive));
  btn.querySelector('span').textContent = anyLive ? 'หยุดดูสดทั้งหมด' : 'ดูสดทั้งหมด';
}

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

$('[data-all-live]').addEventListener('click', () => {
  const anyLive = [...tiles.values()].some((t) => t.isLive());
  wantLive = !anyLive;
  [...tiles.values()].forEach((t, i) => t.setLive(wantLive && i < MAX_LIVE));
  if (wantLive && tiles.size > MAX_LIVE) toast(`ดูสดพร้อมกันได้ ${MAX_LIVE} กล้อง กล้องที่เหลือกดดูสดทีละตัวได้ค่ะ`);
  syncAllButton();
});
for (const b of $$('[data-layout]')) {
  b.addEventListener('click', () => {
    $('[data-wall]').classList.toggle('one', b.dataset.layout === 'one');
    for (const x of $$('[data-layout]')) x.setAttribute('aria-pressed', String(x === b));
  });
}
$('[data-run]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  await api('/api/run', { method: 'POST' });
  for (const t of tiles.values()) t.scanning(true);
}, { ok: 'เริ่มตรวจแล้ว รอผลสักครู่นะคะ' }));
document.addEventListener('live-change', syncAllButton);

// nobody watching a hidden tab: stop the streams, and bring them back when the tab returns
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    resumeOnShow = [...tiles.values()].filter((t) => t.isLive());
    resumeOnShow.forEach((t) => t.setLive(false));
  } else {
    resumeOnShow.forEach((t) => t.setLive(true));
    resumeOnShow = [];
  }
});

listen({
  checking: () => {
    for (const t of tiles.values()) t.scanning(true);
  },
  reading: () => {
    for (const t of tiles.values()) t.scanning(false);
    load();
  },
  status: load,
});
setInterval(load, 60000);
load();

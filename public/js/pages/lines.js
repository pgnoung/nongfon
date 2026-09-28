import { $, $$, api, esc, icon, initChrome, mountAvatar, setSiteName, toast, withBusy } from '../app.js';

initChrome();
mountAvatar($('[data-tip-mascot]'), { size: 64, idSuffix: 'tip' });

const COLORS = { safe: '#3DF5A0', warning: '#FFD60A', critical: '#FF3358' };
const KINDS = ['safe', 'warning', 'critical'];
const NAME_TH = { safe: 'เส้นเขียว', warning: 'เส้นเหลือง', critical: 'เส้นแดง' };
const emptyLines = () => ({ safe: [], warning: [], critical: [] });
const img = $('[data-img]');
const svg = $('[data-svg]');
const noimg = $('[data-noimg]');

let cameras = [];
let cam = null;
let image = null;
let lines = emptyLines();
let saved = '';
let pen = 'warning';
let undo = [];
let drag = null;
let vbH = 562.5;

const clone = (v) => JSON.parse(JSON.stringify(v));
const dirty = () => JSON.stringify(lines) !== saved;

function pushUndo() {
  undo.push(clone(lines));
  if (undo.length > 60) undo.shift();
}

// ------------------------------------------------------------------ drawing
function draw() {
  let out = '';
  for (const kind of KINDS) {
    const pts = lines[kind];
    const color = COLORS[kind];
    const d = pts.map(([x, y]) => `${(x * 1000).toFixed(1)},${(y * vbH).toFixed(1)}`).join(' ');
    if (pts.length >= 2) {
      out += `<polyline points="${d}" fill="none" stroke="#10123a" stroke-opacity=".55" stroke-width="9" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
      out += `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="4.5" stroke-dasharray="14 8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    }
    pts.forEach(([x, y], i) => {
      const active = kind === pen;
      out += `<circle class="handle" data-kind="${kind}" data-i="${i}" cx="${x * 1000}" cy="${y * vbH}" r="${active ? 11 : 7}" fill="${color}" stroke="#10123a" stroke-width="3" opacity="${active ? 1 : 0.75}"/>`;
    });
  }
  svg.innerHTML = out;
  const parts = KINDS.filter((k) => k !== 'safe' || lines.safe.length).map((k) => `${NAME_TH[k]} ${lines[k].length} จุด`);
  $('[data-count]').textContent = `${parts.join(' · ')}${dirty() ? ' · ยังไม่บันทึก' : ''}`;
}

function toPoint(e) {
  const rect = svg.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  return [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4];
}

let pressTimer = null;
svg.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const handle = e.target.closest('.handle');
  if (handle) {
    const kind = handle.dataset.kind;
    const i = Number(handle.dataset.i);
    pushUndo();
    drag = { kind, i, moved: false, id: e.pointerId };
    svg.setPointerCapture(e.pointerId);
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (drag && !drag.moved) {
        lines[drag.kind].splice(drag.i, 1);
        drag = null;
        draw();
        toast('ลบจุดแล้ว');
      }
    }, 650);
    return;
  }
  pushUndo();
  lines[pen].push(toPoint(e));
  draw();
});
svg.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.moved = true;
  clearTimeout(pressTimer);
  lines[drag.kind][drag.i] = toPoint(e);
  draw();
});
const endDrag = () => {
  clearTimeout(pressTimer);
  if (drag && !drag.moved) undo.pop(); // a tap on a handle changed nothing
  drag = null;
};
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
svg.addEventListener('dblclick', (e) => {
  const handle = e.target.closest('.handle');
  if (!handle) return;
  pushUndo();
  lines[handle.dataset.kind].splice(Number(handle.dataset.i), 1);
  draw();
});

// ------------------------------------------------------------------ tools
for (const b of $$('[data-pen]')) {
  b.addEventListener('click', () => {
    pen = b.dataset.pen;
    for (const x of $$('[data-pen]')) x.setAttribute('aria-pressed', String(x === b));
    draw();
  });
}
function doUndo() {
  const prev = undo.pop();
  if (prev) {
    lines = prev;
    draw();
  }
}
$('[data-undo]').addEventListener('click', doUndo);
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && document.activeElement?.tagName !== 'TEXTAREA') {
    e.preventDefault();
    doUndo();
  }
});
$('[data-clear]').addEventListener('click', () => {
  if (!lines[pen].length) return;
  pushUndo();
  lines[pen] = [];
  draw();
});

$('[data-save]').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    for (const kind of KINDS) {
      if (lines[kind].length === 1) throw new Error(`${NAME_TH[kind]}มีจุดเดียว — ต้องมีอย่างน้อย 2 จุด`);
    }
    const out = await api(`/api/cameras/${cam.id}/lines`, { method: 'POST', body: lines });
    lines = { ...emptyLines(), ...clone(out.meta.lines) };
    saved = JSON.stringify(lines);
    cam.meta = out.meta;
    draw();
    flash($('[data-saved]'));
  }, { ok: 'บันทึกเส้นแล้ว น้องฝนจะใช้เส้นนี้ตั้งแต่รอบถัดไปค่ะ' }));

$('[data-fresh]').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const out = await api(`/api/cameras/${cam.id}/snapshot`, { method: 'POST' });
    showImage(out.image);
  }, { ok: 'ได้ภาพใหม่แล้ว', fail: 'ถ่ายภาพไม่สำเร็จ' }));

function flash(el) {
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

// ------------------------------------------------------------------ note + references
let noteTimer = null;
$('[data-note]').addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    try {
      const out = await api(`/api/cameras/${cam.id}/note`, { method: 'POST', body: { note: $('[data-note]').value } });
      cam.meta = out.meta;
      flash($('[data-note-saved]'));
    } catch (err) {
      toast(err.message, { bad: true });
    }
  }, 700);
});

function renderRefs() {
  const refs = cam.meta.refs || {};
  $('[data-refs]').innerHTML = ['day', 'night'].map((kind) => {
    const name = refs[kind];
    const label = kind === 'day' ? '☀️ กลางวัน' : '🌙 กลางคืน';
    return `<div class="ref">${name ? `<img src="/ref/${encodeURIComponent(name)}" alt="ภาพอ้างอิง${label}"><button class="icon-btn" type="button" data-del-ref="${kind}" aria-label="ลบภาพอ้างอิง${label}">${icon('trash')}</button>` : `<span>ยังไม่มีภาพ${label.slice(2)}</span>`}<span class="ref-label">${label}</span></div>`;
  }).join('');
}
$('[data-refs]').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-ref]');
  if (!b) return;
  await withBusy(b, async () => {
    const out = await api(`/api/cameras/${cam.id}/reference/${b.dataset.delRef}`, { method: 'DELETE' });
    cam.meta = out.meta;
    renderRefs();
  }, { ok: 'ลบภาพอ้างอิงแล้ว' });
});
$('[data-set-ref]').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    if (!image) throw new Error('ยังไม่มีภาพ — กด “ถ่ายภาพใหม่” ก่อน');
    const out = await api(`/api/cameras/${cam.id}/reference`, { method: 'POST', body: { image, kind: 'auto' } });
    cam.meta = out.meta;
    renderRefs();
    return out.kind;
  }, { ok: (kind) => `ตั้งเป็นภาพอ้างอิง${kind === 'night' ? 'กลางคืน' : 'กลางวัน'}แล้ว` }));

// ------------------------------------------------------------------ camera selection
function showImage(name) {
  image = name;
  if (!name) {
    img.hidden = true;
    svg.setAttribute('hidden', '');
    noimg.hidden = false;
    noimg.innerHTML = 'ยังไม่มีภาพจากกล้องนี้<br>กด “ถ่ายภาพใหม่” เพื่อดึงภาพมาขีดเส้น';
    return;
  }
  img.onload = () => {
    vbH = (1000 * img.naturalHeight) / img.naturalWidth;
    svg.setAttribute('viewBox', `0 0 1000 ${vbH}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    img.hidden = false;
    svg.removeAttribute('hidden'); // SVG elements have no .hidden property
    noimg.hidden = true;
    draw();
  };
  img.onerror = () => {
    noimg.hidden = false;
    noimg.textContent = 'โหลดภาพไม่ได้ ลองกด “ถ่ายภาพใหม่”';
  };
  img.src = `/snap/${encodeURIComponent(name)}`;
  img.alt = `ภาพจากกล้อง ${cam.name}`;
}

function selectCamera(id) {
  if (cam && dirty() && !confirm('เส้นของกล้องนี้ยังไม่ได้บันทึก จะเปลี่ยนกล้องเลยไหม?')) return;
  cam = cameras.find((c) => c.id === id);
  for (const b of $$('[data-cam]')) b.setAttribute('aria-pressed', String(b.dataset.cam === id));
  lines = { ...emptyLines(), ...clone(cam.meta.lines) };
  saved = JSON.stringify(lines);
  undo = [];
  $('[data-note]').value = cam.meta.note || '';
  renderRefs();
  showImage(cam.last?.ok ? cam.last.image : null);
  history.replaceState(null, '', `#${id}`);
}

addEventListener('beforeunload', (e) => {
  if (cam && dirty()) e.preventDefault();
});

(async () => {
  try {
    const [data, status] = await Promise.all([api('/api/cameras'), api('/api/status')]);
    setSiteName(status.site.name);
    cameras = data.cameras;
  } catch (err) {
    toast(err.message, { bad: true });
    return;
  }
  if (!cameras.length) {
    noimg.innerHTML = 'ยังไม่มีกล้อง — ใส่ <span class="code">CAMERA_1_URL</span> ในไฟล์ .env ก่อนนะคะ';
    for (const b of $$('.editor button')) b.disabled = true;
    return;
  }
  $('[data-cam-tabs]').innerHTML = cameras.map((c) => `<button type="button" data-cam="${esc(c.id)}" aria-pressed="false">${esc(c.name)}</button>`).join('');
  for (const b of $$('[data-cam]')) b.addEventListener('click', () => selectCamera(b.dataset.cam));
  const fromHash = location.hash.slice(1);
  selectCamera(cameras.some((c) => c.id === fromHash) ? fromHash : cameras[0].id);
})();

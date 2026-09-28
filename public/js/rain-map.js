// Rain map around the house: RainViewer past radar (animated) and the Open-Meteo 3-hour forecast
// grid from GET /api/rain-forecast, on a vendored Leaflet map. Port of NamMaLaew's rain_radar.js.
// Remote data reaches the page only through textContent, DOM nodes or Leaflet options — never innerHTML.

const LEAFLET_DIR = '/static/vendor/leaflet';
const OWN_CSS = '/static/css/rain-map.css';
const ICONS = '/static/img/icons.svg';
const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_HOST = 'https://tilecache.rainviewer.com';
const SAFE_RADAR_HOST = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.rainviewer\.com$/i;
const SAFE_RADAR_PATH = /^\/[\w./-]+$/;
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';
// Same tiles as upstream: RainViewer only serves real tiles up to z7, Leaflet scales them up past that.
// RainViewer and Open-Meteo are credited in the line under the map, which keeps the attribution one line on phones.
const RADAR_TILES = { tileSize: 256, maxNativeZoom: 7, maxZoom: 12, opacity: 0, zIndex: 5, className: 'rm-radar' };
const RADII = [10, 25, 50];
const MODES = [
  { id: 'radar', label: 'เรดาร์' },
  { id: '1', label: '+1 ชม.' },
  { id: '2', label: '+2 ชม.' },
  { id: '3', label: '+3 ชม.' },
];
// Hourly intensity bands as upstream (< 1, 1–2.5, 2.5–7.6, ≥ 7.6 mm/h); under 0.1 mm counts as dry.
const BANDS = [
  { below: 1, name: 'ปรอยๆ', range: '< 1' },
  { below: 2.5, name: 'เบา', range: '1–2.5' },
  { below: 7.6, name: 'ปานกลาง', range: '2.5–7.6' },
  { below: Infinity, name: 'หนัก', range: '≥ 7.6' },
];
const DRY_MM = 0.1;
const REFRESH_MS = 10 * 60e3;
const FRAME_MS = 600;
const LAST_FRAME_MS = 1500;
const RADAR_OPACITY = 0.6;
const FETCH_TIMEOUT_MS = 15e3;
const KM_PER_DEG = 111.32;
const HOUR_MS = 3600e3;
const PIN_BODY = 'M18 44C12 37 3 28 3 17A15 15 0 0 1 33 17C33 28 24 37 18 44Z';
const PIN_HOUSE = 'M18 8.5 9 16.3h2.6V25h4.6v-5.2h3.6V25h4.6v-8.7H27Z';
const TEXT = {
  loading: 'กำลังโหลดแผนที่…',
  noLeaflet: 'โหลดแผนที่ไม่ได้ ลองใหม่อีกครั้งนะคะ',
  noLocation: 'ยังไม่ได้ใส่พิกัดบ้าน ใส่ละติจูด/ลองจิจูดในหน้าตั้งค่า แล้วน้องฝนจะดูฝนรอบบ้านให้ค่ะ',
  offline: 'ตอนนี้ออฟไลน์อยู่ พอต่อเน็ตได้ น้องฝนจะโหลดแผนที่ฝนให้ใหม่เองค่ะ',
  radarDown: 'เรดาร์ยังไม่พร้อม น้องฝนจะลองใหม่เองทุก 10 นาทีค่ะ',
  gridDown: 'ดึงพยากรณ์ฝนไม่ได้ ลองกดใหม่อีกครั้งนะคะ',
};

const mounted = new WeakMap();

/**
 * Mount the rain map into `el`. Never throws for network or data problems — those become a
 * friendly Thai message inside `el`, so the rest of the dashboard keeps working.
 * fetchGrid(radiusKm) must resolve to the JSON of GET /api/rain-forecast?radius=R.
 */
export async function mountRainMap(el, options = {}) {
  mounted.get(el)?.destroy();
  const view = new RainMap(el, options);
  mounted.set(el, view);
  await view.start();
  return { setRadius: (r) => view.setRadius(r), destroy: () => view.destroy() };
}

class RainMap {
  constructor(el, { lat, lon, radiusKm = 25, fetchGrid, timeZone = 'Asia/Bangkok' } = {}) {
    this.host = el;
    this.lat = num(lat);
    this.lon = num(lon);
    this.radius = RADII.includes(Number(radiusKm)) ? Number(radiusKm) : 25;
    this.fetchGrid = fetchGrid;
    this.clock = clockFormat(timeZone);
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.playing = !this.reducedMotion;
    this.mode = 'radar';
    this.frames = []; // [{ at, url, layer }] oldest first
    this.frame = 0;
    this.radarError = null;
    this.grid = null;
    this.gridError = null;
    this.gridSeq = 0;
    this.cells = [];
    this.timers = { anim: 0, refresh: 0 };
    this.destroyed = false;
    this.ui = buildView();
    this.bindUi();
  }

  async start() {
    if (!this.ui.root.isConnected) {
      // attach only once our CSS is in, so nothing flashes unstyled (unstyled still beats nothing)
      await loadCss(OWN_CSS).catch(() => {});
      if (this.destroyed) return;
      this.host.append(this.ui.root);
    }
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      this.showMessage(TEXT.noLocation, { href: '/settings#home', label: 'ไปหน้าตั้งค่า', fatal: true });
      return;
    }
    this.showMessage(TEXT.loading, { busy: true });
    try {
      this.L = await loadLeaflet();
    } catch {
      if (!this.destroyed) this.showMessage(TEXT.noLeaflet, { retry: true, fatal: true });
      return;
    }
    if (this.destroyed || this.map) return;
    this.initMap();
    this.listen();
    this.refresh();
    this.render();
  }

  // ---------------------------------------------------------------- setup
  bindUi() {
    const { modeBtns, radiusBtns, play } = this.ui;
    for (const [id, btn] of modeBtns) btn.addEventListener('click', () => this.setMode(id));
    for (const [r, btn] of radiusBtns) btn.addEventListener('click', () => this.setRadius(r));
    play.addEventListener('click', () => this.togglePlay());
  }

  initMap() {
    const { L } = this;
    const still = this.reducedMotion;
    const map = L.map(this.ui.map, {
      center: [this.lat, this.lon], zoom: 9, maxZoom: 12, zoomControl: false, scrollWheelZoom: false,
      zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still,
    });
    L.control.zoom({ position: 'topright', zoomInTitle: 'ซูมเข้า', zoomOutTitle: 'ซูมออก' }).addTo(map);
    L.tileLayer(OSM_TILES, {
      maxZoom: 19, className: 'rm-osm', attribution: OSM_CREDIT,
      // the dashboard sends Referrer-Policy: same-origin, and OSM blocks tiles that arrive with no Referer
      referrerPolicy: 'strict-origin-when-cross-origin',
    }).addTo(map);
    this.ring = L.circle([this.lat, this.lon], { radius: this.radius * 1000, className: 'rm-ring', interactive: false }).addTo(map);
    this.pin = L.marker([this.lat, this.lon], { icon: pinIcon(L), interactive: false, keyboard: false }).addTo(map);
    this.map = map;
    this.ui.root.classList.remove('rm-dead');
    this.ui.msg.hidden = true;
    this.fit();
    if (typeof ResizeObserver === 'function') {
      // a map mounted while hidden has no size; fit it once it gets one
      this.observer = new ResizeObserver(() => {
        map.invalidateSize();
        if (!this.fitted) this.fit();
      });
      this.observer.observe(this.ui.map);
    }
  }

  listen() {
    this.onOnline = () => this.refresh();
    this.onOffline = () => this.render();
    addEventListener('online', this.onOnline);
    addEventListener('offline', this.onOffline);
    this.timers.refresh = setInterval(() => this.refresh(), REFRESH_MS);
  }

  refresh() {
    this.loadRadar();
    this.loadGrid();
  }

  fit() {
    const size = this.map.getSize();
    this.fitted = size.x > 0 && size.y > 0;
    // the outer forecast cells reach half a cell past the ring (2r + r/2 across), so fit all of them
    if (this.fitted) this.map.fitBounds(this.L.latLng(this.lat, this.lon).toBounds(this.radius * 2500));
  }

  // ---------------------------------------------------------------- controls
  setMode(id) {
    if (!this.map || this.ui.modeBtns.get(id)?.disabled) return;
    if (id === this.mode && (id === 'radar' || this.grid)) return;
    this.mode = id;
    if (id === 'radar') {
      this.showRadar();
    } else {
      this.hideRadar();
      if (this.grid) this.drawCells();
      else this.loadGrid();
    }
    this.render();
  }

  setRadius(r) {
    const radius = Number(r);
    if (!this.map || !RADII.includes(radius) || radius === this.radius) return;
    this.radius = radius;
    this.ring.setRadius(radius * 1000);
    this.fit();
    // the grid we hold belongs to the old radius, so drop it in every mode (as upstream)
    this.grid = null;
    this.gridError = null;
    this.clearCells();
    this.syncForecastButtons();
    this.loadGrid();
    this.render();
  }

  togglePlay() {
    if (this.mode !== 'radar' || !this.frames.length) return;
    this.playing = !this.playing;
    this.stopAnim();
    if (this.playing) this.tick();
    else this.showFrame(this.frame);
    this.renderPlay();
  }

  // ---------------------------------------------------------------- radar
  async loadRadar() {
    try {
      const res = await fetch(RADAR_INDEX, { signal: timeoutSignal() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const frames = radarFrames(await res.json());
      if (!frames.length) throw new Error('no radar frames');
      if (this.destroyed) return;
      this.setFrames(frames);
      this.radarError = null;
    } catch {
      if (this.destroyed) return;
      // frames from the last refresh stay useful (their times are on screen), so only complain when we have none
      if (!this.frames.length) this.radarError = friendly(null, TEXT.radarDown);
    }
    this.render();
  }

  setFrames(frames) {
    const known = new Map(this.frames.map((f) => [f.url, f.layer]));
    const next = frames.map((f) => ({ ...f, layer: known.get(f.url) || this.L.tileLayer(f.url, RADAR_TILES) }));
    const same = next.length === this.frames.length && next.every((f, i) => f.url === this.frames[i].url);
    const keep = new Set(next.map((f) => f.layer));
    for (const f of this.frames) if (!keep.has(f.layer)) f.layer.remove();
    this.frames = next;
    if (same) return;
    this.frame = this.playing ? 0 : next.length - 1;
    if (this.mode === 'radar') this.showRadar();
  }

  showRadar() {
    this.clearCells();
    for (const f of this.frames) if (!this.map.hasLayer(f.layer)) f.layer.addTo(this.map);
    this.stopAnim();
    if (!this.frames.length) return;
    if (this.playing) this.tick();
    else this.showFrame(this.frame);
  }

  hideRadar() {
    this.stopAnim();
    for (const f of this.frames) f.layer.remove();
  }

  tick() {
    this.showFrame(this.frame);
    const last = this.frame === this.frames.length - 1;
    this.timers.anim = setTimeout(() => {
      this.frame = (this.frame + 1) % this.frames.length;
      this.tick();
    }, last ? LAST_FRAME_MS : FRAME_MS);
  }

  showFrame(i) {
    this.frame = Math.max(0, Math.min(i, this.frames.length - 1));
    this.frames.forEach((f, j) => f.layer.setOpacity(j === this.frame ? RADAR_OPACITY : 0));
    this.renderHud();
  }

  stopAnim() {
    clearTimeout(this.timers.anim);
    this.timers.anim = 0;
  }

  // ---------------------------------------------------------------- forecast
  async loadGrid() {
    const seq = ++this.gridSeq;
    const radius = this.radius;
    let grid = null;
    let error = null;
    try {
      grid = await this.fetchGrid(radius);
      if (!validGrid(grid, radius)) throw new Error('bad grid');
    } catch (err) {
      grid = null;
      error = friendly(err, TEXT.gridDown);
    }
    if (this.destroyed || seq !== this.gridSeq) return; // the radius changed, or a newer request won
    // a failed refresh keeps the grid we already show; its window times are on screen
    if (grid || !this.grid) {
      this.grid = grid;
      this.gridError = error;
    }
    if (grid) this.recenter(grid.center);
    this.syncForecastButtons();
    if (this.mode !== 'radar') this.drawCells();
    this.render();
  }

  syncForecastButtons() {
    for (const [id, btn] of this.ui.modeBtns) {
      if (id === 'radar') continue;
      const missing = Boolean(this.grid) && this.windowStart(Number(id) - 1) === null;
      btn.disabled = missing;
      if (missing) btn.title = 'ยังไม่มีพยากรณ์ของชั่วโมงนี้';
      else btn.removeAttribute('title');
    }
    if (this.mode !== 'radar' && this.ui.modeBtns.get(this.mode).disabled) this.setMode('radar');
  }

  drawCells() {
    this.clearCells();
    const i = Number(this.mode) - 1;
    const start = this.windowStart(i);
    const g = this.grid;
    if (!g || start === null) return;
    const halfLat = g.cellKm / KM_PER_DEG / 2;
    const halfLon = g.cellKm / (KM_PER_DEG * Math.cos((g.center.lat * Math.PI) / 180)) / 2;
    const label = this.windowLabel(start);
    for (const cell of g.cells) {
      const mm = cell.mm[i];
      const band = rainBand(mm);
      if (!band) continue;
      const bounds = [[cell.lat - halfLat, cell.lon - halfLon], [cell.lat + halfLat, cell.lon + halfLon]];
      const rect = this.L.rectangle(bounds, { className: `rm-cell rm-b${band}`, weight: 1 });
      rect.bindTooltip(h('span', { text: `${label} · ${mm.toFixed(1)} มม.` }), { sticky: true, direction: 'top', className: 'rm-tip' });
      this.cells.push(rect.addTo(this.map));
    }
  }

  clearCells() {
    for (const cell of this.cells) cell.remove();
    this.cells = [];
  }

  recenter({ lat, lon }) {
    if (Math.abs(lat - this.lat) < 1e-4 && Math.abs(lon - this.lon) < 1e-4) return;
    this.lat = lat;
    this.lon = lon;
    this.ring.setLatLng([lat, lon]);
    this.pin.setLatLng([lat, lon]);
    this.fit();
  }

  windowStart(i) {
    const t = this.grid?.times?.[i];
    const ms = typeof t === 'string' ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  windowLabel(start) {
    return `${this.clock.format(start)}–${this.clock.format(start + HOUR_MS)}`;
  }

  // ---------------------------------------------------------------- render
  render() {
    const { modeBtns, radiusBtns, map, legend } = this.ui;
    for (const [id, btn] of modeBtns) btn.setAttribute('aria-pressed', String(id === this.mode));
    for (const [r, btn] of radiusBtns) btn.setAttribute('aria-pressed', String(r === this.radius));
    map.setAttribute('aria-label', `แผนที่ฝนรอบบ้าน รัศมี ${this.radius} กม.`);
    legend.hidden = this.mode === 'radar';
    this.renderPlay();
    this.renderHud();
    this.ui.note.textContent = this.mode === 'radar' ? this.radarNote() : this.forecastNote();
  }

  renderPlay() {
    const { play } = this.ui;
    const name = this.playing ? 'หยุดภาพเรดาร์' : 'เล่นภาพเรดาร์';
    play.hidden = this.mode !== 'radar';
    play.disabled = !this.frames.length;
    play.setAttribute('aria-label', name);
    play.title = name;
    play.querySelector('use').setAttribute('href', `${ICONS}#i-${this.playing ? 'pause' : 'play'}`);
  }

  renderHud() {
    const { hudLabel, scrub } = this.ui;
    const radar = this.mode === 'radar';
    scrub.hidden = !radar || this.frames.length < 2;
    if (!radar) {
      const start = this.windowStart(Number(this.mode) - 1);
      hudLabel.textContent = start !== null ? `พยากรณ์ ${this.windowLabel(start)}` : this.gridError ? 'พยากรณ์ไม่พร้อม' : 'พยากรณ์ กำลังโหลด…';
      return;
    }
    const f = this.frames[this.frame];
    const latest = this.frame === this.frames.length - 1 ? ' · ล่าสุด' : '';
    hudLabel.textContent = f ? `เรดาร์ ${this.clock.format(f.at)}${latest}` : this.radarError ? 'เรดาร์ไม่พร้อม' : 'เรดาร์ กำลังโหลด…';
    const progress = this.frames.length > 1 ? this.frame / (this.frames.length - 1) : 1;
    scrub.firstChild.style.transform = `scaleX(${progress})`;
  }

  radarNote() {
    if (navigator.onLine === false) return TEXT.offline;
    if (!this.frames.length) return this.radarError || 'กำลังโหลดภาพเรดาร์…';
    const first = this.clock.format(this.frames[0].at);
    const last = this.clock.format(this.frames[this.frames.length - 1].at);
    return `ภาพเรดาร์ฝนย้อนหลัง ${first}–${last}`;
  }

  forecastNote() {
    const i = Number(this.mode) - 1;
    const start = this.windowStart(i);
    if (this.grid && start !== null) return forecastSummary(this.grid, i, this.windowLabel(start));
    if (this.grid) return 'ยังไม่มีพยากรณ์ของชั่วโมงนี้';
    return this.gridError || 'กำลังโหลดพยากรณ์ฝน…';
  }

  showMessage(text, { href, label, retry = false, busy = false, fatal = false } = {}) {
    const { root, msg } = this.ui;
    msg.textContent = '';
    msg.append(h('p', { text }));
    if (href) msg.append(h('a', { class: 'rm-msg-act', href, text: label }));
    if (retry) {
      const again = h('button', { type: 'button', class: 'rm-msg-act', text: 'ลองใหม่' });
      again.addEventListener('click', () => this.start());
      msg.append(again);
    }
    msg.setAttribute('aria-busy', String(busy));
    msg.hidden = false;
    root.classList.toggle('rm-dead', fatal);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAnim();
    clearInterval(this.timers.refresh);
    removeEventListener('online', this.onOnline);
    removeEventListener('offline', this.onOffline);
    this.observer?.disconnect();
    this.map?.remove();
    this.ui.root.remove();
    if (mounted.get(this.host) === this) mounted.delete(this.host);
  }
}

// ------------------------------------------------------------------ view
function buildView() {
  const toggle = (label, data) => h('button', { type: 'button', class: 'rm-btn', 'aria-pressed': 'false', ...data, text: label });
  const modeBtns = new Map(MODES.map((m) => [m.id, toggle(m.label, { 'data-mode': m.id })]));
  const radiusBtns = new Map(RADII.map((r) => [r, toggle(`${r} กม.`, { 'data-radius': r })]));
  const play = h('button', { type: 'button', class: 'rm-play' }, icon('pause'));
  const hudLabel = h('span', { class: 'rm-hud-label' });
  const scrub = h('span', { class: 'rm-scrub', 'aria-hidden': 'true' }, h('i'));
  const hud = h('div', { class: 'rm-hud' }, play, h('span', { class: 'rm-hud-text' }, hudLabel, scrub));
  const map = h('div', { class: 'rm-map', role: 'region' });
  const msg = h('div', { class: 'rm-msg', role: 'status', hidden: true });
  const note = h('p', { class: 'rm-note', 'aria-live': 'polite' });
  const legend = h('ul', { class: 'rm-legend', 'aria-label': 'ความแรงฝนต่อชั่วโมง', hidden: true }, ...legendItems());
  const credit = h('p', { class: 'rm-credit' },
    'เรดาร์: ', link('https://www.rainviewer.com/', 'RainViewer'), ' · พยากรณ์: ', link('https://open-meteo.com/', 'Open-Meteo'));
  const root = h('div', { class: 'rm' },
    h('div', { class: 'rm-bar' },
      h('div', { class: 'rm-seg', role: 'group', 'aria-label': 'ช่วงเวลา' }, ...modeBtns.values()),
      h('div', { class: 'rm-seg', role: 'group', 'aria-label': 'รัศมีรอบบ้าน' }, ...radiusBtns.values())),
    h('div', { class: 'rm-stage' }, map, hud, msg),
    h('div', { class: 'rm-foot' }, note, legend, credit));
  return { root, modeBtns, radiusBtns, play, hudLabel, scrub, map, msg, note, legend };
}

function legendItems() {
  const item = (cls, text) => h('li', {}, h('i', { class: `rm-sw ${cls}`, 'aria-hidden': 'true' }), text);
  return [
    h('li', { class: 'rm-unit', text: 'ฝน มม./ชม.' }),
    item('rm-dry', 'ไม่มีฝน'),
    ...BANDS.map((b, i) => item(`rm-b${i + 1}`, `${b.name} ${b.range}`)),
  ];
}

function pinIcon(L) {
  const art = svg('svg', { class: 'rm-pin-art', viewBox: '0 0 36 46', 'aria-hidden': 'true' },
    svg('path', { class: 'rm-pin-body', d: PIN_BODY }),
    svg('path', { class: 'rm-pin-house', d: PIN_HOUSE }));
  const html = h('div', { class: 'rm-pin-wrap' }, h('span', { class: 'rm-ping', 'aria-hidden': 'true' }), art);
  return L.divIcon({ className: 'rm-pin', html, iconSize: [36, 46], iconAnchor: [18, 44] });
}

function forecastSummary(grid, i, label) {
  const values = grid.cells.map((c) => c.mm[i]).filter((v) => typeof v === 'number');
  if (!values.length) return `พยากรณ์ ${label} · ยังไม่มีข้อมูล`;
  const wet = values.filter((v) => v >= DRY_MM);
  if (!wet.length) return `พยากรณ์ ${label} · ไม่มีฝนในรัศมี ${grid.radiusKm} กม.`;
  const home = grid.cells[Math.floor(grid.cells.length / 2)]?.mm[i];
  const max = Math.max(...wet);
  const parts = [`พยากรณ์ ${label}`];
  if (typeof home === 'number') parts.push(`ที่บ้าน ${home >= DRY_MM ? `${home.toFixed(1)} มม.` : 'ไม่มีฝน'}`);
  parts.push(`ฝนตก ${wet.length}/${values.length} จุด`, `หนักสุด ${max.toFixed(1)} มม. (${BANDS[rainBand(max) - 1].name})`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ data
function radarFrames(data) {
  const host = typeof data?.host === 'string' && SAFE_RADAR_HOST.test(data.host) ? data.host : RADAR_HOST;
  const past = Array.isArray(data?.radar?.past) ? data.radar.past : [];
  return past
    .filter((f) => Number.isFinite(f?.time) && typeof f.path === 'string' && SAFE_RADAR_PATH.test(f.path))
    .map((f) => ({ at: f.time * 1000, url: `${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` }));
}

function validGrid(g, radius) {
  return Boolean(g) && g.radiusKm === radius && Number.isFinite(g.cellKm) && g.cellKm > 0 &&
    Number.isFinite(g.center?.lat) && Number.isFinite(g.center?.lon) &&
    Array.isArray(g.times) && g.times.length === MODES.length - 1 && Array.isArray(g.cells) &&
    g.cells.every((c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lon) && Array.isArray(c.mm));
}

function rainBand(mm) {
  if (typeof mm !== 'number' || !(mm >= DRY_MM)) return 0;
  return BANDS.findIndex((b) => mm < b.below) + 1;
}

const THAI = /[\u0E00-\u0E7F]/;
/** Our server answers in short Thai; anything else (English network errors, stack traces) gets `fallback`. */
function friendly(err, fallback) {
  if (navigator.onLine === false) return TEXT.offline;
  const message = typeof err?.message === 'string' ? err.message : '';
  return THAI.test(message) && message.length <= 140 ? message : fallback;
}

function num(v) {
  return v === null || v === undefined || v === '' ? NaN : Number(v);
}

function clockFormat(timeZone) {
  const opts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('th-TH', { ...opts, timeZone });
  } catch {
    return new Intl.DateTimeFormat('th-TH', { ...opts, timeZone: 'Asia/Bangkok' });
  }
}

const timeoutSignal = () => (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined);

// ------------------------------------------------------------------ DOM + assets
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

const icon = (name) => svg('svg', { class: 'rm-i', 'aria-hidden': 'true' }, svg('use', { href: `${ICONS}#i-${name}` }));
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', text });

// Assets are injected once per page; a failed load is forgotten, so "ลองใหม่" can try again.
const assets = new Map();

function once(key, load) {
  if (!assets.has(key)) {
    assets.set(key, load().catch((err) => {
      assets.delete(key);
      throw err;
    }));
  }
  return assets.get(key);
}

function loadLeaflet() {
  return Promise.all([
    loadCss(`${LEAFLET_DIR}/leaflet.css`),
    once('leaflet.js', () => (window.L?.map ? Promise.resolve() : loadAsset('script', { src: `${LEAFLET_DIR}/leaflet.js` }, () => Boolean(window.L?.map)))),
  ]).then(() => window.L);
}

function loadCss(href) {
  return once(href, () => (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)
    ? Promise.resolve()
    : loadAsset('link', { rel: 'stylesheet', href }, () => true)));
}

function loadAsset(tag, attrs, ok) {
  return new Promise((resolve, reject) => {
    const node = h(tag, attrs);
    const failed = () => {
      node.remove();
      reject(new Error(`โหลด ${attrs.src || attrs.href} ไม่ได้`));
    };
    node.addEventListener('load', () => (ok() ? resolve() : failed()), { once: true });
    node.addEventListener('error', failed, { once: true });
    document.head.append(node);
  });
}

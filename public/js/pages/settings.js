import { $, $$, api, esc, icon, initChrome, setSiteName, toast, usd, withBusy } from '../app.js';

initChrome();

let cfg = null; // /api/settings payload
const values = () => cfg.values;

const MODELS = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', note: 'ค่าเริ่มต้น · สมดุลระหว่างความแม่นกับราคา', in: 2, out: 10, think: 500 },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'แม่นที่สุด เหมาะกับภาพกลางคืนที่ดูยาก', in: 4, out: 20, think: 700 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', note: 'ประหยัดที่สุด เหมาะกับกล้องที่ภาพชัด', in: 1, out: 5, think: 0 },
];

// AI_ENGINE=openai — `think` is the measured reasoning overhead on a 3-camera check (gpt-6-luna: 11 real checks, 28 ก.ย.).
const OPENAI_MODELS = [
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', note: 'ค่าเริ่มต้น · ถูกที่สุด เห็นน้ำขังบนถนนได้ตรง', in: 0.1, out: 0.5, think: 1070 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', note: 'รุ่นก่อนหน้า ผลใกล้เคียงกัน', in: 0.2, out: 1.2, think: 300 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', note: 'รุ่นใหญ่ แพงกว่าราว 15 เท่า', in: 2, out: 12, think: 200 },
];

const MQTT_PRESETS = [
  { id: 'alarm', name: 'ไซเรน Tuya/NEO (alarm)', on: '{"alarm":true}', off: '{"alarm":false}' },
  { id: 'warning', name: 'ไซเรน IAS/Heiman (warning)', on: '{"warning":{"mode":"emergency","level":"very_high","strobe":true,"duration":60}}', off: '{"warning":{"mode":"stop"}}' },
  { id: 'state', name: 'สวิตช์/ปลั๊กต่อไซเรน (state)', on: '{"state":"ON"}', off: '{"state":"OFF"}' },
];

// ------------------------------------------------------------------ field builders
function toggle(key, title, help = '') {
  return `<label class="switch"><span class="text"><b>${esc(title)}</b>${help ? `<span>${esc(help)}</span>` : ''}</span>
    <span class="toggle"><input type="checkbox" data-key="${key}" ${values()[key] ? 'checked' : ''}><span></span></span></label>`;
}

function number(key, label, unit, help = '', { step = 1, allowEmpty = false } = {}) {
  const spec = cfg.schema[key] || {};
  const v = values()[key];
  return `<div class="field"><label for="f-${key}">${esc(label)}</label>
    <div class="inline-unit"><input id="f-${key}" type="number" inputmode="decimal" data-key="${key}" data-type="number" ${allowEmpty ? 'data-empty="null"' : ''}
      value="${v === null || v === undefined ? '' : esc(v)}" ${spec.min !== undefined ? `min="${spec.min}"` : ''} ${spec.max !== undefined ? `max="${spec.max}"` : ''} step="${step}">
      ${unit ? `<span class="muted">${esc(unit)}</span>` : ''}</div>
    ${help ? `<span class="help">${help}</span>` : ''}</div>`;
}

function text(key, label, help = '', { placeholder = '', area = false, maxlength = 200 } = {}) {
  const v = values()[key] ?? '';
  const input = area
    ? `<textarea id="f-${key}" data-key="${key}" maxlength="${maxlength}" placeholder="${esc(placeholder)}">${esc(v)}</textarea>`
    : `<input id="f-${key}" type="text" data-key="${key}" maxlength="${maxlength}" value="${esc(v)}" placeholder="${esc(placeholder)}">`;
  return `<div class="field"><label for="f-${key}">${esc(label)}</label>${input}${help ? `<span class="help">${help}</span>` : ''}</div>`;
}

function secret(name, envKey, set) {
  return `<p class="secret">${set ? `<span class="chip ok">${icon('check')}ตั้งแล้ว</span>` : `<span class="chip bad">${icon('x')}ยังไม่ได้ตั้ง</span>`}
    <span>${esc(name)} <span class="code">${esc(envKey)}</span> ในไฟล์ .env</span></p>`;
}

function section(id, title, iconName, tone, body) {
  return `<section class="card form-section" id="${id}" aria-labelledby="h-${id}">
    <div class="card-title" style="margin-bottom:0"><span class="badge-icon ${tone}">${icon(iconName)}</span><h2 id="h-${id}">${esc(title)}</h2><span class="spacer"></span><span class="saved" data-saved-for="${id}">บันทึกแล้ว ✓</span></div>
    ${body}
  </section>`;
}

// ------------------------------------------------------------------ sections
function costLine(model) {
  const cams = Math.max(1, cfg.cameras.length);
  const perCheck = ((cams * 1250 + 1500) * model.in + (model.think + 280) * model.out) / 1e6;
  const perDay = (1440 / values().intervalMinutes) * perCheck;
  return `≈ ${usd(perCheck, 3)}/ครั้ง · ≈ ${usd(perDay * 30, 0)}/เดือน ถ้าตรวจทุก ${values().intervalMinutes} นาที`;
}

function aiSection() {
  const s = values();
  const eng = cfg.engine;
  const isOpenAI = eng.id === 'openai';
  const list = isOpenAI ? OPENAI_MODELS : MODELS;
  const current = eng.model || s.aiModel;
  const known = list.some((m) => m.id === current);
  const cards = list.map((m) => `<label><input type="radio" name="aiModel" value="${m.id}" data-key="aiModel" ${current === m.id ? 'checked' : ''}>
    <b>${esc(m.name)}</b><span>${esc(m.note)}</span><span class="num">${eng.id === 'claude-code' ? 'ใช้โควตาแพ็กเกจ ไม่คิดเงินเพิ่ม' : esc(costLine(m))}</span></label>`).join('');
  return `
    <p class="secret"><span class="chip ${eng.problem ? 'bad' : 'ok'}">${eng.problem ? icon('x') : icon('check')}${esc(eng.label || eng.id)}</span>
      <span class="muted small">${eng.problem ? esc(eng.problem) : 'เปลี่ยนวิธีเชื่อมได้ที่ AI_ENGINE ใน .env'}</span></p>
    <div class="field"><span class="label">โมเดลที่ใช้ดูภาพ</span><div class="model-cards">${cards}</div>
      <span class="help">ตัวเลขค่าใช้จ่ายเป็นการประมาณคร่าวๆ (${cfg.cameras.length || 1} กล้อง ภาพ 1280px) ของจริงดูได้ในการ์ด “ค่า AI” หน้าหลัก${known ? '' : ` · ตอนนี้ใช้ <span class="code">${esc(current)}</span>`}</span></div>
    ${text('aiModel', 'หรือพิมพ์ชื่อโมเดลเอง', isOpenAI ? 'เช่น gpt-6-luna · ต้องเป็นชื่อโมเดลของ OpenAI' : 'เช่น claude-sonnet-5 · สำหรับ Claude Code ใช้ opus / sonnet / haiku ได้', { maxlength: 80 })}
    <div class="field-row">
      <div class="field"><label for="f-aiEffort">ความละเอียดในการคิด</label>
        <select id="f-aiEffort" data-key="aiEffort">${[['low', 'เร็ว/ประหยัด'], ['medium', 'กลาง (แนะนำ)'], ['high', 'ละเอียดสุด']].map(([v, l]) => `<option value="${v}" ${s.aiEffort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="help">${isOpenAI ? 'ใช้กับ Claude เท่านั้น — GPT ตั้งความคิดเอง' : 'มีผลกับ Opus / Sonnet 5 (Haiku ไม่ใช้ค่านี้)'}</span></div>
      ${number('imageMaxEdge', 'ขนาดภาพที่ส่งให้ AI', 'px', 'ใหญ่ขึ้นเห็นรายละเอียดมากขึ้นแต่แพงขึ้น แนะนำ 1280')}
    </div>
    ${toggle('useReferenceImages', 'ส่งภาพอ้างอิงตอนแห้งไปด้วย', 'ตั้งภาพอ้างอิงได้ในหน้า “ขีดเส้น” ช่วยให้แม่นขึ้นตอนกลางคืน')}
    <div class="btn-row"><button class="btn primary small" type="button" data-action="run">${icon('search')}ทดสอบ: ตรวจเดี๋ยวนี้</button><span class="muted small">ผลจะขึ้นที่หน้าหลักภายในไม่กี่วินาที</span></div>`;
}

function telegramSection() {
  const s = values();
  const set = cfg.secrets.telegramToken;
  const cands = cfg.telegram.candidates || [];
  const health = cfg.telegram.health;
  return `
    ${secret('โทเคนบอท', 'TELEGRAM_BOT_TOKEN', set)}
    <ol class="small" style="margin:0;padding-left:1.2em;display:grid;gap:4px">
      <li>ทัก <b>@BotFather</b> ใน Telegram พิมพ์ <span class="code">/newbot</span> ตั้งชื่อ แล้วคัดลอกโทเคน</li>
      <li>ใส่ <span class="code">TELEGRAM_BOT_TOKEN=…</span> ในไฟล์ .env แล้วเริ่มโปรแกรมใหม่</li>
      <li>เปิดบอทของคุณ กด <b>Start</b> (หรือเพิ่มบอทเข้ากลุ่มครอบครัว แล้วพิมพ์ /start)</li>
      <li>กลับมาหน้านี้ กด <b>“ใช้แชทนี้”</b> ด้านล่าง</li>
    </ol>
    ${cands.length ? `<div class="btn-row">${cands.map((c) => `<button class="btn sunny small" type="button" data-bind="${esc(c.id)}">ใช้แชทนี้: ${esc(c.name || 'ไม่มีชื่อ')} (${esc(c.id)})</button>`).join('')}</div>` : set ? '<p class="muted small">ยังไม่เห็นใครทักบอทเลย — ทักบอทแล้วรีเฟรชหน้านี้</p>' : ''}
    ${text('telegramChatId', 'รหัสแชทที่ผูกไว้', 'ตัวเลข (กลุ่มจะติดลบ) — ปกติไม่ต้องพิมพ์เอง', { maxlength: 40 })}
    ${toggle('telegramEnabled', 'ส่งแจ้งเตือนทาง Telegram')}
    ${health && health.ok === false ? `<p class="error-text">รับคำสั่งจากบอทไม่ได้: ${esc(health.error)}</p>` : ''}
    <div class="btn-row"><button class="btn soft small" type="button" data-action="test-telegram">${icon('send')}ส่งข้อความทดสอบ</button>
      <span class="muted small">ในแชทพิมพ์ /status /check /stop /mute /snooze ได้ และกดปุ่มใต้ข้อความเตือนเพื่อหยุดหรืองดเสียงไซเรนได้</span></div>`;
}

function lineSection() {
  return `
    ${secret('Channel access token', 'LINE_CHANNEL_ACCESS_TOKEN', cfg.secrets.lineToken)}
    <p class="small muted">LINE Notify ปิดบริการไปแล้ว จึงใช้ LINE Official Account (Messaging API) แทน — สร้าง OA ของบ้าน แล้วให้คนในบ้านแอดเป็นเพื่อน</p>
    ${text('lineTo', 'ส่งถึง', 'พิมพ์ <b>broadcast</b> = ส่งถึงทุกคนที่แอด OA (ง่ายสุด) หรือใส่ User ID ที่ขึ้นต้นด้วย U จากหน้า LINE Developers', { maxlength: 80, placeholder: 'broadcast' })}
    ${toggle('lineEnabled', 'ส่งแจ้งเตือนทาง LINE', 'ส่งเป็นข้อความ (LINE ไม่รับรูปแนบตรงจากเครื่องในบ้าน)')}
    <div class="btn-row"><button class="btn soft small" type="button" data-action="test-line">${icon('send')}ส่งข้อความทดสอบ</button></div>`;
}

function webhookSection() {
  return `
    ${secret('ลิงก์ webhook', 'WEBHOOK_URL', cfg.secrets.webhookUrl)}
    <p class="small muted">ส่ง JSON ทุกครั้งที่มีแจ้งเตือน — ต่อเข้า Make.com, n8n, Home Assistant หรือระบบอื่นได้</p>
    ${toggle('webhookEnabled', 'ส่ง webhook')}
    <div class="btn-row"><button class="btn soft small" type="button" data-action="test-webhook">${icon('send')}ส่งทดสอบ</button></div>`;
}

function sirenSection() {
  const s = values();
  const preset = MQTT_PRESETS.find((p) => p.on === s.mqttOnPayload && p.off === s.mqttOffPayload)?.id || 'custom';
  return `
    ${toggle('sirenEnabled', 'เปิดไซเรนจริงเมื่อน้ำถึงเส้นแดง', 'ผ่าน MQTT (Zigbee) และ/หรือ webhook ด้านล่าง')}
    ${number('sirenSeconds', 'ดังนานครั้งละ', 'วินาที', 'หยุดเองเมื่อครบเวลา หรือกดหยุดจากหน้าเว็บ/Telegram')}
    ${toggle('sirenOnWarning', 'ให้ไซเรนดังตั้งแต่เส้นเหลือง', 'ปกติดังเฉพาะเส้นแดง')}
    <h3 class="small" style="margin-top:6px">ไซเรน Zigbee ผ่าน MQTT</h3>
    ${secret('ที่อยู่ MQTT broker', 'MQTT_URL', cfg.secrets.mqttUrl)}
    ${text('mqttTopic', 'Topic', 'zigbee2mqtt/<ชื่ออุปกรณ์>/set', { maxlength: 200 })}
    <div class="field"><label for="f-preset">ชนิดอุปกรณ์</label>
      <select id="f-preset" data-preset>${MQTT_PRESETS.map((p) => `<option value="${p.id}" ${preset === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="custom" ${preset === 'custom' ? 'selected' : ''}>กำหนดเอง</option></select></div>
    <div class="field-row">${text('mqttOnPayload', 'ข้อความเปิด (JSON)', '', { maxlength: 500 })}${text('mqttOffPayload', 'ข้อความปิด (JSON)', '', { maxlength: 500 })}</div>
    <h3 class="small" style="margin-top:6px">ไซเรนผ่าน webhook</h3>
    ${secret('ลิงก์เปิด/ปิด', 'SIREN_WEBHOOK_ON_URL / SIREN_WEBHOOK_OFF_URL', cfg.secrets.sirenOnUrl)}
    <p class="small muted">เช่น Home Assistant, Shelly, Tasmota (ตั้ง SIREN_WEBHOOK_METHOD=GET สำหรับอุปกรณ์ที่ใช้ลิงก์ธรรมดา)</p>
    <h3 class="small" style="margin-top:6px">ปลุกผ่าน iPhone (แอป Pushover)</h3>
    ${secret('แอป Pushover', 'PUSHOVER_TOKEN / PUSHOVER_USER', cfg.secrets.pushoverToken && cfg.secrets.pushoverUser)}
    <p class="small muted">ลงแอป Pushover บน iPhone แล้วเปิด Emergency priority → “Override Silent Mode” น้ำถึงเส้นแดงเมื่อไร iPhone จะดังซ้ำทุก 30 วินาทีแม้ปิดเสียงอยู่ จนกว่าจะแตะรับทราบ หรือมีคนกดหยุดไซเรน</p>
    ${toggle('iphoneAlarm', 'ให้ iPhone ดังเมื่อน้ำถึงเส้นแดง')}
    ${toggle('iphoneAlarmOnWarning', 'ให้ iPhone ดังตั้งแต่เส้นเหลือง')}
    <h3 class="small" style="margin-top:6px">ปลุกผ่านมือถือ/แท็บเล็ตข้างเตียง</h3>
    ${toggle('browserAlarm', 'เปิดเสียงเตือนในหน้า “ข้างเตียง”', 'วางมือถือเก่าหรือแท็บเล็ตเสียบชาร์จไว้ข้างเตียง เปิดหน้า ข้างเตียง ค้างไว้')}
    ${toggle('browserAlarmOnWarning', 'ให้หน้า “ข้างเตียง” ดังตั้งแต่เส้นเหลือง')}
    <div class="btn-row"><button class="btn danger small" type="button" data-action="test-siren">${icon('bell')}ทดสอบไซเรน 3 วินาที</button><a class="btn soft small" href="/bedside">${icon('moon')}เปิดหน้าข้างเตียง</a></div>`;
}

const CAM_KIND = { rtsp: 'RTSP', http: 'ภาพ HTTP', ffmpeg: 'ffmpeg', file: 'ไฟล์', demo: 'ภาพวาดสาธิต' };

function cameraListHtml() {
  if (!cfg.cameras.length) return '<p class="empty">ยังไม่มีกล้อง กด “ค้นหากล้องในบ้าน” ด้านบนเพื่อเริ่มค่ะ</p>';
  return `<ul class="events" data-cam-list>${cfg.cameras.map((c) => `<li style="grid-template-columns:34px 1fr auto auto">
    <span class="ev-ico">${icon('camera')}</span>
    <div><div class="ev-title">${esc(c.name)} <span class="chip">${esc(CAM_KIND[c.source] || c.source)}</span>${/^u\d+$/.test(c.id) ? '' : ' <span class="chip">.env</span>'}</div>
      <div class="ev-sub"><span class="code">${esc(c.url)}</span></div><div data-cam-result="${esc(c.id)}"></div></div>
    <button class="btn soft small" type="button" data-test-cam="${esc(c.id)}">ทดสอบ</button>
    ${/^u\d+$/.test(c.id) ? `<button class="btn soft small" type="button" data-cam-remove="${esc(c.id)}" title="เอาออก">${icon('x')}</button>` : '<span></span>'}</li>`).join('')}</ul>`;
}

function camerasSection() {
  return `<p class="small muted">ต่อกล้องในบ้านได้เลย น้องฝนจะหาลิงก์ภาพให้เอง — คุณแค่พิมพ์ชื่อผู้ใช้/รหัสผ่านของกล้อง (ทำงานเฉพาะในวง Wi‑Fi บ้านคุณ ไม่ส่งรหัสออกนอกเครื่อง)</p>
    <div class="btn-row">
      <button class="btn primary small" type="button" data-cam-action="discover">${icon('search')}ค้นหากล้องในบ้าน</button>
      <button class="btn soft small" type="button" data-cam-action="manual">＋ เพิ่มด้วย IP เอง</button>
    </div>
    <div data-finder style="display:grid;gap:12px;margin-top:12px"></div>
    <h3 class="small" style="margin-top:14px">กล้องที่ต่ออยู่</h3>
    <div data-cam-listing>${cameraListHtml()}</div>
    <p class="small muted" style="margin-top:8px">กล้องที่เพิ่มที่นี่เก็บไว้ในเครื่องนี้ · กล้องจาก <span class="code">.env</span> แก้ที่ไฟล์ · วิธีหาลิงก์แต่ละยี่ห้อดูใน <span class="code">docs/cameras.md</span></p>`;
}

// ---- camera finder UI ---------------------------------------------------
const finder = { cards: [], probes: {} }; // probes[key] = { url, snapshotUrl } from a successful test (kept out of the DOM)

const ALL_BRANDS = [
  ['dahua', 'Dahua / RISCO VUpoint'], ['hikvision', 'Hikvision / HiLook'], ['foscam', 'Foscam'],
  ['reolink', 'Reolink'], ['tapo', 'TP-Link Tapo / VIGI'], ['tiandy', 'Tiandy'], ['uniview', 'Uniview'],
  ['generic', 'อื่น ๆ (ONVIF ทั่วไป)'],
];

function finderCard(cam) {
  const key = cam.key;
  const brandList = cam.brands || ALL_BRANDS.map(([k, label]) => ({ key: k, label }));
  const brands = brandList.map((b) => `<option value="${esc(b.key)}" ${b.key === cam.brand ? 'selected' : ''}>${esc(b.label)}</option>`).join('');
  const head = cam.manual
    ? `<div class="finder-head"><b>เพิ่มด้วย IP เอง</b><span class="spacer"></span><button class="btn soft small" type="button" data-f-close title="เอาออก">${icon('x')}</button></div>
        <div class="field-row"><div class="field"><label>IP ของกล้อง</label><input data-f="host" inputmode="decimal" placeholder="192.168.1.50" value="${esc(cam.host || '')}"></div>
        <div class="field" style="max-width:120px"><label>พอร์ต</label><input data-f="port" type="number" min="1" max="65535" value="${cam.port || 80}"></div></div>`
    : `<div class="finder-head"><b>${esc(cam.host)}</b>${cam.port && cam.port !== 80 ? `<span class="muted">:${cam.port}</span>` : ''}
        ${cam.name ? `<span class="chip">${esc(cam.name)}</span>` : ''}${cam.connected ? `<span class="chip ok">${icon('check')}ต่ออยู่แล้ว</span>` : ''}<span class="spacer"></span>
        <button class="btn soft small" type="button" data-f-close title="เอาออก">${icon('x')}</button></div>
        ${cam.note ? `<p class="finder-note">${esc(cam.note)}</p>` : ''}`;
  return `<div class="finder-card" data-key="${esc(key)}" data-host="${esc(cam.host || '')}" data-port="${esc(cam.port || 80)}">
    ${head}
    <div class="field-row">
      <div class="field"><label>ชื่อกล้อง (ตั้งเอง)</label><input data-f="name" maxlength="60" value="${esc(cam.name && !GENERIC_NAMES.test(cam.name) ? cam.name : '')}" placeholder="เช่น หน้าบ้าน / โรงรถ"></div>
      <div class="field"><label>ยี่ห้อ</label><select data-f="brand">${brands}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>ชื่อผู้ใช้ของกล้อง</label><input data-f="username" autocomplete="off" autocapitalize="none" spellcheck="false" value="admin" placeholder="เช่น admin"></div>
      <div class="field"><label>รหัสผ่านของกล้อง</label><input data-f="password" type="password" autocomplete="new-password" placeholder="รหัสของกล้อง (ไม่ใช่รหัสแอปมือถือ)"></div>
      <div class="field" style="max-width:130px" data-f-channel ${BRAND_CHANNELS.has(cam.brand) ? '' : 'hidden'}><label>ช่อง (เครื่องบันทึก)</label><input data-f="channel" type="number" min="1" max="32" value="1"></div>
    </div>
    <div class="btn-row"><button class="btn primary small" type="button" data-f-test>${icon('search')}ทดสอบการต่อ</button>
      <span class="muted small" data-f-hint>${esc(BRANDS_HINT[cam.brand] || '')}</span></div>
    <div data-f-result style="margin-top:8px"></div>
  </div>`;
}

const BRANDS_HINT = {
  dahua: 'RISCO VUpoint = ไส้ใน Dahua · ลืมรหัส: ดูในแอป/เครื่องบันทึก RISCO หรือค่าเริ่มต้นบนสติกเกอร์กล้อง (admin / _AdmiN_ ตามด้วย MAC)',
  foscam: 'ลืมรหัส: ตั้งใหม่ในแอป (เปิดภาพกล้อง → Settings → Security Settings) หรือกดปุ่ม Reset ค้าง 10–15 วิ แล้วตั้งใหม่ตอน login ครั้งแรก',
  tapo: 'ตั้ง Camera Account ใหม่ในแอป Tapo ได้เลย ไม่ต้องรู้รหัสเก่า (คนละชุดกับบัญชี TP-Link)',
  tiandy: 'ถ้าไม่ติด ลองยี่ห้อ Dahua หรือ ONVIF ทั่วไป',
};
const BRAND_ONVIF_PORT = { tapo: 2020, foscam: 888 };
const BRAND_CHANNELS = new Set(['dahua', 'hikvision', 'reolink', 'tiandy', 'uniview']); // brands whose recorders have channels
const GENERIC_NAMES = /^(general|ipc-?model|ipcamera|ipc|camera|onvif)$/i; // ONVIF names that tell the owner nothing

function renderFinder() {
  const box = $('[data-finder]');
  if (box) box.innerHTML = finder.cards.map(finderCard).join('');
}

function refreshCameraListing() {
  const box = $('[data-cam-listing]');
  if (box) box.innerHTML = cameraListHtml();
}

function render() {
  const s = values();
  const sections = [
    section('home', 'บ้านของเรา', 'home', '', `
      ${text('siteName', 'ชื่อบ้าน', 'แสดงในข้อความแจ้งเตือน', { maxlength: 60 })}
      ${text('siteDescription', 'เล่าเรื่องบ้านให้ AI ฟัง', 'ยิ่งเล่าละเอียด AI ยิ่งเดาระดับน้ำแม่น: กล้องไหนเห็นอะไร น้ำมักมาทางไหน ระดับไหนถือว่าอันตราย', {
        area: true, maxlength: 2000,
        placeholder: 'เช่น บ้านชั้นเดียวยกพื้น 40 ซม. กล้องหน้าบ้านเห็นถนนและประตูรั้ว กล้องโรงรถเห็นพื้นโรงรถกับบันได น้ำมักท่วมถนนก่อนแล้วไหลเข้าประตูรั้ว ถ้าถึงบันไดขั้นแรกคืออันตราย',
      })}
      <div class="field-row">
        ${number('latitude', 'ละติจูด', '', 'ใช้ดูฝนรอบบ้าน (ไม่บังคับ)', { step: 'any', allowEmpty: true })}
        ${number('longitude', 'ลองจิจูด', '', '', { step: 'any', allowEmpty: true })}
      </div>
      <div class="btn-row"><button class="btn soft small" type="button" data-action="locate">${icon('location')}ใช้ตำแหน่งของเครื่องนี้</button>
        <span class="muted small">หรือคลิกขวาบน Google Maps แล้วคัดลอกพิกัดมาใส่</span></div>
      ${text('timezone', 'เขตเวลา', 'ค่าเริ่มต้น Asia/Bangkok', { maxlength: 60 })}`),
    section('ai', 'สมองของน้องฝน (AI)', 'search', 'aqua', aiSection()),
    section('schedule', 'รอบการตรวจ', 'clock', '', `
      ${number('intervalMinutes', 'ตรวจทุกๆ', 'นาที', 'ค่าปกติที่แนะนำ 10 นาที')}
      ${toggle('adaptiveInterval', 'ปรับความถี่อัตโนมัติ', 'ถี่ขึ้นเมื่อน้ำขึ้น/ถึงเส้น และห่างขึ้นเมื่อพยากรณ์ยืนยันว่าไม่มีฝน (ต้องใส่พิกัดบ้าน)')}
      <div class="field-row">
        ${number('fastIntervalMinutes', 'ตอนน้ำขึ้น ตรวจทุก', 'นาที')}
        ${number('relaxedIntervalMinutes', 'ตอนฟ้าโปร่ง ตรวจทุก', 'นาที')}
      </div>
      ${toggle('paused', 'พักการตรวจชั่วคราว', 'เช่น ตอนย้ายกล้องหรือซ่อมบ้าน')}`),
    section('rules', 'เกณฑ์ตัดสิน', 'alert', 'sun', `
      <p class="small muted">ถ้าขีดเส้นไว้ น้องฝนตัดสินจากเส้นเป็นหลัก (ถึงเส้นเหลือง = เฝ้าระวัง, ถึงเส้นแดง = อันตราย) ระดับตัวเลขใช้เสริม</p>
      <div class="field-row">
        ${number('warnLevel', 'เตือนเมื่อระดับรวมถึง', '/100', 'ใช้ทั้งกรณีมีเส้นและไม่มีเส้น')}
        ${number('criticalLevel', 'อันตรายเมื่อระดับรวมถึง', '/100', 'ใช้เฉพาะตอนที่ยังไม่มีเส้นแดงเลย')}
      </div>
      ${toggle('confirmCritical', 'ตรวจซ้ำก่อนปลุกเมื่อเห็นเส้นแดงครั้งแรก', 'กันปลุกผิดจากแสงสะท้อน/ภาพกลางคืน')}
      ${toggle('confirmWarning', 'ตรวจซ้ำก่อนแจ้งเมื่อเห็นเส้นเหลืองครั้งแรก', 'กันเตือนผิดจากไฟสปอตไลท์ หญ้าเปียก หรือฝนบนเลนส์ (ช้าลงราว 90 วินาที)')}
      <div class="field-row">
        ${number('confirmDelaySeconds', 'ตรวจซ้ำหลังจาก', 'วินาที')}
        ${number('criticalRepeatMinutes', 'เตือนซ้ำทุก', 'นาที', 'ระหว่างที่น้ำยังอยู่ที่เส้นแดง')}
        ${number('failureThreshold', 'แจ้งเมื่อมองไม่เห็นติดกัน', 'รอบ')}
      </div>
      ${toggle('predictiveWarning', 'เตือนล่วงหน้าเมื่อน้ำขึ้นเร็ว', 'คำนวณจากแนวโน้ม ถ้าจะถึงเส้นแดงเร็วๆ นี้ เตือนก่อนเลย')}
      ${number('predictiveMinutes', 'เตือนถ้าคาดว่าจะถึงเส้นแดงภายใน', 'นาที')}`),
    section('telegram', 'Telegram', 'send', 'aqua', telegramSection()),
    section('line', 'LINE', 'send', '', lineSection()),
    section('webhook', 'Webhook', 'send', '', webhookSection()),
    section('notify', 'แจ้งเตือนเรื่องอะไรบ้าง', 'bell', 'pink', `
      <p class="small muted">น้ำถึงเส้นแดงจะแจ้งเสมอ ส่วนเรื่องอื่นเลือกได้</p>
      ${toggle('notifyWarning', 'น้ำถึงเส้นเหลือง / น้ำขึ้นเร็ว')}
      ${toggle('notifyRecovery', 'น้ำกลับสู่ปกติ')}
      ${toggle('notifyFailure', 'กล้องหรือ AI มีปัญหา')}
      ${toggle('hourlySummary', 'สรุปรายชั่วโมง (ส่งแบบเงียบ ไม่มีเสียง)', 'น้ำที่บ้าน ฝนตอนนี้และ 3 ชม.ข้างหน้า ฝนรอบบ้าน 25 กม. และข่าวน้ำท่วมล่าสุด')}
      ${text('newsQuery', 'คำค้นข่าวน้ำท่วม', 'ใส่ชื่อเขต/อำเภอของบ้าน เช่น “น้ำท่วม บางใหญ่” จะได้ข่าวที่ใกล้ตัว (ข่าวจาก Google News ย้อนหลัง 6 ชม.)', { maxlength: 120 })}
      <div class="field"><label for="f-dailySummaryHour">สรุปประจำวัน</label>
        <select id="f-dailySummaryHour" data-key="dailySummaryHour" data-empty="null"><option value="">ไม่ต้องส่ง</option>
        ${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.dailySummaryHour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00 น.</option>`).join('')}</select>
        <span class="help">ข้อความสั้นๆ ว่าน้องฝนยังเฝ้าอยู่ ตรวจไปกี่ครั้ง น้ำสูงสุดเท่าไร</span></div>`),
    section('siren', 'ไซเรนปลุก', 'bell', 'pink', sirenSection()),
    section('cameras', 'กล้อง', 'camera', 'aqua', camerasSection()),
    section('storage', 'เก็บข้อมูล', 'image', '', `
      <div class="field-row">
        ${number('snapshotRetentionDays', 'เก็บภาพไว้', 'วัน', 'ภาพเก่ากว่านี้ลบอัตโนมัติ (ภาพอ้างอิงไม่ถูกลบ)')}
        ${number('historyDays', 'เก็บประวัติผลตรวจ', 'วัน')}
      </div>`),
  ];
  $('[data-sections]').innerHTML = sections.join('');
  const titles = { home: 'บ้าน', ai: 'AI', schedule: 'รอบตรวจ', rules: 'เกณฑ์', telegram: 'Telegram', line: 'LINE', webhook: 'Webhook', notify: 'แจ้งเตือน', siren: 'ไซเรน', cameras: 'กล้อง', storage: 'ข้อมูล' };
  $('[data-settings-nav]').innerHTML = Object.entries(titles).map(([id, t]) => `<a href="#${id}">${esc(t)}</a>`).join('');
  renderFinder(); // keep any open finder cards after a full re-render
}

// ------------------------------------------------------------------ saving
const timers = new Map();
async function save(key, value, el) {
  try {
    const out = await api('/api/settings', { method: 'POST', body: { [key]: value } });
    cfg.values = out.values;
    const sec = el.closest('section')?.id;
    const tag = sec && $(`[data-saved-for="${sec}"]`);
    if (tag) {
      tag.classList.add('show');
      setTimeout(() => tag.classList.remove('show'), 1800);
    }
    if (key === 'siteName') setSiteName(out.values.siteName);
    if (key === 'aiModel' || key === 'intervalMinutes') {
      const y = scrollY;
      render();
      scrollTo(0, y);
    }
  } catch (err) {
    toast(err.message, { bad: true, ms: 6000 });
  }
}

function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.empty === 'null' && el.value === '') return null;
  if (el.dataset.type === 'number') return el.value === '' ? null : Number(el.value);
  if (el.id === 'f-dailySummaryHour') return el.value === '' ? null : Number(el.value);
  return el.value;
}

$('[data-sections]').addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-preset]')) {
    const p = MQTT_PRESETS.find((x) => x.id === el.value);
    if (p) {
      $('#f-mqttOnPayload').value = p.on;
      $('#f-mqttOffPayload').value = p.off;
      save('mqttOnPayload', p.on, el).then(() => save('mqttOffPayload', p.off, el));
    }
    return;
  }
  if (!el.dataset.key) return;
  clearTimeout(timers.get(el.dataset.key));
  save(el.dataset.key, readValue(el), el);
});
$('[data-sections]').addEventListener('change', (e) => {
  const sel = e.target.closest('.finder-card [data-f="brand"]');
  if (!sel) return;
  const card = sel.closest('.finder-card');
  const port = BRAND_ONVIF_PORT[sel.value] || 80;
  const input = card.querySelector('[data-f="port"]');
  if (input) input.value = port;
  else card.dataset.port = port;
  const hint = card.querySelector('[data-f-hint]');
  if (hint) hint.textContent = BRANDS_HINT[sel.value] || '';
  card.querySelector('[data-f-channel]')?.toggleAttribute('hidden', !BRAND_CHANNELS.has(sel.value));
});
$('[data-sections]').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset.key || el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') return;
  clearTimeout(timers.get(el.dataset.key));
  timers.set(el.dataset.key, setTimeout(() => save(el.dataset.key, readValue(el), el), 900));
});

// ------------------------------------------------------------------ actions
const ACTIONS = {
  run: () => api('/api/run', { method: 'POST' }).then(() => 'เริ่มตรวจแล้ว ดูผลที่หน้าหลักได้เลย'),
  'test-telegram': () => api('/api/test/telegram', { method: 'POST' }).then(() => 'ส่งข้อความทดสอบทาง Telegram แล้ว'),
  'test-line': () => api('/api/test/line', { method: 'POST' }).then(() => 'ส่งข้อความทดสอบทาง LINE แล้ว'),
  'test-webhook': () => api('/api/test/webhook', { method: 'POST' }).then(() => 'ส่ง webhook ทดสอบแล้ว'),
  'test-siren': () => api('/api/siren/test', { method: 'POST' }).then(() => 'สั่งไซเรนแล้ว (ถ้าเปิดหน้าข้างเตียงไว้จะดังด้วย)'),
  locate: () => new Promise((resolve, reject) => {
    if (!navigator.geolocation || !isSecureContext) {
      reject(new Error('เบราว์เซอร์ขอพิกัดได้เฉพาะบน https หรือ localhost — ใส่พิกัดเองได้เลยค่ะ'));
      return;
    }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = Math.round(pos.coords.latitude * 1e4) / 1e4;
      const lon = Math.round(pos.coords.longitude * 1e4) / 1e4;
      $('#f-latitude').value = lat;
      $('#f-longitude').value = lon;
      await api('/api/settings', { method: 'POST', body: { latitude: lat, longitude: lon } });
      cfg.values.latitude = lat;
      cfg.values.longitude = lon;
      resolve(`ตั้งพิกัดบ้านแล้ว (${lat}, ${lon})`);
    }, () => reject(new Error('ขอพิกัดไม่สำเร็จ')), { timeout: 10000 });
  }),
};

$('[data-sections]').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]');
  if (action) {
    await withBusy(action, () => ACTIONS[action.dataset.action](), { ok: (msg) => msg });
    return;
  }
  const bind = e.target.closest('[data-bind]');
  if (bind) {
    await withBusy(bind, async () => {
      await api('/api/telegram/bind', { method: 'POST', body: { chatId: bind.dataset.bind } });
      await load();
    }, { ok: 'ผูกแชทแล้ว ลองกด “ส่งข้อความทดสอบ” ได้เลย' });
    return;
  }
  const test = e.target.closest('[data-test-cam]');
  if (test) {
    const id = test.dataset.testCam;
    const out = await withBusy(test, () => api(`/api/cameras/${id}/snapshot`, { method: 'POST' }), { fail: 'ดึงภาพไม่สำเร็จ' });
    if (out) {
      $(`[data-cam-result="${id}"]`).innerHTML = `<div class="shot" style="max-width:320px;margin-top:8px"><img src="/snap/${encodeURIComponent(out.image)}" alt="ภาพทดสอบ"></div>
        <p class="small muted">${out.width}×${out.height} · ความสว่าง ${out.metrics.brightness} · ${out.metrics.night ? '🌙 โหมดอินฟราเรด' : '☀️ ภาพสี'}</p>`;
      toast('ดึงภาพจากกล้องได้แล้ว');
    }
    return;
  }

  // ---- camera finder ----
  const camAction = e.target.closest('[data-cam-action]');
  if (camAction) {
    if (camAction.dataset.camAction === 'discover') {
      const found = await withBusy(camAction, () => api('/api/cameras/discover', { method: 'POST' }), { fail: 'ค้นหาไม่สำเร็จ' });
      if (!found) return;
      const existing = new Set(finder.cards.map((c) => c.key));
      for (const cam of found.cameras) {
        if (existing.has(cam.host)) continue;
        finder.cards.push({ key: cam.host, host: cam.host, port: cam.port, name: cam.name, brand: cam.brand, brands: cam.brands, note: cam.note, connected: cam.connected });
      }
      renderFinder();
      toast(found.cameras.length ? `เจอกล้อง ${found.cameras.length} ตัวในบ้าน` : 'ยังไม่เจอกล้องในวงนี้ — ลอง “เพิ่มด้วย IP เอง” ได้ค่ะ');
      if (!found.cameras.length && !finder.cards.some((c) => c.manual)) finder.cards.push({ key: `manual-${manualSeq++}`, manual: true, brand: 'dahua' });
      renderFinder();
      return;
    }
    if (camAction.dataset.camAction === 'manual') {
      finder.cards.push({ key: `manual-${manualSeq++}`, manual: true, brand: 'dahua' });
      renderFinder();
      return;
    }
  }
  const fTest = e.target.closest('[data-f-test]');
  if (fTest) return void probeCard(fTest);
  const fAdd = e.target.closest('[data-f-add]');
  if (fAdd) return void addCard(fAdd);
  const fClose = e.target.closest('[data-f-close]');
  if (fClose) {
    const el = fClose.closest('.finder-card');
    finder.cards = finder.cards.filter((c) => c.key !== el.dataset.key);
    delete finder.probes[el.dataset.key];
    renderFinder();
    return;
  }
  const rm = e.target.closest('[data-cam-remove]');
  if (rm) {
    const out = await withBusy(rm, () => api('/api/cameras/remove', { method: 'POST', body: { id: rm.dataset.camRemove } }), { fail: 'เอาออกไม่สำเร็จ' });
    if (out) {
      cfg.cameras = out.cameras;
      refreshCameraListing();
      toast('เอากล้องออกแล้ว');
    }
  }
});

// ------------------------------------------------------------------ camera finder actions
let manualSeq = 0;

function cardEl(key) {
  return $(`.finder-card[data-key="${key}"]`);
}
function cardValues(el) {
  const get = (f) => el.querySelector(`[data-f="${f}"]`);
  return {
    host: get('host') ? get('host').value.trim() : el.dataset.host,
    port: get('port') ? Number(get('port').value) : Number(el.dataset.port) || 80,
    name: get('name')?.value.trim() || '',
    brand: get('brand')?.value || 'generic',
    username: get('username')?.value.trim() || '',
    password: get('password')?.value ?? '',
    channel: Number(get('channel')?.value) || 1,
  };
}

async function probeCard(btn) {
  const el = btn.closest('.finder-card');
  const key = el.dataset.key;
  const v = cardValues(el);
  if (!v.host) return void toast('ใส่ IP ของกล้องก่อนค่ะ', { bad: true });
  if (!v.username) return void toast('ใส่ชื่อผู้ใช้ของกล้องก่อนค่ะ', { bad: true });
  const result = el.querySelector('[data-f-result]');
  result.innerHTML = '';
  const out = await withBusy(btn, () => api('/api/cameras/probe', { method: 'POST', body: { host: v.host, port: v.port, username: v.username, password: v.password, brand: v.brand, channel: v.channel } }), { fail: 'ต่อไม่สำเร็จ' });
  if (!out) return;
  if (!out.ok) {
    const tried = (out.tried || []).slice(0, 4).map((t) => `<li><span class="code">${esc(t.url)}</span> — ${esc(t.error)}</li>`).join('');
    result.innerHTML = `<p class="error-text">${esc(out.error || 'ต่อไม่สำเร็จ')}</p>${tried ? `<ul class="small muted" style="padding-left:1.1em;display:grid;gap:3px">${tried}</ul>` : ''}
      <p class="small muted">ลองเปลี่ยนยี่ห้อ หรือตรวจชื่อผู้ใช้/รหัสอีกครั้งค่ะ</p>`;
    return;
  }
  finder.probes[key] = { url: out.url, snapshotUrl: out.snapshotUrl || '', name: v.name };
  const dev = out.deviceInfo && (out.deviceInfo.manufacturer || out.deviceInfo.model) ? `${esc(out.deviceInfo.manufacturer || '')} ${esc(out.deviceInfo.model || '')}`.trim() : '';
  result.innerHTML = `<div class="finder-ok">
    <img src="${out.sample}" alt="ภาพจากกล้อง" style="max-width:100%;border:var(--line);border-radius:12px">
    <p class="small" style="margin-top:6px"><span class="chip ok">${icon('check')}ต่อได้แล้ว</span> ${out.width}×${out.height}${dev ? ` · ${dev}` : ''}</p>
    <p class="small muted"><span class="code">${esc(out.urlMasked)}</span></p>
    <div class="btn-row"><button class="btn primary small" type="button" data-f-add>${icon('check')}เพิ่มกล้องนี้</button></div>
  </div>`;
}

async function addCard(btn) {
  const el = btn.closest('.finder-card');
  const key = el.dataset.key;
  const probe = finder.probes[key];
  if (!probe) return;
  const name = (el.querySelector('[data-f="name"]')?.value.trim()) || probe.name || cardValues(el).host;
  const out = await withBusy(btn, () => api('/api/cameras/add', { method: 'POST', body: { name, url: probe.url, snapshotUrl: probe.snapshotUrl } }), { fail: 'บันทึกไม่สำเร็จ' });
  if (!out) return;
  cfg.cameras = out.cameras;
  finder.cards = finder.cards.filter((c) => c.key !== key);
  delete finder.probes[key];
  renderFinder();
  refreshCameraListing();
  toast(`เพิ่มกล้อง “${name}” แล้ว น้องฝนกำลังตรวจให้ค่ะ`);
}

async function load() {
  try {
    cfg = await api('/api/settings');
  } catch (err) {
    toast(err.message, { bad: true });
    return;
  }
  setSiteName(cfg.values.siteName);
  render();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
load();

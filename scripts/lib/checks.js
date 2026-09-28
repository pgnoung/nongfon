// Online checks the setup wizard and `npm run doctor` use to prove a key or token works before the
// owner walks away. Each returns { ok, detail } in Thai and never includes the secret in the text.

const TIMEOUT_MS = 15000;
const UA = 'NongFon-setup/1.0';

async function call(fetchImpl, url, init = {}) {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: null, error: err };
  }
}

const offline = (r) => ({ ok: false, detail: `ต่ออินเทอร์เน็ตไม่ได้ (${r.error?.cause?.code || r.error?.name || 'network'}) — เช็กเน็ตแล้วลองใหม่` });

/** OpenAI: the key must be valid and allowed to use the model. */
export async function checkOpenAI(key, model = 'gpt-6-luna', { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, `https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA },
  });
  if (r.status === 0) return offline(r);
  if (r.status === 200) return { ok: true, detail: `คีย์ใช้ได้ และเรียกโมเดล ${model} ได้` };
  if (r.status === 401) return { ok: false, detail: 'คีย์ไม่ถูกต้อง หรือถูกยกเลิกแล้ว — สร้างใหม่ที่ platform.openai.com/api-keys' };
  if (r.status === 404) return { ok: false, detail: `คีย์ใช้ได้ แต่บัญชีนี้ยังเรียกโมเดล ${model} ไม่ได้ — เติมเครดิตก่อน หรือเลือกโมเดลอื่นในหน้าตั้งค่า` };
  if (r.status === 429) return { ok: false, detail: 'คีย์ใช้ได้ แต่โควตา/เครดิตหมด — เติมเครดิตที่ platform.openai.com/settings/organization/billing' };
  return { ok: false, detail: `ตรวจคีย์ไม่ได้ (HTTP ${r.status}) ลองใหม่อีกครั้ง` };
}

/** Anthropic (Claude API): the key must be valid and allowed to use the model. */
export async function checkAnthropic(key, model = 'claude-sonnet-5', { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'User-Agent': UA },
  });
  if (r.status === 0) return offline(r);
  if (r.status === 200) return { ok: true, detail: `คีย์ใช้ได้ และเรียกโมเดล ${model} ได้` };
  if (r.status === 401) return { ok: false, detail: 'คีย์ไม่ถูกต้อง หรือถูกยกเลิกแล้ว — สร้างใหม่ที่ console.anthropic.com' };
  if (r.status === 404) return { ok: false, detail: `คีย์ใช้ได้ แต่ไม่พบโมเดล ${model} — เลือกโมเดลอื่นในหน้าตั้งค่า` };
  return { ok: false, detail: `ตรวจคีย์ไม่ได้ (HTTP ${r.status}) ลองใหม่อีกครั้ง` };
}

/** Telegram bot token → the bot's @username. */
export async function checkTelegram(token, { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, `https://api.telegram.org/bot${token}/getMe`);
  if (r.status === 0) return offline(r);
  if (r.status === 200 && r.body?.ok) return { ok: true, detail: `บอท @${r.body.result?.username} พร้อมใช้`, username: r.body.result?.username };
  if (r.status === 401 || r.status === 404) return { ok: false, detail: 'โทเคนบอทไม่ถูกต้อง — คัดลอกใหม่จาก @BotFather' };
  return { ok: false, detail: `ตรวจโทเคนไม่ได้ (HTTP ${r.status})` };
}

/** LINE Messaging API channel access token → the OA's basic id. */
export async function checkLine(token, { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, 'https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 0) return offline(r);
  if (r.status === 200) return { ok: true, detail: `LINE OA ${r.body?.displayName || ''} ${r.body?.basicId || ''}`.trim() };
  if (r.status === 401) return { ok: false, detail: 'Channel access token ไม่ถูกต้อง — ออกใหม่ใน LINE Developers → Messaging API' };
  return { ok: false, detail: `ตรวจ LINE ไม่ได้ (HTTP ${r.status})` };
}

/** Pushover app token + user (or group) key → the registered devices. */
export async function checkPushover(token, user, { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, 'https://api.pushover.net/1/users/validate.json', {
    method: 'POST',
    body: new URLSearchParams({ token, user }),
  });
  if (r.status === 0) return offline(r);
  if (r.body?.status === 1) {
    const devices = r.body.devices || [];
    return { ok: true, detail: `Pushover ใช้ได้ — อุปกรณ์: ${devices.join(', ') || '(ยังไม่มี ลงแอปในมือถือก่อน)'}`, devices };
  }
  const why = (r.body?.errors || []).join(', ');
  if (/application token/i.test(why)) return { ok: false, detail: 'API Token ของแอปไม่ถูกต้อง (ต้องเป็นรหัสของแอปที่สร้างใน pushover.net ปกติขึ้นต้นด้วย a) — ถ้ายังสร้างแอปไม่ได้ ให้ยืนยันอีเมลของบัญชี Pushover ก่อน' };
  if (/user/i.test(why)) return { ok: false, detail: 'User Key ไม่ถูกต้อง (ดูมุมขวาบนของหน้า pushover.net หลังล็อกอิน ปกติขึ้นต้นด้วย u)' };
  return { ok: false, detail: `ตรวจ Pushover ไม่ได้ (${why || `HTTP ${r.status}`})` };
}

function placeLabel(parts) {
  return parts.filter(Boolean).filter((p, i, all) => all.indexOf(p) === i).join(', ');
}

/**
 * Place name → up to 5 candidates { label, latitude, longitude, area }. Open-Meteo first (fast, English
 * names), then OpenStreetMap Nominatim (understands Thai names). One query per setup — well within
 * both services' fair-use rules.
 */
export async function geocode(name, { fetchImpl = fetch } = {}) {
  const q = String(name || '').trim();
  if (!q) return [];
  const om = await call(fetchImpl, `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '5', language: 'th', format: 'json' })}`);
  const fromOm = (om.body?.results || []).map((r) => ({
    label: placeLabel([r.admin3, r.admin2, r.admin1, r.country]) || r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    area: placeLabel([r.admin2 || r.name, r.admin1]).replace(/จังหวัด|อำเภอ|เขต/g, '').trim(),
  }));
  if (fromOm.length) return fromOm;
  const osm = await call(fetchImpl, `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '5', 'accept-language': 'th' })}`, {
    headers: { 'User-Agent': `${UA} (home flood watcher setup)` },
  });
  return (Array.isArray(osm.body) ? osm.body : []).map((r) => ({
    label: r.display_name,
    latitude: Math.round(Number(r.lat) * 1e4) / 1e4,
    longitude: Math.round(Number(r.lon) * 1e4) / 1e4,
    area: String(r.display_name || '').split(',').slice(0, 2).join(' ').replace(/จังหวัด|อำเภอ|เขต/g, '').replace(/\s+/g, ' ').trim(),
  })).filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
}

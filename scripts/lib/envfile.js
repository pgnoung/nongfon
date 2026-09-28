// Read, update and write the .env file for the setup wizard without losing the owner's comments
// or line order. The rules match loadEnvFile() in src/config.js (KEY=value, optional quotes, # comments).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_LINE = /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw) {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
    const inner = value.slice(1, value.lastIndexOf(quote));
    return quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner;
  }
  return value.replace(/\s+#.*$/, '').trim();
}

/** { KEY: value } for the active (uncommented) lines; a later line wins, like the app's loader. */
export function parseEnv(text) {
  const entries = String(text || '').split(/\r?\n/)
    .map((line) => line.match(KEY_LINE))
    .filter((m) => m && !m[1])
    .map((m) => [m[2], unquote(m[3])]);
  return Object.fromEntries(entries);
}

/** Format one value so loadEnvFile() reads it back unchanged. */
export function formatValue(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error('ค่าในไฟล์ .env ต้องอยู่บรรทัดเดียว');
  if (text === '' || /^[^\s#"'\\]+$/.test(text)) return text;
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * Apply { KEY: value | null } to the .env text. An active KEY= line is replaced; otherwise a commented
 * template line (# KEY=…) is uncommented in place; otherwise the line is appended. null removes the
 * active line (the template comment stays). Returns new text; the input is not changed.
 */
export function upsertEnv(text, updates) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const lines = source === '' ? [] : source.replace(/\n$/, '').split('\n');
  const pending = new Map(Object.entries(updates));

  const activeIndex = (key) => lines.findIndex((line) => {
    const m = line.match(KEY_LINE);
    return m && !m[1] && m[2] === key;
  });
  const templateIndex = (key) => lines.findIndex((line) => {
    const m = line.match(KEY_LINE);
    return m && m[1] && m[2] === key;
  });

  const replaced = new Map(); // line index → new line (or null to drop)
  const appended = [];
  for (const [key, value] of pending) {
    const active = activeIndex(key);
    if (value === null || value === undefined) {
      if (active >= 0) replaced.set(active, null);
      continue;
    }
    const line = `${key}=${formatValue(value)}`;
    if (active >= 0) replaced.set(active, line);
    else if (templateIndex(key) >= 0 && !replaced.has(templateIndex(key))) replaced.set(templateIndex(key), line);
    else appended.push(line);
  }

  const kept = lines
    .map((line, i) => (replaced.has(i) ? replaced.get(i) : line))
    .filter((line) => line !== null);
  const tail = appended.length ? ['', '# ---- ค่าจากตัวช่วยติดตั้งน้องฝน', ...appended] : [];
  return `${[...kept, ...tail].join('\n')}\n`;
}

/** Write the file atomically, readable by this user only (Windows ignores the mode). */
export function writeEnvFile(file, text) {
  const dir = path.dirname(path.resolve(file));
  const tmp = path.join(dir, `.env.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not supported (Windows) */
  }
}

export function readEnvFile(file, fallbackFile) {
  for (const f of [file, fallbackFile]) {
    if (!f) continue;
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      /* try the next one */
    }
  }
  return '';
}

// ------------------------------------------------------------------ checks without network

export const looksLike = {
  openaiKey: (v) => /^sk-[A-Za-z0-9_-]{20,}$/.test(v),
  anthropicKey: (v) => /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/.test(v),
  claudeOauth: (v) => /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/.test(v),
  telegramToken: (v) => /^\d{5,12}:[A-Za-z0-9_-]{30,}$/.test(v),
  pushoverKey: (v) => /^[A-Za-z0-9]{30}$/.test(v),
  lineToken: (v) => /^[A-Za-z0-9+/=_-]{80,}$/.test(v),
};

/** Hide the password part of a camera link for display: rtsp://admin:••••@192.168.1.50/… */
export function maskUrl(url) {
  return String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@\s]*@/i, '$1••••@');
}

/** A camera link the app can open, or a Thai explanation of what is wrong. */
export function cameraUrlProblem(url, { isPublicHost } = {}) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return 'ลิงก์ไม่ถูกต้อง ต้องขึ้นต้นด้วย rtsp:// หรือ http:// เช่น rtsp://admin:รหัส@192.168.1.50:554/stream1';
  }
  if (!/^(rtsps?|https?):$/.test(u.protocol)) return 'รองรับลิงก์ rtsp:// rtsps:// http:// และ https:// ค่ะ';
  if (!u.hostname) return 'ลิงก์ยังไม่มี IP ของกล้อง';
  if (isPublicHost && isPublicHost(u.hostname)) return 'IP นี้เป็น IP บนอินเทอร์เน็ต — ใช้ IP ของกล้องในวง LAN บ้านคุณ (เช่น 192.168.x.x) เท่านั้นนะคะ';
  return null;
}

/** A readable password for the dashboard, e.g. fon-7kq2-m9xp-4rtz (no look-alike letters). */
export function generatePassword(random = crypto.randomBytes) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = random(12);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return `fon-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

/** "13.84, 100.36" or a Google Maps link with @lat,lng → { latitude, longitude }, else null. */
export function parseCoordinates(text) {
  const s = String(text || '');
  const m = s.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/) || s.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude: Math.round(latitude * 1e4) / 1e4, longitude: Math.round(longitude * 1e4) / 1e4 };
}

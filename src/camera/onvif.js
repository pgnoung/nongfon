// Find cameras on the home network and work out the link that pulls a picture from each one, so the
// owner only has to type the camera's username and password. Two ways, tried in this order:
//   1. ONVIF — most IP cameras answer WS-Discovery on the LAN and, once you log in, tell you their exact
//      RTSP stream and JPEG snapshot URLs (GetStreamUri / GetSnapshotUri). We ask them directly.
//   2. Brand templates — for cameras whose ONVIF media service is locked down, we fall back to the
//      well-known URL shape for that brand (Dahua/RISCO, Foscam, Hikvision, Reolink …).
// This file only builds and parses requests; it never guesses passwords. The caller verifies a candidate
// by actually grabbing one frame.

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { assertLanHost, isPrivateHost, ipv4ToInt } from '../net/lan.js';

const WS_DISCOVERY = { addr: '239.255.255.250', port: 3702 };

// ------------------------------------------------------------------ WS-Discovery (list cameras)
function probeXml() {
  return `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:${randomUUID()}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
}

const first = (s, tag) => (s.match(new RegExp(`<[^>]*${tag}[^>]*>([^<]+)<`, 'i')) || [])[1];

/** One WS-Discovery reply → a camera we could try to connect to. */
export function parseProbeMatch(xml, fromIp) {
  const xaddrs = (first(xml, 'XAddrs') || '').trim().split(/\s+/).filter(Boolean);
  // prefer the plain IPv4 service address, not a link-local IPv6 one
  const xaddr = xaddrs.find((u) => /^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(u)) || xaddrs[0] || (fromIp ? `http://${fromIp}/onvif/device_service` : '');
  const scopesRaw = first(xml, 'Scopes') || '';
  const scopes = decodeURIComponent(scopesRaw).split(/\s+/).filter(Boolean);
  let host = fromIp;
  let port = 80;
  try {
    const u = new URL(xaddr);
    host = u.hostname;
    port = Number(u.port) || 80;
  } catch { /* keep fromIp / 80 */ }
  return { host, port, xaddr, scopes, brand: brandFromScopes(scopes), name: scopeValue(scopes, 'name') };
}

const scopeValue = (scopes, key) => {
  const hit = scopes.find((s) => s.includes(`/${key}/`));
  return hit ? decodeURIComponent(hit.split(`/${key}/`)[1] || '').replace(/\/+$/, '') : '';
};

/** Best-effort brand from ONVIF scopes (hardware/name) — only used to order the URL templates we try. */
export function brandFromScopes(scopes = []) {
  const blob = scopes.join(' ').toLowerCase();
  for (const [brand, needles] of Object.entries(BRAND_HINTS)) if (needles.some((n) => blob.includes(n))) return brand;
  return '';
}

const BRAND_HINTS = {
  dahua: ['dahua', 'rvcm', 'rvnvr', 'risco', 'amcrest', 'lorex'],
  hikvision: ['hikvision', 'hilook', 'hiwatch'],
  foscam: ['foscam', 'ipcam-', 'ipc-model'],
  reolink: ['reolink'],
  tapo: ['tapo', 'tp-link', 'tplink'],
  tiandy: ['tiandy'],
  uniview: ['uniview', 'unv'],
};

/**
 * Multicast a WS-Discovery probe and collect the cameras that answer.
 * De-duplicated by host. Read-only: no login, no per-host connection.
 */
export function discover({ timeoutMs = 4000, bindAddress } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const byHost = new Map();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closed */ }
      resolve([...byHost.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      const m = parseProbeMatch(msg.toString(), rinfo.address);
      if (m.host && !byHost.has(m.host)) byHost.set(m.host, m);
    });
    sock.bind(0, bindAddress, () => {
      const send = () => { if (!done) sock.send(probeXml(), WS_DISCOVERY.port, WS_DISCOVERY.addr, () => {}); };
      send();
      setTimeout(send, 700); // UDP can drop the first probe
    });
    setTimeout(finish, timeoutMs);
  });
}

// ------------------------------------------------------------------ ONVIF SOAP with login
/** WS-Security UsernameToken (PasswordDigest) — the login most ONVIF cameras accept. */
export function usernameToken(username, password, { nonceBytes, created } = {}) {
  const nonce = nonceBytes || randomBytes(16);
  const createdAt = created || new Date().toISOString();
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(createdAt, 'utf8'), Buffer.from(password, 'utf8')])).digest('base64');
  return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${xmlEscape(username)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${createdAt}</Created></UsernameToken></Security></s:Header>`;
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function envelope(bodyXml, header = '') {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">${header}<s:Body>${bodyXml}</s:Body></s:Envelope>`;
}

async function soap(url, bodyXml, { username, password, timeoutMs = 4000 } = {}) {
  const header = username ? usernameToken(username, password) : '';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: envelope(bodyXml, header),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err) => { throw Object.assign(new Error(`ต่อ ONVIF ไม่ได้: ${err.cause?.code || err.name || err.message}`), { code: 'onvif' }); });
  const text = await res.text();
  return { status: res.status, text };
}

const tagValues = (s, tag) => [...s.matchAll(new RegExp(`<[^>/]*:?${tag}[^>]*>([^<]*)</[^>]*:?${tag}>`, 'g'))].map((m) => m[1]);
const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]+)"`)) || [])[1];

/** Parse GetProfiles → [{ token, width, height }]. */
export function parseProfiles(xml) {
  const out = [];
  for (const m of xml.matchAll(/<[^>]*:?Profiles\b([^>]*)>([\s\S]*?)<\/[^>]*:?Profiles>/g)) {
    const token = attr(m[1], 'token') || attr(m[2], 'token');
    const res = m[2].match(/<[^>]*:?Resolution>\s*<[^>]*:?Width>(\d+)<[^>]*>\s*<[^>]*:?Height>(\d+)</);
    out.push({ token, width: res ? Number(res[1]) : null, height: res ? Number(res[2]) : null });
  }
  return out;
}

const parseUri = (xml) => tagValues(xml, 'Uri')[0] || null;

/**
 * Log in to a camera over ONVIF and read its exact stream + snapshot URLs.
 * Returns { deviceInfo, mediaUrl, candidates:[{profile,width,height,streamUri,snapshotUri}] }.
 * Throws with a Thai message the UI can show (bad login, no media service, …).
 */
export async function resolveOnvif({ host, port = 80, username, password, timeoutMs = 4000 }) {
  assertLanHost(host);
  const base = `http://${host}:${port || 80}`;
  const deviceUrl = `${base}/onvif/device_service`;
  const auth = { username, password, timeoutMs };

  const info = await soap(deviceUrl, '<tds:GetDeviceInformation/>', auth);
  if (info.status === 401 || /NotAuthorized|auth/i.test(info.text)) {
    throw Object.assign(new Error('กล้องไม่รับชื่อผู้ใช้/รหัสผ่านนี้ (ONVIF) — ลองรหัสของกล้อง ไม่ใช่รหัสแอปบนมือถือ'), { code: 'auth' });
  }
  const deviceInfo = {
    manufacturer: tagValues(info.text, 'Manufacturer')[0] || '',
    model: tagValues(info.text, 'Model')[0] || '',
    firmware: tagValues(info.text, 'FirmwareVersion')[0] || '',
  };

  const caps = await soap(deviceUrl, '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>', auth);
  let mediaUrl = (caps.text.match(/<[^>]*:?Media>[\s\S]*?<[^>]*:?XAddr>([^<]+)</) || [])[1];
  if (mediaUrl) mediaUrl = mediaUrl.replace(/^https?:\/\/[^/]+/, base); // some cameras report a wrong host/port here
  if (!mediaUrl) mediaUrl = `${base}/onvif/media_service`;

  const prof = await soap(mediaUrl, '<trt:GetProfiles/>', auth);
  const profiles = parseProfiles(prof.text);
  if (!profiles.length) throw Object.assign(new Error('เข้ากล้องได้ แต่ยังไม่ได้รายชื่อสตรีม (media service ไม่เปิด) — ลองลิงก์ตามยี่ห้อแทน'), { code: 'no-media', deviceInfo });

  const candidates = [];
  for (const p of profiles) {
    if (!p.token) continue;
    const su = await soap(mediaUrl, `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${xmlEscape(p.token)}</trt:ProfileToken></trt:GetStreamUri>`, auth).catch(() => ({ text: '' }));
    const sn = await soap(mediaUrl, `<trt:GetSnapshotUri><trt:ProfileToken>${xmlEscape(p.token)}</trt:ProfileToken></trt:GetSnapshotUri>`, auth).catch(() => ({ text: '' }));
    candidates.push({ profile: p.token, width: p.width, height: p.height, streamUri: parseUri(su.text), snapshotUri: parseUri(sn.text) });
  }
  // biggest resolution first (the main stream), so the owner gets the clear picture by default
  candidates.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  return { deviceInfo, mediaUrl, candidates };
}

// ------------------------------------------------------------------ credentials + brand templates
/** Put URL-encoded credentials into a URI the camera returned without them. */
export function withCredentials(uri, username, password) {
  const u = new URL(uri);
  if (username) {
    u.username = encodeURIComponent(username);
    u.password = encodeURIComponent(password ?? '');
  }
  return u.toString();
}

// {IP}/{USER}/{PASS} are filled in. `stream` is the clear main stream; `sub` the light one; `snapshot` an HTTP JPEG.
export const BRAND_TEMPLATES = {
  dahua: { // Dahua OEM — RISCO VUpoint, Amcrest, Lorex, many "General" cameras and NVRs
    label: 'Dahua / RISCO VUpoint',
    stream: 'rtsp://{USER}:{PASS}@{IP}:554/cam/realmonitor?channel={CH}&subtype=0',
    sub: 'rtsp://{USER}:{PASS}@{IP}:554/cam/realmonitor?channel={CH}&subtype=1',
    snapshot: 'http://{USER}:{PASS}@{IP}/cgi-bin/snapshot.cgi?channel={CH}',
    channels: true,
  },
  hikvision: {
    label: 'Hikvision / HiLook',
    stream: 'rtsp://{USER}:{PASS}@{IP}:554/Streaming/Channels/{CH}01',
    sub: 'rtsp://{USER}:{PASS}@{IP}:554/Streaming/Channels/{CH}02',
    snapshot: 'http://{USER}:{PASS}@{IP}/ISAPI/Streaming/channels/{CH}01/picture',
    channels: true,
  },
  foscam: {
    label: 'Foscam',
    onvifPort: 888, // Foscam answers ONVIF on 888 and RTSP/HTTP on 88
    stream: 'rtsp://{USER}:{PASS}@{IP}:88/videoMain',
    sub: 'rtsp://{USER}:{PASS}@{IP}:88/videoSub',
    snapshot: 'http://{IP}:88/cgi-bin/CGIProxy.fcgi?cmd=snapPicture2&usr={USER}&pwd={PASS}',
  },
  reolink: {
    label: 'Reolink',
    stream: 'rtsp://{USER}:{PASS}@{IP}:554/h264Preview_{CH}_main',
    sub: 'rtsp://{USER}:{PASS}@{IP}:554/h264Preview_{CH}_sub',
    snapshot: 'http://{IP}/cgi-bin/api.cgi?cmd=Snap&channel={CH0}&user={USER}&password={PASS}',
    channels: true,
  },
  tapo: {
    label: 'TP-Link Tapo / VIGI',
    onvifPort: 2020, // only after a Camera Account is created in the Tapo app
    stream: 'rtsp://{USER}:{PASS}@{IP}:554/stream1',
    sub: 'rtsp://{USER}:{PASS}@{IP}:554/stream2',
  },
  tiandy: {
    label: 'Tiandy',
    stream: 'rtsp://{USER}:{PASS}@{IP}:554/cam/realmonitor?channel={CH}&subtype=0',
    sub: 'rtsp://{USER}:{PASS}@{IP}:554/cam/realmonitor?channel={CH}&subtype=1',
    channels: true,
  },
  uniview: {
    label: 'Uniview',
    stream: 'rtsp://{USER}:{PASS}@{IP}:554/media/video{CH}',
    snapshot: 'http://{IP}/images/snapshot.jpg',
    channels: true,
  },
  generic: {
    label: 'อื่น ๆ (ONVIF ทั่วไป)',
    stream: 'rtsp://{USER}:{PASS}@{IP}:554/onvif1',
    sub: 'rtsp://{USER}:{PASS}@{IP}:554/onvif2',
    channels: false,
  },
};

/** All brand keys, with the guessed one first. */
export function brandOptions(guess) {
  const keys = Object.keys(BRAND_TEMPLATES);
  return [guess, ...keys.filter((k) => k !== guess)].filter((k) => k && BRAND_TEMPLATES[k]).map((k) => ({ key: k, label: BRAND_TEMPLATES[k].label }));
}

function fill(tpl, { ip, username, password, channel = 1 }) {
  return tpl
    .replaceAll('{IP}', ip)
    .replaceAll('{USER}', encodeURIComponent(username))
    .replaceAll('{PASS}', encodeURIComponent(password ?? ''))
    .replaceAll('{CH}', String(channel))
    .replaceAll('{CH0}', String(channel - 1));
}

/**
 * Candidate URLs for a brand, in the order to try them. `main` first (clear picture), then the snapshot,
 * then the sub stream. Returns [{ label, url, kind }]. Credentials are URL-encoded.
 */
export function templateUrls({ brand, host, username, password, channel = 1 }) {
  assertLanHost(host);
  const tpl = BRAND_TEMPLATES[brand] || BRAND_TEMPLATES.generic;
  const ctx = { ip: host, username, password, channel };
  const out = [];
  if (tpl.stream) out.push({ label: `${tpl.label} · ภาพชัด`, url: fill(tpl.stream, ctx), kind: 'rtsp' });
  if (tpl.snapshot) out.push({ label: `${tpl.label} · ภาพนิ่ง`, url: fill(tpl.snapshot, ctx), kind: 'http' });
  if (tpl.sub) out.push({ label: `${tpl.label} · ภาพเล็ก`, url: fill(tpl.sub, ctx), kind: 'rtsp' });
  return out;
}

/** ONVIF ports to try for a brand: the one given, then the brand's usual port, then 80. */
export function onvifPortsFor(brand, given) {
  const usual = BRAND_TEMPLATES[brand]?.onvifPort;
  return [...new Set([Number(given) || 0, usual || 0, 80].filter((p) => p > 0 && p < 65536))];
}

// ------------------------------------------------------------------ LAN sweep (cameras that skip WS-Discovery)
// Some cameras never answer WS-Discovery: a Tapo before its Camera Account exists, a Foscam that dozed off.
// A quick TCP knock on a handful of camera ports across the home /24 finds them. LAN only, read-only.
export const SWEEP_PORTS = [88, 554, 2020, 8800];

/** Every host in the private /24 networks this machine sits on (never a public or huge network). */
export function lanHosts(interfaces = os.networkInterfaces()) {
  const hosts = new Set();
  for (const list of Object.values(interfaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || !isPrivateHost(a.address) || a.address.startsWith('127.')) continue;
      const ip = ipv4ToInt(a.address);
      const base = (ip & 0xffffff00) >>> 0; // sweep the /24 around us, even on a bigger network
      for (let i = 1; i < 255; i++) {
        const h = base + i;
        if (h === ip) continue;
        hosts.add([h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255].join('.'));
      }
    }
  }
  return [...hosts];
}

function knock(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

/** Knock `ports` on `hosts` (concurrency-limited) → [{ host, open: [ports] }] for hosts with any open port. */
export async function sweepHosts(hosts, { ports = SWEEP_PORTS, timeoutMs = 400, concurrency = 96 } = {}) {
  const jobs = [];
  for (const host of hosts) if (isPrivateHost(host)) for (const port of ports) jobs.push([host, port]);
  const open = new Map();
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [host, port] = jobs[next++];
      if (await knock(host, port, timeoutMs)) {
        if (!open.has(host)) open.set(host, []);
        open.get(host).push(port);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return [...open.entries()].map(([host, ports]) => ({ host, open: ports.sort((a, b) => a - b) }));
}

/**
 * Brand hint from which camera ports answered: 88 → Foscam; 2020 or 8800 → Tapo. A Tapo that shows 8800 but
 * not 554 has no Camera Account yet, so it cannot be connected until the owner creates one in the Tapo app.
 */
export function brandFromPorts(open = []) {
  const has = (p) => open.includes(p);
  if (has(88)) return { brand: 'foscam', port: 888, note: '' };
  if (has(2020) || has(8800)) {
    const ready = has(554);
    return { brand: 'tapo', port: 2020, note: ready ? '' : 'กล้อง Tapo ยังไม่ได้เปิด Camera Account — ในแอป Tapo: แตะกล้อง → ⚙️ → Advanced Settings → Camera Account แล้วตั้งชื่อผู้ใช้/รหัส (6–32 ตัว) ก่อน' };
  }
  if (has(554)) return { brand: '', port: 80, note: '' };
  return null;
}

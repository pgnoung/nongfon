// Grab one still frame from a camera. Supported sources:
//   rtsp://user:pass@ip:554/stream     → ffmpeg (most IP cameras, Tapo, Hikvision, Dahua, go2rtc)
//   http(s)://…/snapshot.jpg           → HTTP GET (Basic or Digest auth, MJPEG streams OK)
//   ffmpeg:<anything ffmpeg can open>  → ffmpeg (HLS, local video device, …)
//   file:///path or /path              → newest image in a file/folder (for testing)
//   demo:street / demo:carport         → cartoon scenes for demo mode

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameMetrics, isBlank, normalizeFrame } from './image.js';
import { logger, maskText } from '../log.js';
import { sleep } from '../util.js';

const log = logger('camera');

export class CaptureError extends Error {
  constructor(message, code = 'capture') {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- ffmpeg
export function ffmpegArgs(input, { rtspTransport = 'tcp' } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (/^rtsps?:\/\//i.test(input) && rtspTransport) args.push('-rtsp_transport', rtspTransport);
  // Decode key frames only: the first non-key frame of an H.264/H.265 stream
  // often decodes to a flat grey picture.
  args.push('-skip_frame', 'nokey', '-i', input, '-an', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1');
  return args;
}

function runFfmpeg(input, { ffmpegPath = 'ffmpeg', timeoutMs = 20000, rtspTransport } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, ffmpegArgs(input, { rtspTransport }), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new CaptureError(`เรียก ffmpeg ไม่ได้: ${err.message}`, 'ffmpeg'));
      return;
    }
    const out = [];
    let err = '';
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(reject, new CaptureError(`กล้องไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที`, 'timeout'));
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => {
      if (err.length < 2000) err += c;
    });
    child.on('error', (e) => {
      const msg = e.code === 'ENOENT'
        ? 'ไม่พบโปรแกรม ffmpeg — รันตัวติดตั้งน้องฝนอีกครั้ง (จะเติม ffmpeg ให้) หรือใช้ Docker หรือเปลี่ยนไปใช้ลิงก์ภาพแบบ http'
        : `ffmpeg ผิดพลาด: ${e.message}`;
      done(reject, new CaptureError(msg, 'ffmpeg'));
    });
    child.on('close', (code) => {
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 1000) done(resolve, buf);
      else {
        const detail = maskText(err.trim().split('\n').slice(-2).join(' ')).slice(0, 240);
        done(reject, new CaptureError(`ดึงภาพจากสตรีมไม่ได้ (ffmpeg ${code})${detail ? `: ${detail}` : ''}`, 'ffmpeg'));
      }
    });
  });
}

/** RTSP over TCP first (works through most routers); fall back to UDP for cameras that refuse TCP. */
async function grabWithFfmpeg(input, ctx = {}) {
  try {
    return await runFfmpeg(input, { ...ctx, rtspTransport: 'tcp' });
  } catch (err) {
    if (/^rtsps?:\/\//i.test(input) && /461|Unsupported Transport/i.test(err.message)) {
      return runFfmpeg(input, { ...ctx, rtspTransport: 'udp' });
    }
    throw err;
  }
}

// ---------------------------------------------------------------- HTTP
function parseChallenge(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

/** RFC 7616 Digest header (MD5 / SHA-256, qop=auth) — Hikvision/Dahua snapshots need it. */
export function digestAuthorization({ username, password, method, uri, challenge, cnonce, nc = '00000001' }) {
  const algorithm = (challenge.algorithm || 'MD5').toUpperCase();
  const hashName = algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
  const h = (s) => crypto.createHash(hashName).update(s).digest('hex');
  cnonce = cnonce || crypto.randomBytes(8).toString('hex');
  let ha1 = h(`${username}:${challenge.realm}:${password}`);
  if (algorithm.endsWith('-SESS')) ha1 = h(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = h(`${method}:${uri}`);
  const qop = (challenge.qop || '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : '';
  const response = qop ? h(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : h(`${ha1}:${challenge.nonce}:${ha2}`);
  let header = `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", algorithm=${challenge.algorithm || 'MD5'}, response="${response}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (challenge.opaque) header += `, opaque="${challenge.opaque}"`;
  return header;
}

/** Read an MJPEG (multipart/x-mixed-replace) body until the first complete JPEG. */
async function firstJpegFromStream(body, maxBytes = 8 * 1024 * 1024) {
  const reader = body.getReader();
  let buf = Buffer.alloc(0);
  try {
    while (buf.length < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start >= 0) {
        const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end > start) return buf.subarray(start, end + 2);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new CaptureError('อ่านภาพจากสตรีม MJPEG ไม่ครบ', 'http');
}

async function grabHttp(rawUrl, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const url = new URL(rawUrl);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const headers = { 'User-Agent': 'nongfon/1.0', Accept: 'image/*,multipart/x-mixed-replace' };
  if (username) headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { headers, signal });
    const challenge = res.headers.get('www-authenticate') || '';
    if (res.status === 401 && username && /^digest/i.test(challenge)) {
      await res.body?.cancel();
      const auth = digestAuthorization({
        username, password, method: 'GET', uri: url.pathname + url.search, challenge: parseChallenge(challenge),
      });
      res = await fetchImpl(url, { headers: { ...headers, Authorization: auth }, signal });
    }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CaptureError(`กล้องไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที`, 'timeout');
    }
    throw new CaptureError(`ต่อกล้องไม่ได้: ${err.cause?.code || err.message}`, 'http');
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new CaptureError(`กล้องไม่ยอมให้เข้า (HTTP ${res.status}) — ตรวจชื่อผู้ใช้/รหัสผ่านในลิงก์`, 'auth');
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new CaptureError(`กล้องตอบ HTTP ${res.status}`, 'http');
  }
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.startsWith('multipart/')) return firstJpegFromStream(res.body);
  if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
    await res.body?.cancel();
    throw new CaptureError(`ลิงก์นี้ไม่ได้ส่งรูปกลับมา (ได้ ${type.split(';')[0]})`, 'http');
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------- http through macOS curl
// On macOS, a launchd service built from Homebrew binaries (node, ffmpeg) is blocked from the
// home network by Local Network privacy, while Apple's own /usr/bin/curl is allowed. With
// HTTP_TOOL=curl, snapshot links are fetched by curl; the login goes in on stdin, never argv.
const CURL_IMAGE = /^(\xff\xd8\xff|\x89PNG|RIFF)/;
const quoteCurl = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

async function grabWithCurl(rawUrl, { timeoutMs = 20000, curlPath = '/usr/bin/curl', spawnImpl = spawn } = {}) {
  const url = new URL(rawUrl);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const args = ['-sS', '-f', '--anyauth', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '-A', 'nongfon/1.0', '-o', '-', '-K', '-', '--url', url.toString()];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(curlPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new CaptureError(`เรียก curl ไม่ได้: ${err.message}`, 'http'));
      return;
    }
    const out = [];
    let err = '';
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => reject(new CaptureError(`เรียก curl ไม่ได้: ${e.message}`, 'http')));
    child.on('close', (code) => {
      if (code === 28) return reject(new CaptureError(`กล้องไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที`, 'timeout'));
      if (code === 22 && /\b40[13]\b/.test(err)) return reject(new CaptureError('กล้องไม่ยอมให้เข้า — ตรวจชื่อผู้ใช้/รหัสผ่านในลิงก์', 'auth'));
      if (code === 22) return reject(new CaptureError(`กล้องตอบ ${(err.match(/error: (\d{3})/) || [])[1] ? `HTTP ${err.match(/error: (\d{3})/)[1]}` : 'ข้อผิดพลาด'}`, 'http'));
      if (code !== 0) return reject(new CaptureError(`ต่อกล้องไม่ได้ (curl ${code}): ${err.trim().replace(/^curl: \(\d+\) /, '').slice(0, 120)}`, 'http'));
      const buf = Buffer.concat(out);
      if (!CURL_IMAGE.test(buf.subarray(0, 4).toString('latin1'))) return reject(new CaptureError('ลิงก์นี้ไม่ได้ส่งรูปกลับมา', 'http'));
      resolve(buf);
    });
    // the login rides on stdin as a curl config line, so it never shows up in the process list
    child.stdin.write(username ? `user = "${quoteCurl(username)}:${quoteCurl(password)}"\n` : '');
    child.stdin.end();
  });
}

// ---------------------------------------------------------------- files
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

async function grabFile(target) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new CaptureError(`ไม่พบไฟล์หรือโฟลเดอร์ ${target}`, 'file');
  }
  if (stat.isDirectory()) {
    const names = (await fs.readdir(target)).filter((n) => IMAGE_EXT.test(n));
    if (!names.length) throw new CaptureError(`ไม่มีไฟล์ภาพในโฟลเดอร์ ${target}`, 'file');
    const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(target, n))).mtimeMs })));
    withTime.sort((a, b) => b.t - a.t);
    return fs.readFile(path.join(target, withTime[0].n));
  }
  return fs.readFile(target);
}

/** Raw bytes of one frame from any supported source. */
export async function grabFrame(camera, ctx = {}) {
  const url = camera.url.trim();
  if (url.startsWith('demo:')) {
    if (!ctx.demoFrame) throw new CaptureError('โหมดสาธิตยังไม่พร้อม', 'demo');
    return ctx.demoFrame(camera);
  }
  if (url.startsWith('ffmpeg:')) return grabWithFfmpeg(url.slice(7), ctx);
  if (/^rtsps?:\/\//i.test(url) || /^rtmp:\/\//i.test(url)) return grabWithFfmpeg(url, ctx);
  if (/^https?:\/\//i.test(url)) return ctx.httpTool === 'curl' ? grabWithCurl(url, ctx) : grabHttp(url, ctx);
  const file = url.startsWith('file://') ? fileURLToPath(url) : url;
  return grabFile(path.resolve(file));
}

/**
 * Capture, normalise and quality-check one camera, with one retry.
 * Returns { buffer, width, height, metrics } or throws CaptureError.
 */
export async function captureCamera(camera, ctx = {}) {
  const attempts = ctx.attempts ?? 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = await grabFrame(camera, ctx);
      let norm;
      try {
        norm = await normalizeFrame(raw, ctx.maxEdge);
      } catch {
        throw new CaptureError('ได้ข้อมูลมาแต่ไม่ใช่ภาพที่เปิดได้', 'decode');
      }
      const metrics = await frameMetrics(norm.buffer);
      if (isBlank(metrics)) throw new CaptureError('ภาพเป็นสีเดียวทั้งภาพ (สตรีมยังไม่พร้อมหรือเลนส์ถูกบัง)', 'blank');
      return { ...norm, metrics };
    } catch (err) {
      lastError = err instanceof CaptureError ? err : new CaptureError(err.message);
      log.warn(`${camera.name}: ครั้งที่ ${attempt}/${attempts} ไม่สำเร็จ — ${lastError.message}`);
      if (attempt < attempts) await sleep(ctx.retryDelayMs ?? 2000);
    }
  }
  throw lastError;
}

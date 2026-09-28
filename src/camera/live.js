// Live view: each camera as one MJPEG stream (multipart/x-mixed-replace) that any
// number of dashboard viewers can watch at once, like a CCTV monitor.
//   rtsp / rtmp / ffmpeg:    → one long-running ffmpeg that turns the video into small JPEGs
//   go2rtc …/api/frame.jpeg  → proxy go2rtc's own …/api/stream.mjpeg
//   other http(s) links      → poll the snapshot (or proxy it, if it answers with MJPEG)
//   files / folders          → poll the newest image
//   demo:street / carport    → cartoon frames from demo mode
// One source per camera however many people watch. It stops a few seconds after the
// last viewer leaves, so nothing keeps pulling video from the camera all night.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CaptureError, digestAuthorization, grabFrame } from './capture.js';
import { logger, maskText } from '../log.js';

const log = logger('live');

export const BOUNDARY = 'nfframe';
const LIVE_HEADERS = {
  'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Connection: 'close',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
};
const FRESH_MS = 3000; // frame() reuses a frame younger than this
const MAX_POLL_FAILURES = 3;
const POLL_TIMEOUT_MS = 10000;
const ONE_SHOT_TIMEOUT_MS = 20000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 3000;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout fires at once above this
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const CRLF = Buffer.from('\r\n');
const FFMPEG_MISSING = 'ไม่พบโปรแกรม ffmpeg — รันตัวติดตั้งน้องฝนอีกครั้ง (จะเติม ffmpeg ให้) หรือใช้ Docker หรือเปลี่ยนไปใช้ลิงก์ภาพแบบ http';

/** Error text people will see: camera logins and password-like query values hidden. */
function clean(text) {
  return maskText(text).replace(/([?&][^=&\s]*(?:pass|pwd|token|secret|key|auth|sig)[^=&\s]*=)[^&\s]+/gi, '$1****');
}

// ---------------------------------------------------------------- source kinds
/** go2rtc snapshot link (…/api/frame.jpeg?src=NAME) → its MJPEG stream, same query and login. */
export function go2rtcStreamUrl(url) {
  let u;
  try {
    u = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.pathname.endsWith('/api/frame.jpeg') || !u.searchParams.get('src')) return null;
  u.pathname = u.pathname.replace(/frame\.jpeg$/, 'stream.mjpeg');
  return u.toString();
}

export function liveKind(url) {
  const u = String(url ?? '').trim();
  if (u.startsWith('demo:')) return 'demo';
  if (u.startsWith('ffmpeg:') || /^(rtsps?|rtmp):\/\//i.test(u)) return 'ffmpeg';
  if (/^https?:\/\//i.test(u) && go2rtcStreamUrl(u)) return 'mjpeg';
  return 'poll';
}

/** ffmpeg arguments for an endless run of small JPEGs on stdout. */
export function liveFfmpegArgs(input, { width = 960, fps = 4, rtspTransport = 'tcp', localFile = false } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (/^rtsps?:\/\//i.test(input) && rtspTransport) args.push('-rtsp_transport', rtspTransport);
  // A video file would be read as fast as the disk allows and then end: play it in real time, on a loop.
  if (localFile) args.push('-re', '-stream_loop', '-1');
  args.push('-i', input, '-an', '-vf', `fps=${fps},scale='min(${width},iw)':-2`, '-c:v', 'mjpeg', '-q:v', '7', '-f', 'image2pipe', 'pipe:1');
  return args;
}

async function isLocalFile(input) {
  let file = input;
  if (/^file:/i.test(input)) {
    try {
      file = fileURLToPath(input);
    } catch {
      file = input.slice(5);
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    return false; // http:, rtsp:, pipe:, …
  }
  try {
    return (await fs.stat(file)).isFile(); // not /dev/video0 and friends
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- JPEG stream splitting
/**
 * Where the JPEG starting at `start` ends. Walks the marker segments, so an EXIF
 * thumbnail (a whole JPEG inside APP1) or FFD9 bytes inside a table cannot end it early.
 * Returns { end } just past EOI, { restart } at a new SOI (this picture was cut short),
 * or null when more bytes are needed.
 */
function scanJpeg(buf, start) {
  let i = start + 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return plainSearch(buf, i);
    const m = buf[i + 1];
    if (m === 0xd9) return { end: i + 2 };
    if (m === 0xd8) return { restart: i };
    if (m === 0xff) {
      i += 1; // fill byte
    } else if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2; // markers without a length
    } else {
      if (i + 3 >= buf.length) return null;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return plainSearch(buf, i + 2);
      i += 2 + len;
      if (m === 0xda) {
        i = skipScan(buf, i);
        if (i < 0) return null;
      }
    }
  }
  return null;
}

/** Skip compressed scan data up to the next real marker (FF00 = stuffed byte, FFD0-D7 = restart). */
function skipScan(buf, from) {
  let i = from;
  for (;;) {
    const ff = buf.indexOf(0xff, i);
    if (ff < 0 || ff + 1 >= buf.length) return -1;
    const next = buf[ff + 1];
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) i = ff + 2;
    else if (next === 0xff) i = ff + 1;
    else return ff;
  }
}

/** Damaged structure: fall back to the next SOI or EOI, whichever comes first. */
function plainSearch(buf, from) {
  const soi = buf.indexOf(SOI, from);
  const eoi = buf.indexOf(EOI, from);
  if (soi >= 0 && (eoi < 0 || soi < eoi)) return { restart: soi };
  return eoi < 0 ? null : { end: eoi + 2 };
}

/** Split concatenated JPEGs (SOI FFD8 … EOI FFD9). Frames are views into `buffer`; `rest` is the unfinished tail. */
export function splitJpegs(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const frames = [];
  let start = buf.indexOf(SOI);
  while (start >= 0) {
    const found = scanJpeg(buf, start);
    if (!found) return { frames, rest: buf.subarray(start) };
    if (found.restart !== undefined) {
      start = found.restart;
    } else {
      frames.push(buf.subarray(start, found.end));
      start = buf.indexOf(SOI, found.end);
    }
  }
  // No picture has started: keep only a trailing 0xFF, it may be the first half of the next SOI.
  const keep = buf.length && buf[buf.length - 1] === 0xff ? 1 : 0;
  return { frames, rest: buf.subarray(buf.length - keep) };
}

/** Feeds stream chunks to splitJpegs, joining them only when a picture may have just ended. */
class JpegCollector {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.chunks = [];
    this.size = 0;
    this.last = 0;
  }

  push(chunk) {
    if (!chunk.length) return;
    const mayEnd = chunk.includes(EOI) || (this.last === 0xff && chunk[0] === 0xd9);
    this.chunks.push(chunk);
    this.size += chunk.length;
    this.last = chunk[chunk.length - 1];
    if (mayEnd) {
      const { frames, rest } = splitJpegs(this.chunks.length === 1 ? chunk : Buffer.concat(this.chunks, this.size));
      this.chunks = rest.length ? [rest] : [];
      this.size = rest.length;
      this.last = rest.length ? rest[rest.length - 1] : 0;
      for (const frame of frames) this.onFrame(frame);
    }
    if (this.size > MAX_FRAME_BYTES) {
      // no complete picture in 8 MB: drop it and resync on the next SOI
      this.chunks = [];
      this.size = 0;
      this.last = 0;
    }
  }
}

// ---------------------------------------------------------------- images
/** Width from a JPEG's SOF header, or 0 when it cannot be read. */
function jpegWidth(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return 0;
  let i = 2;
  while (i + 8 < buf.length && buf[i] === 0xff) {
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return buf.readUInt16BE(i + 7);
    if (m === 0xda || m === 0xd9) return 0;
    i += m === 0xff ? 1 : 2 + buf.readUInt16BE(i + 2);
  }
  return 0;
}

/** Live frames are JPEGs no wider than `width`; small JPEGs pass through untouched. */
async function fitJpeg(buffer, width) {
  const w = jpegWidth(buffer);
  if (w && w <= width) return buffer;
  try {
    return await sharp(buffer).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
  } catch {
    throw new CaptureError('ได้ข้อมูลมาแต่ไม่ใช่ภาพที่เปิดได้', 'decode');
  }
}

function partOf(jpeg) {
  const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  return Buffer.concat([head, jpeg, CRLF]);
}

// ---------------------------------------------------------------- HTTP
function parseChallenge(header) {
  const out = {};
  for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

const typeOf = (res) => (res.headers.get('content-type') || '').toLowerCase();

/** GET with the login from the URL (Basic, or Digest when the camera asks for it). Resolves once headers arrive. */
async function openHttp(rawUrl, { signal, fetchImpl }) {
  const url = new URL(rawUrl);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const headers = { 'User-Agent': 'nongfon/1.0', Accept: 'multipart/x-mixed-replace, image/*' };
  if (username) headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  let res;
  try {
    res = await fetchImpl(url, { headers, signal });
    const challenge = res.headers.get('www-authenticate') || '';
    if (res.status === 401 && username && /^digest/i.test(challenge)) {
      await res.body?.cancel().catch(() => {});
      const auth = digestAuthorization({
        username, password, method: 'GET', uri: url.pathname + url.search, challenge: parseChallenge(challenge),
      });
      res = await fetchImpl(url, { headers: { ...headers, Authorization: auth }, signal });
    }
  } catch (err) {
    if (signal.aborted) throw err;
    throw new CaptureError(`ต่อกล้องไม่ได้: ${err.cause?.code || err.message}`, 'http');
  }
  if (res.ok) return res;
  await res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) {
    throw new CaptureError(`กล้องไม่ยอมให้เข้า (HTTP ${res.status}) — ตรวจชื่อผู้ใช้/รหัสผ่านในลิงก์`, 'auth');
  }
  throw new CaptureError(`กล้องตอบ HTTP ${res.status}`, 'http');
}

// ---------------------------------------------------------------- one camera's source
class LiveSource {
  constructor(camera, opts) {
    this.camera = camera;
    this.id = camera.id;
    this.url = camera.url.trim();
    this.kind = liveKind(this.url);
    this.opts = opts;
    this.viewers = new Set();
    this.startedAt = Date.now();
    this.frames = 0;
    this.lastFrameAt = null;
    this.latest = null;
    this.error = null;
    this.stopped = false;
    this.probed = false;
    this.busy = false;
    this.acceptedAt = 0;
    // 80 % of the frame interval, so a camera already running at `fps` is not halved by jitter
    this.minGapMs = 800 / opts.fps;
  }

  info() {
    return {
      id: this.id, kind: this.kind, viewers: this.viewers.size, startedAt: this.startedAt,
      frames: this.frames, lastFrameAt: this.lastFrameAt, error: this.error, running: !this.stopped,
    };
  }

  start() {
    log.info(`เริ่มดูสดกล้อง ${this.camera.name} (${this.kind})`);
    let run;
    if (this.kind === 'ffmpeg') run = this.#runFfmpeg('tcp');
    else if (this.kind === 'mjpeg') run = this.#runStream(go2rtcStreamUrl(this.url));
    else run = this.#pollLoop();
    run.catch((err) => this.fail(err));
  }

  // -------------------------------------------------------------- viewers
  addViewer(req, res, first) {
    const viewer = { res, blocked: false, gone: false };
    viewer.onDrain = () => {
      viewer.blocked = false;
    };
    const leave = () => this.removeViewer(viewer);
    req.on('close', leave);
    res.on('close', leave);
    res.on('error', leave);
    viewer.timer = setTimeout(() => {
      log.info(`ครบเวลาดูสดกล้อง ${this.camera.name} ปิดการเชื่อมต่อ (เปิดดูใหม่ได้)`);
      this.removeViewer(viewer);
    }, Math.min(this.opts.maxViewerMs, MAX_TIMER_MS));
    clearTimeout(this.idleTimer);
    this.viewers.add(viewer);
    log.debug(`ดูสดกล้อง ${this.camera.name} อยู่ ${this.viewers.size} คน`);
    if (first) this.#send(viewer, partOf(first));
    if (res.destroyed || res.writableEnded) this.removeViewer(viewer); // the browser left before we got here
  }

  removeViewer(viewer) {
    if (viewer.gone) return;
    viewer.gone = true;
    clearTimeout(viewer.timer);
    viewer.res.off('drain', viewer.onDrain);
    this.viewers.delete(viewer);
    const { res } = viewer;
    // Cut the connection rather than end it cleanly: a cleanly ended stream leaves the last
    // frame on screen looking live (Chromium fires no event), a cut one blanks the picture
    // (and fires <img> "error" if no frame had arrived yet).
    if (!res.destroyed && !res.writableEnded) res.destroy();
    if (!this.stopped && !this.viewers.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.stop('idle'), this.opts.idleMs);
    }
  }

  #send(viewer, part) {
    if (viewer.blocked || viewer.gone) return;
    try {
      if (!viewer.res.write(part)) {
        // Slow viewer: skip frames until its socket drains instead of queueing them in memory.
        viewer.blocked = true;
        viewer.res.once('drain', viewer.onDrain);
      }
    } catch {
      this.removeViewer(viewer);
    }
  }

  emit(jpeg) {
    if (this.stopped) return;
    this.frames += 1;
    this.lastFrameAt = Date.now();
    this.error = null;
    this.latest = jpeg;
    if (this.kind === 'ffmpeg' || this.kind === 'mjpeg') this.#armStall();
    this.opts.onFrame(this.id, jpeg);
    const part = partOf(jpeg);
    for (const viewer of this.viewers) this.#send(viewer, part);
  }

  // -------------------------------------------------------------- ending
  fail(err) {
    if (this.stopped) return;
    this.error = clean(err?.message || String(err));
    log.warn(`สตรีมสดกล้อง ${this.camera.name} หยุด: ${this.error}`);
    this.stop('error');
  }

  stop(reason = 'stop') {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.stallTimer);
    clearTimeout(this.pollTimer);
    this.wake?.();
    this.controller?.abort();
    this.#kill();
    for (const viewer of [...this.viewers]) this.removeViewer(viewer);
    this.opts.onEnd(this, reason);
  }

  #armStall() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.fail(new CaptureError(`ไม่มีภาพจากกล้องเกิน ${Math.round(this.opts.stallMs / 1000)} วินาที`, 'stall'));
    }, this.opts.stallMs);
  }

  #kill() {
    const child = this.child;
    this.child = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    // SIGTERM first: ffmpeg then sends RTSP TEARDOWN, so the camera frees the session for the next check.
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    force.unref();
    child.once('close', () => clearTimeout(force));
  }

  // -------------------------------------------------------------- ffmpeg
  async #runFfmpeg(transport) {
    const input = this.url.startsWith('ffmpeg:') ? this.url.slice(7) : this.url;
    const localFile = await isLocalFile(input);
    if (this.stopped) return;
    const args = liveFfmpegArgs(input, { width: this.opts.width, fps: this.opts.fps, rtspTransport: transport, localFile });
    const child = this.opts.spawnImpl(this.opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.#armStall();
    const collector = new JpegCollector((jpeg) => this.emit(jpeg));
    let stderr = '';
    child.stdout.on('data', (chunk) => collector.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 4000) {
        // keep whole lines only, so a camera URL is never cut in half before it is masked
        const cut = stderr.indexOf('\n', stderr.length - 2000);
        stderr = cut >= 0 ? stderr.slice(cut + 1) : '';
      }
    });
    child.on('error', (err) => {
      this.fail(new CaptureError(err.code === 'ENOENT' ? FFMPEG_MISSING : `ffmpeg ผิดพลาด: ${err.message}`, 'ffmpeg'));
    });
    child.on('close', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      if (transport === 'tcp' && /^rtsps?:\/\//i.test(input) && /461|Unsupported Transport/i.test(stderr)) {
        log.info(`กล้อง ${this.camera.name} ไม่รับ RTSP แบบ TCP ลองแบบ UDP`);
        this.#runFfmpeg('udp').catch((err) => this.fail(err));
        return;
      }
      const detail = clean(stderr.trim().split('\n').slice(-2).join(' ')).slice(0, 240);
      this.fail(new CaptureError(`สตรีมจากกล้องหยุด (ffmpeg ${code ?? signal})${detail ? `: ${detail}` : ''}`, 'ffmpeg'));
    });
  }

  // -------------------------------------------------------------- MJPEG over HTTP
  async #runStream(url, response = null, controller = new AbortController()) {
    this.controller = controller;
    this.#armStall();
    try {
      const res = response ?? (await openHttp(url, { signal: controller.signal, fetchImpl: this.opts.fetchImpl }));
      const type = typeOf(res);
      if (!res.body || (type && !/^(multipart\/|image\/|application\/octet-stream)/.test(type))) {
        await res.body?.cancel().catch(() => {});
        throw new CaptureError(`ลิงก์นี้ไม่ได้ส่งภาพกลับมา${type ? ` (ได้ ${type.split(';')[0]})` : ''}`, 'http');
      }
      const collector = new JpegCollector((jpeg) => this.#streamFrame(jpeg));
      for await (const chunk of res.body) {
        if (this.stopped) return;
        collector.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
      throw new CaptureError('กล้องปิดสตรีมภาพ', 'stream');
    } catch (err) {
      if (this.stopped) return;
      this.fail(err instanceof CaptureError ? err : new CaptureError(`สตรีมภาพขาด: ${err.cause?.code || err.message}`, 'stream'));
    }
  }

  /** Cameras send MJPEG at their own rate and size: keep at most `fps` frames, shrunk to `width`. */
  #streamFrame(jpeg) {
    const now = Date.now();
    if (this.busy || now - this.acceptedAt < this.minGapMs) return;
    this.acceptedAt = now;
    this.busy = true;
    fitJpeg(jpeg, this.opts.width)
      .then((out) => this.emit(out))
      .catch((err) => log.debug(`กล้อง ${this.camera.name}: ข้ามภาพที่เปิดไม่ได้ — ${err.message}`))
      .finally(() => {
        this.busy = false;
      });
  }

  // -------------------------------------------------------------- polling (snapshots, files, demo)
  async #pollLoop() {
    let failures = 0;
    while (!this.stopped) {
      const began = Date.now();
      try {
        const raw = await this.#grab();
        if (raw === null || this.stopped) return; // switched to streaming, or stopped meanwhile
        const jpeg = await fitJpeg(raw, this.opts.width);
        failures = 0;
        this.emit(jpeg);
      } catch (err) {
        if (this.stopped) return;
        failures += 1;
        this.error = clean(err.message);
        if (failures >= MAX_POLL_FAILURES) return this.fail(err);
        log.debug(`กล้อง ${this.camera.name}: ดึงภาพสดไม่สำเร็จ ${failures}/${MAX_POLL_FAILURES} — ${this.error}`);
      }
      await this.#sleep(Math.max(0, this.opts.pollMs - (Date.now() - began)));
    }
  }

  #grab() {
    // with HTTP_TOOL=curl, node itself may not reach the camera: skip the MJPEG probe and poll through curl
    if (!this.probed && /^https?:\/\//i.test(this.url) && this.opts.httpTool !== 'curl') return this.#probe();
    const { ffmpegPath, fetchImpl, demoFrame, httpTool } = this.opts;
    return grabFrame(this.camera, { ffmpegPath, fetchImpl, demoFrame, httpTool, timeoutMs: POLL_TIMEOUT_MS });
  }

  /** First request to an http link: a snapshot is polled from then on, an MJPEG answer is kept open and streamed. */
  async #probe() {
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const res = await openHttp(this.url, { signal: controller.signal, fetchImpl: this.opts.fetchImpl });
      const type = typeOf(res);
      if (type.startsWith('multipart/')) {
        clearTimeout(timer);
        this.probed = true;
        this.kind = 'mjpeg';
        log.info(`กล้อง ${this.camera.name} ส่งภาพแบบ MJPEG อยู่แล้ว เปลี่ยนเป็นรับสตรีมต่อเนื่อง`);
        this.#runStream(null, res, controller).catch((err) => this.fail(err));
        return null;
      }
      if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
        await res.body?.cancel().catch(() => {});
        throw new CaptureError(`ลิงก์นี้ไม่ได้ส่งรูปกลับมา (ได้ ${type.split(';')[0]})`, 'http');
      }
      const buf = Buffer.from(await res.arrayBuffer());
      this.probed = true;
      return buf;
    } catch (err) {
      if (controller.signal.aborted && !this.stopped) {
        throw new CaptureError(`กล้องไม่ตอบภายใน ${Math.round(POLL_TIMEOUT_MS / 1000)} วินาที`, 'timeout');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (this.kind !== 'mjpeg' && this.controller === controller) this.controller = null;
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.pollTimer = setTimeout(resolve, ms);
    });
  }
}

// ---------------------------------------------------------------- the hub
export class LiveHub {
  #sources = new Map(); // camera id → running LiveSource
  #failed = new Map(); // camera id → info() of a source that ended with an error
  #latest = new Map(); // camera id → { jpeg, at }
  #oneShots = new Map(); // camera id → in-flight frame() capture

  constructor({
    ffmpegPath = 'ffmpeg', getCamera, demoFrame = null, width = 960, fps = 4, pollMs = 1000, maxStreams = 4,
    idleMs = 8000, maxViewerMs = 15 * 60e3, stallMs = 20e3, fetchImpl = fetch, spawnImpl = spawn, httpTool = 'fetch',
  } = {}) {
    if (typeof getCamera !== 'function') throw new TypeError('LiveHub ต้องมี getCamera(id)');
    this.getCamera = getCamera;
    this.maxStreams = maxStreams;
    this.opts = {
      ffmpegPath, demoFrame, width, fps, pollMs, idleMs, maxViewerMs, stallMs, fetchImpl, spawnImpl, httpTool,
      onFrame: (id, jpeg) => this.#latest.set(id, { jpeg, at: Date.now() }),
      onEnd: (source, reason) => this.#ended(source, reason),
    };
  }

  /** Serve one viewer: 'ok' (response now streaming), 'unknown' (answer 404) or 'busy' (answer 503). */
  attach(id, req, res) {
    const camera = this.getCamera(id);
    if (!camera) return 'unknown';
    let source = this.#sources.get(id);
    const isNew = !source;
    if (isNew) {
      if (!this.#makeRoom()) {
        log.info(`ดูสดพร้อมกันได้สูงสุด ${this.maxStreams} กล้อง — ยังเปิดกล้อง ${camera.name} ไม่ได้`);
        return 'busy';
      }
      source = new LiveSource(camera, this.opts);
      this.#sources.set(id, source);
      this.#failed.delete(id);
    }
    res.writeHead(200, { ...LIVE_HEADERS });
    res.flushHeaders?.();
    source.addViewer(req, res, source.latest || this.#fresh(id));
    if (isNew) source.start();
    return 'ok';
  }

  /** The latest live frame if younger than 3 s, otherwise one capture (shared by concurrent callers). */
  async frame(id) {
    const camera = this.getCamera(id);
    if (!camera) throw new CaptureError('ไม่พบกล้องนี้', 'unknown');
    const fresh = this.#fresh(id);
    if (fresh) return fresh;
    if (!this.#oneShots.has(id)) {
      this.#oneShots.set(id, this.#capture(camera).finally(() => this.#oneShots.delete(id)));
    }
    return this.#oneShots.get(id);
  }

  stats() {
    const streams = [...this.#sources.values()].map((s) => s.info());
    for (const [id, info] of this.#failed) if (!this.#sources.has(id)) streams.push(info);
    return { streams };
  }

  stopAll() {
    const running = this.#sources.size;
    for (const source of [...this.#sources.values()]) source.stop('shutdown');
    this.#failed.clear();
    this.#latest.clear();
    if (running) log.info(`ปิดสตรีมดูสดทั้งหมด ${running} กล้อง`);
  }

  async #capture(camera) {
    const { ffmpegPath, fetchImpl, demoFrame, width } = this.opts;
    let raw;
    try {
      raw = await grabFrame(camera, { ffmpegPath, fetchImpl, demoFrame, timeoutMs: ONE_SHOT_TIMEOUT_MS });
    } catch (err) {
      throw new CaptureError(clean(err.message), err.code || 'capture');
    }
    const jpeg = await fitJpeg(raw, width);
    this.#latest.set(camera.id, { jpeg, at: Date.now() });
    return jpeg;
  }

  #fresh(id) {
    const hit = this.#latest.get(id);
    return hit && Date.now() - hit.at < FRESH_MS ? hit.jpeg : null;
  }

  /** At the limit, a source nobody is watching (waiting out idleMs) gives way to a camera someone wants. */
  #makeRoom() {
    if (this.#sources.size < this.maxStreams) return true;
    const idle = [...this.#sources.values()].find((s) => !s.viewers.size);
    if (!idle) return false;
    idle.stop('idle');
    return true;
  }

  #ended(source, reason) {
    if (this.#sources.get(source.id) === source) this.#sources.delete(source.id);
    if (reason === 'error') this.#failed.set(source.id, source.info());
    if (reason === 'idle') log.info(`หยุดสตรีมกล้อง ${source.camera.name} (ไม่มีคนดู)`);
  }
}

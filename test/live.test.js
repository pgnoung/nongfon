import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { BOUNDARY, LiveHub, go2rtcStreamUrl, liveFfmpegArgs, liveKind, splitJpegs } from '../src/camera/live.js';
import { CaptureError } from '../src/camera/capture.js';
import { makeJpeg, tmpDir } from './helpers.js';

const HAS_FFMPEG = !spawnSync('ffmpeg', ['-version']).error;
const NO_FFMPEG = !HAS_FFMPEG && 'ffmpeg is not on PATH';
const b64 = (s) => Buffer.from(s).toString('base64');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO_CAMS = {
  cam1: { id: 'cam1', name: 'หน้าบ้าน', url: 'demo:street' },
  cam2: { id: 'cam2', name: 'โรงรถ', url: 'demo:carport' },
};
const getDemo = (id) => DEMO_CAMS[id] || null;

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

function shutdown(server) {
  server.closeAllConnections();
  server.close();
}

/** Dashboard stand-in: GET /<camera id> → hub.attach, answering 404/503 like the real route. */
function liveServer(hub) {
  return serve((req, res) => {
    const outcome = hub.attach(req.url.slice(1), req, res);
    if (outcome !== 'ok') {
      res.writeHead(outcome === 'unknown' ? 404 : 503);
      res.end(outcome);
    }
  });
}

/** Deterministic wait: re-check a condition until it holds, fail loudly after a bound. */
async function waitFor(check, what, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for: ${what}`);
    await delay(10);
  }
}

const DELIM = Buffer.from(`--${BOUNDARY}\r\n`);

/** Parse our multipart body byte for byte: boundary, headers, exactly Content-Length JPEG bytes, CRLF. */
function parseParts(buf) {
  const parts = [];
  let i = 0;
  while (buf.length - i >= DELIM.length) {
    if (!buf.subarray(i, i + DELIM.length).equals(DELIM)) throw new Error(`no boundary at byte ${i}`);
    const headEnd = buf.indexOf('\r\n\r\n', i);
    if (headEnd < 0) break;
    const head = buf.subarray(i + DELIM.length, headEnd).toString('latin1');
    const len = Number(/^Content-Length: (\d+)$/m.exec(head)?.[1]);
    if (!Number.isInteger(len)) throw new Error(`no Content-Length in ${JSON.stringify(head)}`);
    const start = headEnd + 4;
    if (buf.length < start + len + 2) break;
    if (buf.toString('latin1', start + len, start + len + 2) !== '\r\n') throw new Error('part does not end with CRLF');
    parts.push({ head, body: buf.subarray(start, start + len) });
    i = start + len + 2;
  }
  return { parts, rest: buf.subarray(i) };
}

/** A browser-like viewer that collects parts as they arrive. */
function openViewer(url) {
  return new Promise((resolve, reject) => {
    const viewer = { parts: [], buffered: Buffer.alloc(0), closed: false, complete: false, problem: null };
    const req = http.get(url, (res) => {
      viewer.status = res.statusCode;
      viewer.headers = res.headers;
      res.on('data', (chunk) => {
        try {
          const { parts, rest } = parseParts(Buffer.concat([viewer.buffered, chunk]));
          viewer.parts.push(...parts);
          viewer.buffered = rest;
        } catch (err) {
          viewer.problem = err;
        }
      });
      res.on('error', () => {}); // a cut-off stream is an expected outcome here
      res.on('close', () => {
        viewer.closed = true;
        viewer.complete = res.complete;
      });
      resolve(viewer);
    });
    req.on('error', (err) => (viewer.status ? null : reject(err)));
    viewer.close = () => req.destroy();
  });
}

/** Minimal ServerResponse stand-in that records every write; `full` makes write() report a full socket. */
function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, {
    chunks: [], full: false, destroyed: false, writableEnded: false, status: null, headers: null,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    write(chunk) {
      res.chunks.push(Buffer.from(chunk));
      return !res.full;
    },
    end() {
      res.writableEnded = true;
      res.emit('close');
    },
    destroy() {
      res.destroyed = true;
      res.emit('close');
    },
  });
  return res;
}

/** A JPEG carrying a whole second JPEG inside APP1, the way cameras embed an EXIF thumbnail. */
function withThumbnail(jpeg, thumb) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), thumb]);
  const marker = Buffer.from([0xff, 0xe1, 0, 0]);
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

// ------------------------------------------------------------------ pure helpers
test('splitJpegs finds whole pictures across any chunk boundary (thumbnails included)', async () => {
  const a = await makeJpeg({ width: 64, height: 48 });
  const b = await makeJpeg({ width: 96, height: 40 });
  const c = withThumbnail(a, b);
  const text = (s) => Buffer.from(s);
  const stream = Buffer.concat([
    text('--x\r\nContent-Type: image/jpeg\r\n\r\n'), a, text('\r\n--x\r\n\r\n'), c, text('\r\n--x\r\n\r\n'), b, text('\r\n'),
  ]);
  for (const size of [1, 2, 3, 7, 100, 1000, stream.length]) {
    const got = [];
    let rest = Buffer.alloc(0);
    for (let i = 0; i < stream.length; i += size) {
      const out = splitJpegs(Buffer.concat([rest, stream.subarray(i, i + size)]));
      got.push(...out.frames);
      rest = out.rest;
    }
    assert.equal(got.length, 3, `chunk size ${size}`);
    assert.ok(got[0].equals(a) && got[1].equals(c) && got[2].equals(b), `chunk size ${size}`);
    assert.equal(rest.length, 0, `chunk size ${size}`);
  }
});

test('splitJpegs drops a picture that was cut short and keeps unfinished bytes', async () => {
  const a = await makeJpeg({ width: 64, height: 48 });
  const b = await makeJpeg({ width: 96, height: 40 });
  const { frames, rest } = splitJpegs(Buffer.concat([a.subarray(0, a.length - 20), b]));
  assert.equal(frames.length, 1);
  assert.ok(frames[0].equals(b));
  assert.equal(rest.length, 0);
  const half = splitJpegs(Buffer.concat([Buffer.from('--x\r\n\r\n'), a.subarray(0, 100)]));
  assert.equal(half.frames.length, 0);
  assert.ok(half.rest.equals(a.subarray(0, 100)));
  assert.deepEqual([...splitJpegs(Buffer.from('--x\r\n\xff', 'latin1')).rest], [0xff]); // may be half an SOI
  assert.equal(splitJpegs(Buffer.from('no pictures here')).rest.length, 0);
});

test('liveKind and go2rtcStreamUrl pick the right source for every link', () => {
  assert.equal(liveKind('rtsp://admin:pw@10.0.0.2:554/stream1'), 'ffmpeg');
  assert.equal(liveKind('rtsps://cam.local/s'), 'ffmpeg');
  assert.equal(liveKind('rtmp://cam.local/live'), 'ffmpeg');
  assert.equal(liveKind('ffmpeg:/videos/clip.mp4'), 'ffmpeg');
  assert.equal(liveKind('http://10.0.0.9:1984/api/frame.jpeg?src=front'), 'mjpeg');
  assert.equal(liveKind('http://10.0.0.9:1984/api/frame.jpeg'), 'poll');
  assert.equal(liveKind('https://cam.local/snapshot.jpg'), 'poll');
  assert.equal(liveKind(' demo:street '), 'demo');
  assert.equal(liveKind('/srv/camera-folder'), 'poll');
  assert.equal(liveKind('file:///srv/camera/latest.jpg'), 'poll');

  assert.equal(
    go2rtcStreamUrl('http://admin:p%40ss@10.0.0.9:1984/api/frame.jpeg?src=front_door&x=1'),
    'http://admin:p%40ss@10.0.0.9:1984/api/stream.mjpeg?src=front_door&x=1',
  );
  assert.equal(go2rtcStreamUrl('https://home.example/go2rtc/api/frame.jpeg?src=gate'), 'https://home.example/go2rtc/api/stream.mjpeg?src=gate');
  assert.equal(go2rtcStreamUrl('http://cam.local/snapshot.jpg'), null);
  assert.equal(go2rtcStreamUrl('rtsp://cam.local/api/frame.jpeg?src=a'), null);
  assert.equal(go2rtcStreamUrl('not a url'), null);
});

test('ffmpeg live args: RTSP over TCP, local files loop in real time, small JPEGs out', () => {
  assert.deepEqual(liveFfmpegArgs('rtsp://u:p@10.0.0.2/s', { width: 640, fps: 2 }), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-rtsp_transport', 'tcp', '-i', 'rtsp://u:p@10.0.0.2/s',
    '-an', '-vf', "fps=2,scale='min(640,iw)':-2", '-c:v', 'mjpeg', '-q:v', '7', '-f', 'image2pipe', 'pipe:1',
  ]);
  assert.deepEqual(liveFfmpegArgs('/videos/test.mp4', { localFile: true }).slice(4, 9), ['-re', '-stream_loop', '-1', '-i', '/videos/test.mp4']);
  assert.ok(!liveFfmpegArgs('http://cam.local/live.m3u8').includes('-re'));
  assert.ok(liveFfmpegArgs('rtsp://cam.local/s', { rtspTransport: 'udp' }).includes('udp'));
});

// ------------------------------------------------------------------ fan-out and lifecycle
test('demo camera: two viewers share one source and both get well-formed JPEG parts', async (t) => {
  const picture = await makeJpeg({ width: 640, height: 360 });
  let renders = 0;
  const hub = new LiveHub({ getCamera: getDemo, demoFrame: async () => { renders++; return picture; }, width: 320, pollMs: 40 });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); });

  const a = await openViewer(`${base}/cam1`);
  const b = await openViewer(`${base}/cam1`);
  for (const v of [a, b]) {
    assert.equal(v.status, 200);
    assert.equal(v.headers['content-type'], `multipart/x-mixed-replace; boundary=${BOUNDARY}`);
    assert.equal(v.headers['cache-control'], 'no-store, no-cache, must-revalidate');
    assert.equal(v.headers.pragma, 'no-cache');
    assert.equal(v.headers['x-accel-buffering'], 'no');
    assert.equal(v.headers['x-content-type-options'], 'nosniff');
  }
  await waitFor(() => a.parts.length >= 3 && b.parts.length >= 3, 'three parts for each viewer');
  for (const part of [...a.parts, ...b.parts]) {
    assert.equal(part.head, `Content-Type: image/jpeg\r\nContent-Length: ${part.body.length}`);
    const meta = await sharp(part.body).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 320, 180]);
  }
  assert.equal(a.problem, null);
  assert.equal(b.problem, null);
  const { streams } = hub.stats();
  assert.equal(streams.length, 1);
  assert.equal(streams[0].kind, 'demo');
  assert.equal(streams[0].viewers, 2);
  assert.ok(renders <= streams[0].frames + 1, `one shared source (${renders} renders for ${streams[0].frames} frames)`);
});

test('the source outlives its last viewer by idleMs, is reused within it, then stops', async (t) => {
  const picture = await makeJpeg();
  let renders = 0;
  const hub = new LiveHub({ getCamera: getDemo, demoFrame: async () => { renders++; return picture; }, pollMs: 30, idleMs: 400 });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); });

  const first = await openViewer(`${base}/cam1`);
  await waitFor(() => first.parts.length >= 1, 'first frame');
  const { startedAt } = hub.stats().streams[0];
  first.close();
  await waitFor(() => hub.stats().streams[0]?.viewers === 0, 'viewer gone');
  const again = await openViewer(`${base}/cam1`);
  await waitFor(() => again.parts.length >= 1, 'a frame right after coming back');
  assert.equal(hub.stats().streams.length, 1);
  assert.equal(hub.stats().streams[0].startedAt, startedAt, 'the same source was reused');
  again.close();
  await waitFor(() => hub.stats().streams.length === 0, 'idle stop');
  const rendered = renders;
  await delay(100);
  assert.equal(renders, rendered, 'no more captures once stopped');
});

test('maxStreams: another camera is busy while one is watched; an idle source makes room', async (t) => {
  const picture = await makeJpeg();
  const hub = new LiveHub({ getCamera: getDemo, demoFrame: async () => picture, pollMs: 30, maxStreams: 1, idleMs: 60e3 });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); });

  const watching = await openViewer(`${base}/cam1`);
  assert.equal(watching.status, 200);
  assert.equal((await openViewer(`${base}/cam2`)).status, 503);
  const res = fakeRes();
  assert.equal(hub.attach('cam2', new EventEmitter(), res), 'busy');
  assert.equal(res.status, null);
  assert.equal(res.chunks.length, 0);
  const second = await openViewer(`${base}/cam1`);
  assert.equal(second.status, 200, 'a camera that is already live always has room');

  watching.close();
  second.close();
  await waitFor(() => hub.stats().streams[0]?.viewers === 0, 'cam1 idle');
  const other = await openViewer(`${base}/cam2`);
  assert.equal(other.status, 200);
  await waitFor(() => other.parts.length >= 1, 'cam2 frame');
  assert.deepEqual(hub.stats().streams.map((s) => s.id), ['cam2']);
});

test('unknown camera ids are refused without touching the response', async () => {
  const hub = new LiveHub({ getCamera: () => null });
  const res = fakeRes();
  assert.equal(hub.attach('nope', new EventEmitter(), res), 'unknown');
  assert.equal(res.status, null);
  assert.equal(res.chunks.length, 0);
  await assert.rejects(hub.frame('nope'), (err) => err instanceof CaptureError && err.code === 'unknown');
  assert.deepEqual(hub.stats(), { streams: [] });
  assert.throws(() => new LiveHub({}), /getCamera/);
});

test('a slow viewer skips frames until drain instead of queueing them', async (t) => {
  const picture = await makeJpeg();
  const hub = new LiveHub({ getCamera: getDemo, demoFrame: async () => picture, pollMs: 15 });
  t.after(() => hub.stopAll());
  const req = new EventEmitter();
  const res = fakeRes();
  res.full = true;
  assert.equal(hub.attach('cam1', req, res), 'ok');
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Connection: 'close',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  await waitFor(() => res.chunks.length === 1, 'first part');
  const blockedAt = hub.stats().streams[0].frames;
  await waitFor(() => hub.stats().streams[0].frames >= blockedAt + 3, 'more frames produced meanwhile');
  assert.equal(res.chunks.length, 1, 'nothing queued while the socket is full');
  res.full = false;
  res.emit('drain');
  await waitFor(() => res.chunks.length >= 3, 'writes resume after drain');
  const { parts, rest } = parseParts(Buffer.concat(res.chunks));
  assert.equal(rest.length, 0);
  assert.equal(parts.length, res.chunks.length, 'every write is one whole part');
  req.emit('close');
  assert.equal(hub.stats().streams[0].viewers, 0);
});

test('maxViewerMs cuts a forgotten viewer off, then the idle source stops', async (t) => {
  const picture = await makeJpeg();
  const hub = new LiveHub({ getCamera: getDemo, demoFrame: async () => picture, pollMs: 30, maxViewerMs: 200, idleMs: 50 });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); });

  const v = await openViewer(`${base}/cam1`);
  await waitFor(() => v.closed, 'viewer ended by maxViewerMs', 3000);
  assert.equal(v.complete, false, 'cut, so the browser blanks the picture instead of freezing it as if live');
  assert.ok(v.parts.length >= 1);
  await waitFor(() => hub.stats().streams.length === 0, 'source stopped once nobody watches');
});

// ------------------------------------------------------------------ HTTP sources
test('go2rtc: frame.jpeg link becomes one shared stream.mjpeg connection with Basic auth', async (t) => {
  const picture = await makeJpeg(); // 320 wide: under the live width, so it passes through byte for byte
  const upstream = [];
  let open = 0;
  const cam = await serve((req, res) => {
    upstream.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== `Basic ${b64('admin:p@ss')}`) {
      res.writeHead(401);
      return res.end();
    }
    open++;
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
    const half = picture.length >> 1;
    const timer = setInterval(() => {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${picture.length}\r\n\r\n`);
      res.write(picture.subarray(0, half)); // one picture split across network writes
      res.write(picture.subarray(half));
      res.write('\r\n');
    }, 25);
    res.on('close', () => {
      open--;
      clearInterval(timer);
    });
  });
  const url = `${cam.base.replace('http://', 'http://admin:p%40ss@')}/api/frame.jpeg?src=front_door`;
  const hub = new LiveHub({ getCamera: (id) => (id === 'cam1' ? { id, name: 'ประตู', url } : null), width: 640, fps: 20 });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); shutdown(cam.server); });

  const a = await openViewer(`${base}/cam1`);
  const b = await openViewer(`${base}/cam1`);
  await waitFor(() => a.parts.length >= 2 && b.parts.length >= 2, 'proxied frames');
  assert.ok([...a.parts, ...b.parts].every((p) => p.body.equals(picture)));
  assert.deepEqual(upstream, [{ url: '/api/stream.mjpeg?src=front_door', auth: `Basic ${b64('admin:p@ss')}` }]);
  assert.equal(hub.stats().streams[0].kind, 'mjpeg');
  hub.stopAll();
  await waitFor(() => open === 0, 'upstream connection released');
  await waitFor(() => a.closed && b.closed, 'viewers closed');
});

test('snapshot links are polled and shrunk to the live width', async (t) => {
  const picture = await makeJpeg(); // 320×180
  let hits = 0;
  const cam = await serve((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(picture);
  });
  const hub = new LiveHub({ getCamera: (id) => ({ id, name: 'สนาม', url: `${cam.base}/snap.jpg` }), width: 160, pollMs: 30 });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); shutdown(cam.server); });

  const v = await openViewer(`${base}/cam1`);
  await waitFor(() => v.parts.length >= 3, 'polled frames');
  for (const part of v.parts) {
    const meta = await sharp(part.body).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 160, 90]);
  }
  assert.ok(hits >= 3);
  assert.equal(hub.stats().streams[0].kind, 'poll');
});

test('a plain http link that answers with MJPEG is streamed, not re-requested', async (t) => {
  const picture = await makeJpeg();
  let requests = 0;
  const cam = await serve((req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=b' });
    const part = Buffer.concat([Buffer.from('--b\r\nContent-Type: image/jpeg\r\n\r\n'), picture, Buffer.from('\r\n')]);
    const timer = setInterval(() => res.write(part), 20);
    res.on('close', () => clearInterval(timer));
  });
  const hub = new LiveHub({ getCamera: (id) => ({ id, name: 'ลานจอด', url: `${cam.base}/video.cgi` }), pollMs: 30, fps: 30 });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); shutdown(cam.server); });

  const v = await openViewer(`${base}/cam1`);
  await waitFor(() => v.parts.length >= 4, 'streamed frames');
  assert.ok(v.parts.every((p) => p.body.equals(picture)));
  assert.equal(requests, 1);
  assert.equal(hub.stats().streams[0].kind, 'mjpeg');
});

test('three failed polls in a row cut viewers off; the next viewer starts fresh', async (t) => {
  let hits = 0;
  const cam = await serve((req, res) => {
    hits++;
    res.writeHead(500);
    res.end();
  });
  const url = `${cam.base.replace('http://', 'http://admin:hunter22@')}/snap.jpg`;
  const hub = new LiveHub({ getCamera: (id) => ({ id, name: 'สนาม', url }), pollMs: 20 });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); shutdown(cam.server); });

  const v = await openViewer(`${base}/cam1`);
  await waitFor(() => v.closed, 'viewer cut off');
  assert.equal(v.complete, false, 'a broken connection, so the <img> fires "error"');
  assert.equal(hits, 3);
  assert.deepEqual(hub.stats().streams.map(({ running, error }) => ({ running, error })), [{ running: false, error: 'กล้องตอบ HTTP 500' }]);
  const retry = await openViewer(`${base}/cam1`);
  assert.equal(retry.status, 200);
  assert.deepEqual(hub.stats().streams.map((s) => s.running), [true]);
});

test('frame(): reuses a fresh live frame, otherwise one capture shared by concurrent callers', async (t) => {
  const picture = await makeJpeg({ width: 640, height: 360 });
  let renders = 0;
  const hub = new LiveHub({
    getCamera: getDemo, width: 320, pollMs: 5000,
    demoFrame: async () => {
      renders++;
      await delay(30);
      return picture;
    },
  });
  t.after(() => hub.stopAll());

  const [x, y] = await Promise.all([hub.frame('cam1'), hub.frame('cam1')]);
  assert.equal(renders, 1);
  assert.ok(x.equals(y));
  assert.equal((await sharp(x).metadata()).width, 320);
  await hub.frame('cam1');
  assert.equal(renders, 1, 'younger than 3 s: no new capture');

  const res = fakeRes();
  hub.attach('cam2', new EventEmitter(), res);
  await waitFor(() => res.chunks.length >= 1, 'live frame');
  const before = renders;
  const live = await hub.frame('cam2');
  assert.equal(renders, before, 'the live picture is handed out, no extra capture');
  assert.ok(parseParts(res.chunks[0]).parts[0].body.equals(live));

  const broken = new LiveHub({ getCamera: (id) => ({ id, name: 'x', url: 'http://admin:hunter22@127.0.0.1:9/snap.jpg' }) });
  await assert.rejects(broken.frame('cam9'), (err) => err instanceof CaptureError && /ต่อกล้องไม่ได้/.test(err.message) && !err.message.includes('hunter22'));
});

// ------------------------------------------------------------------ ffmpeg
test('a missing ffmpeg is explained and the viewer is cut off', async (t) => {
  const hub = new LiveHub({ getCamera: (id) => ({ id, name: 'หน้าบ้าน', url: 'rtsp://10.0.0.5/s' }), ffmpegPath: '/nonexistent/ffmpeg' });
  t.after(() => hub.stopAll());
  const res = fakeRes();
  assert.equal(hub.attach('cam1', new EventEmitter(), res), 'ok');
  await waitFor(() => res.destroyed, 'viewer cut off');
  const [s] = hub.stats().streams;
  assert.equal(s.running, false);
  assert.match(s.error, /ไม่พบโปรแกรม ffmpeg/);
});

test('ffmpeg: a looping local video streams as small JPEGs, and ffmpeg stops with the hub', { skip: NO_FFMPEG }, async (t) => {
  const video = path.join(tmpDir(), 'clip.mp4');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', '-y', video]);
  assert.equal(made.status, 0, String(made.stderr));
  const children = [];
  const hub = new LiveHub({
    getCamera: (id) => ({ id, name: 'วิดีโอทดสอบ', url: `ffmpeg:${video}` }),
    width: 160,
    fps: 8,
    spawnImpl: (cmd, args, opts) => {
      const child = spawn(cmd, args, opts);
      children.push({ child, args });
      return child;
    },
  });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); });

  const v = await openViewer(`${base}/cam1`);
  await waitFor(() => v.parts.length >= 3, 'frames from ffmpeg', 10000);
  for (const part of v.parts) {
    const meta = await sharp(part.body).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 160, 120]);
  }
  assert.equal(children.length, 1);
  const { child, args } = children[0];
  const at = args.indexOf('-re');
  assert.deepEqual(args.slice(at, at + 5), ['-re', '-stream_loop', '-1', '-i', video]);
  hub.stopAll();
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'ffmpeg exited');
  await waitFor(() => v.closed, 'viewer ended');
  assert.deepEqual(hub.stats(), { streams: [] });
});

test('ffmpeg failure cuts viewers off with an error that never shows the camera password', { skip: NO_FFMPEG }, async (t) => {
  // nothing listens on port 9, so ffmpeg fails fast and prints the full camera URL
  const hub = new LiveHub({ getCamera: (id) => ({ id, name: 'หน้าบ้าน', url: 'rtsp://admin:hunter22@127.0.0.1:9/stream1' }) });
  const { server, base } = await liveServer(hub);
  t.after(() => { hub.stopAll(); shutdown(server); });

  const v = await openViewer(`${base}/cam1`);
  await waitFor(() => v.closed, 'viewer cut off', 10000);
  assert.equal(v.complete, false);
  const [s] = hub.stats().streams;
  assert.equal(s.running, false);
  assert.match(s.error, /ffmpeg/);
  assert.ok(!s.error.includes('hunter22'), s.error);
  if (s.error.includes('rtsp://')) assert.match(s.error, /rtsp:\/\/admin:\*\*\*\*@/);
});

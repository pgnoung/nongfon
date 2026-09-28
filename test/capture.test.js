import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { captureCamera, digestAuthorization, ffmpegArgs, grabFrame } from '../src/camera/capture.js';
import { makeJpeg, tmpDir } from './helpers.js';

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const quick = { attempts: 1, retryDelayMs: 0, maxEdge: 640 };

test('HTTP snapshot with Basic auth taken from the URL', async () => {
  const jpeg = await makeJpeg();
  let auth = '';
  const { server, base } = await serve((req, res) => {
    auth = req.headers.authorization || '';
    if (auth !== `Basic ${Buffer.from('admin:p@ss').toString('base64')}`) {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(jpeg);
  });
  const url = base.replace('http://', 'http://admin:p%40ss@') + '/snap.jpg';
  const frame = await captureCamera({ name: 't', url }, quick);
  assert.equal(frame.width, 320);
  assert.ok(frame.metrics.contrast > 5);
  await assert.rejects(captureCamera({ name: 't', url: `${base}/snap.jpg` }, quick), /ไม่ยอมให้เข้า/);
  server.close();
});

test('HTTP snapshot with Digest auth (Hikvision/Dahua style)', async () => {
  const jpeg = await makeJpeg();
  const nonce = 'abc123';
  const realm = 'IP Camera';
  const { server, base } = await serve((req, res) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Digest ')) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="xyz"` });
      return res.end();
    }
    const f = Object.fromEntries([...h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
    const ha1 = md5(`admin:${realm}:secret`);
    const ha2 = md5(`GET:${f.uri}`);
    const expected = md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:auth:${ha2}`);
    if (f.response !== expected || f.opaque !== 'xyz') {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(jpeg);
  });
  const url = base.replace('http://', 'http://admin:secret@') + '/ISAPI/Streaming/channels/101/picture';
  const frame = await captureCamera({ name: 'hik', url }, quick);
  assert.equal(frame.height, 180);
  server.close();
});

test('digestAuthorization matches RFC 2617 example', () => {
  const header = digestAuthorization({
    username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: '00000001', cnonce: '0a4f113b',
    challenge: { realm: 'testrealm@host.com', qop: 'auth,auth-int', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41' },
  });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
});

test('MJPEG stream: the first complete JPEG is used', async () => {
  const jpeg = await makeJpeg();
  const { server, base } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
    const timer = setInterval(() => {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write('\r\n');
    }, 20);
    req.on('close', () => clearInterval(timer));
  });
  const buf = await grabFrame({ name: 'm', url: `${base}/video` }, { timeoutMs: 5000 });
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  assert.equal(buf.length, jpeg.length);
  server.closeAllConnections();
  server.close();
});

test('a web page instead of a picture is a clear error', async () => {
  const { server, base } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>login</html>');
  });
  await assert.rejects(captureCamera({ name: 'h', url: `${base}/` }, quick), /ไม่ได้ส่งรูปกลับมา/);
  server.close();
});

test('files and folders (newest image wins); flat frames are rejected', async () => {
  const dir = tmpDir();
  const old = path.join(dir, 'a.jpg');
  const newest = path.join(dir, 'b.jpg');
  fs.writeFileSync(old, await makeJpeg({ width: 200, height: 100 }));
  fs.writeFileSync(newest, await makeJpeg({ width: 300, height: 150 }));
  fs.utimesSync(old, new Date(Date.now() - 60e3), new Date(Date.now() - 60e3));
  const frame = await captureCamera({ name: 'f', url: dir }, quick);
  assert.equal(frame.width, 300);
  const flat = path.join(dir, 'flat.jpeg.flat');
  fs.writeFileSync(flat, await makeJpeg({ flat: true }));
  await assert.rejects(captureCamera({ name: 'f', url: `file://${flat}` }, quick), /สีเดียว/);
  await assert.rejects(captureCamera({ name: 'f', url: path.join(dir, 'nope.jpg') }, quick), /ไม่พบไฟล์/);
});

test('ffmpeg: RTSP over TCP, key frames only', () => {
  const a = ffmpegArgs('rtsp://u:p@1.2.3.4/stream1');
  assert.deepEqual(a.slice(a.indexOf('-rtsp_transport'), a.indexOf('-rtsp_transport') + 2), ['-rtsp_transport', 'tcp']);
  assert.ok(a.includes('-skip_frame'));
  assert.ok(!ffmpegArgs('http://x/y.m3u8').includes('-rtsp_transport'));
});

test('missing ffmpeg explains what to do', async () => {
  await assert.rejects(
    captureCamera({ name: 'r', url: 'rtsp://127.0.0.1:1/x' }, { ...quick, ffmpegPath: '/nonexistent/ffmpeg' }),
    /ไม่พบโปรแกรม ffmpeg/,
  );
});

// ---------------------------------------------------------------- snapshots through macOS curl
function fakeSpawn({ stdout = null, stderr = '', code = 0 } = {}) {
  const calls = [];
  const impl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const call = { cmd, args, input: '' };
    child.stdin = { write: (s) => { call.input += s; }, end: () => {} };
    child.kill = () => {};
    calls.push(call);
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
  return { impl, calls };
}
test('HTTP snapshot through macOS curl: login on stdin (not argv), errors explained', async () => {
  const jpeg = await makeJpeg({ width: 64, height: 48 });
  const ok = fakeSpawn({ stdout: jpeg });
  const buf = await grabFrame({ name: 'nvr', url: 'http://admin:p%40ss@192.168.1.64/cgi-bin/snapshot.cgi?channel=1' }, { httpTool: 'curl', spawnImpl: ok.impl, timeoutMs: 15000 });
  assert.deepEqual(buf, jpeg);
  const { cmd, args, input } = ok.calls[0];
  assert.equal(cmd, '/usr/bin/curl');
  assert.ok(args.includes('--anyauth'));
  assert.equal(args[args.indexOf('--url') + 1], 'http://192.168.1.64/cgi-bin/snapshot.cgi?channel=1');
  assert.ok(!args.join(' ').includes('p@ss'), 'the password never appears on the command line');
  assert.match(input, /user = "admin:p@ss"/);
  const denied = fakeSpawn({ code: 22, stderr: 'curl: (22) The requested URL returned error: 401' });
  await assert.rejects(grabFrame({ name: 'nvr', url: 'http://admin:x@h/snap' }, { httpTool: 'curl', spawnImpl: denied.impl }), (e) => e.code === 'auth');
  const slow = fakeSpawn({ code: 28, stderr: 'curl: (28) Operation timed out' });
  await assert.rejects(grabFrame({ name: 'nvr', url: 'http://h/snap' }, { httpTool: 'curl', spawnImpl: slow.impl }), (e) => e.code === 'timeout');
  const page = fakeSpawn({ stdout: Buffer.from('<html>login</html>') });
  await assert.rejects(grabFrame({ name: 'nvr', url: 'http://h/snap' }, { httpTool: 'curl', spawnImpl: page.impl }), /ไม่ได้ส่งรูป/);
});

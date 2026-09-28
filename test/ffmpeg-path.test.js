import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundledFfmpeg, findOnPath, resolveFfmpeg } from '../src/camera/ffmpeg-path.js';

test('findOnPath walks the PATH and returns the first executable match', () => {
  const seen = [];
  const exists = (f) => { seen.push(f); return f === '/opt/homebrew/bin/ffmpeg'; };
  const env = { PATH: '/usr/bin::/opt/homebrew/bin:/usr/local/bin' };
  assert.equal(findOnPath('ffmpeg', { env, platform: 'darwin', exists }), '/opt/homebrew/bin/ffmpeg');
  assert.deepEqual(seen, ['/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']); // empty entries skipped, stops at the hit
  assert.equal(findOnPath('ffmpeg', { env: { PATH: '' }, platform: 'linux', exists }), null);
});

test('findOnPath on Windows splits on ; and tries the PATHEXT endings', () => {
  const env = { PATH: 'C:\\tools;C:\\ffmpeg\\bin', PATHEXT: '.COM;.EXE' };
  const hit = findOnPath('ffmpeg', { env, platform: 'win32', exists: (f) => /ffmpeg[\\/]bin[\\/]ffmpeg\.exe$/.test(f) });
  assert.match(hit, /ffmpeg\.exe$/);
});

test('bundledFfmpeg uses the ffmpeg-static path only when the binary is really there', () => {
  assert.equal(bundledFfmpeg({ load: () => '/app/node_modules/ffmpeg-static/ffmpeg', exists: () => true }), '/app/node_modules/ffmpeg-static/ffmpeg');
  assert.equal(bundledFfmpeg({ load: () => '/gone/ffmpeg', exists: () => false }), null);
  assert.equal(bundledFfmpeg({ load: () => null, exists: () => true }), null);
  assert.equal(bundledFfmpeg({ load: () => { throw new Error('Cannot find module'); } }), null);
});

test('resolveFfmpeg: FFMPEG_PATH, then the PATH, then the bundled copy, else plain ffmpeg', () => {
  const none = () => null;
  assert.equal(resolveFfmpeg({ env: { FFMPEG_PATH: '/x/ffmpeg' }, onPath: () => '/usr/bin/ffmpeg', bundled: () => '/b' }), '/x/ffmpeg');
  assert.equal(resolveFfmpeg({ env: {}, onPath: () => '/usr/bin/ffmpeg', bundled: () => '/b' }), 'ffmpeg');
  assert.equal(resolveFfmpeg({ env: {}, onPath: none, bundled: () => '/app/node_modules/ffmpeg-static/ffmpeg' }), '/app/node_modules/ffmpeg-static/ffmpeg');
  assert.equal(resolveFfmpeg({ env: {}, onPath: none, bundled: none }), 'ffmpeg');
});

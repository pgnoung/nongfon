import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Store } from '../src/store.js';

export function tmpDir(prefix = 'nongfon-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A small JPEG with some texture (so it is not "blank"). */
export async function makeJpeg({ width = 320, height = 180, flat = false } = {}) {
  const svg = flat
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#808080"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#8FD3FF"/><rect y="${height / 2}" width="100%" height="${height / 2}" fill="#3FB7C9"/><circle cx="60" cy="50" r="30" fill="#FFD447"/><rect x="200" y="40" width="80" height="60" fill="#2B2D7C"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

export function makeStore(env = {}) {
  const dir = tmpDir();
  const store = new Store(dir, env).init();
  return { dir, store };
}

/** Records every call; methods return what `returns[name]` says. */
export function spy(returns = {}) {
  const calls = [];
  const handler = {
    get(_target, name) {
      if (name === 'calls') return calls;
      if (name === 'then') return undefined;
      return (...args) => {
        calls.push({ name, args });
        const r = returns[name];
        return typeof r === 'function' ? r(...args) : r;
      };
    },
  };
  return new Proxy({}, handler);
}

export const settle = () => new Promise((r) => setImmediate(r));

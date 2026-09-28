// Which ffmpeg to run for RTSP cameras: FFMPEG_PATH wins, then an ffmpeg already on the PATH
// (Homebrew, apt, Docker), then the copy the one-click installer adds when the machine has none
// (npm package ffmpeg-static). Falls back to plain 'ffmpeg' so the capture error can say
// "ffmpeg not found" with the fix.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Full path of `name` on the PATH, or null. Windows also tries the PATHEXT endings (.exe …). */
export function findOnPath(name, { env = process.env, platform = process.platform, exists = isExecutable } = {}) {
  const endings = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ending of endings) {
      const candidate = path.join(dir, name + ending);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** The ffmpeg binary shipped by the optional npm package ffmpeg-static, when installed. */
export function bundledFfmpeg({ load = () => require('ffmpeg-static'), exists = isExecutable } = {}) {
  try {
    const file = load();
    return typeof file === 'string' && exists(file) ? file : null;
  } catch {
    return null;
  }
}

export function resolveFfmpeg({ env = process.env, onPath = findOnPath, bundled = bundledFfmpeg } = {}) {
  if (env.FFMPEG_PATH) return env.FFMPEG_PATH;
  if (onPath('ffmpeg', { env })) return 'ffmpeg';
  return bundled() || 'ffmpeg';
}

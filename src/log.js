// Tiny logger that never prints secrets.
// Every token/password we load is registered with addSecret() and masked on output,
// and credentials embedded in URLs (rtsp://user:pass@host) are always hidden.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const secrets = new Set();

export function addSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
}

export function maskText(text) {
  let out = String(text);
  // user:password@ inside any URL
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+:)[^@\s]+@/gi, '$1****@');
  // Telegram bot tokens in API URLs
  out = out.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot****');
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('****');
  }
  return out;
}

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${maskText(text)}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function logger(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

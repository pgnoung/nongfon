// Password login with a signed cookie. Changing DASHBOARD_PASSWORD logs everyone out.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeEqual } from '../util.js';

const COOKIE = 'nf_session';
const MAX_AGE_S = 30 * 24 * 3600;

export function sessionSecret(config) {
  if (config.secrets.dashboardSecret) return config.secrets.dashboardSecret;
  const file = path.join(config.dataDir, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  constructor({ password, secret }) {
    this.password = password || '';
    this.secret = secret;
    this.attempts = new Map();
    // bind sessions to the current password so a password change revokes them
    this.pwTag = crypto.createHash('sha256').update(`nf:${this.password}`).digest('hex').slice(0, 16);
  }

  get enabled() {
    return Boolean(this.password);
  }

  #sign(value) {
    return crypto.createHmac('sha256', this.secret).update(`${value}.${this.pwTag}`).digest('base64url');
  }

  issue() {
    const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
    const nonce = crypto.randomBytes(8).toString('hex');
    const value = `${exp}.${nonce}`;
    return `${value}.${this.#sign(value)}`;
  }

  valid(token) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [exp, nonce, sig] = parts;
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
    return safeEqual(sig, this.#sign(`${exp}.${nonce}`));
  }

  isLoggedIn(req) {
    return this.valid(parseCookies(req.headers.cookie)[COOKIE]);
  }

  cookie(token, req) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure}`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /** Allow 8 tries per 5 minutes per client address. */
  allowAttempt(ip) {
    const now = Date.now();
    const recent = (this.attempts.get(ip) || []).filter((t) => now - t < 5 * 60e3);
    this.attempts.set(ip, recent);
    return recent.length < 8;
  }

  check(ip, password) {
    const recent = this.attempts.get(ip) || [];
    recent.push(Date.now());
    this.attempts.set(ip, recent);
    const ok = safeEqual(password || '', this.password);
    if (ok) this.attempts.delete(ip);
    return ok;
  }
}

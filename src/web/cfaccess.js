// Cloudflare Access in front of the dashboard. Every request that came through Access carries a
// signed JWT (header Cf-Access-Jwt-Assertion). A valid one — our team, our application (AUD), not
// expired — means the visitor already proved a family email, so the dashboard password is not
// asked again. A request straight to the LAN port cannot carry a valid signature, so it still needs
// the password.

import crypto from 'node:crypto';

const CERTS_TTL_MS = 60 * 60e3;
const FORCE_REFRESH_MIN_MS = 60e3; // an unknown key id refetches the keys at most once a minute
const LEEWAY_S = 60;
const MAX_REMEMBERED = 200;

const decodePart = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** Returns { verify(token) → claims | null } or null when Access is not configured. */
export function createAccessVerifier({ teamDomain, aud, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!teamDomain || !aud) return null;
  const issuer = `https://${teamDomain}`;
  let keys = new Map();
  let fetchedAt = 0;
  let inflight = null;
  const remembered = new Map(); // token → claims, for tokens already verified

  function loadKeys(force = false) {
    const age = now() - fetchedAt;
    if (keys.size && (force ? age < FORCE_REFRESH_MIN_MS : age < CERTS_TTL_MS)) return Promise.resolve(keys);
    if (!inflight) {
      inflight = (async () => {
        const res = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Access certs HTTP ${res.status}`);
        const body = await res.json();
        const next = new Map();
        for (const jwk of body.keys || []) {
          if (jwk.kid && jwk.kty === 'RSA') next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        }
        keys = next;
        fetchedAt = now();
        return keys;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  async function keyFor(kid) {
    const known = (await loadKeys().catch(() => new Map())).get(kid);
    if (known) return known;
    return (await loadKeys(true).catch(() => new Map())).get(kid) || null; // keys rotate
  }

  async function verify(token) {
    if (!token || typeof token !== 'string') return null;
    const hit = remembered.get(token);
    if (hit) {
      if (hit.exp + LEEWAY_S > now() / 1000) return hit;
      remembered.delete(token);
    }
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let header;
    let claims;
    try {
      header = decodePart(parts[0]);
      claims = decodePart(parts[1]);
    } catch {
      return null;
    }
    if (header.alg !== 'RS256' || !header.kid) return null;
    const key = await keyFor(header.kid);
    if (!key) return null;
    const signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!signed) return null;
    const t = now() / 1000;
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud) || claims.iss !== issuer) return null;
    if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < t) return null;
    if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > t) return null;
    if (remembered.size >= MAX_REMEMBERED) remembered.clear();
    remembered.set(token, claims);
    return claims;
  }

  return { verify, issuer };
}

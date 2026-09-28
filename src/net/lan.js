// Guard so the camera finder only ever talks to the home network. The dashboard is behind a password,
// but we still refuse any target that is not a private LAN address, so the app can never be used to reach
// the public internet or a cloud metadata endpoint on the owner's behalf.

/** Parse an IPv4 string to its 32-bit number, or null if it is not a plain IPv4 literal. */
export function ipv4ToInt(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host).trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const RANGES = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16], // link-local
  ['127.0.0.0', 8], // loopback
];

/**
 * True only for a private/loopback IPv4 literal. Hostnames are rejected on purpose: a name could
 * resolve to a public address, and cameras on the LAN are always reached by their IP here.
 */
export function isPrivateHost(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Throw a user-facing error unless `host` is a private LAN IPv4. */
export function assertLanHost(host) {
  if (!isPrivateHost(host)) {
    throw Object.assign(new Error('ต่อได้เฉพาะกล้องในวง LAN บ้านคุณ (เช่น 192.168.x.x) เท่านั้น'), { status: 400 });
  }
  return host;
}

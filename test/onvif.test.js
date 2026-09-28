import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, ipv4ToInt, assertLanHost } from '../src/net/lan.js';
import net from 'node:net';
import {
  parseProbeMatch, brandFromScopes, usernameToken, parseProfiles,
  withCredentials, templateUrls, brandOptions, BRAND_TEMPLATES,
  onvifPortsFor, lanHosts, sweepHosts, brandFromPorts,
} from '../src/camera/onvif.js';

test('LAN guard: only private IPv4 literals pass', () => {
  for (const ip of ['192.168.1.10', '10.0.0.5', '172.16.9.9', '127.0.0.1', '169.254.1.1']) assert.equal(isPrivateHost(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '169.253.0.1', '172.32.0.1', '203.0.113.5', 'camera.local', 'example.com', '', '999.1.1.1']) {
    assert.equal(isPrivateHost(ip), false, ip);
  }
  assert.equal(ipv4ToInt('0.0.0.0'), 0);
  assert.throws(() => assertLanHost('8.8.8.8'), /LAN/);
  assert.equal(assertLanHost('192.168.1.50'), '192.168.1.50');
});

test('WS-Discovery reply parses to a reachable camera', () => {
  const xml = `<Envelope><Body><ProbeMatches><ProbeMatch>
    <XAddrs>http://192.168.1.12/onvif/device_service http://[fe80::1]/onvif/device_service</XAddrs>
    <Scopes>onvif://www.onvif.org/name/General onvif://www.onvif.org/hardware/RVCM52P2000A onvif://www.onvif.org/location/country/china</Scopes>
  </ProbeMatch></ProbeMatches></Body></Envelope>`;
  const m = parseProbeMatch(xml, '192.168.1.12');
  assert.equal(m.host, '192.168.1.12');
  assert.equal(m.port, 80);
  assert.equal(m.brand, 'dahua'); // RVCM… is a Dahua-family RISCO VUpoint
  assert.match(m.xaddr, /192\.168\.1\.12/); // the IPv4 XAddr, not the IPv6 one
});

test('brand is guessed from ONVIF scopes', () => {
  assert.equal(brandFromScopes(['x/hardware/IPC-model', 'x/name/IPC-model']), 'foscam'); // real Foscam S41 scope
  assert.equal(brandFromScopes(['x/hardware/RVNVR08002QB']), 'dahua'); // RISCO VUpoint NVR
  assert.equal(brandFromScopes(['x/name/HIKVISION']), 'hikvision');
  assert.equal(brandFromScopes(['x/name/ipcamera']), ''); // generic string → unknown, fall back to templates
  assert.equal(brandFromScopes(['x/name/mystery']), '');
});

test('WS-Security UsernameToken carries a base64 SHA1 digest, not the password', () => {
  const nonce = Buffer.from('0123456789abcdef');
  const created = '2026-09-27T10:00:00.000Z';
  const xml = usernameToken('admin', 'hunter2', { nonceBytes: nonce, created });
  assert.match(xml, /<Username>admin<\/Username>/);
  assert.match(xml, /PasswordDigest/);
  assert.doesNotMatch(xml, /hunter2/); // the raw password is never in the request
  assert.match(xml, new RegExp(nonce.toString('base64').replace(/[+/]/g, '\\$&')));
  assert.match(xml, /2026-09-27T10:00:00/);
});

test('GetProfiles parses tokens and resolutions, biggest usable first later', () => {
  const xml = `<GetProfilesResponse>
    <Profiles token="mainStream"><VideoEncoderConfiguration><Resolution><Width>2560</Width><Height>1440</Height></Resolution></VideoEncoderConfiguration></Profiles>
    <Profiles token="subStream"><VideoEncoderConfiguration><Resolution><Width>640</Width><Height>360</Height></Resolution></VideoEncoderConfiguration></Profiles>
  </GetProfilesResponse>`;
  const profiles = parseProfiles(xml);
  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles[0], { token: 'mainStream', width: 2560, height: 1440 });
  assert.equal(profiles[1].token, 'subStream');
});

test('credentials are URL-encoded into a returned stream URI', () => {
  const uri = 'rtsp://192.168.1.12:554/cam/realmonitor?channel=1&subtype=0';
  const withc = withCredentials(uri, 'admin', 'p@ss:w/rd');
  const u = new URL(withc);
  assert.equal(u.username, 'admin');
  assert.equal(decodeURIComponent(u.password), 'p@ss:w/rd');
  assert.equal(u.hostname, '192.168.1.12');
  // a URI that already has creds and an empty username request is unchanged
  assert.equal(withCredentials(uri, '', ''), uri);
});

test('brand templates fill IP and encoded credentials; RISCO uses the Dahua path', () => {
  const urls = templateUrls({ brand: 'dahua', host: '192.168.1.12', username: 'admin', password: 'a b', channel: 2 });
  assert.ok(urls.length >= 2);
  assert.equal(urls[0].kind, 'rtsp');
  assert.match(urls[0].url, /^rtsp:\/\/admin:a%20b@192\.168\.1\.12:554\/cam\/realmonitor\?channel=2&subtype=0$/);
  const foscam = templateUrls({ brand: 'foscam', host: '192.168.1.103', username: 'u', password: 'x' });
  assert.match(foscam[0].url, /:88\/videoMain$/);
  // an unknown brand still yields a generic ONVIF guess rather than throwing
  assert.ok(templateUrls({ brand: 'nope', host: '10.0.0.9', username: 'u', password: 'x' }).length >= 1);
});

test('templateUrls refuses a non-LAN host (no SSRF)', () => {
  assert.throws(() => templateUrls({ brand: 'dahua', host: '8.8.8.8', username: 'u', password: 'x' }), /LAN/);
});

test('brandOptions lists the guess first and every known brand once', () => {
  const opts = brandOptions('foscam');
  assert.equal(opts[0].key, 'foscam');
  assert.equal(new Set(opts.map((o) => o.key)).size, opts.length);
  assert.equal(opts.length, Object.keys(BRAND_TEMPLATES).length);
});

test('ONVIF ports: the given one, then the brand port (Tapo 2020, Foscam 888), then 80', () => {
  assert.deepEqual(onvifPortsFor('tapo', 80), [80, 2020]);
  assert.deepEqual(onvifPortsFor('foscam', 888), [888, 80]);
  assert.deepEqual(onvifPortsFor('dahua', 80), [80]);
  assert.deepEqual(onvifPortsFor('generic', 0), [80]);
});

test('LAN sweep covers only the private /24 around this machine', () => {
  const hosts = lanHosts({
    en0: [{ family: 'IPv4', address: '192.168.1.23', internal: false }],
    utun4: [{ family: 'IPv4', address: '100.64.0.7', internal: false }], // VPN / CGNAT: not the home LAN
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  });
  assert.equal(hosts.length, 253); // .1-.254 minus ourselves
  assert.ok(hosts.includes('192.168.1.150'));
  assert.ok(!hosts.includes('192.168.1.23'));
  assert.ok(hosts.every((h) => h.startsWith('192.168.1.')));
});

test('sweepHosts reports the ports that answer, and skips public hosts', async () => {
  const server = net.createServer((sock) => sock.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const found = await sweepHosts(['127.0.0.1', '8.8.8.8'], { ports: [port, 1], timeoutMs: 300 });
    assert.deepEqual(found, [{ host: '127.0.0.1', open: [port] }]);
  } finally {
    server.close();
  }
});

test('brand from open ports: Foscam 88, Tapo 2020/8800 (and says when its Camera Account is missing)', () => {
  assert.equal(brandFromPorts([88, 443]).brand, 'foscam');
  const tapoOff = brandFromPorts([443, 8800]);
  assert.equal(tapoOff.brand, 'tapo');
  assert.match(tapoOff.note, /Camera Account/);
  const tapoOn = brandFromPorts([554, 2020, 8800]);
  assert.equal(tapoOn.brand, 'tapo');
  assert.equal(tapoOn.note, '');
  assert.equal(brandFromPorts([554]).brand, '');
  assert.equal(brandFromPorts([443]), null); // nothing camera-like
});

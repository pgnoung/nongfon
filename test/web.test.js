import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHub, createWebServer, cleanLine, maskUrl } from '../src/web/server.js';
import { Notifier } from '../src/notify/index.js';
import { Siren } from '../src/siren/siren.js';
import { makeStore } from './helpers.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function startApp({ password = 'correct horse', accessVerifier = null } = {}) {
  const { dir, store } = makeStore();
  const secrets = {
    anthropicKey: '', claudeOauth: '', telegramToken: '', lineToken: '', mqttUrl: '', mqttUsername: '', mqttPassword: '',
    webhookUrl: '', sirenOnUrl: '', sirenOffUrl: '', dashboardPassword: password, dashboardSecret: 'test-secret',
  };
  const config = { demo: false, engine: 'anthropic', dataDir: dir, cameras: [{ id: 'cam1', name: 'หน้าบ้าน', url: 'rtsp://admin:hunter22@10.0.0.5/s' }], secrets };
  const hub = createHub();
  const notifier = new Notifier({ store, config, fetchImpl: async () => new Response('{}') });
  const siren = new Siren({ store, config, notifier, broadcast: hub.broadcast, publish: async () => {} });
  let runs = 0;
  const watcher = {
    nextAt: Date.now() + 60e3, current: null, intervalMinutes: () => 10,
    runNow: async () => { runs++; return null; },
    snapshot: async () => ({ image: 'x_cam1_live.jpg', width: 10, height: 10, metrics: { night: false, brightness: 100 } }),
  };
  const weather = { get: () => null, refresh: async () => null };
  const { server } = createWebServer({ config, store, watcher, siren, notifier, weather, bot: null, hub, engineProblem: () => null, accessVerifier });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = server.address().port;

  /** Raw request (fetch would normalise ../ in paths). */
  const req = (method, path, { body, headers = {}, cookie } = {}) =>
    new Promise((resolve, reject) => {
      const h = { ...headers };
      if (cookie) h.Cookie = cookie;
      let data;
      if (body !== undefined) {
        data = typeof body === 'string' ? body : JSON.stringify(body);
        h['Content-Type'] = h['Content-Type'] || 'application/json';
      }
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });

  const login = async () => {
    const r = await req('POST', '/login', { body: { password } });
    assert.equal(r.status, 200);
    return r.headers['set-cookie'][0].split(';')[0];
  };
  return { store, req, login, hub, runs: () => runs };
}

test('health check is public, everything else needs a login', async () => {
  const app = await startApp();
  assert.equal((await app.req('GET', '/healthz')).status, 200);
  const page = await app.req('GET', '/');
  assert.equal(page.status, 303);
  assert.match(page.headers.location, /^\/login/);
  assert.equal((await app.req('GET', '/api/status')).status, 401);
  assert.equal((await app.req('GET', '/snap/x.jpg')).status, 303);
  assert.equal((await app.req('GET', '/login')).status, 200);
});

test('login: wrong password refused, right one gives an HttpOnly cookie', async () => {
  const app = await startApp();
  const bad = await app.req('POST', '/login', { body: { password: 'nope' } });
  assert.equal(bad.status, 401);
  const good = await app.req('POST', '/login', { body: { password: 'correct horse' } });
  assert.equal(good.status, 200);
  assert.match(good.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/);
  const cookie = good.headers['set-cookie'][0].split(';')[0];
  const status = await app.req('GET', '/api/status', { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.json.site.name, 'บ้านของเรา');
  assert.ok(Array.isArray(status.json.setup));
  assert.equal((await app.req('GET', '/api/status', { cookie: 'nf_session=1.2.3' })).status, 401);
  const page = await app.req('GET', '/', { cookie });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.text, /pages\/overview\.js/);
});

test('login attempts are rate limited', async () => {
  const app = await startApp();
  for (let i = 0; i < 8; i++) await app.req('POST', '/login', { body: { password: `x${i}` } });
  assert.equal((await app.req('POST', '/login', { body: { password: 'correct horse' } })).status, 429);
});

test('state-changing requests must be same-origin JSON', async () => {
  const app = await startApp();
  const cookie = await app.login();
  assert.equal((await app.req('POST', '/api/run', { cookie, body: 'x=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await app.req('POST', '/api/run', { cookie, body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  const ok = await app.req('POST', '/api/run', { cookie, body: {}, headers: { Origin: 'http://' + 'localhost' } });
  assert.equal(ok.status, 403); // host header is 127.0.0.1:port, so a localhost origin is still foreign
  const same = await app.req('POST', '/api/run', { cookie, body: {} });
  assert.equal(same.status, 200);
  assert.equal(app.runs(), 1);
});

test('settings are validated before saving', async () => {
  const app = await startApp();
  const cookie = await app.login();
  const bad = await app.req('POST', '/api/settings', { cookie, body: { intervalMinutes: 0, aiEffort: 'turbo' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors.length, 2);
  const order = await app.req('POST', '/api/settings', { cookie, body: { warnLevel: 95, criticalLevel: 90 } });
  assert.equal(order.status, 400);
  const good = await app.req('POST', '/api/settings', { cookie, body: { intervalMinutes: 5, siteName: 'บ้านคุณแม่' } });
  assert.equal(good.status, 200);
  assert.equal(app.store.settings.intervalMinutes, 5);
  const view = await app.req('GET', '/api/settings', { cookie });
  assert.equal(view.json.values.siteName, 'บ้านคุณแม่');
  assert.equal(view.json.secrets.dashboardPassword, true);
  assert.ok(!view.text.includes('correct horse'));
  assert.ok(!view.text.includes('hunter22'));
  assert.match(view.json.cameras[0].url, /admin:\*\*\*\*@/);
});

test('lines are cleaned before storing', async () => {
  const app = await startApp();
  const cookie = await app.login();
  const r = await app.req('POST', '/api/cameras/cam1/lines', { cookie, body: { warning: [[0.1, 0.5], [2, -1], ['x', 1]], critical: [[0.5, 0.5]] } });
  assert.equal(r.status, 200);
  assert.deepEqual(app.store.cameraMeta('cam1').lines, { safe: [], warning: [[0.1, 0.5], [1, 0]], critical: [] });
  await app.req('POST', '/api/cameras/cam1/lines', { cookie, body: { safe: [[0, 0.3], [1, 0.3]], warning: [[0, 0.5], [1, 0.5]] } });
  assert.deepEqual(app.store.cameraMeta('cam1').lines.safe, [[0, 0.3], [1, 0.3]]);
  assert.equal((await app.req('POST', '/api/cameras/nope/lines', { cookie, body: {} })).status, 404);
  assert.deepEqual(cleanLine([[0, 0]]), []);
});

test('no path tricks for static files, snapshots or templates', async () => {
  const app = await startApp();
  const cookie = await app.login();
  assert.equal((await app.req('GET', '/static/js/app.js')).status, 200);
  assert.equal((await app.req('GET', '/static/..%2f..%2fpackage.json')).status, 404);
  // dot-segments are resolved by the URL parser first, so this becomes /package.json — never served
  assert.equal((await app.req('GET', '/static/../../package.json', { cookie })).status, 404);
  assert.equal((await app.req('GET', '/static/pages/overview.html')).status, 404);
  assert.equal((await app.req('GET', '/static/layout.html')).status, 404);
  assert.equal((await app.req('GET', '/snap/..%2f..%2fsettings.json', { cookie })).status, 404);
  assert.equal((await app.req('GET', '/ref/..%2fsettings.json', { cookie })).status, 404);
  assert.equal((await app.req('GET', '/snap/.hidden.jpg', { cookie })).status, 404);
});

test('live events reach logged-in dashboards', async () => {
  const app = await startApp();
  const cookie = await app.login();
  const port = (await new Promise((r) => r(servers.at(-1).address().port)));
  const got = await new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Cookie: cookie } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      let text = '';
      res.on('data', (c) => {
        text += c;
        if (text.includes('event: reading')) {
          r.destroy();
          resolve(text);
        }
      });
      setTimeout(() => app.hub.broadcast('reading', { id: 'r1' }), 50);
    });
    r.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  assert.match(got, /data: \{"id":"r1"\}/);
});

test('without DASHBOARD_PASSWORD the dashboard explains how to set one', async () => {
  const app = await startApp({ password: '' });
  const r = await app.req('GET', '/');
  assert.equal(r.status, 503);
  assert.match(r.text, /DASHBOARD_PASSWORD/);
  assert.equal((await app.req('GET', '/healthz')).status, 200);
});

test('maskUrl hides passwords and token-like query values', () => {
  assert.equal(maskUrl('rtsp://admin:secret@10.0.0.2:554/s'), 'rtsp://admin:****@10.0.0.2:554/s');
  assert.equal(maskUrl('http://cam/snap.jpg?user=a&pwd=b&token=c'), 'http://cam/snap.jpg?user=a&pwd=****&token=****');
});

test('a visitor who already passed Cloudflare Access is not asked for the dashboard password', async () => {
  const accessVerifier = { verify: async (t) => (t === 'valid-access-jwt' ? { email: 'family@example.com' } : null) };
  const app = await startApp({ accessVerifier });
  const through = { 'Cf-Access-Jwt-Assertion': 'valid-access-jwt' };
  assert.equal((await app.req('GET', '/', { headers: through })).status, 200);
  assert.equal((await app.req('GET', '/api/status', { headers: through })).status, 200);
  const login = await app.req('GET', '/login?next=%2Fcameras', { headers: through });
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, '/cameras');
  assert.equal((await app.req('GET', '/login?next=%2F%2Fevil.example', { headers: through })).headers.location, '/', 'no open redirect');
  // a forged or missing assertion still needs the password
  assert.equal((await app.req('GET', '/', { headers: { 'Cf-Access-Jwt-Assertion': 'forged' } })).status, 303);
  assert.equal((await app.req('GET', '/api/status', { headers: { 'Cf-Access-Jwt-Assertion': 'forged' } })).status, 401);
  assert.equal((await app.req('GET', '/api/status')).status, 401);
  // logging out through Access ends the Access session too
  assert.equal((await app.req('GET', '/logout', { headers: through })).headers.location, '/cdn-cgi/access/logout');
});

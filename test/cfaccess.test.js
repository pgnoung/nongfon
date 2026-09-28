import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAccessVerifier } from '../src/web/cfaccess.js';

const TEAM = 'family-home.cloudflareaccess.com';
const AUD = 'aud-nongfon-123';
const NOW = 1_790_000_000_000;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function sign(claims, { kid = 'k1', key = privateKey } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc(claims)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}
const good = (over = {}) => ({ aud: [AUD], iss: `https://${TEAM}`, email: 'family@example.com', iat: NOW / 1000 - 60, exp: NOW / 1000 + 3600, ...over });

function setup() {
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches++;
    assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
  return { v: createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl, now: () => NOW }), fetches: () => fetches };
}

test('Cloudflare Access: a token signed for our team and app is accepted (keys fetched once)', async () => {
  const t = setup();
  const claims = await t.v.verify(sign(good()));
  assert.equal(claims.email, 'family@example.com');
  assert.ok(await t.v.verify(sign(good({ aud: AUD }))), 'aud may be a plain string');
  assert.equal(t.fetches(), 1);
});

test('Cloudflare Access: wrong app, wrong team, expired, tampered or foreign-key tokens are refused', async () => {
  const t = setup();
  assert.equal(await t.v.verify(sign(good({ aud: ['someone-else'] }))), null);
  assert.equal(await t.v.verify(sign(good({ iss: 'https://evil.cloudflareaccess.com' }))), null);
  assert.equal(await t.v.verify(sign(good({ exp: NOW / 1000 - 3600 }))), null);
  const token = sign(good());
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify(good({ email: 'stranger@x.com' }))).toString('base64url');
  assert.equal(await t.v.verify(`${h}.${forged}.${s}`), null);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal(await t.v.verify(sign(good(), { key: other })), null);
  assert.equal(await t.v.verify(sign(good(), { kid: 'unknown' })), null);
  assert.equal(await t.v.verify('not.a.jwt'), null);
  assert.equal(await t.v.verify(''), null);
});

test('Cloudflare Access: off unless both the team domain and the application AUD are set', () => {
  assert.equal(createAccessVerifier({ teamDomain: TEAM, aud: '' }), null);
  assert.equal(createAccessVerifier({ teamDomain: '', aud: AUD }), null);
});

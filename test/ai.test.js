import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildContent, RESULT_SCHEMA } from '../src/ai/prompt.js';
import { costUsd, extractJson, normalizeResult } from '../src/ai/result.js';
import { createAnthropicEngine, supportsEffort, usesServerFallback } from '../src/ai/anthropic.js';
import { createClaudeCodeEngine, parseResultEvent } from '../src/ai/claude-code.js';
import { engineProblem } from '../src/ai/index.js';
import { tmpDir } from './helpers.js';

const Y = [[0, 0.5], [1, 0.5]];
const pic = Buffer.from('fake-jpeg');

test('prompt content: static part first, pictures last', () => {
  const { blocks, staticCount } = buildContent({
    siteName: 'บ้าน', siteDescription: 'บ้านชั้นเดียว',
    cameras: [
      { id: 'cam1', name: 'หน้าบ้าน', lines: { warning: Y }, note: 'ประตูรั้ว', reference: { buffer: pic, kind: 'night' }, frame: { buffer: pic, night: true, timeText: '02:22' } },
      { id: 'cam2', name: 'โรงรถ', lines: {}, frame: null },
    ],
  });
  assert.equal(staticCount, 3); // intro + reference label + reference image
  assert.match(blocks[0].text, /yellow line only/);
  assert.match(blocks[0].text, /no lines/);
  assert.match(blocks[0].text, /ประตูรั้ว/);
  assert.equal(blocks[2].type, 'image');
  assert.match(blocks[3].text, /night infrared picture, taken 02:22/);
  assert.match(blocks.at(-1).text, /No picture could be captured from "cam2"/);
});

test('schema is strict-ready (every object closed, every field required)', () => {
  const walk = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
  };
  walk(RESULT_SCHEMA);
});

test('model output is clamped and missing cameras are filled in', () => {
  const r = normalizeResult({ cameras: [{ id: 'cam1', line_status: 'weird', water: 'flooded', note_th: 'x'.repeat(300) }, { id: 'intruder', line_status: 'at_red' }], level: 140, confidence: 85, headline_th: 'ok' }, ['cam1', 'cam2']);
  assert.equal(r.level, 100);
  assert.equal(r.confidence, 0.85);
  assert.equal(r.cameras.cam1.lineStatus, 'cannot_tell');
  assert.ok(r.cameras.cam1.note.length <= 140);
  assert.equal(r.cameras.cam2.lineStatus, 'cannot_tell');
  assert.equal(r.cameras.intruder, undefined);
  assert.deepEqual(extractJson('noise {"a":1} noise'), { a: 1 });
  assert.equal(extractJson('nothing'), null);
});

test('prices: Opus 5 vs Haiku 4.5, cache reads are cheap', () => {
  assert.equal(costUsd('claude-opus-5', { input: 1e6 }), 5);
  assert.equal(costUsd('claude-haiku-4-5', { output: 1e6 }), 5);
  assert.equal(costUsd('claude-opus-5', { cacheRead: 1e6 }), 0.5);
  assert.equal(costUsd('claude-sonnet-5', { cacheWrite1h: 1e6 }), 4);
  assert.equal(costUsd('some-other-model', { input: 1 }), null);
  assert.ok(supportsEffort('claude-opus-5') && supportsEffort('claude-sonnet-5') && !supportsEffort('claude-haiku-4-5'));
  assert.ok(usesServerFallback('claude-opus-5') && !usesServerFallback('claude-sonnet-5'));
});

function fakeApi(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const { status = 200, json } = reply(seen.at(-1));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

const answer = {
  cameras: [{ id: 'cam1', line_status: 'at_yellow', water: 'flooded', note_th: 'น้ำถึงเส้นเหลือง' }],
  level: 57, confidence: 0.8, headline_th: 'น้ำถึงเส้นเหลืองแล้ว',
};
const message = (content, extra = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, ...extra,
});

test('Anthropic engine: request shape and parsed answer', async () => {
  const api = await fakeApi(() => ({ json: message([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(answer) }]) }));
  const engine = createAnthropicEngine({ apiKey: 'sk-test', baseURL: api.base });
  const { blocks, staticCount } = buildContent({ siteName: 'บ้าน', cameras: [{ id: 'cam1', name: 'หน้าบ้าน', lines: { warning: Y }, frame: { buffer: pic, night: false, timeText: '10:00' } }] });

  const r = await engine.analyze({ model: 'claude-opus-5', effort: 'medium', blocks, staticCount, cacheTtl: '1h', expectedIds: ['cam1'] });
  assert.equal(r.ok, true);
  assert.equal(r.level, 57);
  assert.equal(r.cameras.cam1.lineStatus, 'at_yellow');
  assert.equal(r.costUsd, 0.01025);
  const sent = api.seen[0];
  assert.match(sent.url, /\/v1\/messages\?beta=true/);
  assert.equal(sent.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(sent.body.fallbacks, 'default');
  assert.equal(sent.body.output_config.effort, 'medium');
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.deepEqual(sent.body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(sent.body.messages[0].content[staticCount - 1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(sent.body.temperature, undefined);

  await engine.analyze({ model: 'claude-haiku-4-5', effort: 'medium', blocks, staticCount, cacheTtl: '5m', expectedIds: ['cam1'] });
  const haiku = api.seen[1];
  assert.equal(haiku.url, '/v1/messages');
  assert.equal(haiku.body.fallbacks, undefined);
  assert.equal(haiku.body.output_config.effort, undefined);
  assert.deepEqual(haiku.body.system[0].cache_control, { type: 'ephemeral' });
  api.server.close();
});

test('Anthropic engine: refusal and auth errors become readable failures', async () => {
  let mode = 'refusal';
  const api = await fakeApi(() => (mode === 'refusal'
    ? { json: message([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } }) }
    : { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
  const engine = createAnthropicEngine({ apiKey: 'sk-test', baseURL: api.base });
  const req = { model: 'claude-opus-5', blocks: [{ type: 'text', text: 'x' }], staticCount: 1, expectedIds: ['cam1'] };
  const refused = await engine.analyze(req);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /refusal/);
  mode = 'auth';
  const denied = await engine.analyze(req);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /ANTHROPIC_API_KEY/);
  api.server.close();
});

function fakeClaudeBin(script) {
  const dir = tmpDir();
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${script}`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('Claude Code engine: stream-json in, structured_output out', async () => {
  const bin = fakeClaudeBin(`
    let input = '';
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => {
      const args = process.argv.slice(2);
      const msg = JSON.parse(input.trim());
      const ok = args.includes('--json-schema') && args[args.indexOf('--tools') + 1] === '' && msg.message.content.some((b) => b.type === 'image')
        && process.env.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-oat01-test';
      console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
      console.log(JSON.stringify({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok,
        result: '', total_cost_usd: 0.012, usage: { input_tokens: 900, output_tokens: 150 },
        structured_output: ${JSON.stringify(answer)} }));
    });`);
  const engine = createClaudeCodeEngine({ bin, oauthToken: 'sk-ant-oat01-test' });
  const r = await engine.analyze({ model: 'sonnet', effort: 'low', blocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'eA==' } }], expectedIds: ['cam1'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.level, 57);
  assert.equal(r.subscription, true);
  assert.equal(r.costUsd, 0.012);
});

test('Claude Code engine: login problems are explained', async () => {
  const bin = fakeClaudeBin(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }));
      process.exit(1);
    });`);
  const engine = createClaudeCodeEngine({ bin, oauthToken: 'x' });
  const r = await engine.analyze({ model: 'sonnet', blocks: [], expectedIds: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /claude setup-token/);
  const missing = createClaudeCodeEngine({ bin: '/nonexistent/claude' });
  assert.match((await missing.analyze({ blocks: [], expectedIds: [] })).error, /ไม่พบโปรแกรม claude/);
  assert.equal(parseResultEvent('garbage\n{"type":"result","x":1}\n{partial').x, 1);
});

test('engineProblem tells people which secret is missing', () => {
  assert.match(engineProblem({ engine: 'anthropic', secrets: {} }), /ANTHROPIC_API_KEY/);
  assert.match(engineProblem({ engine: 'claude-code', secrets: {} }), /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(engineProblem({ engine: 'anthropic', secrets: { anthropicKey: 'x' } }), null);
  assert.match(engineProblem({ engine: 'gpt', secrets: {} }), /AI_ENGINE/);
});

test('"cannot judge" from the model never reads as a dry level', () => {
  const r = normalizeResult({
    cameras: [{ id: 'cam1', line_status: 'cannot_tell', water: 'dry', coverage_pct: 130, note_th: 'มืดมาก' }],
    level: 0, level_status: 'unknown', distance_th: 'ไม่แน่ใจ', confidence: 0.2, headline_th: 'มองไม่เห็นน้ำ',
  }, ['cam1']);
  assert.equal(r.level, null);
  assert.equal(r.aiStatus, 'unknown');
  assert.equal(r.cameras.cam1.coverage, 100);
  assert.equal(r.distance, 'ไม่แน่ใจ');
  const ok = normalizeResult({ cameras: [], level: 42, level_status: 'normal', distance_th: '', confidence: 0.9, headline_th: '' }, []);
  assert.equal(ok.level, 42);
  assert.equal(ok.aiStatus, 'normal');
  const legacy = normalizeResult({ cameras: [], level: 42, confidence: 0.9, headline_th: '' }, []);
  assert.equal(legacy.aiStatus, null);
  assert.equal(legacy.level, 42);
});

test('the prompt knows the green (safe) line', async () => {
  const { LINE_STATUS, SYSTEM_PROMPT } = await import('../src/ai/prompt.js');
  assert.ok(LINE_STATUS.includes('below_green'));
  assert.match(SYSTEM_PROMPT, /GREEN/);
  assert.ok(RESULT_SCHEMA.properties.cameras.items.properties.line_status.enum.includes('below_green'));
  const G = [[0, 0.3], [1, 0.3]];
  const { blocks } = buildContent({ siteName: 'บ้าน', cameras: [{ id: 'cam1', name: 'หน้าบ้าน', lines: { safe: G, warning: G, critical: G } }] });
  assert.match(blocks[0].text, /green, yellow and red lines/);
});

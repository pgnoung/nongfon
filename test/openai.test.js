import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIEngine, toOpenAIContent } from '../src/ai/openai.js';
import { imageBlock } from '../src/ai/prompt.js';

test('blocks convert to OpenAI content parts (text + data-url image)', () => {
  const parts = toOpenAIContent([{ type: 'text', text: 'hi' }, imageBlock(Buffer.from([1, 2, 3]))]);
  assert.deepEqual(parts[0], { type: 'text', text: 'hi' });
  assert.equal(parts[1].type, 'image_url');
  assert.match(parts[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('analyze parses a GPT JSON reply into the normalized result', async () => {
  let sentBody;
  const fakeFetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        model: 'gpt-4o-2026',
        usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } },
        choices: [{ finish_reason: 'stop', message: { content: '{"cameras":[{"id":"cam1","line_status":"at_yellow","water":"flooded","coverage_pct":40,"note_th":"น้ำถึงเส้นเหลือง"}],"level":55,"level_status":"warning","distance_th":"ต่ำกว่าเส้นแดง 20 ซม.","confidence":0.8,"headline_th":"น้ำถึงเส้นเหลืองแล้ว"}' } }],
      }),
    };
  };
  const engine = createOpenAIEngine({ apiKey: 'sk-test', fetchImpl: fakeFetch });
  const out = await engine.analyze({ model: 'gpt-4o', blocks: [{ type: 'text', text: 'x' }], expectedIds: ['cam1'] });
  assert.equal(out.ok, true);
  assert.equal(out.level, 55);
  assert.equal(out.aiStatus, 'warning');
  assert.equal(out.cameras.cam1.lineStatus, 'at_yellow');
  assert.equal(out.engine, 'openai');
  assert.equal(sentBody.model, 'gpt-4o');
  assert.equal(sentBody.response_format.type, 'json_object');
  assert.ok(out.usage.cacheRead === 200 && out.usage.input === 1000);
  assert.ok(out.costUsd > 0);
});

test('a Claude model name falls back to the configured OpenAI model', async () => {
  let sentModel;
  const fakeFetch = async (url, opts) => { sentModel = JSON.parse(opts.body).model; return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: {} }) }; };
  const engine = createOpenAIEngine({ apiKey: 'sk', model: 'gpt-4o', fetchImpl: fakeFetch });
  await engine.analyze({ model: 'claude-sonnet-5', blocks: [], expectedIds: [] });
  assert.equal(sentModel, 'gpt-4o');
});

test('a 401 becomes a friendly Thai error, not a throw', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) });
  const engine = createOpenAIEngine({ apiKey: 'sk', fetchImpl: fakeFetch });
  const out = await engine.analyze({ model: 'gpt-4o', blocks: [], expectedIds: [] });
  assert.equal(out.ok, false);
  assert.match(out.error, /OPENAI_API_KEY/);
});

test('the OpenAI engine reports the model it will really use', async () => {
  const { effectiveModel } = await import('../src/ai/index.js');
  assert.equal(effectiveModel({ engine: 'openai' }, 'claude-sonnet-5'), 'gpt-6-luna');
  assert.equal(effectiveModel({ engine: 'openai' }, 'gpt-5.6-luna'), 'gpt-5.6-luna');
  assert.equal(effectiveModel({ engine: 'anthropic' }, 'claude-sonnet-5'), 'claude-sonnet-5');
});

test('GPT-5.6/6 rows are priced before the gpt-5 prefix row', async () => {
  const { priceFor } = await import('../src/ai/result.js');
  assert.equal(priceFor('gpt-6-luna').input, 0.1);
  assert.equal(priceFor('gpt-5.6-luna').input, 0.2);
  assert.equal(priceFor('gpt-5.6-terra').output, 12);
  assert.equal(priceFor('gpt-5-2025-08-07').input, 1.25);
});

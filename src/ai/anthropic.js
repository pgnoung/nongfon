// Claude through the Anthropic API (pay per use with an API key).

import Anthropic from '@anthropic-ai/sdk';
import { RESULT_SCHEMA, SYSTEM_PROMPT } from './prompt.js';
import { costUsd, extractJson, failedResult, normalizeResult } from './result.js';

/** Models that accept output_config.effort. */
export function supportsEffort(model) {
  return /^claude-(opus-5|sonnet-5|fable|mythos|opus-4-[678]|sonnet-4-6)/.test(model);
}

/** Models with safety classifiers that can decline; let the API retry on its recommended fallback. */
export function usesServerFallback(model) {
  return /^claude-(opus-5|fable|mythos)/.test(model);
}

export function describeApiError(err, model) {
  if (err instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY ไม่ถูกต้องหรือถูกยกเลิก (401)';
  if (err instanceof Anthropic.PermissionDeniedError) return `บัญชีนี้ยังใช้โมเดล ${model} ไม่ได้ (403)`;
  if (err instanceof Anthropic.NotFoundError) return `ไม่รู้จักโมเดล "${model}" (404) — ตรวจชื่อโมเดลในหน้าตั้งค่า`;
  if (err instanceof Anthropic.RateLimitError) return 'เรียก Claude ถี่เกินโควตา (429) — ลองเพิ่มระยะห่างการตรวจ';
  if (err instanceof Anthropic.BadRequestError) return `Claude ไม่รับคำขอ (400): ${String(err.error?.error?.message || err.message).slice(0, 200)}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'Claude ตอบช้าเกินกำหนด (timeout)';
  if (err instanceof Anthropic.APIConnectionError) return 'เชื่อมต่อ Claude ไม่ได้ — ตรวจอินเทอร์เน็ต';
  if (err instanceof Anthropic.InternalServerError) return `Claude ขัดข้องชั่วคราว (${err.status})`;
  if (err instanceof Anthropic.APIError) return `Claude ตอบข้อผิดพลาด ${err.status ?? ''}: ${String(err.message).slice(0, 200)}`;
  return `เรียก Claude ไม่สำเร็จ: ${err.message}`;
}

export function createAnthropicEngine({ apiKey, baseURL, timeoutMs = 120_000, client } = {}) {
  const api = client || new Anthropic({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 2 });

  /**
   * req: { model, effort, blocks, staticCount, cacheTtl, expectedIds }
   */
  async function analyze(req) {
    const { model, effort, blocks, staticCount, cacheTtl, expectedIds } = req;
    const cache = cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    const content = blocks.map((b, i) => (i === staticCount - 1 ? { ...b, cache_control: cache } : b));
    const params = {
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: cache }],
      messages: [{ role: 'user', content }],
      output_config: {
        format: { type: 'json_schema', schema: RESULT_SCHEMA },
        ...(effort && supportsEffort(model) ? { effort } : {}),
      },
    };

    const started = Date.now();
    let response;
    try {
      response = usesServerFallback(model)
        ? await api.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await api.messages.create(params);
    } catch (err) {
      return failedResult(describeApiError(err, model), { engine: 'anthropic', model, ms: Date.now() - started });
    }
    const ms = Date.now() - started;
    const u = response.usage || {};
    const usage = {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens || 0,
      cacheWrite5m: u.cache_creation
        ? u.cache_creation.ephemeral_5m_input_tokens || 0
        : u.cache_creation_input_tokens || 0,
    };
    const servedBy = response.model || model;
    const meta = { engine: 'anthropic', model: servedBy, ms, usage, costUsd: costUsd(servedBy, usage) };

    if (response.stop_reason === 'refusal') {
      return failedResult('Claude ปฏิเสธการวิเคราะห์ภาพชุดนี้ (refusal)', meta);
    }
    if (response.stop_reason === 'max_tokens') {
      return failedResult('คำตอบของ Claude ยาวเกินกำหนด (max_tokens)', meta);
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = extractJson(text);
    if (!parsed) return failedResult('อ่านคำตอบ JSON จาก Claude ไม่ได้', meta);
    return { ...normalizeResult(parsed, expectedIds), ...meta };
  }

  return { name: 'anthropic', analyze };
}

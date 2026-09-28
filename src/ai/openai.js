// GPT through the OpenAI API (pay per use with an API key). Same job as the Claude engine: look at the
// camera frames and return the flood JSON. Uses plain fetch — no extra dependency.

import { RESULT_SCHEMA, SYSTEM_PROMPT } from './prompt.js';
import { costUsd, extractJson, failedResult, normalizeResult, priceFor } from './result.js';

// On real frames of a flooded road (2026-09-28) gpt-6-luna called the standing water correctly on every
// run at ~1/15 the cost of gpt-4o, which called it only a wet surface.
export const OPENAI_DEFAULT_MODEL = 'gpt-6-luna';
export const isOpenAiModel = (m) => /^(gpt-|o\d|chatgpt|ft:)/i.test(m || '');

/** Anthropic-style content blocks → OpenAI chat content parts. */
export function toOpenAIContent(blocks) {
  return blocks.map((b) => (b.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}`, detail: 'high' } }
    : { type: 'text', text: b.text }));
}

const SHAPE = 'Return ONLY a JSON object (no markdown) with exactly these keys: '
  + '"cameras": array of {"id","line_status","water","coverage_pct","note_th"}, plus '
  + '"level" (int 0-100), "level_status", "distance_th", "confidence" (0-1), "headline_th".';

function describeError(status, data) {
  const msg = String(data?.error?.message || '').slice(0, 200);
  if (status === 401) return 'OPENAI_API_KEY ไม่ถูกต้องหรือถูกยกเลิก (401)';
  if (status === 404) return `ไม่รู้จักโมเดลนี้ (404) — ตรวจชื่อโมเดลในหน้าตั้งค่า${msg ? `: ${msg}` : ''}`;
  if (status === 429) return 'เรียก OpenAI ถี่เกินโควตา (429) — เพิ่มระยะห่างการตรวจ หรือเช็กเครดิต';
  if (status === 400) return `OpenAI ไม่รับคำขอ (400): ${msg}`;
  if (status >= 500) return `OpenAI ขัดข้องชั่วคราว (${status})`;
  return `OpenAI ตอบข้อผิดพลาด ${status}: ${msg}`;
}

export function createOpenAIEngine({ apiKey, model, baseURL = 'https://api.openai.com/v1', timeoutMs = 120_000, fetchImpl = fetch } = {}) {
  const fallbackModel = model || OPENAI_DEFAULT_MODEL;

  async function analyze(req) {
    const { blocks, expectedIds } = req;
    const useModel = isOpenAiModel(req.model) ? req.model : fallbackModel;
    const body = {
      model: useModel,
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\n${SHAPE}` },
        { role: 'user', content: toOpenAIContent(blocks) },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 4000,
    };

    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const to = err.name === 'TimeoutError' || err.name === 'AbortError';
      return failedResult(to ? 'OpenAI ตอบช้าเกินกำหนด (timeout)' : `เชื่อมต่อ OpenAI ไม่ได้: ${err.cause?.code || err.message}`, { engine: 'openai', model: useModel, ms: Date.now() - started });
    }
    const ms = Date.now() - started;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return failedResult(describeError(res.status, data), { engine: 'openai', model: useModel, ms });

    const served = data.model || useModel;
    const u = data.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    const usage = { input: Math.max(0, (u.prompt_tokens || 0) - cached), output: u.completion_tokens || 0, cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0 };
    const meta = { engine: 'openai', model: served, ms, usage, costUsd: costUsd(served, usage) };

    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') return failedResult('คำตอบของ GPT ยาวเกินกำหนด (length)', meta);
    const text = choice?.message?.content || '';
    const parsed = extractJson(text);
    if (!parsed) return failedResult('อ่านคำตอบ JSON จาก GPT ไม่ได้', meta);
    return { ...normalizeResult(parsed, expectedIds), ...meta };
  }

  return { name: 'openai', analyze };
}

export { RESULT_SCHEMA, priceFor };

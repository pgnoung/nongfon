// Claude through the Claude Code CLI in headless mode (`claude -p`), using a
// Claude Pro/Max subscription token from `claude setup-token` instead of an API key.

import { spawn } from 'node:child_process';
import { RESULT_SCHEMA, SYSTEM_PROMPT } from './prompt.js';
import { extractJson, failedResult, normalizeResult } from './result.js';
import { maskText } from '../log.js';

export function claudeArgs({ model, effort }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(RESULT_SCHEMA),
    '--system-prompt', SYSTEM_PROMPT,
    '--tools', '',
    '--no-session-persistence',
    '--max-turns', '4',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

/** Find the final {"type":"result"} event in stream-json output. */
export function parseResultEvent(stdout) {
  let result = null;
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const evt = JSON.parse(s);
      if (evt && evt.type === 'result') result = evt;
    } catch {
      /* partial line */
    }
  }
  return result;
}

export function createClaudeCodeEngine({ bin = 'claude', oauthToken, timeoutMs = 180_000 } = {}) {
  async function analyze(req) {
    const { model, effort, blocks, expectedIds } = req;
    const started = Date.now();
    const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

    const run = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, claudeArgs({ model, effort }), { env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ error: `เรียกโปรแกรม claude ไม่ได้: ${err.message}` });
        return;
      }
      let out = '';
      let errText = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ error: `claude ไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที` });
      }, timeoutMs);
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => {
        if (errText.length < 4000) errText += c;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          error: e.code === 'ENOENT'
            ? 'ไม่พบโปรแกรม claude — ติดตั้งด้วย npm i -g @anthropic-ai/claude-code (Docker มีให้แล้ว)'
            : `claude ผิดพลาด: ${e.message}`,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, errText });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n');
    });

    const ms = Date.now() - started;
    const meta = { engine: 'claude-code', model, ms };
    if (run.error) return failedResult(run.error, meta);

    const evt = parseResultEvent(run.out);
    if (!evt) {
      const detail = maskText(run.errText.trim().split('\n').slice(-2).join(' ')).slice(0, 200);
      return failedResult(`claude ไม่ส่งผลลัพธ์กลับมา (exit ${run.code})${detail ? `: ${detail}` : ''}`, meta);
    }
    const u = evt.usage || {};
    const usage = {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite5m: u.cache_creation_input_tokens || 0,
      cacheWrite1h: 0,
    };
    // With a subscription nothing is billed per call; total_cost_usd is the API-equivalent estimate.
    Object.assign(meta, { usage, costUsd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : null, subscription: true });

    if (evt.is_error || evt.subtype !== 'success') {
      const why = String(evt.result || evt.subtype || '').slice(0, 200);
      const hint = /log ?in|auth|token/i.test(why) ? ' — ตรวจ CLAUDE_CODE_OAUTH_TOKEN (สร้างใหม่ด้วย claude setup-token)' : '';
      return failedResult(`claude รายงานข้อผิดพลาด: ${maskText(why)}${hint}`, meta);
    }
    const parsed = evt.structured_output ?? extractJson(evt.result);
    if (!parsed) return failedResult('อ่านคำตอบ JSON จาก claude ไม่ได้', meta);
    return { ...normalizeResult(parsed, expectedIds), ...meta };
  }

  return { name: 'claude-code', analyze };
}

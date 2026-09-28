import { createAnthropicEngine } from './anthropic.js';
import { createClaudeCodeEngine } from './claude-code.js';
import { createOpenAIEngine, isOpenAiModel, OPENAI_DEFAULT_MODEL } from './openai.js';
import { createDemoEngine } from '../demo.js';

export const ENGINES = {
  anthropic: 'Claude API (ANTHROPIC_API_KEY)',
  'claude-code': 'Claude Code + แพ็กเกจ Pro/Max (CLAUDE_CODE_OAUTH_TOKEN)',
  openai: 'GPT ผ่าน OpenAI API (OPENAI_API_KEY)',
  demo: 'AI จำลอง (โหมดสาธิต)',
};

export function createEngine(config, { world, lineLookup } = {}) {
  if (config.engine === 'demo') return createDemoEngine({ world, lineLookup });
  if (config.engine === 'claude-code') {
    return createClaudeCodeEngine({ bin: config.claudeBin, oauthToken: config.secrets.claudeOauth });
  }
  if (config.engine === 'openai') {
    return createOpenAIEngine({ apiKey: config.secrets.openaiKey });
  }
  return createAnthropicEngine({ apiKey: config.secrets.anthropicKey });
}

/** The model a check will really use: the OpenAI engine swaps a Claude name for its own default. */
export function effectiveModel(config, aiModel) {
  if (config.engine === 'openai' && !isOpenAiModel(aiModel)) return OPENAI_DEFAULT_MODEL;
  return aiModel;
}

/** Is the chosen engine configured well enough to try? */
export function engineProblem(config) {
  if (config.engine === 'demo') return null;
  if (config.engine === 'claude-code') {
    return config.secrets.claudeOauth ? null : 'ยังไม่ได้ใส่ CLAUDE_CODE_OAUTH_TOKEN ใน .env (สร้างด้วยคำสั่ง claude setup-token)';
  }
  if (config.engine === 'openai') {
    return config.secrets.openaiKey ? null : 'ยังไม่ได้ใส่ OPENAI_API_KEY ใน .env';
  }
  if (config.engine !== 'anthropic') return `ไม่รู้จัก AI_ENGINE=${config.engine} (ใช้ anthropic, openai หรือ claude-code)`;
  return config.secrets.anthropicKey ? null : 'ยังไม่ได้ใส่ ANTHROPIC_API_KEY ใน .env';
}

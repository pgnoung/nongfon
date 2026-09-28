#!/usr/bin/env node
// Write non-secret settings into .env — for an AI agent guiding the setup, or a script.
//
//   node scripts/set-env.js AI_ENGINE=openai AI_MODEL=gpt-6-luna SITE_NAME="บ้านสวน"
//   node scripts/set-env.js --unset DEMO
//
// Keys, tokens, passwords and camera links (they carry the camera password) are refused on purpose:
// the owner types those into `npm run secrets` or the dashboard, so they never pass through a chat.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile, upsertEnv, writeEnvFile } from './lib/envfile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ALLOWED_KEYS = /^(AI_ENGINE|AI_MODEL|DEMO|SITE_NAME|LATITUDE|LONGITUDE|NEWS_QUERY|TIMEZONE|PORT|PUBLIC_URL|CAMERA_\d{1,2}_NAME|CF_ACCESS_TEAM_DOMAIN|CF_ACCESS_AUD|LINE_TO|MQTT_TOPIC|SIREN_ENABLED|SIREN_WEBHOOK_METHOD|HTTP_TOOL)$/;

const RULES = {
  AI_ENGINE: (v) => ['openai', 'anthropic', 'claude-code'].includes(v) || 'ใช้ได้แค่ openai, anthropic หรือ claude-code',
  DEMO: (v) => ['0', '1', 'true', 'false'].includes(v) || 'ใช้ 1 (เปิดโหมดสาธิต) หรือ 0',
  LATITUDE: (v) => (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 90) || 'ละติจูดต้องเป็นตัวเลข -90 ถึง 90',
  LONGITUDE: (v) => (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 180) || 'ลองจิจูดต้องเป็นตัวเลข -180 ถึง 180',
  PORT: (v) => (/^\d+$/.test(v) && Number(v) >= 1024 && Number(v) <= 65535) || 'พอร์ตต้องเป็นตัวเลข 1024–65535',
};

/** args like ['AI_ENGINE=openai', '--unset', 'DEMO'] → { updates } or { error } in Thai. */
export function parseArgs(args) {
  const updates = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--unset') {
      const key = args[++i];
      if (!key || !ALLOWED_KEYS.test(key)) return { error: `ลบค่า ${key || '(ไม่ได้ระบุ)'} ด้วยคำสั่งนี้ไม่ได้` };
      updates[key] = null;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq <= 0) return { error: `ต้องเขียนแบบ KEY=ค่า (ได้ “${arg}”)` };
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if (!ALLOWED_KEYS.test(key)) {
      return { error: `${key} เป็นค่าลับหรือค่าที่มีรหัสอยู่ข้างใน — ให้เจ้าของเครื่องใส่เองด้วย npm run secrets หรือในหน้าเว็บ` };
    }
    const verdict = RULES[key] ? RULES[key](value) : true;
    if (verdict !== true) return { error: `${key}: ${verdict}` };
    updates[key] = value;
  }
  if (!Object.keys(updates).length) return { error: 'ยังไม่ได้บอกว่าจะตั้งค่าอะไร เช่น node scripts/set-env.js AI_ENGINE=openai' };
  return { updates };
}

function main() {
  const { updates, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`❌ ${error}`);
    process.exit(2);
  }
  const envFile = path.join(ROOT, '.env');
  const created = !fs.existsSync(envFile);
  const text = upsertEnv(readEnvFile(envFile, path.join(ROOT, '.env.example')), updates);
  writeEnvFile(envFile, text);
  if (created) console.log('✅ สร้างไฟล์ .env จากแม่แบบแล้ว (อ่านได้เฉพาะผู้ใช้เครื่องนี้)');
  for (const [key, value] of Object.entries(updates)) console.log(value === null ? `✅ ลบ ${key}` : `✅ ${key}=${value}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

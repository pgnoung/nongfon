#!/usr/bin/env node
// Start น้องฝน by itself after the computer restarts (for the user who is logged in).
//
//   npm run autostart -- on | off | status
//
// macOS: a LaunchAgent opens install/autostart-mac.command in Terminal at login. Running inside
//        Terminal matters: macOS lets Terminal reach cameras on the home network, while background
//        services built from downloaded programs are blocked by the Local Network privacy setting.
// Windows: a small NongFon.cmd in the Startup folder starts it minimised.
// Linux: a systemd user service (add `sudo loginctl enable-linger $USER` to start before login).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { autostartFile } from './lib/autostart-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.nongfon.autostart';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function macPlist(root = ROOT) {
  const command = path.join(root, 'install', 'autostart-mac.command');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>Terminal</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

export function windowsStartupCmd(root = ROOT) {
  const script = path.win32.join(root, 'install', 'nongfon.ps1');
  return `@echo off\r\nstart "NongFon" /min powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" start -NoBrowser\r\n`;
}

export function linuxUnit(root = ROOT) {
  return `[Unit]
Description=NongFon flood watch
After=network-online.target

[Service]
WorkingDirectory=${root}
ExecStart=/usr/bin/env bash "${path.join(root, 'install', 'nongfon.sh')}" start --no-browser
Restart=on-failure
RestartSec=20

[Install]
WantedBy=default.target
`;
}

function turnOn(platform, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (platform === 'darwin') {
    fs.writeFileSync(file, macPlist());
    fs.chmodSync(path.join(ROOT, 'install', 'autostart-mac.command'), 0o755);
    return 'เปิดเองอัตโนมัติแล้ว — ครั้งหน้าที่ล็อกอินเข้าเครื่อง Terminal จะเปิดน้องฝนให้เอง (อย่าปิดหน้าต่างนั้นนะคะ)';
  }
  if (platform === 'win32') {
    fs.writeFileSync(file, windowsStartupCmd());
    return 'เปิดเองอัตโนมัติแล้ว — ครั้งหน้าที่ล็อกอิน Windows น้องฝนจะเปิดเองแบบย่อหน้าต่าง';
  }
  fs.writeFileSync(file, linuxUnit());
  const r = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  const e = spawnSync('systemctl', ['--user', 'enable', 'nongfon.service'], { encoding: 'utf8' });
  if (r.status !== 0 || e.status !== 0) return `เขียนไฟล์ ${file} แล้ว แต่สั่ง systemctl --user ไม่ได้ — ลองพิมพ์เอง: systemctl --user enable --now nongfon`;
  return 'เปิดเองอัตโนมัติแล้ว (systemd user service) — ถ้าอยากให้เปิดก่อนล็อกอิน: sudo loginctl enable-linger $USER';
}

function turnOff(platform, file) {
  if (platform === 'linux') spawnSync('systemctl', ['--user', 'disable', 'nongfon.service'], { encoding: 'utf8' });
  if (!fs.existsSync(file)) return 'ยังไม่ได้ตั้งให้เปิดเองอยู่แล้วค่ะ';
  fs.rmSync(file);
  return 'ยกเลิกการเปิดเองอัตโนมัติแล้วค่ะ (น้องฝนที่เปิดอยู่ตอนนี้ยังทำงานต่อจนกว่าจะปิดหน้าต่าง)';
}

function main() {
  const action = process.argv[2] || 'status';
  const platform = process.platform;
  const file = autostartFile(platform, os.homedir(), process.env);
  if (action === 'on') console.log(`✅ ${turnOn(platform, file)}`);
  else if (action === 'off') console.log(`✅ ${turnOff(platform, file)}`);
  else console.log(fs.existsSync(file) ? `✅ ตั้งให้เปิดเองแล้ว (${file})` : 'ℹ️  ยังไม่ได้ตั้งให้เปิดเอง — ดับเบิลคลิกตัวเปิดน้องฝน → เมนู 5 (หรือ npm run autostart -- on)');
  if (action === 'on' && platform === 'darwin') console.log('   กันเครื่องหลับ: System Settings → Energy → เปิด “Prevent automatic sleeping” และ “Start up automatically after a power failure”');
  if (action === 'on' && platform === 'win32') console.log('   กันเครื่องหลับ: Settings → System → Power → Sleep = Never (ตอนเสียบปลั๊ก)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

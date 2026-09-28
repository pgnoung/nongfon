// Where each system keeps "start น้องฝน when I log in". Shared by autostart.js and doctor.js.

import os from 'node:os';
import path from 'node:path';

export function autostartFile(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', 'com.nongfon.autostart.plist');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'NongFon.cmd');
  return path.join(home, '.config', 'systemd', 'user', 'nongfon.service');
}

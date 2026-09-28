// Two-way Telegram: answer /status, /check, /stop, /snooze from the bound chat,
// and the buttons under each alert. Uses long polling, so no public URL is needed.

import { helpMessage, statusMessage } from './messages.js';
import { STATUS_TH } from '../judge.js';
import { escapeHtml, sleep } from '../util.js';
import { logger } from '../log.js';

const log = logger('telegram');

const COMMANDS = [
  { command: 'status', description: 'ดูสถานะล่าสุด + รูป' },
  { command: 'check', description: 'ตรวจเดี๋ยวนี้' },
  { command: 'stop', description: 'หยุดไซเรน' },
  { command: 'mute', description: 'งดเสียงไซเรนจนกว่าน้ำจะลด' },
  { command: 'snooze', description: 'งดเสียงไซเรน (นาที) เช่น /snooze 60' },
  { command: 'resume', description: 'ยกเลิกงดเสียง' },
  { command: 'testsiren', description: 'ทดสอบไซเรน 3 วินาที' },
  { command: 'help', description: 'วิธีใช้' },
];

export function parseCommand(text) {
  const t = String(text || '').trim();
  const m = t.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (m) return { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() };
  const thai = [
    [/^(สถานะ|เช็ค|ดู)/, 'status'],
    [/^(ตรวจ|เช็คเลย)/, 'check'],
    [/^(หยุด|ปิดไซเรน|ปิดเสียง)/, 'stop'],
    [/^(ทดสอบไซเรน|เทสไซเรน)/, 'testsiren'],
    [/^(งดจน|เงียบจน)/, 'mute'],
    [/^(เงียบ|งด)/, 'snooze'],
    [/^(ยกเลิกงด|เปิดเสียง)/, 'resume'],
  ];
  for (const [re, cmd] of thai) if (re.test(t)) return { cmd, arg: (t.match(/\d+/) || [''])[0] };
  return { cmd: '', arg: '' };
}

export class TelegramBot {
  constructor({ store, notifier, siren, watcher, buildPhoto }) {
    this.store = store;
    this.notifier = notifier;
    this.siren = siren;
    this.watcher = watcher;
    this.buildPhoto = buildPhoto;
    this.running = false;
    this.health = { ok: null, error: null, at: null };
  }

  get tg() {
    return this.notifier.telegram;
  }

  authorized(chatId) {
    const bound = this.store.settings.telegramChatId;
    return Boolean(bound) && String(chatId) === String(bound);
  }

  start() {
    if (!this.tg || this.running) return;
    this.running = true;
    this.tg.setCommands(COMMANDS).catch(() => {});
    this.#loop();
  }

  stop() {
    this.running = false;
  }

  async #loop() {
    let backoff = 5000;
    while (this.running) {
      try {
        const updates = await this.tg.getUpdates(this.store.state.telegramOffset || 0, 25);
        this.health = { ok: true, error: null, at: Date.now() };
        backoff = 5000;
        for (const update of updates) {
          this.store.patchState({ telegramOffset: update.update_id + 1 });
          await this.handle(update).catch((err) => log.warn(`ตอบ Telegram ไม่สำเร็จ: ${err.message}`));
        }
      } catch (err) {
        this.health = { ok: false, error: err.message, at: Date.now() };
        log.warn(`รับคำสั่ง Telegram ไม่ได้: ${err.message}`);
        await sleep(err.status === 401 ? 600e3 : backoff);
        backoff = Math.min(backoff * 2, 120e3);
      }
    }
  }

  async #reply(chatId, html) {
    return this.tg.sendMessage(chatId, html);
  }

  async #sendStatus(chatId, reading) {
    const st = this.store.state;
    const msg = statusMessage({ siteName: this.store.settings.siteName, timezone: this.store.settings.timezone }, reading, {
      pending: Boolean(st.pendingCritical),
      snoozeUntil: this.siren.status().snoozeUntil,
      muteLevel: this.siren.status().muteLevel,
      paused: this.store.settings.paused,
    });
    const photo = reading ? await this.buildPhoto(reading).catch(() => null) : null;
    if (photo) await this.tg.sendPhoto(chatId, photo, msg.html);
    else await this.#reply(chatId, msg.html);
  }

  async #run(cmd, arg, chatId) {
    switch (cmd) {
      case 'status':
        return this.#sendStatus(chatId, this.store.latestReading());
      case 'check': {
        await this.#reply(chatId, '🔍 กำลังตรวจให้เดี๋ยวนี้ค่ะ รอสักครู่นะคะ…');
        const reading = await this.watcher.runNow('telegram');
        return this.#sendStatus(chatId, reading);
      }
      case 'stop': {
        const st = this.siren.status() || {};
        const wasOn = Boolean(st.on || st.ringingPhones);
        await this.siren.stop('telegram');
        return this.#reply(chatId, wasOn
          ? '🔕 ปิดไซเรนแล้วค่ะ (ถ้าน้ำยังสูง จะเตือนซ้ำตามรอบ)'
          : '🔕 ตอนนี้ไม่มีไซเรนดังอยู่ค่ะ ปุ่มนี้ใช้ปิดเสียงตอนไซเรนกำลังดัง ถ้าอยากลองเสียง พิมพ์ /testsiren');
      }
      case 'testsiren': {
        const out = this.siren.outputs?.() || {};
        await this.siren.sound({ reason: 'ทดสอบจาก Telegram', seconds: 3, test: true });
        this.notifier?.record?.('siren', 'ทดสอบไซเรน 3 วินาที', 'สั่งจาก Telegram');
        const where = [out.iphone && 'iPhone ที่ลงแอป Pushover', out.mqtt && 'ไซเรน MQTT', out.webhook && 'ไซเรน webhook', 'มือถือหรือแท็บเล็ตที่เปิดหน้าข้างเตียงค้างไว้'].filter(Boolean).join(' · ');
        const noDevice = out.mqtt || out.webhook || out.iphone ? '' : '\nตอนนี้ยังไม่ได้ต่อไซเรนจริง ถ้าไม่มีเครื่องไหนเปิดหน้าข้างเตียงอยู่ จะไม่มีเสียงค่ะ';
        return this.#reply(chatId, `🔔 ทดสอบไซเรน 3 วินาทีแล้วค่ะ เสียงจะดังที่: ${where}${noDevice}`);
      }
      case 'snooze': {
        const minutes = Math.min(720, Math.max(5, Number(arg) || 60));
        await this.siren.snooze(minutes, 'telegram');
        return this.#reply(chatId, `😴 งดเสียงไซเรน ${minutes} นาทีค่ะ ข้อความเตือนยังส่งตามปกติ และจะยกเลิกเองเมื่อน้ำกลับสู่ปกติ`);
      }
      case 'mute': {
        const { muteLevel } = await this.siren.muteUntilDrop('telegram');
        return this.#reply(chatId, `😴 งดเสียงไซเรนจนกว่าน้ำจะลดต่ำกว่าระดับ${STATUS_TH[muteLevel]}ค่ะ ข้อความเตือนยังส่งตามปกติ`);
      }
      case 'resume':
        this.siren.unsnooze('telegram');
        return this.#reply(chatId, '🔔 ยกเลิกงดเสียงแล้วค่ะ');
      case 'start':
      case 'help':
        return this.#reply(chatId, helpMessage().html);
      default:
        return this.#reply(chatId, `ไม่รู้จักคำสั่งนี้ค่ะ\n\n${helpMessage().html}`);
    }
  }

  async handle(update) {
    if (update.callback_query) {
      const q = update.callback_query;
      const chatId = q.message?.chat?.id;
      if (!this.authorized(chatId)) return this.tg.answerCallback(q.id, 'แชทนี้ยังไม่ได้เชื่อมกับน้องฝน');
      const [action, arg] = String(q.data || '').split(':');
      log.info(`Telegram: กดปุ่ม ${action}${arg ? ` ${arg}` : ''} (${q.message?.chat?.title || chatId})`);
      const sst = this.siren.status() || {};
      const quiet = action === 'stop' && !sst.on && !sst.ringingPhones;
      const label = { stop: quiet ? 'ตอนนี้ไม่มีไซเรนดังอยู่' : 'ปิดไซเรนแล้ว', mute: 'งดเสียงจนกว่าน้ำจะลด', snooze: `งดเสียง ${arg || 60} นาที`, check: 'กำลังตรวจอีกรอบ…' }[action] || 'รับทราบ';
      await this.tg.answerCallback(q.id, label).catch(() => {});
      return this.#run(action, arg, chatId);
    }
    const message = update.message;
    if (!message?.chat || !message.text) return;
    const chatId = message.chat.id;
    if (!this.authorized(chatId)) {
      const name = message.chat.title || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || message.chat.username || '';
      const list = (this.store.state.telegramCandidates || []).filter((c) => String(c.id) !== String(chatId));
      list.unshift({ id: chatId, name, at: Date.now() });
      this.store.patchState({ telegramCandidates: list.slice(0, 5) });
      return this.#reply(chatId,
        `สวัสดีค่ะ นี่คือบอท <b>น้องฝนเฝ้าบ้าน</b> ☔\nแชทนี้ยังไม่ได้เชื่อมกับบ้าน — เปิดหน้า <b>ตั้งค่า → Telegram</b> บนแดชบอร์ด แล้วกด “ใช้แชทนี้”\nรหัสแชท: <code>${escapeHtml(String(chatId))}</code>`);
    }
    const { cmd, arg } = parseCommand(message.text);
    log.info(`Telegram: คำสั่ง ${cmd || 'help'}${arg ? ` ${arg}` : ''} (${message.chat.title || chatId})`);
    return this.#run(cmd || 'help', arg, chatId);
  }
}

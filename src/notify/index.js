// Fan one alert out to every configured channel and keep a record for the dashboard.

import { createTelegram } from './telegram.js';
import { createLine } from './line.js';
import { postWebhook } from './webhook.js';
import { logger } from '../log.js';
import { randomId } from '../util.js';

const log = logger('notify');

export class Notifier {
  constructor({ store, config, fetchImpl = fetch }) {
    this.store = store;
    this.config = config;
    this.fetchImpl = fetchImpl;
    const { telegramToken, lineToken, webhookUrl } = config.secrets;
    this.telegram = telegramToken ? createTelegram({ token: telegramToken, fetchImpl }) : null;
    this.line = lineToken ? createLine({ token: lineToken, fetchImpl }) : null;
    this.webhookUrl = webhookUrl || '';
  }

  /** Which channels will actually receive the next alert. */
  channels() {
    const s = this.store.settings;
    return {
      telegram: Boolean(this.telegram && s.telegramEnabled && s.telegramChatId),
      line: Boolean(this.line && s.lineEnabled && s.lineTo),
      webhook: Boolean(this.webhookUrl && s.webhookEnabled),
    };
  }

  /** Log-only entry (shown on the dashboard, not sent anywhere). */
  record(kind, title, text = '', extra = {}) {
    return this.store.addEvent({ id: randomId('e'), ts: Date.now(), kind, title, text, channels: {}, ...extra });
  }

  /**
   * msg: { kind, title, html, text, photo?: Buffer | () => Promise<Buffer|null>, buttons?, silent?, readingId?, data? }
   */
  async send(msg) {
    const s = this.store.settings;
    const on = this.channels();
    const channels = {};

    if (on.telegram) {
      try {
        let photo = typeof msg.photo === 'function' ? await msg.photo().catch(() => null) : msg.photo;
        let sent = null;
        if (photo) {
          try {
            sent = await this.telegram.sendPhoto(s.telegramChatId, photo, msg.html, { buttons: msg.buttons, silent: msg.silent });
          } catch (err) {
            log.warn(`ส่งรูปทาง Telegram ไม่สำเร็จ ส่งเป็นข้อความแทน: ${err.message}`);
            photo = null;
          }
        }
        if (!photo) sent = await this.telegram.sendMessage(s.telegramChatId, msg.html, { buttons: msg.buttons, silent: msg.silent });
        // Telegram's own message id is the proof the message landed
        channels.telegram = { ok: true, messageId: sent?.message_id ?? null, photo: Boolean(photo) };
      } catch (err) {
        channels.telegram = { ok: false, error: err.message };
      }
    }
    if (on.line) {
      try {
        await this.line.send(s.lineTo, msg.text, { silent: msg.silent });
        channels.line = { ok: true };
      } catch (err) {
        channels.line = { ok: false, error: err.message };
      }
    }
    if (on.webhook) {
      try {
        await postWebhook(this.webhookUrl, {
          event: msg.kind, title: msg.title, text: msg.text, site: s.siteName, time: new Date().toISOString(), ...msg.data,
        }, { fetchImpl: this.fetchImpl });
        channels.webhook = { ok: true };
      } catch (err) {
        channels.webhook = { ok: false, error: err.message };
      }
    }

    for (const [name, r] of Object.entries(channels)) {
      if (r.ok) log.info(`ส่ง "${msg.title}" ทาง ${name} แล้ว`);
      else log.warn(`ส่ง "${msg.title}" ทาง ${name} ไม่สำเร็จ: ${r.error}`);
    }
    if (!Object.keys(channels).length) log.info(`(ยังไม่ได้ตั้งช่องทางแจ้งเตือน) ${msg.title}`);

    return this.store.addEvent({
      id: randomId('e'), ts: Date.now(), kind: msg.kind, title: msg.title, text: msg.text,
      readingId: msg.readingId || null, channels,
    });
  }
}

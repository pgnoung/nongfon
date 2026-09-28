// Telegram Bot API client (no library needed).

export class TelegramError extends Error {
  constructor(message, { status, retryAfter } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function explain(status, description = '') {
  if (status === 401) return 'TELEGRAM_BOT_TOKEN ไม่ถูกต้อง';
  if (status === 403) return 'บอทส่งหาแชทนี้ไม่ได้ — ต้องทักบอท (กด Start) ก่อน หรือบอทถูกบล็อก';
  if (status === 400 && /chat not found/i.test(description)) return 'ไม่พบแชทนี้ — ตรวจ TELEGRAM_CHAT_ID และทักบอทก่อน';
  if (status === 409) return 'บอทนี้ถูกใช้ที่อื่นอยู่ (webhook/โปรแกรมอื่น) — ใช้บอทแยกสำหรับน้องฝน';
  if (status === 429) return 'ส่งถี่เกินไป Telegram ขอให้รอสักครู่';
  return `Telegram ตอบ ${status}: ${description}`.trim();
}

export function createTelegram({ token, fetchImpl = fetch, apiBase = 'https://api.telegram.org' }) {
  async function call(method, payload, { timeoutMs = 20000 } = {}) {
    const url = `${apiBase}/bot${token}/${method}`;
    const init = { method: 'POST', signal: AbortSignal.timeout(timeoutMs) };
    if (payload instanceof FormData) init.body = payload;
    else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(payload || {});
    }
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      const why = err.name === 'TimeoutError' ? 'หมดเวลา' : err.cause?.code || err.message;
      throw new TelegramError(`ต่อ Telegram ไม่ได้ (${why})`);
    }
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || !body.ok) {
      throw new TelegramError(explain(res.status, body.description), {
        status: res.status,
        retryAfter: body.parameters?.retry_after,
      });
    }
    return body.result;
  }

  const markup = (buttons) => (buttons ? { reply_markup: { inline_keyboard: buttons } } : {});

  return {
    call,
    getMe: () => call('getMe'),
    sendMessage: (chatId, html, { buttons, silent = false } = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: silent,
        ...markup(buttons),
      }),
    async sendPhoto(chatId, buffer, html, { buttons, silent = false } = {}) {
      // Captions are limited to 1024 characters; long text goes in a follow-up message.
      const fits = html.length <= 1000;
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('photo', new Blob([buffer], { type: 'image/jpeg' }), 'nongfon.jpg');
      form.set('parse_mode', 'HTML');
      form.set('disable_notification', String(silent));
      if (fits) {
        form.set('caption', html);
        if (buttons) form.set('reply_markup', JSON.stringify({ inline_keyboard: buttons }));
      }
      const sent = await call('sendPhoto', form, { timeoutMs: 45000 });
      if (!fits) await call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_notification: silent, ...markup(buttons) });
      return sent;
    },
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }),
    getUpdates: (offset, timeoutSec = 25) =>
      call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeoutSec + 10) * 1000 }),
    setCommands: (commands) => call('setMyCommands', { commands }),
  };
}

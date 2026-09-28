// LINE Messaging API (LINE Notify was shut down in 2025, so we use an Official Account).
// `to` is a user/group ID, or "broadcast" to message every friend of the OA —
// handy when only family members follow the house's OA.

import crypto from 'node:crypto';

function explain(status, message = '') {
  if (status === 401) return 'LINE_CHANNEL_ACCESS_TOKEN ไม่ถูกต้อง';
  if (status === 400 && /to/i.test(message)) return 'LINE_TO ไม่ถูกต้อง (ต้องเป็น User ID ที่ขึ้นต้นด้วย U หรือคำว่า broadcast)';
  if (status === 429) return 'ข้อความ LINE เกินโควตาของเดือนนี้';
  return `LINE ตอบ ${status}: ${message}`.trim();
}

export function createLine({ token, fetchImpl = fetch, apiBase = 'https://api.line.me' }) {
  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Line-Retry-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(`ต่อ LINE ไม่ได้ (${err.name === 'TimeoutError' ? 'หมดเวลา' : err.cause?.code || err.message})`);
    }
    if (!res.ok) {
      let message = '';
      try {
        message = (await res.json()).message || '';
      } catch {
        /* ignore */
      }
      throw new Error(explain(res.status, message));
    }
    return true;
  }

  return {
    /** silent: deliver without a notification sound (hourly roll-ups must not wake anyone). */
    send(to, text, { silent = false } = {}) {
      const messages = [{ type: 'text', text: text.slice(0, 5000) }];
      if (!to || to === 'broadcast') return post('/v2/bot/message/broadcast', { messages, notificationDisabled: silent });
      return post('/v2/bot/message/push', { to, messages, notificationDisabled: silent });
    },
  };
}

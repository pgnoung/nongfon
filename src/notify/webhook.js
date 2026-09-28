// Generic webhook: POST a JSON event to Make.com, n8n, Home Assistant, IFTTT, …

export async function postWebhook(url, event, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'nongfon/1.0' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`ส่ง webhook ไม่ได้ (${err.name === 'TimeoutError' ? 'หมดเวลา' : err.cause?.code || err.message})`);
  }
  await res.body?.cancel();
  if (!res.ok) throw new Error(`webhook ตอบ HTTP ${res.status}`);
  return true;
}

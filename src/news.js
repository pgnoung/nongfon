// Recent flood news from Google News (Thai edition) RSS — free, no key. Headlines are kept word
// for word with their outlet and time; nothing here summarises or rewrites them.

const TIMEOUT_MS = 15e3;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Google News search limited to the last `hours` hours. */
export function newsUrl(query, hours = 6) {
  const q = `${String(query || '').trim()} when:${hours}h`;
  return `https://news.google.com/rss/search?${new URLSearchParams({ q, hl: 'th', gl: 'TH', ceid: 'TH:th' })}`;
}

function decode(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

/**
 * RSS → [{ title, source, at, link }], newest first, at most `limit`, only from the last
 * `maxAgeHours`. The same headline from several outlets is kept once (the newest).
 */
export function parseNewsRss(xml, { now = Date.now(), maxAgeHours = 6, limit = 3 } = {}) {
  const items = (String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || []).map((raw) => {
    const source = tag(raw, 'source');
    const full = tag(raw, 'title');
    const title = source && full.endsWith(` - ${source}`) ? full.slice(0, -(source.length + 3)).trim() : full;
    return { title, source, at: Date.parse(tag(raw, 'pubDate')), link: tag(raw, 'link') };
  });
  const fresh = items
    .filter((n) => n.title && Number.isFinite(n.at) && now - n.at <= maxAgeHours * 3600e3 && n.at - now <= 3600e3)
    .sort((a, b) => b.at - a.at);
  const seen = new Set();
  return fresh.filter((n) => {
    const key = n.title.replace(/\s+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

/** Latest headlines for `query`; [] when no query is set. Throws on network/HTTP errors. */
export async function fetchNews(query, { fetchImpl = fetch, hours = 6, limit = 3, now = Date.now() } = {}) {
  if (!String(query || '').trim()) return [];
  const res = await fetchImpl(newsUrl(query, hours), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'NongFon/1.0 (home flood watch)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseNewsRss(await res.text(), { now, maxAgeHours: hours, limit });
}

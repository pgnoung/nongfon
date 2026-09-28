import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newsUrl, parseNewsRss } from '../src/news.js';

const NOW = Date.parse('2026-09-28T11:00:00Z'); // 18:00 in Bangkok
const item = (title, source, minsAgo) =>
  `<item><title>${title} - ${source}</title><link>https://news.example/${encodeURIComponent(source)}</link>` +
  `<pubDate>${new Date(NOW - minsAgo * 60e3).toUTCString()}</pubDate><source url="https://x.example">${source}</source></item>`;

test('news: Google News RSS items become short, recent, de-duplicated headlines', () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>x</title>${[
    item('น้ำท่วมถนนสุขุมวิท &amp; รถติดหนัก', 'ไทยรัฐ', 20),
    item('น้ำท่วมถนนสุขุมวิท &amp; รถติดหนัก', 'ข่าวสด', 25), // the same story from another outlet
    item('กทม. เตือนฝนตกหนักคืนนี้', 'Thai PBS', 90),
    item('ข่าวเก่าเมื่อวาน', 'มติชน', 60 * 20), // too old
  ].join('')}</channel></rss>`;
  const news = parseNewsRss(xml, { now: NOW, maxAgeHours: 6, limit: 3 });
  assert.equal(news.length, 2);
  assert.equal(news[0].title, 'น้ำท่วมถนนสุขุมวิท & รถติดหนัก');
  assert.equal(news[0].source, 'ไทยรัฐ');
  assert.equal(news[1].source, 'Thai PBS');
  assert.ok(news[0].at > news[1].at);
  assert.deepEqual(parseNewsRss('<rss></rss>', { now: NOW }), []);
});

test('news: the search asks Thai Google News for the last few hours only', () => {
  const u = new URL(newsUrl('น้ำท่วม บางใหญ่', 6));
  assert.equal(u.hostname, 'news.google.com');
  assert.equal(u.searchParams.get('q'), 'น้ำท่วม บางใหญ่ when:6h');
  assert.equal(u.searchParams.get('hl'), 'th');
});

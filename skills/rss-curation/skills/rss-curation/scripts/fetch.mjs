import { XMLParser } from 'fast-xml-parser';
import { insertArticle } from './db.mjs';

const FETCH_TIMEOUT_MS = 15_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

function safeDate(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function extractText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val['#text']) return val['#text'];
  return String(val);
}

function resolveAtomLink(link) {
  if (typeof link === 'string') return link;
  if (Array.isArray(link)) {
    const alt = link.find((l) => l['@_rel'] === 'alternate');
    return alt?.['@_href'] || link[0]?.['@_href'] || '';
  }
  return link?.['@_href'] || '';
}

function safeNormalize(fn) {
  return (items) => {
    const raw = Array.isArray(items) ? items : [items];
    const results = [];
    for (const item of raw) {
      try {
        results.push(fn(item));
      } catch {
        // skip malformed entry, keep processing the rest
      }
    }
    return results;
  };
}

const normalizeRssItem = (item) => ({
  title: item.title || '',
  url: item.link || item.guid || '',
  publishedAt: safeDate(item.pubDate),
  summary: item.description || '',
  author: item.author || null,
});

const normalizeAtomEntry = (entry) => ({
  title: extractText(entry.title),
  url: resolveAtomLink(entry.link),
  publishedAt: safeDate(entry.published) || safeDate(entry.updated),
  summary: extractText(entry.summary) || extractText(entry.content) || '',
  author: entry.author?.name || null,
});

const normalizeRdfItem = (item) => ({
  title: item.title || '',
  url: item.link || '',
  publishedAt: safeDate(item['dc:date']),
  summary: item.description || '',
  author: item['dc:creator'] || null,
});

function normalizeItems(parsed) {
  const channel = parsed?.rss?.channel;
  if (channel?.item) return safeNormalize(normalizeRssItem)(channel.item);

  const feed = parsed?.feed;
  if (feed?.entry) return safeNormalize(normalizeAtomEntry)(feed.entry);

  const rdf = parsed?.['rdf:RDF'];
  if (rdf?.item) return safeNormalize(normalizeRdfItem)(rdf.item);

  return [];
}

export function parseFeed(xml, feedName, feedUrl) {
  try {
    const parsed = parser.parse(xml);
    return normalizeItems(parsed)
      .filter((item) => item.url)
      .map((item) => ({ ...item, feedName, feedUrl }));
  } catch {
    return [];
  }
}

export async function fetchFeeds(config, db) {
  const feeds = config.feeds || [];
  let total = 0;
  let newCount = 0;
  const newArticles = [];
  const errors = [];

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        errors.push({ feed: feed.name, error: `HTTP ${res.status}` });
        continue;
      }
      const xml = await res.text();
      const articles = parseFeed(xml, feed.name, feed.url);
      total += articles.length;

      for (const article of articles) {
        const { id, isNew } = insertArticle(db, article);
        if (isNew) {
          newCount++;
          newArticles.push({ ...article, id });
        }
      }
    } catch (err) {
      const msg = err.name === 'TimeoutError'
        ? 'timeout'
        : (err.message || 'unknown error');
      errors.push({ feed: feed.name, error: msg });
      console.error(`Failed to fetch feed: ${feed.name} (${feed.url}): ${msg}`);
    }
  }

  return { total, new: newCount, articles: newArticles, errors };
}

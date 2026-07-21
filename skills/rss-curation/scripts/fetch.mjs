import { XMLParser } from 'fast-xml-parser';
import { insertArticle } from './db.mjs';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

function normalizeRssItems(channel) {
  const items = channel.item;
  if (!items) return [];
  return (Array.isArray(items) ? items : [items]).map((item) => ({
    title: item.title || '',
    url: item.link || '',
    publishedAt: item.pubDate
      ? new Date(item.pubDate).toISOString()
      : null,
    summary: item.description || '',
    author: item.author || null,
  }));
}

function normalizeAtomEntries(feed) {
  const entries = feed.entry;
  if (!entries) return [];
  return (Array.isArray(entries) ? entries : [entries]).map((entry) => ({
    title: entry.title || '',
    url: entry.link?.['@_href'] || entry.link || '',
    publishedAt: entry.published
      ? new Date(entry.published).toISOString()
      : entry.updated
        ? new Date(entry.updated).toISOString()
        : null,
    summary: entry.summary || entry.content || '',
    author: entry.author?.name || null,
  }));
}

function normalizeItems(parsed) {
  const channel = parsed?.rss?.channel;
  if (channel) return normalizeRssItems(channel);

  const feed = parsed?.feed;
  if (feed) return normalizeAtomEntries(feed);

  return [];
}

export function parseFeed(xml, feedName, feedUrl) {
  try {
    const parsed = parser.parse(xml);
    return normalizeItems(parsed).map((item) => ({
      ...item,
      feedName,
      feedUrl,
    }));
  } catch {
    return [];
  }
}

export async function fetchFeeds(config, db) {
  const feeds = config.feeds || [];
  let total = 0;
  let newCount = 0;
  const newArticles = [];

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url);
      if (!res.ok) continue;
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
    } catch {
      console.error(`Failed to fetch feed: ${feed.name} (${feed.url})`);
    }
  }

  return { total, new: newCount, articles: newArticles };
}

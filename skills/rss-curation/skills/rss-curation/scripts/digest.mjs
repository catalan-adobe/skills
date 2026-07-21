import fs from 'node:fs';
import path from 'node:path';
import { openDb, getArticlesByFetchDate } from './db.mjs';

const TOP_THRESHOLD = 7;
const DEFAULT_MIN_SCORE = 6;

function safeParseTags(raw) {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function timeAgo(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderTopPick(article, index) {
  const tags = safeParseTags(article.tags);
  const lines = [
    `### #${index + 1} \u00b7 ${article.title} (${article.score})`,
    '',
    `- **Source:** ${article.feed_name} \u00b7 ${timeAgo(article.published_at)}`,
    `- **Why:** ${article.score_reason}`,
  ];
  if (tags.length) lines.push(`- **Tags:** ${tags.join(', ')}`);
  lines.push(`- **Link:** ${article.url}`, '');
  return lines.join('\n');
}

function renderAlsoNoted(article, index) {
  const reason = article.score_reason || '';
  return `- **#${index + 1} \u00b7 ${article.title}** (${article.score}) \u2014 ${article.feed_name} \u00b7 ${article.url} \u00b7 ${reason}`;
}

function groupByPublishDate(articles) {
  const groups = {};
  for (const article of articles) {
    const pubDate = (article.published_at || article.fetched_at || '')
      .slice(0, 10);
    if (!pubDate) continue;
    if (!groups[pubDate]) groups[pubDate] = [];
    groups[pubDate].push(article);
  }
  return groups;
}

function renderDigest(date, articles, minScore) {
  const scored = articles.filter((a) => a.score >= minScore);
  const topPicks = scored.filter((a) => a.score >= TOP_THRESHOLD);
  const alsoNoted = scored.filter(
    (a) => a.score >= minScore && a.score < TOP_THRESHOLD,
  );

  const lines = [
    `# RSS Digest \u2014 ${date}`,
    '',
    `> ${articles.length} articles, ${scored.length} passed your relevance threshold (\u2265${minScore}/10)`,
    '',
  ];

  let idCounter = 0;

  if (topPicks.length > 0) {
    lines.push('## \u2b50 Top Picks', '');
    topPicks.forEach((a) => {
      lines.push(renderTopPick(a, idCounter));
      idCounter++;
    });
    lines.push('---', '');
  }

  if (alsoNoted.length > 0) {
    lines.push(`## Also Noted (score ${minScore}\u2013${TOP_THRESHOLD})`, '');
    alsoNoted.forEach((a) => {
      lines.push(renderAlsoNoted(a, idCounter));
      idCounter++;
    });
    lines.push('', '---', '');
  }

  lines.push(
    '*Feed: \ud83d\udc4d #id \u00b7 \ud83d\udc4e #id \u2014 reply with feedback to improve future digests*',
    '',
  );

  return lines.join('\n');
}

export function generateDigest(dbPath, fetchDate, options = {}) {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const outDir = options.outDir;
  const db = openDb(dbPath);

  try {
    const allArticles = getArticlesByFetchDate(db, fetchDate);
    const byDate = groupByPublishDate(allArticles);
    const dates = Object.keys(byDate).sort().reverse();
    const results = {};

    for (const date of dates) {
      const md = renderDigest(date, byDate[date], minScore);
      results[date] = md;

      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `${date}.md`), md);
      }
    }

    return results;
  } finally {
    db.close();
  }
}

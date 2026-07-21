import fs from 'node:fs';
import path from 'node:path';
import { openDb, getArticlesByDate } from './db.mjs';

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
  return [
    `### #${index + 1} · ${article.title} (${article.score})`,
    `**Source:** ${article.feed_name} · ${timeAgo(article.published_at)}`,
    `**Why:** ${article.score_reason}`,
    tags.length ? `**Tags:** ${tags.join(', ')}` : '',
    `[Read →](${article.url})`,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderAlsoNoted(article) {
  const reason = article.score_reason || '';
  return `- **${article.title}** (${article.score}) — ${article.feed_name} · [link](${article.url}) · ${reason}`;
}

export function generateDigest(dbPath, date, options = {}) {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const outDir = options.outDir;
  const db = openDb(dbPath);

  try {
    const allTotal = getArticlesByDate(db, date);
    const allScored = getArticlesByDate(db, date, minScore);
    const topPicks = allScored.filter((a) => a.score >= TOP_THRESHOLD);
    const alsoNoted = allScored.filter(
      (a) => a.score >= minScore && a.score < TOP_THRESHOLD,
    );

    const lines = [
      `# RSS Digest — ${date}`,
      '',
      `> ${allTotal.length} articles fetched, ${allScored.length} passed your relevance threshold (≥${minScore}/10)`,
      '',
    ];

    if (topPicks.length > 0) {
      lines.push('## ⭐ Top Picks', '');
      topPicks.forEach((a, i) => lines.push(renderTopPick(a, i)));
      lines.push('---', '');
    }

    if (alsoNoted.length > 0) {
      lines.push(`## Also Noted (score ${minScore}–${TOP_THRESHOLD})`, '');
      alsoNoted.forEach((a) => lines.push(renderAlsoNoted(a)));
      lines.push('', '---', '');
    }

    lines.push(
      '*Feed: 👍 #id · 👎 #id — reply with feedback to improve future digests*',
      '',
    );

    const md = lines.join('\n');

    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${date}.md`), md);
    }

    return md;
  } finally {
    db.close();
  }
}

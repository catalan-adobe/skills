import fs from 'node:fs';
import yaml from 'js-yaml';
import { openDb, recordFeedback, getFeedbackStats } from './db.mjs';

export function applyFeedback(dbPath, url, signal) {
  const db = openDb(dbPath);
  try {
    recordFeedback(db, url, signal);
    return JSON.stringify({ ok: true, url, signal });
  } finally {
    db.close();
  }
}

function safeParseTags(raw) {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function extractTopics(articles) {
  const tagCounts = {};
  for (const article of articles) {
    const tags = safeParseTags(article.tags);
    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
}

export function learnFromFeedback(dbPath, profilePath) {
  const db = openDb(dbPath);
  try {
    const { ups, downs } = getFeedbackStats(db);
    const profile = yaml.load(fs.readFileSync(profilePath, 'utf8'));

    const learned = {
      boost: extractTopics(ups),
      suppress: extractTopics(downs),
      examples: {
        liked: ups.map((a) => ({
          title: a.title,
          reason: a.score_reason || 'liked by user',
        })),
        disliked: downs.map((a) => ({
          title: a.title,
          reason: a.score_reason || 'disliked by user',
        })),
      },
    };

    profile.learned = learned;
    fs.writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 80 }));

    return JSON.stringify({ ok: true, learned });
  } finally {
    db.close();
  }
}

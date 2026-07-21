import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/db.mjs',
);

async function loadDb() {
  return import(`${DB_MOD}?t=${Date.now()}`);
}

describe('db', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('openDb creates tables and FTS index', async () => {
    const { openDb } = await loadDb();
    const db = openDb(dbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes('articles'));
    assert.ok(tables.includes('articles_fts'));
    db.close();
  });

  it('insertArticle stores and deduplicates by URL', async () => {
    const { openDb, insertArticle } = await loadDb();
    const db = openDb(dbPath);
    const article = {
      url: 'https://example.com/post-1',
      title: 'Test Post',
      author: 'Author',
      feedName: 'Test Feed',
      feedUrl: 'https://example.com/feed.xml',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'A test summary',
    };
    const first = insertArticle(db, article);
    assert.equal(first.isNew, true);
    assert.ok(first.id > 0);

    const second = insertArticle(db, article);
    assert.equal(second.isNew, false);
    db.close();
  });

  it('getUnscored returns only articles without scores', async () => {
    const { openDb, insertArticle, writeScores, getUnscored } =
      await loadDb();
    const db = openDb(dbPath);
    insertArticle(db, {
      url: 'https://example.com/scored',
      title: 'Scored',
      feedName: 'F',
      feedUrl: 'https://f.com/rss',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'scored article',
    });
    insertArticle(db, {
      url: 'https://example.com/unscored',
      title: 'Unscored',
      feedName: 'F',
      feedUrl: 'https://f.com/rss',
      publishedAt: '2025-07-21T11:00:00Z',
      summary: 'unscored article',
    });
    writeScores(db, [
      {
        url: 'https://example.com/scored',
        score: 8.0,
        scoreReason: 'relevant',
        tags: ['ai'],
      },
    ]);

    const unscored = getUnscored(db);
    assert.equal(unscored.length, 1);
    assert.equal(unscored[0].url, 'https://example.com/unscored');
    db.close();
  });

  it('searchArticles finds matches via FTS', async () => {
    const { openDb, insertArticle, searchArticles } = await loadDb();
    const db = openDb(dbPath);
    insertArticle(db, {
      url: 'https://example.com/webgpu',
      title: 'WebGPU lands in Chrome',
      feedName: 'Chrome Blog',
      feedUrl: 'https://chrome.com/rss',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'WebGPU is now available in stable Chrome',
    });
    insertArticle(db, {
      url: 'https://example.com/rust',
      title: 'Rust 2025 edition',
      feedName: 'Rust Blog',
      feedUrl: 'https://rust.com/rss',
      publishedAt: '2025-07-21T11:00:00Z',
      summary: 'The Rust 2025 edition is here',
    });

    const results = searchArticles(db, 'WebGPU');
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'WebGPU lands in Chrome');
    db.close();
  });

  it('recordFeedback and getFeedbackStats', async () => {
    const { openDb, insertArticle, recordFeedback, getFeedbackStats } =
      await loadDb();
    const db = openDb(dbPath);
    insertArticle(db, {
      url: 'https://example.com/good',
      title: 'Good Post',
      feedName: 'F',
      feedUrl: 'https://f.com/rss',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'good',
    });
    insertArticle(db, {
      url: 'https://example.com/bad',
      title: 'Bad Post',
      feedName: 'F',
      feedUrl: 'https://f.com/rss',
      publishedAt: '2025-07-21T11:00:00Z',
      summary: 'bad',
    });

    recordFeedback(db, 'https://example.com/good', 'up');
    recordFeedback(db, 'https://example.com/bad', 'down');

    const stats = getFeedbackStats(db);
    assert.equal(stats.ups.length, 1);
    assert.equal(stats.downs.length, 1);
    assert.equal(stats.ups[0].title, 'Good Post');
    db.close();
  });

  it('getArticlesByDate filters by date and minimum score', async () => {
    const { openDb, insertArticle, writeScores, getArticlesByDate } =
      await loadDb();
    const db = openDb(dbPath);
    insertArticle(db, {
      url: 'https://example.com/high',
      title: 'High Score',
      feedName: 'F',
      feedUrl: 'https://f.com/rss',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'high',
    });
    insertArticle(db, {
      url: 'https://example.com/low',
      title: 'Low Score',
      feedName: 'F',
      feedUrl: 'https://f.com/rss',
      publishedAt: '2025-07-21T11:00:00Z',
      summary: 'low',
    });
    writeScores(db, [
      {
        url: 'https://example.com/high',
        score: 8.5,
        scoreReason: 'very relevant',
        tags: ['ai'],
      },
      {
        url: 'https://example.com/low',
        score: 3.0,
        scoreReason: 'not relevant',
        tags: ['crypto'],
      },
    ]);

    const all = getArticlesByDate(db, '2025-07-21');
    assert.equal(all.length, 2);

    const highOnly = getArticlesByDate(db, '2025-07-21', 6);
    assert.equal(highOnly.length, 1);
    assert.equal(highOnly[0].title, 'High Score');
    db.close();
  });
});

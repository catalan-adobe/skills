# RSS Curation Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an RSS curation skill that fetches feeds, stores articles in a searchable SQLite knowledge base, and produces LLM-scored ranked digests.

**Architecture:** Single Node.js script (`rss-feed.mjs`) with subcommands dispatching to focused modules: `db.mjs` (SQLite layer), `fetch.mjs` (RSS parsing), `search.mjs` (FTS5), `feedback.mjs` (signals + learning). Claude scores articles interactively; a cron job handles headless fetch-only runs.

**Tech Stack:** Node 22 ESM, better-sqlite3 (12.12.0), fast-xml-parser (5.10.1), js-yaml (4.3.0), node:test for testing.

## Global Constraints

- Node 22 LTS, ESM only (`"type": "module"`)
- ≤100 lines/function, cyclomatic complexity ≤8
- Absolute imports only (scripts are self-contained under `scripts/`)
- Tests use `node:test` + `node:assert/strict`
- Skill scripts live in `skills/rss-curation/scripts/`
- Reference files in `skills/rss-curation/references/`
- SKILL.md under ~500 lines; extract reference material to `references/`
- Pin exact dependency versions (no `^` or `~`)
- Data directory: `~/repos/gc/catalan/notes/rss/`

---

### Task 1: Scaffold and SQLite Database Layer

**Files:**

- Create: `skills/rss-curation/scripts/package.json`
- Create: `skills/rss-curation/scripts/db.mjs`
- Create: `tests/rss-curation/db.test.js`

**Interfaces:**

- Consumes: nothing (foundational)
- Produces:
  - `openDb(dbPath: string): Database` — opens/creates DB, runs migrations
  - `insertArticle(db, article: object): { id: number, isNew: boolean }`
  - `getUnscored(db): Article[]`
  - `writeScores(db, scores: Array<{ url, score, scoreReason, tags }>): void`
  - `searchArticles(db, query: string, limit?: number): Article[]`
  - `recordFeedback(db, url: string, signal: 'up'|'down'): void`
  - `getFeedbackStats(db): { ups: Article[], downs: Article[] }`
  - `getArticlesByDate(db, date: string, minScore?: number): Article[]`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "rss-curation-scripts",
  "private": true,
  "type": "module",
  "dependencies": {
    "better-sqlite3": "12.12.0",
    "fast-xml-parser": "5.10.1",
    "js-yaml": "4.3.0"
  }
}
```

Create at `skills/rss-curation/scripts/package.json`.

- [ ] **Step 2: Write failing tests for DB layer**

Create `tests/rss-curation/db.test.js`:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd skills/rss-curation/scripts && npm install && cd ../../../ && node --test tests/rss-curation/db.test.js`
Expected: FAIL — `db.mjs` does not exist yet.

- [ ] **Step 4: Implement db.mjs**

Create `skills/rss-curation/scripts/db.mjs`:

```js
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS articles (
  id            INTEGER PRIMARY KEY,
  url           TEXT UNIQUE,
  title         TEXT,
  author        TEXT,
  feed_name     TEXT,
  feed_url      TEXT,
  published_at  TEXT,
  fetched_at    TEXT,
  summary       TEXT,
  content       TEXT,
  score         REAL,
  score_reason  TEXT,
  tags          TEXT,
  feedback      TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, summary, content, tags,
  content=articles,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, summary, content, tags)
  VALUES (new.id, new.title, new.summary, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, summary, content, tags)
  VALUES ('delete', old.id, old.title, old.summary, old.content, old.tags);
  INSERT INTO articles_fts(rowid, title, summary, content, tags)
  VALUES (new.id, new.title, new.summary, new.content, new.tags);
END;
`;

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function insertArticle(db, article) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO articles
      (url, title, author, feed_name, feed_url, published_at, fetched_at, summary)
    VALUES
      (@url, @title, @author, @feedName, @feedUrl, @publishedAt, @fetchedAt, @summary)
  `);
  const result = stmt.run({
    url: article.url,
    title: article.title,
    author: article.author || null,
    feedName: article.feedName,
    feedUrl: article.feedUrl,
    publishedAt: article.publishedAt,
    fetchedAt: new Date().toISOString(),
    summary: article.summary || null,
  });
  const isNew = result.changes > 0;
  const id = isNew
    ? result.lastInsertRowid
    : db.prepare('SELECT id FROM articles WHERE url = ?').get(article.url).id;
  return { id: Number(id), isNew };
}

export function getUnscored(db) {
  return db
    .prepare('SELECT * FROM articles WHERE score IS NULL ORDER BY published_at DESC')
    .all();
}

export function writeScores(db, scores) {
  const stmt = db.prepare(`
    UPDATE articles
    SET score = @score, score_reason = @scoreReason, tags = @tags
    WHERE url = @url
  `);
  const tx = db.transaction((items) => {
    for (const item of items) {
      stmt.run({
        url: item.url,
        score: item.score,
        scoreReason: item.scoreReason,
        tags: JSON.stringify(item.tags),
      });
    }
  });
  tx(scores);
}

export function searchArticles(db, query, limit = 20) {
  return db
    .prepare(`
      SELECT a.*, rank
      FROM articles_fts f
      JOIN articles a ON a.id = f.rowid
      WHERE articles_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)
    .all(query, limit);
}

export function recordFeedback(db, url, signal) {
  db.prepare('UPDATE articles SET feedback = ? WHERE url = ?').run(signal, url);
}

export function getFeedbackStats(db) {
  const ups = db
    .prepare("SELECT * FROM articles WHERE feedback = 'up' ORDER BY published_at DESC")
    .all();
  const downs = db
    .prepare("SELECT * FROM articles WHERE feedback = 'down' ORDER BY published_at DESC")
    .all();
  return { ups, downs };
}

export function getArticlesByDate(db, date, minScore) {
  if (minScore != null) {
    return db
      .prepare(`
        SELECT * FROM articles
        WHERE published_at LIKE ? AND score >= ?
        ORDER BY score DESC
      `)
      .all(`${date}%`, minScore);
  }
  return db
    .prepare(`
      SELECT * FROM articles
      WHERE published_at LIKE ?
      ORDER BY score DESC NULLS LAST
    `)
    .all(`${date}%`);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/rss-curation/db.test.js`
Expected: All 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/rss-curation/scripts/package.json \
       skills/rss-curation/scripts/db.mjs \
       tests/rss-curation/db.test.js
git commit -m "feat(rss-curation): scaffold project and SQLite DB layer"
```

---

### Task 2: RSS Feed Fetching

**Files:**

- Create: `skills/rss-curation/scripts/fetch.mjs`
- Create: `tests/rss-curation/fetch.test.js`

**Interfaces:**

- Consumes: `db.mjs` — `openDb`, `insertArticle`
- Produces:
  - `parseFeed(xml: string, feedName: string, feedUrl: string): Article[]` — parses RSS/Atom XML
  - `fetchFeeds(config: object, db: Database): { total: number, new: number, articles: Article[] }` — fetches all feeds, deduplicates, stores

- [ ] **Step 1: Write failing tests for feed parsing**

Create `tests/rss-curation/fetch.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const FETCH_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/fetch.mjs',
);

async function loadFetch() {
  return import(`${FETCH_MOD}?t=${Date.now()}`);
}

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <item>
      <title>First Post</title>
      <link>https://blog.example.com/first</link>
      <pubDate>Mon, 21 Jul 2025 10:00:00 GMT</pubDate>
      <description>This is the first post summary.</description>
      <author>alice@example.com (Alice)</author>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://blog.example.com/second</link>
      <pubDate>Mon, 21 Jul 2025 11:00:00 GMT</pubDate>
      <description>This is the second post summary.</description>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Atom Post</title>
    <link href="https://atom.example.com/post-1"/>
    <published>2025-07-21T12:00:00Z</published>
    <summary>An atom post summary.</summary>
    <author><name>Bob</name></author>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 items', async () => {
    const { parseFeed } = await loadFetch();
    const articles = parseFeed(RSS_SAMPLE, 'Test Blog', 'https://blog.example.com/rss');
    assert.equal(articles.length, 2);
    assert.equal(articles[0].title, 'First Post');
    assert.equal(articles[0].url, 'https://blog.example.com/first');
    assert.ok(articles[0].publishedAt);
    assert.equal(articles[0].summary, 'This is the first post summary.');
    assert.equal(articles[0].feedName, 'Test Blog');
  });

  it('parses Atom feeds', async () => {
    const { parseFeed } = await loadFetch();
    const articles = parseFeed(ATOM_SAMPLE, 'Atom Blog', 'https://atom.example.com/feed');
    assert.equal(articles.length, 1);
    assert.equal(articles[0].title, 'Atom Post');
    assert.equal(articles[0].url, 'https://atom.example.com/post-1');
    assert.equal(articles[0].summary, 'An atom post summary.');
  });

  it('returns empty array for invalid XML', async () => {
    const { parseFeed } = await loadFetch();
    const articles = parseFeed('not xml', 'Bad', 'https://bad.com/rss');
    assert.equal(articles.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/rss-curation/fetch.test.js`
Expected: FAIL — `fetch.mjs` does not exist.

- [ ] **Step 3: Implement fetch.mjs**

Create `skills/rss-curation/scripts/fetch.mjs`:

```js
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

function normalizeItems(parsed) {
  // RSS 2.0
  const channel = parsed?.rss?.channel;
  if (channel) {
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

  // Atom
  const feed = parsed?.feed;
  if (feed) {
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
  const { insertArticle } = await import('./db.mjs');
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
      // Skip feeds that fail — log but don't crash
      console.error(`Failed to fetch feed: ${feed.name} (${feed.url})`);
    }
  }

  return { total, new: newCount, articles: newArticles };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rss-curation/fetch.test.js`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/rss-curation/scripts/fetch.mjs \
       tests/rss-curation/fetch.test.js
git commit -m "feat(rss-curation): RSS/Atom feed fetching and parsing"
```

---

### Task 3: Search Module

**Files:**

- Create: `skills/rss-curation/scripts/search.mjs`
- Create: `tests/rss-curation/search.test.js`

**Interfaces:**

- Consumes: `db.mjs` — `openDb`, `insertArticle`, `searchArticles`
- Produces:
  - `formatSearchResults(results: Article[]): string` — formats search results as JSON for Claude to present
  - `runSearch(dbPath: string, query: string, limit?: number): string` — end-to-end: open DB, search, format, return

- [ ] **Step 1: Write failing tests**

Create `tests/rss-curation/search.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/db.mjs',
);
const SEARCH_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/search.mjs',
);

describe('search', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-search-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runSearch returns matching articles as JSON', async () => {
    const { openDb, insertArticle } = await import(`${DB_MOD}?t=${Date.now()}`);
    const { runSearch } = await import(`${SEARCH_MOD}?t=${Date.now()}`);
    const db = openDb(dbPath);
    insertArticle(db, {
      url: 'https://example.com/wasm',
      title: 'WebAssembly gets GC support',
      feedName: 'Chrome Blog',
      feedUrl: 'https://chrome.com/rss',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'WebAssembly garbage collection is shipping',
    });
    db.close();

    const output = runSearch(dbPath, 'WebAssembly');
    const parsed = JSON.parse(output);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].title, 'WebAssembly gets GC support');
    assert.equal(parsed.query, 'WebAssembly');
  });

  it('runSearch returns empty results for no matches', async () => {
    const { openDb } = await import(`${DB_MOD}?t=${Date.now()}`);
    const { runSearch } = await import(`${SEARCH_MOD}?t=${Date.now()}`);
    const db = openDb(dbPath);
    db.close();

    const output = runSearch(dbPath, 'nonexistent');
    const parsed = JSON.parse(output);
    assert.equal(parsed.results.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/rss-curation/search.test.js`
Expected: FAIL — `search.mjs` does not exist.

- [ ] **Step 3: Implement search.mjs**

Create `skills/rss-curation/scripts/search.mjs`:

```js
import { openDb, searchArticles } from './db.mjs';

export function formatSearchResults(results, query) {
  return JSON.stringify({
    query,
    count: results.length,
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      feedName: r.feed_name,
      publishedAt: r.published_at,
      summary: r.summary,
      score: r.score,
      tags: r.tags ? JSON.parse(r.tags) : [],
      feedback: r.feedback,
    })),
  }, null, 2);
}

export function runSearch(dbPath, query, limit = 20) {
  const db = openDb(dbPath);
  try {
    const results = searchArticles(db, query, limit);
    return formatSearchResults(results, query);
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rss-curation/search.test.js`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/rss-curation/scripts/search.mjs \
       tests/rss-curation/search.test.js
git commit -m "feat(rss-curation): FTS5 search module"
```

---

### Task 4: Feedback and Learn Module

**Files:**

- Create: `skills/rss-curation/scripts/feedback.mjs`
- Create: `tests/rss-curation/feedback.test.js`

**Interfaces:**

- Consumes: `db.mjs` — `openDb`, `recordFeedback`, `getFeedbackStats`; `js-yaml` for profile I/O
- Produces:
  - `applyFeedback(dbPath: string, url: string, signal: 'up'|'down'): string` — records feedback, returns confirmation JSON
  - `learnFromFeedback(dbPath: string, profilePath: string): string` — aggregates feedback patterns, updates profile, returns diff JSON

- [ ] **Step 1: Write failing tests**

Create `tests/rss-curation/feedback.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/db.mjs',
);
const FB_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/feedback.mjs',
);

describe('feedback', () => {
  let tmpDir;
  let dbPath;
  let profilePath;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-fb-'));
    dbPath = path.join(tmpDir, 'test.db');
    profilePath = path.join(tmpDir, 'profile.yaml');

    const { openDb, insertArticle, writeScores } = await import(
      `${DB_MOD}?t=${Date.now()}`
    );
    const db = openDb(dbPath);
    insertArticle(db, {
      url: 'https://example.com/ai-agents',
      title: 'Building AI Agents',
      feedName: 'AI Blog',
      feedUrl: 'https://ai.com/rss',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'How to build AI agents with tool use',
    });
    insertArticle(db, {
      url: 'https://example.com/crypto-hype',
      title: 'Top 10 Crypto Coins',
      feedName: 'Crypto Daily',
      feedUrl: 'https://crypto.com/rss',
      publishedAt: '2025-07-21T11:00:00Z',
      summary: 'The hottest crypto coins this week',
    });
    writeScores(db, [
      {
        url: 'https://example.com/ai-agents',
        score: 9.0,
        scoreReason: 'AI agents',
        tags: ['ai', 'agents'],
      },
      {
        url: 'https://example.com/crypto-hype',
        score: 2.0,
        scoreReason: 'crypto listicle',
        tags: ['crypto'],
      },
    ]);
    db.close();

    fs.writeFileSync(
      profilePath,
      'explicit:\n  interests:\n    - "AI agents"\n  anti-interests: []\n'
        + 'inferred:\n  sources: []\n  topics: []\n'
        + 'learned:\n  boost: []\n  suppress: []\n  examples:\n    liked: []\n    disliked: []\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applyFeedback records signal and returns confirmation', async () => {
    const { applyFeedback } = await import(`${FB_MOD}?t=${Date.now()}`);
    const output = applyFeedback(
      dbPath,
      'https://example.com/ai-agents',
      'up',
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.signal, 'up');
  });

  it('learnFromFeedback updates profile with patterns', async () => {
    const { applyFeedback, learnFromFeedback } = await import(
      `${FB_MOD}?t=${Date.now()}`
    );
    applyFeedback(dbPath, 'https://example.com/ai-agents', 'up');
    applyFeedback(dbPath, 'https://example.com/crypto-hype', 'down');

    const output = learnFromFeedback(dbPath, profilePath);
    const parsed = JSON.parse(output);
    assert.ok(parsed.learned);
    assert.ok(parsed.learned.examples.liked.length > 0);
    assert.ok(parsed.learned.examples.disliked.length > 0);

    // Profile file should be updated
    const profile = fs.readFileSync(profilePath, 'utf8');
    assert.ok(profile.includes('Building AI Agents'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/rss-curation/feedback.test.js`
Expected: FAIL — `feedback.mjs` does not exist.

- [ ] **Step 3: Implement feedback.mjs**

Create `skills/rss-curation/scripts/feedback.mjs`:

```js
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

function extractTopics(articles) {
  const tagCounts = {};
  for (const article of articles) {
    const tags = article.tags ? JSON.parse(article.tags) : [];
    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rss-curation/feedback.test.js`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/rss-curation/scripts/feedback.mjs \
       tests/rss-curation/feedback.test.js
git commit -m "feat(rss-curation): feedback recording and profile learning"
```

---

### Task 5: Digest Generation

**Files:**

- Create: `skills/rss-curation/scripts/digest.mjs`
- Create: `tests/rss-curation/digest.test.js`

**Interfaces:**

- Consumes: `db.mjs` — `openDb`, `getArticlesByDate`
- Produces:
  - `generateDigest(dbPath: string, date: string, options?: { minScore?: number, outDir?: string }): string` — generates markdown digest, writes to file, returns the markdown

- [ ] **Step 1: Write failing tests**

Create `tests/rss-curation/digest.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/db.mjs',
);
const DIGEST_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/digest.mjs',
);

describe('digest', () => {
  let tmpDir;
  let dbPath;
  let outDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-digest-'));
    dbPath = path.join(tmpDir, 'test.db');
    outDir = path.join(tmpDir, 'digests');

    const { openDb, insertArticle, writeScores } = await import(
      `${DB_MOD}?t=${Date.now()}`
    );
    const db = openDb(dbPath);
    insertArticle(db, {
      url: 'https://example.com/top',
      title: 'Top Pick Article',
      feedName: 'Tech Blog',
      feedUrl: 'https://tech.com/rss',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'This is a top article about AI agents',
    });
    insertArticle(db, {
      url: 'https://example.com/mid',
      title: 'Also Noted Article',
      feedName: 'Dev Blog',
      feedUrl: 'https://dev.com/rss',
      publishedAt: '2025-07-21T11:00:00Z',
      summary: 'A decent article about web perf',
    });
    insertArticle(db, {
      url: 'https://example.com/low',
      title: 'Low Score Noise',
      feedName: 'Spam Feed',
      feedUrl: 'https://spam.com/rss',
      publishedAt: '2025-07-21T12:00:00Z',
      summary: 'Not interesting',
    });
    writeScores(db, [
      {
        url: 'https://example.com/top',
        score: 9.2,
        scoreReason: 'Directly relevant AI agent architecture',
        tags: ['ai', 'agents'],
      },
      {
        url: 'https://example.com/mid',
        score: 6.5,
        scoreReason: 'Web performance topic',
        tags: ['web', 'performance'],
      },
      {
        url: 'https://example.com/low',
        score: 2.0,
        scoreReason: 'Spam content',
        tags: ['spam'],
      },
    ]);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates markdown with top picks and also noted sections', async () => {
    const { generateDigest } = await import(`${DIGEST_MOD}?t=${Date.now()}`);
    const md = generateDigest(dbPath, '2025-07-21', { outDir });

    assert.ok(md.includes('# RSS Digest'));
    assert.ok(md.includes('Top Pick Article'));
    assert.ok(md.includes('9.2'));
    assert.ok(md.includes('Also Noted'));
    assert.ok(md.includes('Also Noted Article'));
    // Low score should not appear
    assert.ok(!md.includes('Low Score Noise'));
  });

  it('writes digest file to outDir', async () => {
    const { generateDigest } = await import(`${DIGEST_MOD}?t=${Date.now()}`);
    generateDigest(dbPath, '2025-07-21', { outDir });

    const filePath = path.join(outDir, '2025-07-21.md');
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('Top Pick Article'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/rss-curation/digest.test.js`
Expected: FAIL — `digest.mjs` does not exist.

- [ ] **Step 3: Implement digest.mjs**

Create `skills/rss-curation/scripts/digest.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { openDb, getArticlesByDate } from './db.mjs';

const TOP_THRESHOLD = 7;
const DEFAULT_MIN_SCORE = 6;

function timeAgo(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderTopPick(article, index) {
  const tags = article.tags ? JSON.parse(article.tags) : [];
  return [
    `### #${index + 1} · ${article.title} (${article.score})`,
    `**Source:** ${article.feed_name} · ${timeAgo(article.published_at)}`,
    `**Why:** ${article.score_reason}`,
    tags.length ? `**Tags:** ${tags.join(', ')}` : '',
    `[Read →](${article.url})`,
    '',
  ].filter(Boolean).join('\n');
}

function renderAlsoNoted(article) {
  return `- **${article.title}** (${article.score}) — ${article.feed_name} · [link](${article.url}) · ${article.score_reason}`;
}

export function generateDigest(dbPath, date, options = {}) {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const outDir = options.outDir;
  const db = openDb(dbPath);

  try {
    const allScored = getArticlesByDate(db, date, minScore);
    const allTotal = getArticlesByDate(db, date);
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
      lines.push(`## Also Noted (score ${minScore}–${TOP_THRESHOLD - 0.1})`, '');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rss-curation/digest.test.js`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/rss-curation/scripts/digest.mjs \
       tests/rss-curation/digest.test.js
git commit -m "feat(rss-curation): markdown digest generation"
```

---

### Task 6: CLI Entry Point

**Files:**

- Create: `skills/rss-curation/scripts/rss-feed.mjs`
- Create: `tests/rss-curation/cli.test.js`

**Interfaces:**

- Consumes: `fetch.mjs` — `fetchFeeds`; `search.mjs` — `runSearch`; `feedback.mjs` — `applyFeedback`, `learnFromFeedback`; `digest.mjs` — `generateDigest`; `db.mjs` — `openDb`, `getUnscored`
- Produces: CLI entry point with subcommands: `fetch`, `search`, `feedback`, `digest`, `unscored`

- [ ] **Step 1: Write failing tests for CLI arg parsing**

Create `tests/rss-curation/cli.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/rss-feed.mjs',
);

describe('CLI', () => {
  it('exits with error when no subcommand given', () => {
    assert.throws(
      () => execFileSync('node', [SCRIPT], { encoding: 'utf8' }),
      (err) => {
        assert.ok(err.stderr.includes('Usage:'));
        return true;
      },
    );
  });

  it('exits with error for unknown subcommand', () => {
    assert.throws(
      () => execFileSync('node', [SCRIPT, 'bogus'], { encoding: 'utf8' }),
      (err) => {
        assert.ok(err.stderr.includes('Unknown subcommand'));
        return true;
      },
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/rss-curation/cli.test.js`
Expected: FAIL — `rss-feed.mjs` does not exist.

- [ ] **Step 3: Implement rss-feed.mjs**

Create `skills/rss-curation/scripts/rss-feed.mjs`:

```js
#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetchFeeds } from './fetch.mjs';
import { openDb, getUnscored } from './db.mjs';
import { runSearch } from './search.mjs';
import { applyFeedback, learnFromFeedback } from './feedback.mjs';
import { generateDigest } from './digest.mjs';

function die(msg) {
  const usage = [
    'Usage: rss-feed.mjs <subcommand> [options]',
    '',
    'Subcommands:',
    '  fetch      --config <path> --db <path>',
    '  unscored   --db <path>',
    '  digest     --db <path> --date <YYYY-MM-DD> [--out <dir>] [--min-score <n>]',
    '  search     --db <path> --query <text> [--limit <n>]',
    '  feedback   --db <path> --url <url> --signal <up|down>',
    '  learn      --db <path> --profile <path>',
  ];
  console.error(`${msg}\n\n${usage.join('\n')}`);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  const args = argv.slice(2);
  flags.subcommand = args[0];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i]
        .slice(2)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = args[i + 1] || true;
      i++;
    }
  }
  return flags;
}

function requireFlag(flags, name) {
  if (!flags[name]) die(`Missing required flag: --${name}`);
  return flags[name];
}

const COMMANDS = {
  async fetch(flags) {
    const configPath = requireFlag(flags, 'config');
    const dbPath = requireFlag(flags, 'db');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    const db = openDb(dbPath);
    try {
      const result = await fetchFeeds(config, db);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      db.close();
    }
  },

  async unscored(flags) {
    const dbPath = requireFlag(flags, 'db');
    const db = openDb(dbPath);
    try {
      const articles = getUnscored(db);
      console.log(JSON.stringify(articles, null, 2));
    } finally {
      db.close();
    }
  },

  async digest(flags) {
    const dbPath = requireFlag(flags, 'db');
    const date = flags.date || new Date().toISOString().slice(0, 10);
    const outDir = flags.out;
    const minScore = flags.minScore ? Number(flags.minScore) : undefined;
    const md = generateDigest(dbPath, date, { outDir, minScore });
    console.log(md);
  },

  async search(flags) {
    const dbPath = requireFlag(flags, 'db');
    const query = requireFlag(flags, 'query');
    const limit = flags.limit ? Number(flags.limit) : 20;
    console.log(runSearch(dbPath, query, limit));
  },

  async feedback(flags) {
    const dbPath = requireFlag(flags, 'db');
    const url = requireFlag(flags, 'url');
    const signal = requireFlag(flags, 'signal');
    if (signal !== 'up' && signal !== 'down') {
      die('--signal must be "up" or "down"');
    }
    console.log(applyFeedback(dbPath, url, signal));
  },

  async learn(flags) {
    const dbPath = requireFlag(flags, 'db');
    const profilePath = requireFlag(flags, 'profile');
    console.log(learnFromFeedback(dbPath, profilePath));
  },
};

async function main() {
  const flags = parseFlags(process.argv);
  if (!flags.subcommand) die('No subcommand provided.');
  const cmd = COMMANDS[flags.subcommand];
  if (!cmd) die(`Unknown subcommand: ${flags.subcommand}`);
  await cmd(flags);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rss-curation/cli.test.js`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/rss-curation/scripts/rss-feed.mjs \
       tests/rss-curation/cli.test.js
git commit -m "feat(rss-curation): CLI entry point with subcommand dispatch"
```

---

### Task 7: SKILL.md, Default Config, and tile.json

**Files:**

- Create: `skills/rss-curation/SKILL.md`
- Create: `skills/rss-curation/tile.json`
- Create: `skills/rss-curation/references/default-config.yaml`
- Create: `skills/rss-curation/references/default-profile.yaml`

**Interfaces:**

- Consumes: all scripts from Tasks 1-6
- Produces: the skill prompt that teaches Claude how to orchestrate the pipeline

- [ ] **Step 1: Create default-config.yaml**

Create `skills/rss-curation/references/default-config.yaml`:

```yaml
feeds:
  # Add your RSS/Atom feed URLs here
  # - name: Hacker News
  #   url: https://hnrss.org/frontpage
  # - name: Simon Willison
  #   url: https://simonwillison.net/atom/everything/
  # - name: Chrome Blog
  #   url: https://developer.chrome.com/blog/rss.xml

settings:
  min_score: 6
  schedule: "0 7 * * *"   # daily at 7 AM

data_dir: ~/repos/gc/catalan/notes/rss
```

- [ ] **Step 2: Create default-profile.yaml**

Create `skills/rss-curation/references/default-profile.yaml`:

```yaml
explicit:
  interests: []
    # Add topics you care about:
    # - "AI agents and coding assistants"
    # - "Web performance and browser APIs"
  anti-interests: []
    # Add topics you want to suppress:
    # - "Cryptocurrency and blockchain"

inferred:
  sources: []
  topics: []

learned:
  boost: []
  suppress: []
  examples:
    liked: []
    disliked: []
```

- [ ] **Step 3: Create tile.json**

Create `skills/rss-curation/tile.json`:

```json
{
  "name": "catalan-adobe/rss-curation",
  "version": "0.1.0",
  "private": false,
  "summary": "Follow RSS feeds and curate them with LLM-scored relevance. Builds a searchable knowledge base of tech articles, produces ranked daily digests, and learns your interests from feedback over time.",
  "skills": {
    "rss-curation": {
      "path": "SKILL.md"
    }
  }
}
```

- [ ] **Step 4: Create SKILL.md**

Create `skills/rss-curation/SKILL.md`. This is the skill prompt — it must
cover all 4 modes (digest, search, feedback, learn) and the first-run setup.
Keep under 500 lines. See the detailed content below.

The SKILL.md should include:

1. **Frontmatter** — name, description, triggers
2. **Script Location** — `${CLAUDE_SKILL_DIR}/scripts` with fallback
3. **First-Run Setup** — npm install, config creation, profile bootstrap
4. **Mode: Digest** — fetch → present unscored to Claude for scoring → write scores → generate digest
5. **Mode: Search** — run FTS5 search, present results
6. **Mode: Feedback** — record up/down signals by URL or digest article ID
7. **Mode: Learn** — aggregate feedback into profile, show diff
8. **Scoring Prompt** — the exact prompt template Claude uses to score articles, including how to read the profile
9. **Data paths** — where config, profile, DB, and digests live

The scoring section is critical. It should instruct Claude to:

- Read the profile.yaml
- Receive the batch of unscored articles as JSON
- For each article, return: `{ url, score (0-10), scoreReason, tags: string[] }`
- Use the profile layers with explicit > inferred > learned priority

- [ ] **Step 5: Commit**

```bash
git add skills/rss-curation/SKILL.md \
       skills/rss-curation/tile.json \
       skills/rss-curation/references/default-config.yaml \
       skills/rss-curation/references/default-profile.yaml
git commit -m "feat(rss-curation): SKILL.md, tile.json, and default configs"
```

---

### Task 8: Setup Subcommand and Launchd Plist

**Files:**

- Create: `skills/rss-curation/scripts/setup.mjs`
- Modify: `skills/rss-curation/scripts/rss-feed.mjs` — add `setup` subcommand
- Create: `tests/rss-curation/setup.test.js`

**Interfaces:**

- Consumes: `db.mjs` — `openDb`; `js-yaml` for config/profile creation
- Produces:
  - `initDataDir(dataDir: string, configTemplatePath: string, profileTemplatePath: string): { configPath, profilePath, dbPath }` — creates data directory, copies default configs
  - `generateLaunchdPlist(scriptPath: string, configPath: string, dbPath: string, schedule: string): string` — returns plist XML

- [ ] **Step 1: Write failing tests**

Create `tests/rss-curation/setup.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETUP_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/setup.mjs',
);

const REFS = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/references',
);

describe('setup', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-setup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initDataDir creates directory structure with config and profile', async () => {
    const { initDataDir } = await import(`${SETUP_MOD}?t=${Date.now()}`);
    const dataDir = path.join(tmpDir, 'rss');
    const result = initDataDir(
      dataDir,
      path.join(REFS, 'default-config.yaml'),
      path.join(REFS, 'default-profile.yaml'),
    );

    assert.ok(fs.existsSync(result.configPath));
    assert.ok(fs.existsSync(result.profilePath));
    assert.ok(fs.existsSync(result.dbPath));
    assert.ok(fs.existsSync(path.join(dataDir, 'digests')));
  });

  it('generateLaunchdPlist returns valid plist XML', async () => {
    const { generateLaunchdPlist } = await import(
      `${SETUP_MOD}?t=${Date.now()}`
    );
    const plist = generateLaunchdPlist(
      '/path/to/rss-feed.mjs',
      '/path/to/config.yaml',
      '/path/to/feeds.db',
      '0 7 * * *',
    );

    assert.ok(plist.includes('<!DOCTYPE plist'));
    assert.ok(plist.includes('rss-feed.mjs'));
    assert.ok(plist.includes('<key>Hour</key>'));
    assert.ok(plist.includes('<integer>7</integer>'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/rss-curation/setup.test.js`
Expected: FAIL — `setup.mjs` does not exist.

- [ ] **Step 3: Implement setup.mjs**

Create `skills/rss-curation/scripts/setup.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';

export function initDataDir(dataDir, configTemplate, profileTemplate) {
  fs.mkdirSync(path.join(dataDir, 'digests'), { recursive: true });

  const configPath = path.join(dataDir, 'config.yaml');
  const profilePath = path.join(dataDir, 'profile.yaml');
  const dbPath = path.join(dataDir, 'feeds.db');

  if (!fs.existsSync(configPath)) {
    fs.copyFileSync(configTemplate, configPath);
  }
  if (!fs.existsSync(profilePath)) {
    fs.copyFileSync(profileTemplate, profilePath);
  }

  // Initialize DB schema
  const db = openDb(dbPath);
  db.close();

  return { configPath, profilePath, dbPath };
}

export function generateLaunchdPlist(scriptPath, configPath, dbPath, schedule) {
  const parts = parseCron(schedule);
  const label = 'com.catalan.rss-curation';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${scriptPath}</string>
    <string>fetch</string>
    <string>--config</string>
    <string>${configPath}</string>
    <string>--db</string>
    <string>${dbPath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${parts.hour}</integer>
    <key>Minute</key>
    <integer>${parts.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/rss-curation.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/rss-curation.err</string>
</dict>
</plist>`;
}

function parseCron(schedule) {
  const [minute, hour] = schedule.split(' ');
  return {
    minute: Number(minute) || 0,
    hour: Number(hour) || 7,
  };
}
```

- [ ] **Step 4: Wire setup into rss-feed.mjs**

Add the `setup` import and command to `skills/rss-curation/scripts/rss-feed.mjs`:

Add to imports:

```js
import { initDataDir, generateLaunchdPlist } from './setup.mjs';
```

Add to COMMANDS object:

```js
  async setup(flags) {
    const dataDir = requireFlag(flags, 'dataDir');
    const refsDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../references',
    );
    const result = initDataDir(
      dataDir,
      path.join(refsDir, 'default-config.yaml'),
      path.join(refsDir, 'default-profile.yaml'),
    );
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  },
```

Update the usage in `die()` to include `setup`:

```
'  setup      --data-dir <path>',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/rss-curation/setup.test.js`
Expected: All 2 tests PASS.

- [ ] **Step 6: Run all tests**

Run: `node --test tests/rss-curation/*.test.js`
Expected: All tests PASS across all test files.

- [ ] **Step 7: Commit**

```bash
git add skills/rss-curation/scripts/setup.mjs \
       skills/rss-curation/scripts/rss-feed.mjs \
       tests/rss-curation/setup.test.js
git commit -m "feat(rss-curation): setup subcommand with launchd plist generation"
```

---

### Task 9: Integration Test and README Update

**Files:**

- Create: `tests/rss-curation/integration.test.js`
- Modify: `README.md` — add rss-curation section

**Interfaces:**

- Consumes: all modules
- Produces: end-to-end test proving fetch → store → search → feedback flow works

- [ ] **Step 1: Write integration test**

Create `tests/rss-curation/integration.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/db.mjs',
);
const FETCH_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/fetch.mjs',
);
const SEARCH_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/search.mjs',
);
const FB_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/feedback.mjs',
);
const DIGEST_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/digest.mjs',
);

describe('integration: full pipeline', () => {
  let tmpDir;
  let dbPath;
  let profilePath;
  let outDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-int-'));
    dbPath = path.join(tmpDir, 'test.db');
    profilePath = path.join(tmpDir, 'profile.yaml');
    outDir = path.join(tmpDir, 'digests');

    fs.writeFileSync(
      profilePath,
      'explicit:\n  interests: ["AI"]\n  anti-interests: []\n'
        + 'inferred:\n  sources: []\n  topics: []\n'
        + 'learned:\n  boost: []\n  suppress: []\n  examples:\n    liked: []\n    disliked: []\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores articles, scores, searches, gives feedback, generates digest', async () => {
    const { openDb, insertArticle, writeScores } = await import(
      `${DB_MOD}?t=${Date.now()}`
    );
    const { runSearch } = await import(`${SEARCH_MOD}?t=${Date.now()}`);
    const { applyFeedback, learnFromFeedback } = await import(
      `${FB_MOD}?t=${Date.now()}`
    );
    const { generateDigest } = await import(`${DIGEST_MOD}?t=${Date.now()}`);

    // 1. Store articles
    const db = openDb(dbPath);
    insertArticle(db, {
      url: 'https://example.com/ai-post',
      title: 'AI Agent Patterns',
      feedName: 'AI Weekly',
      feedUrl: 'https://ai.com/rss',
      publishedAt: '2025-07-21T10:00:00Z',
      summary: 'Practical patterns for building AI agents',
    });
    insertArticle(db, {
      url: 'https://example.com/css-post',
      title: 'CSS Container Queries',
      feedName: 'CSS Tricks',
      feedUrl: 'https://css.com/rss',
      publishedAt: '2025-07-21T11:00:00Z',
      summary: 'Container queries are now baseline',
    });

    // 2. Score them
    writeScores(db, [
      {
        url: 'https://example.com/ai-post',
        score: 9.0,
        scoreReason: 'AI agent architecture',
        tags: ['ai', 'agents'],
      },
      {
        url: 'https://example.com/css-post',
        score: 7.5,
        scoreReason: 'CSS advancement',
        tags: ['css', 'web'],
      },
    ]);
    db.close();

    // 3. Search
    const searchResult = JSON.parse(runSearch(dbPath, 'AI'));
    assert.ok(searchResult.results.length >= 1);

    // 4. Feedback
    applyFeedback(dbPath, 'https://example.com/ai-post', 'up');
    const learnResult = JSON.parse(learnFromFeedback(dbPath, profilePath));
    assert.ok(learnResult.learned.examples.liked.length > 0);

    // 5. Digest
    const md = generateDigest(dbPath, '2025-07-21', { outDir });
    assert.ok(md.includes('AI Agent Patterns'));
    assert.ok(md.includes('CSS Container Queries'));
    assert.ok(fs.existsSync(path.join(outDir, '2025-07-21.md')));
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `node --test tests/rss-curation/integration.test.js`
Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `node --test tests/rss-curation/*.test.js`
Expected: All tests PASS.

- [ ] **Step 4: Add rss-curation section to README.md**

Add after the last skill entry in `README.md`:

```markdown
### rss-curation

Follow RSS feeds and curate them with LLM-scored relevance. Builds a
searchable SQLite knowledge base of articles, produces ranked daily
digests, and learns your interests from feedback over time. Three-layer
interest profile: explicit interests, inferred from your environment,
and learned from thumbs-up/down feedback.

**Dependencies:** Node 22+, better-sqlite3

See [SKILL.md](skills/rss-curation/SKILL.md) for details.
```

- [ ] **Step 5: Commit**

```bash
git add tests/rss-curation/integration.test.js README.md
git commit -m "feat(rss-curation): integration test and README entry"
```

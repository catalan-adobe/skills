import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @param {string} s */
function parseJSON(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`Invalid JSON output: ${e.message}`);
  }
}

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
    const parsed = parseJSON(output);
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
    const parsed = parseJSON(output);
    assert.equal(parsed.results.length, 0);
  });
});

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fromList, mergeScan, normalise, readInventory, recordVisit, writeInventory,
} from './inventory.mjs';

const scanned = (...urls) => urls.map((url) => ({
  url, origin: 'https://x.example', status: 'valid', level1: '', level2: '', level3: '',
  filename: '', search: '', lang: '', message: '',
}));
const now = () => '2026-01-01T00:00:00.000Z';

test('mergeScan adds new URLs with a group, keeps enrichment, marks the vanished', () => {
  const A = 'https://x.example/en/a/1.html';
  const B = 'https://x.example/en/b/1.html';
  const C = 'https://x.example/en/c/1.html';
  const first = mergeScan([], scanned(A, B), { now });
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((r) => r.group), ['a', 'b']);
  assert.ok(first.every((r) => r.inLastScan === true && r.firstSeen === now()));
  const enriched = first.map((r) => (r.url === A ? { ...r, kind: 'page', cache: { at: 'x' } } : r));
  const second = mergeScan(enriched, scanned(A, C), { now: () => '2026-02-01T00:00:00.000Z' });
  const a = second.find((r) => r.url.includes('/a/'));
  const b = second.find((r) => r.url.includes('/b/'));
  const c = second.find((r) => r.url.includes('/c/'));
  assert.equal(a.kind, 'page', 'enrichment survives a re-scan');
  assert.deepEqual(a.cache, { at: 'x' });
  assert.equal(a.inLastScan, true);
  assert.equal(b.inLastScan, false, 'gone from the crawl, kept in the inventory');
  assert.equal(c.inLastScan, true);
  assert.equal(c.firstSeen, '2026-02-01T00:00:00.000Z');
  assert.equal(second.length, 3);
});

test('fromList turns operator lines into scan entries; blanks and duplicates dropped', () => {
  const P = 'https://x.example/en/p.html';
  const entries = fromList(`${P}\n\n${P}\nnot a url\n`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, 'https://x.example/en/p.html');
  assert.equal(entries[0].level1, 'en');
  assert.equal(entries[0].filename, 'p.html');
  assert.equal(entries[0].message, 'operator-provided list');
});

test('recordVisit merges cache facts into the record and adds unknown URLs as discovered', () => {
  const inventory = mergeScan([], scanned('https://x.example/en/a/1.html'), { now });
  const target = 'https://x.example/en/a/2.html';
  const facts = {
    http: { status: 301, contentType: 'text/html' },
    redirect: { status: 301, target, chain: [], targetInList: false },
    kind: 'redirect',
    migrate: 'target',
    cache: { at: 'y', selection: 's', path: 'p', durationMs: 5 },
  };
  const after = recordVisit(inventory, 'https://x.example/en/a/1.html', facts);
  assert.equal(after[0].kind, 'redirect');
  assert.equal(after[0].redirect.target, target);
  assert.equal(after[0].inLastScan, true, 'scan fields untouched');
  const Z = 'https://x.example/en/z.html';
  const withNew = recordVisit(after, Z, { kind: 'page', migrate: 'yes' });
  const z = withNew.find((r) => r.url.endsWith('/z.html'));
  assert.equal(z.inLastScan, false);
  assert.equal(z.discovered, 'cache');
});

test('read/write round-trip on disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cpv2-inv-'));
  assert.deepEqual(await readInventory(dir), []);
  await writeInventory(dir, mergeScan([], scanned('https://x.example/'), { now }));
  const back = await readInventory(dir);
  assert.equal(back[0].url, 'https://x.example/');
  await writeFile(path.join(dir, 'urls.json'), 'not json');
  await assert.rejects(() => readInventory(dir), /urls\.json is not valid JSON/);
  assert.match(await readFile(path.join(dir, 'urls.json'), 'utf8'), /not json/);
});

test('normalise upgrades a bare crawl result once and leaves an inventory alone', () => {
  const bare = scanned('https://x.example/en/a/1.html', 'https://x.example/en/b/1.html');
  const upgraded = normalise(bare, { now });
  assert.deepEqual(upgraded.map((r) => [r.group, r.inLastScan, r.firstSeen]),
    [['a', true, now()], ['b', true, now()]]);
  assert.strictEqual(normalise(upgraded), upgraded);
});

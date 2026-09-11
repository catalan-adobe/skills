import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths } from './paths.mjs';
import { createClient } from './http.mjs';
import { listRecords, upsertRecords } from './state.mjs';
import { classifyStatic, runInventory } from './inventory.mjs';

const execFileP = promisify(execFile);
const inventoryCli = fileURLToPath(new URL('./inventory.mjs', import.meta.url));

let server;
let base;

const sitemapEntry = (loc) => `<sitemap><loc>${loc}</loc></sitemap>`;
const urlEntry = (loc, extra = '') => `<url><loc>${loc}</loc>${extra}</url>`;

const wrap = (tag, parts) => `<${tag}>${parts.join('')}</${tag}>`;

const routes = (host) => ({
  '/sitemap_index.xml': wrap('sitemapindex', [
    sitemapEntry(`${host}/post-sitemap.xml`),
    sitemapEntry(`${host}/page-sitemap.xml`),
  ]),
  '/post-sitemap.xml': wrap('urlset', [
    urlEntry(`${host}/blog/one/`, '<lastmod>2026-01-02</lastmod>'),
    urlEntry(`${host}/blog/gone/`),
  ]),
  '/page-sitemap.xml': wrap('urlset', [
    urlEntry(`${host}/`),
    urlEntry(`${host}/?pricing=starter`),
    urlEntry(`${host}/app-category/x/`),
    urlEntry(`${host}/moved/`),
    urlEntry(`${host}/partner/`),
  ]),
});

before(async () => {
  server = http.createServer((req, res) => {
    const table = routes(base);
    if (table[req.url]) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(table[req.url]);
      return;
    }
    if (req.url === '/boom-sitemap.xml') { res.writeHead(500); res.end(); return; }
    if (req.url === '/blog/gone/') { res.writeHead(404); res.end(); return; }
    if (req.url === '/moved/') { res.writeHead(301, { location: '/' }); res.end(); return; }
    if (req.url === '/partner/') {
      res.writeHead(302, { location: 'https://partner.invalid/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>');
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const config = () => ({
  origin: base,
  sitemapIndex: `${base}/sitemap_index.xml`,
  exclusions: { queryStrings: true, pathPatterns: ['^/app-category/'], sitemapTypes: {} },
  concurrency: { fetch: 2 },
  rateLimit: { requestsPerSecond: 1000 },
  templateSeeds: { post: 'blog-post', page: 'page' },
});

test(
  'classifyStatic applies query-string, path and sitemap-type exclusions',
  () => {
    const ex = {
      queryStrings: true,
      pathPatterns: ['^/tag/'],
      sitemapTypes: { pricing: 'modal-deeplink' },
    };
    assert.deepEqual(
      classifyStatic(
        { url: 'https://x.test/a?b=1', path: '/a?b=1', sitemapType: 'page' },
        ex
      ),
      { reason: 'query-string' }
    );
    assert.deepEqual(
      classifyStatic(
        {
          url: 'https://x.test/tag/z',
          path: '/tag/z',
          sitemapType: 'post_tag',
        },
        ex
      ),
      { reason: 'path-pattern' }
    );
    assert.deepEqual(
      classifyStatic(
        { url: 'https://x.test/p', path: '/p', sitemapType: 'pricing' },
        ex
      ),
      { reason: 'modal-deeplink' }
    );
    assert.equal(
      classifyStatic(
        { url: 'https://x.test/p', path: '/p', sitemapType: 'page' },
        ex
      ),
      null
    );
  }
);

test('include patterns exclude everything else', () => {
  const rec = {
    url: 'https://example.com/fr/x',
    path: '/fr/x',
    sitemapType: 'corporate',
  };
  assert.deepEqual(
    classifyStatic(rec, {}, ['^/de/corporate/']),
    { reason: 'not-included' }
  );
  assert.equal(
    classifyStatic(
      { ...rec, path: '/de/corporate/x' },
      {},
      ['^/de/corporate/']
    ),
    null
  );
});

test('runInventory writes urls.json with exclusions, probes and redirect targets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-inventory-'));
  const paths = resolvePaths({ MIGRATION_DATA_DIR: dir, MIGRATION_PROJECT_DIR: dir });
  const client = createClient({ requestsPerSecond: 1000 });
  const summary = await runInventory({ config: config(), client, paths });
  const rows = Object.fromEntries((await listRecords('urls', { paths })).map((r) => [r.path, r]));
  assert.equal(summary.total, 7);
  assert.equal(rows['/blog/one/'].status, 'todo');
  assert.equal(rows['/blog/one/'].template, 'blog-post');
  assert.equal(rows['/blog/one/'].httpStatus, 200);
  assert.equal(rows['/blog/one/'].lastmod, '2026-01-02');
  assert.deepEqual(rows['/blog/gone/'].excluded, { reason: 'http-404' });
  assert.deepEqual(rows['/?pricing=starter'].excluded, { reason: 'query-string' });
  assert.deepEqual(rows['/app-category/x/'].excluded, { reason: 'path-pattern' });
  assert.deepEqual(rows['/moved/'].excluded, { reason: 'internal-redirect' });
  assert.equal(rows['/moved/'].redirectTo, `${base}/`);
  assert.deepEqual(rows['/partner/'].excluded, { reason: 'external-redirect' });
  assert.equal(rows['/partner/'].redirectTo, 'https://partner.invalid/');
  assert.deepEqual(summary.excludedByReason, {
    'external-redirect': 1,
    'http-404': 1,
    'internal-redirect': 1,
    'path-pattern': 1,
    'query-string': 1,
  });
});

test('a sitemap index that errors fails the run with the HTTP status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-inventory-'));
  const paths = resolvePaths({ MIGRATION_DATA_DIR: dir, MIGRATION_PROJECT_DIR: dir });
  const client = createClient({
    requestsPerSecond: 1000, retries: 1, sleep: async () => {},
  });
  await assert.rejects(
    runInventory({
      config: { ...config(), sitemapIndex: `${base}/boom-sitemap.xml` },
      client,
      paths,
      probe: false,
    }),
    /returned HTTP 500/,
  );
});

test('a probe failure is recorded on the record and counted in the summary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-inventory-'));
  const paths = resolvePaths({ MIGRATION_DATA_DIR: dir, MIGRATION_PROJECT_DIR: dir });
  const inner = createClient({ requestsPerSecond: 1000 });
  const client = {
    get: inner.get,
    probe: async (url) => {
      if (url.endsWith('/blog/one/')) throw new Error('probe exploded');
      return inner.probe(url);
    },
  };
  const summary = await runInventory({ config: config(), client, paths });
  assert.equal(summary.probeErrors, 1);
  const [row] = await listRecords('urls', { where: { path: '/blog/one/' }, paths });
  assert.match(row.probeError, /probe exploded/);
});

test('re-running preserves templates refined by later stages', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-inventory-'));
  const paths = resolvePaths({ MIGRATION_DATA_DIR: dir, MIGRATION_PROJECT_DIR: dir });
  const client = createClient({ requestsPerSecond: 1000 });
  await runInventory({
    config: config(), client, paths, probe: false,
  });
  await upsertRecords('urls', [{
    url: `${base}/blog/one/`, template: 'blog-post-2', fingerprint: 'h|x',
  }], paths);
  await runInventory({
    config: config(), client, paths, probe: false,
  });
  const [row] = await listRecords('urls', { where: { path: '/blog/one/' }, paths });
  assert.equal(row.template, 'blog-post-2');
  assert.equal(row.fingerprint, 'h|x');
});

test('a failing child sitemap is recorded and the others are inventoried', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-inventory-'));
  const paths = resolvePaths({ MIGRATION_DATA_DIR: dir, MIGRATION_PROJECT_DIR: dir });
  const pages = {
    'https://example.com/sitemapindex.xml': '<sitemapindex><sitemap><loc>https://example.com/a.xml'
      + '</loc></sitemap><sitemap><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>',
    'https://example.com/a.xml': '<urlset><url><loc>https://example.com/x</loc></url></urlset>',
  };
  const client = {
    get: async (url) => (pages[url]
      ? { url, status: 200, body: pages[url], finalUrl: url }
      : { url, status: 500, body: '', finalUrl: url }),
  };
  const cfg = config();
  const testConfig = {
    ...cfg,
    sitemapIndex: 'https://example.com/sitemapindex.xml',
  };
  const summary = await runInventory({
    config: testConfig,
    client,
    paths,
    probe: false,
  });
  assert.equal(summary.total, 1);
  assert.equal(summary.sitemaps.total, 2);
  assert.deepEqual(
    summary.sitemaps.failed.map((f) => f.url),
    ['https://example.com/b.xml']
  );
  assert.match(summary.sitemaps.failed[0].error, /HTTP 500/);
});

test('CLI with no arguments exits 1 with config requirement', async () => {
  const result = await execFileP(process.execPath, [inventoryCli], {})
    .catch((e) => e);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /site\.config\.json/);
});

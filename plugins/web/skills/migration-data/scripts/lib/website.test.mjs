import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { write as writeComposition } from './composition.mjs';
import { init } from './migration.mjs';
import { pageId, upsert } from './pages.mjs';
import { classOf } from './schema.mjs';
import {
  ACCESS_SCHEMA, CHROME_SCHEMA, WEBSITE_SCHEMA, chromeId, pagesWith, readAccess, readChrome,
  readWebsite, refresh, writeAccess, writeChrome,
} from './website.mjs';

const ORIGIN = 'https://a.example/';
const AT = '2026-09-22T10:00:00.000Z';
const found = (url, extra = {}) => (
  { url, discovered: { from: 'sitemap', at: AT, source: 'sitemap.xml' }, ...extra });
const fresh = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-site-'));
  await init(cwd, { origin: ORIGIN });
  return cwd;
};

test('website.json is a summary of the table: discovery, counts, groups in scope', async () => {
  const cwd = await fresh();
  assert.equal(classOf(WEBSITE_SCHEMA), 'derived');
  assert.equal(await readWebsite(cwd), null);
  await upsert(cwd, [
    found(`${ORIGIN}`, { kind: 'page', cache: { at: AT, path: 'h/index.html', selection: 's' } }),
    found(`${ORIGIN}blogs/a`, { kind: 'page' }), found(`${ORIGIN}blogs/b`, { kind: 'binary' }),
    { url: `${ORIGIN}docs/c`, discovered: { from: 'crawl', at: AT } },
    found('https://other.example/x'),
  ]);
  const site = await refresh(cwd);
  assert.deepEqual(site.source, { origin: ORIGIN, scope: ORIGIN });
  assert.deepEqual(site.discovery,
    [{ from: 'sitemap', source: 'sitemap.xml', urls: 4 }, { from: 'crawl', urls: 1 }]);
  assert.deepEqual(site.counts,
    { urls: 5, inScope: 4, in: 3, out: 2, undecided: 0, cached: 1, composed: 0 });
  assert.deepEqual(site.groups, [
    { name: 'blogs', urls: 2, in: 1, cached: 0, composed: 0 },
    { name: '', urls: 1, in: 1, cached: 1, composed: 0 },
    { name: 'docs', urls: 1, in: 1, cached: 0, composed: 0 },
  ], 'largest first, the off-scope page in no group');
  assert.equal(site.summary, `${ORIGIN}: 4 URLs in scope (5 known) in 3 groups; 3 in, 2 out, `
    + '0 undecided; 1 cached, 0 composed.');
  assert.deepEqual(await readWebsite(cwd), site);
});

test('access.json: one decision on how to open a page', async () => {
  const cwd = await fresh();
  assert.equal(classOf(ACCESS_SCHEMA), 'decision');
  await assert.rejects(writeAccess(cwd, { browser: {} }), /\$\.browser\.engine: required/);
  await assert.rejects(writeAccess(cwd, { browser: { engine: 'chromium' },
    overlays: [{ selector: '#cmp', action: 'nuke' }] }), /action: must be one of "hide"/);
  const a = await writeAccess(cwd, {
    browser: { engine: 'chromium', headless: true, headers: { 'accept-language': 'en' } },
    overlays: [{ selector: '#onetrust-banner-sdk', action: 'click', note: 'accept button' },
      { selector: '#chat', action: 'hide', css: ['#chat { display: none !important }'] }],
    scrollFix: 'html, body { overflow: auto !important }',
    verifiedOn: ['pag-000000000001', 'pag-000000000001', 'pag-000000000002'],
  });
  assert.equal(a.browser.headers['accept-language'], 'en', 'the probe\'s findings pass through');
  assert.deepEqual(a.verifiedOn, ['pag-000000000001', 'pag-000000000002']);
  assert.equal(a.summary, 'chromium; 2 overlay rule(s); verified on 2 page(s)');
  assert.deepEqual(await readAccess(cwd), a);
});

test('chrome.json defines variants; which pages carry one is a query over the table', async () => {
  const cwd = await fresh();
  assert.equal(classOf(CHROME_SCHEMA), 'derived');
  await upsert(cwd, [found(`${ORIGIN}a`, { kind: 'page' }), found(`${ORIGIN}b`, { kind: 'page' })]);
  const header = chromeId('header', ['#utility-nav-bar']);
  const footer = chromeId('footer', ['body > footer']);
  const c = await writeChrome(cwd, {
    method: { name: 'visual-tree', at: AT },
    variants: [
      { part: 'header', label: 'utility bar', selectors: ['#utility-nav-bar'], optional: [],
        pages: 2 },
      { part: 'footer', selectors: ['body > footer'], optional: ['body > footer > .legal'],
        pages: 1, evidence: ['website/chrome/footer.png'] },
      { id: 'chr-aaaaaaaaaaaa', part: 'subnav', selectors: ['nav.sub'], optional: [], pages: 1 },
    ],
    rejected: [{ selector: '#banner', reason: 'support 45 % is under the line' }],
  });
  assert.deepEqual(c.variants.map((v) => v.id), [header, footer, 'chr-aaaaaaaaaaaa'],
    'ids from part and first selector; a given id kept');
  assert.equal(c.summary,
    '3 chrome variant(s) over header, footer, subnav; 1 candidate(s) rejected');
  assert.deepEqual(await readChrome(cwd), c);
  await assert.rejects(writeChrome(cwd, { method: { name: 'x', at: AT },
    variants: [{ part: 'Header', selectors: ['x'], optional: [], pages: 0 }] }),
  /part: must match/);
  const comp = (chrome) => (
    { method: { name: 'visual-tree', at: AT }, chrome, sections: [], omitted: [] });
  await writeComposition(cwd, pageId(`${ORIGIN}a`),
    comp([{ ref: header, selector: '#utility-nav-bar' }, { ref: footer, selector: 'footer' }]));
  await writeComposition(cwd, pageId(`${ORIGIN}b`),
    comp([{ ref: header, selector: '#utility-nav-bar' }]));
  assert.deepEqual((await pagesWith(cwd, header)).map((p) => p.url), [`${ORIGIN}a`, `${ORIGIN}b`]);
  assert.deepEqual((await pagesWith(cwd, footer)).map((p) => p.url), [`${ORIGIN}a`]);
  assert.deepEqual(await pagesWith(cwd, 'chr-aaaaaaaaaaaa'), []);
});

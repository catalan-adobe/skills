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
  ACCESS_SCHEMA, FRAGMENTS_SCHEMA, PLACEMENTS, WEBSITE_SCHEMA, addOverlay, fragmentId,
  pagesUsing, readAccess, readFragments, readWebsite, refresh, writeAccess, writeFragments,
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
  // Composed means read into sections: a composition of template fragments only is not.
  const home = pageId(`${ORIGIN}`);
  const method = { name: 'visual-tree', at: AT };
  await writeComposition(cwd, home, { method, fragments: [], sections: [], omitted: [] });
  assert.equal((await refresh(cwd)).counts.composed, 0);
  await writeComposition(cwd, home, { method, fragments: [], omitted: [],
    sections: [{ id: 's1', selector: 'main', items: [] }] });
  assert.equal((await refresh(cwd)).counts.composed, 1);
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
  // An agent saw a chat widget in a capture: one rule added, nothing else touched.
  const added = await addOverlay(cwd, { selector: '#chat-bar', action: 'hide',
    note: 'floating chat widget over the content' });
  assert.deepEqual(added.overlays.at(-1), { selector: '#chat-bar', action: 'hide',
    css: ['#chat-bar { display: none !important; }'],
    note: 'floating chat widget over the content' });
  assert.equal(added.overlays.length, a.overlays.length + 1);
  assert.deepEqual(added.verifiedOn, a.verifiedOn, 'not verified by adding');
  const replaced = await addOverlay(cwd, { selector: '#chat-bar', action: 'remove' });
  assert.equal(replaced.overlays.filter((o) => o.selector === '#chat-bar').length, 1);
  assert.equal(replaced.overlays.at(-1).css, undefined);
  await assert.rejects(addOverlay(cwd, { selector: '#x', action: 'nuke' }), /one of hide/);
});

test('fragments.json defines the shared documents; pages using one is a query', async () => {
  const cwd = await fresh();
  assert.equal(classOf(FRAGMENTS_SCHEMA), 'derived');
  assert.deepEqual(PLACEMENTS, ['template', 'inline']);
  await upsert(cwd, [found(`${ORIGIN}a`, { kind: 'page' }), found(`${ORIGIN}b`, { kind: 'page' })]);
  const header = fragmentId('template', 'header');
  const footer = fragmentId('template', 'footer');
  const cta = fragmentId('inline', 'contact-cta');
  const f = await writeFragments(cwd, {
    method: { name: 'visual-tree', at: AT },
    fragments: [
      { placement: 'template', part: 'header', label: 'utility bar + main nav',
        selectors: ['#utility-nav-bar', '.component-nav-top'], optional: [], pages: 2 },
      { placement: 'template', part: 'footer', selectors: ['body > footer'],
        optional: ['body > footer > .legal'], pages: 1, evidence: ['website/footer.png'] },
      { placement: 'inline', name: 'contact-cta', selectors: ['.cmp-experiencefragment--contact'],
        type: 'typ-000000000001', pages: 1 },
    ],
    rejected: [{ selector: '#banner', reason: 'support 45 % is under the line' }],
  });
  assert.deepEqual(f.fragments.map((x) => x.id), [header, footer, cta],
    'ids from placement and part or name');
  assert.equal(f.fragments[0].selectors.length, 2, 'one header, two bands');
  assert.equal(f.summary,
    '2 template fragment(s) (header, footer), 1 inline; 1 candidate(s) rejected');
  assert.deepEqual(await readFragments(cwd), f);
  await assert.rejects(writeFragments(cwd, { method: { name: 'x', at: AT }, fragments: [
    { placement: 'template', part: 'header', selectors: ['a'], optional: [], pages: 1 },
    { placement: 'template', part: 'header', selectors: ['b'], optional: [], pages: 1 },
  ] }), /two template fragments for part header: one header is one document/);
  const twoDesigns = await writeFragments(cwd, { method: { name: 'x', at: AT }, fragments: [
    { id: 'frg-aaaaaaaaaaaa', placement: 'template', part: 'header', label: 'main site',
      selectors: ['a'], optional: [], pages: 40 },
    { id: 'frg-bbbbbbbbbbbb', placement: 'template', part: 'header', label: 'campaign',
      selectors: ['b'], optional: [], pages: 8 },
  ] });
  assert.equal(twoDesigns.fragments.length, 2, 'two designs, each with an id and a label');
  await assert.rejects(writeFragments(cwd, { method: { name: 'x', at: AT },
    fragments: [{ placement: 'inline', name: 'Contact CTA', selectors: ['x'], pages: 1 }] }),
  /must match exactly one shape/);
  const comp = (fragments, items = []) => ({ method: { name: 'visual-tree', at: AT }, fragments,
    sections: items.length ? [{ id: 's1', selector: 'main', items }] : [], omitted: [] });
  await writeComposition(cwd, pageId(`${ORIGIN}a`),
    comp([{ ref: header, selector: '#utility-nav-bar' }, { ref: footer, selector: 'footer' }],
      [{ role: 'fragment', ref: cta, selector: '.cmp-experiencefragment--contact' }]));
  await writeComposition(cwd, pageId(`${ORIGIN}b`),
    comp([{ ref: header, selector: '#utility-nav-bar' }]));
  assert.deepEqual((await pagesUsing(cwd, header)).map((p) => p.url), [`${ORIGIN}a`, `${ORIGIN}b`]);
  assert.deepEqual((await pagesUsing(cwd, footer)).map((p) => p.url), [`${ORIGIN}a`]);
  assert.deepEqual((await pagesUsing(cwd, cta)).map((p) => p.url), [`${ORIGIN}a`], 'inline too');
  assert.deepEqual(await pagesUsing(cwd, 'frg-aaaaaaaaaaaa'), []);
});

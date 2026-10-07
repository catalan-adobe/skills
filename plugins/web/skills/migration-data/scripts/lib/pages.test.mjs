import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { init, plan } from './migration.mjs';
import {
  DECISIONS_SCHEMA, FILE, REASONS, REASON_CODES, SCHEMA, canonical, decide, get, groupOf, list,
  pageId, read, setReasons, summarise, upsert, verdict,
} from './pages.mjs';
import { classOf, schemaOf } from './schema.mjs';
import { openStore } from './store.mjs';

const ORIGIN = 'https://www.example.com/';
const fresh = async (opts = {}) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-pages-'));
  await init(cwd, { origin: ORIGIN, ...opts });
  return cwd;
};
const AT = '2026-09-22T10:00:00.000Z';
const found = (url, extra = {}) => ({ url, discovered: { from: 'sitemap', at: AT }, ...extra });
const byUrl = (table) => Object.fromEntries(table.pages.map((p) => [p.url, p]));

test('canonical URLs, stable ids, groups below the scope', () => {
  assert.equal(canonical('https://a.example/x/#top'), 'https://a.example/x');
  assert.equal(canonical('https://a.example/'), 'https://a.example/');
  assert.equal(canonical('https://a.example/x/?q=1'), 'https://a.example/x?q=1');
  assert.equal(pageId('https://a.example/x/'), pageId('https://a.example/x#frag'));
  assert.equal(groupOf('https://a.example/blogs/one.html', 'https://a.example/'), 'blogs');
  assert.equal(groupOf('https://a.example/blogs.html', 'https://a.example/'), '');
  assert.equal(groupOf('https://a.example/', 'https://a.example/'), '');
  assert.equal(groupOf('https://a.example/en/p/x/y', 'https://a.example/en/p/'), 'x');
  assert.equal(groupOf('https://b.example/x', 'https://a.example/'), null);
});

test('the reason vocabulary is closed and documented; the table is derived, decisions decided',
  () => {
    assert.equal(classOf(SCHEMA), 'derived');
    assert.equal(classOf(DECISIONS_SCHEMA), 'decision');
    const codes = schemaOf(SCHEMA).schema.properties.pages.items.properties.verdict.properties
      .reasons.items.properties.code.enum;
    assert.deepEqual(codes, REASON_CODES);
    for (const code of REASON_CODES) assert.ok(REASONS[code].length > 10, `${code} documented`);
  });

test('upsert discovers, merges facts by id, and judges every record', async () => {
  const cwd = await fresh();
  const table = await upsert(cwd, [
    found(`${ORIGIN}`), found(`${ORIGIN}blogs/one.html`), found(`${ORIGIN}blogs/two.html/`),
    found(`${ORIGIN}docs/a.pdf`), found('https://other.example/x'),
  ]);
  assert.equal(table.schema, SCHEMA);
  const t = byUrl(table);
  assert.deepEqual(Object.keys(t).sort(), [
    'https://other.example/x', `${ORIGIN}`, `${ORIGIN}blogs/one.html`, `${ORIGIN}blogs/two.html`,
    `${ORIGIN}docs/a.pdf`,
  ]);
  assert.equal(t[`${ORIGIN}blogs/one.html`].group, 'blogs');
  assert.deepEqual(t[`${ORIGIN}`].verdict, { status: 'in', reasons: [] }, 'no plan: in');
  assert.equal(t['https://other.example/x'].verdict.status, 'out');
  assert.deepEqual(t['https://other.example/x'].verdict.reasons.map((r) => [r.code, r.kind, r.by]),
    [['off-scope', 'exclude', 'discover']]);
  assert.equal(t[`${ORIGIN}docs/a.pdf`].kind, 'unknown', 'a pdf is a page until the site says');
  // The cache step reports what it found, by URL; facts merge, the verdict follows.
  const after = byUrl(await upsert(cwd, [
    { url: `${ORIGIN}docs/a.pdf`, kind: 'binary',
      http: { status: 200, contentType: 'application/pdf' },
      cache: { at: AT, path: 'h/docs/a.pdf', selection: 's' } },
    { url: `${ORIGIN}blogs/two.html`, kind: 'redirect',
      redirect: { status: 301, target: `${ORIGIN}blogs/one.html` },
      finalUrl: `${ORIGIN}blogs/one.html` },
    { url: `${ORIGIN}blogs/one.html`, kind: 'page', http: { status: 200, contentType: 'text/html' },
      finalUrl: `${ORIGIN}blogs/one.html`,
      cache: { at: AT, path: 'h/blogs/one.html', selection: 's' } },
    { url: `${ORIGIN}`, kind: 'error', http: { status: 500 } },
  ]));
  assert.deepEqual(after[`${ORIGIN}docs/a.pdf`].verdict.reasons.map((r) => r.code), ['not-a-page']);
  assert.deepEqual(after[`${ORIGIN}blogs/two.html`].verdict.reasons.map((r) => [r.code, r.detail]),
    [['redirect', `${ORIGIN}blogs/one.html`]]);
  assert.deepEqual(after[`${ORIGIN}`].verdict.reasons.map((r) => [r.code, r.detail]),
    [['http-error', 'HTTP 500']]);
  assert.equal(after[`${ORIGIN}blogs/one.html`].verdict.status, 'in');
  assert.equal(after[`${ORIGIN}blogs/one.html`].discovered.from, 'sitemap', 'discovery is kept');
  assert.match(table.summary, /^5 URLs in 3 groups: 4 in, 1 out, 0 undecided; 0 cached/);
  assert.match((await read(cwd)).summary, /2 cached, 0 composed\. Reasons: .*1 off-scope/);
});

test('a duplicate final URL is excluded; other units set and replace their own reasons',
  async () => {
    const cwd = await fresh();
    await upsert(cwd, [
      { ...found(`${ORIGIN}a`), kind: 'page', finalUrl: `${ORIGIN}a` },
      { ...found(`${ORIGIN}a?utm=x`), kind: 'page', finalUrl: `${ORIGIN}a` },
    ]);
    const t = byUrl(await read(cwd));
    assert.equal(t[`${ORIGIN}a`].verdict.status, 'in');
    assert.deepEqual(t[`${ORIGIN}a?utm=x`].verdict.reasons.map((r) => r.code), ['duplicate']);
    const a = pageId(`${ORIGIN}a`);
    const flagged = await setReasons(cwd, 'chrome', { [a]: [{ code: 'no-footer', kind: 'flag' }] });
    const fv = byUrl(flagged)[`${ORIGIN}a`].verdict;
    assert.deepEqual([fv.status, fv.reasons.map(({ at, ...r }) => r)],
      ['in', [{ code: 'no-footer', kind: 'flag', by: 'chrome' }]], 'a flag keeps the page in');
    const again = await setReasons(cwd, 'chrome', {});
    assert.deepEqual(byUrl(again)[`${ORIGIN}a`].verdict.reasons, [], 'a rerun clears its own');
    const emptied = await setReasons(cwd, 'composition',
      { [a]: [{ code: 'empty', kind: 'exclude', detail: 'nothing between the chrome' }] });
    assert.equal(byUrl(emptied)[`${ORIGIN}a`].verdict.status, 'out');
    assert.deepEqual((await list(cwd, { reason: 'empty' })).map((p) => p.url), [`${ORIGIN}a`]);
  });

test('the plan decides: no plan in, a budget undecided, a selection in or over', async () => {
  const cwd = await fresh({ plan: { pages: 1 } });
  await upsert(cwd, [found(`${ORIGIN}a`), found(`${ORIGIN}b`)]);
  assert.deepEqual((await read(cwd)).pages.map((p) => p.verdict.status),
    ['undecided', 'undecided']);
  await plan(cwd, { selection: 'migrate' });
  const unknown = await upsert(cwd, []);
  assert.deepEqual(unknown.pages.map((p) => p.verdict.status), ['undecided', 'undecided'],
    'a selection named but not given: nothing to judge with');
  const chosen = await upsert(cwd, [], { selected: new Set([pageId(`${ORIGIN}a`)]) });
  const t = byUrl(chosen);
  assert.equal(t[`${ORIGIN}a`].verdict.status, 'in');
  assert.deepEqual(t[`${ORIGIN}b`].verdict.reasons.map((r) => [r.code, r.by, r.detail]),
    [['over-budget', 'plan', 'not in selection migrate']]);
  assert.equal(t[`${ORIGIN}b`].verdict.status, 'out');
});

test('the operator decides a page, with a reason, and wins; get and list answer by id or URL',
  async () => {
    const cwd = await fresh();
    await upsert(cwd, [found(`${ORIGIN}legal`), found('https://other.example/keep')]);
    await assert.rejects(decide(cwd, `${ORIGIN}nope`, 'out', 'x'), /no page .*nope in the table/);
    await assert.rejects(decide(cwd, `${ORIGIN}legal`, 'out', ''), /decision needs its reason/);
    const out = await decide(cwd, `${ORIGIN}legal`, 'out', 'legal pages stay on the old site');
    const legal = byUrl(out)[`${ORIGIN}legal`].verdict;
    assert.equal(legal.status, 'out');
    assert.deepEqual(legal.reasons.map(({ at, ...r }) => r), [
      { code: 'operator', kind: 'exclude', by: 'operator',
        detail: 'legal pages stay on the old site' },
    ]);
    const kept = await decide(cwd, 'https://other.example/keep', 'in', 'wanted anyway');
    const k = byUrl(kept)['https://other.example/keep'].verdict;
    assert.equal(k.status, 'in', 'the operator overrides an exclusion');
    assert.deepEqual(k.reasons.map((r) => r.code), ['off-scope', 'operator']);
    const decisions = await openStore(cwd).read('pages/decisions.json', DECISIONS_SCHEMA);
    assert.equal(Object.keys(decisions.pages).length, 2);
    assert.equal((await get(cwd, `${ORIGIN}legal/`)).id, pageId(`${ORIGIN}legal`));
    assert.equal((await get(cwd, pageId(`${ORIGIN}legal`))).url, `${ORIGIN}legal`);
    assert.equal(await get(cwd, `${ORIGIN}zzz`), null);
    assert.deepEqual((await list(cwd, { status: 'out' })).map((p) => p.url), [`${ORIGIN}legal`]);
    assert.deepEqual((await list(cwd, { group: '' })).length, 2);
    assert.equal(summarise([]),
      '0 URLs in 0 groups: 0 in, 0 out, 0 undecided; 0 cached, 0 composed.');
    assert.equal(verdict({ id: 'pag-x' }, [], { plan: { pages: null, selection: null } }).status,
      'in');
    assert.ok(await openStore(cwd).exists(FILE));
  });

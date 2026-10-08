import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HEIGHT_EXPRESSION, captureExpression, pagesToCapture, preparedAtTop,
} from './capture.mjs';
import {
  check, findNode, flagsOf, fragmentsOf, outlineExpression, pageComposition, pending,
  resolveExpression, workerMain,
} from './chrome.mjs';
import { data } from './data.mjs';

const O = 'https://site.example/';
const AT = '2026-09-22T10:00:00.000Z';
const box = (y, height, width = 1280, x = 0) => ({ x, y, width, height });
const el = (tag, className, bounds, children = [], extra = {}) => ({
  tag, className, selector: `${tag.toLowerCase()}.${className.split(' ')[0]}`, bounds,
  children, ...extra,
});

// Ten pages: 7 main, 2 with the blog header (same slot, other structure), 1 landing page
// without any chrome; a CTA band above the footer on 5 pages.
function siteTree(n) {
  const height = 3000 + n * 131;
  const landing = n === 10;
  const blog = n === 8 || n === 9;
  const children = [];
  if (!landing) {
    children.push(el('DIV', 'utility', box(0, 53), [], { id: 'utility-nav-bar' }));
    children.push(blog
      ? el('DIV', 'experiencefragment', box(53, 80),
        [el('DIV', 'blog-nav', box(53, 80)), el('DIV', 'blog-search', box(53, 80))])
      : el('DIV', 'experiencefragment', box(53, 80), [el('DIV', 'main-nav', box(53, 80))]));
  }
  children.push(el('DIV', 'content', box(200 + n * 70, 900)));
  if (!landing && n <= 5) children.push(el('DIV', 'cta banner', box(height - 900, 300)));
  if (!landing) {
    children.push(el('DIV', 'experiencefragment', box(height - 600, 600), [
      el('DIV', 'siteFooter row', box(height - 600, 500), [], { id: `xf-${n}abcdef` }),
    ]));
  }
  return el('BODY', 'page', box(0, height), children);
}
const urlOf = (n) => `${O}${n === 10 ? 'campaign' : n >= 8 ? 'blog' : 'p'}/${n}.html`;

/** A fake browser: answers each expression as the bundle and the page would. */
const numberOf = (url) => Number(/\/(\d+)\.html/.exec(url)?.[1]);

function fakeIo(treeOf, { failOn = [], pageOf = numberOf } = {}) {
  const calls = { visited: [], shots: [], proxies: [] };
  let current = null;
  return {
    calls,
    treeBundle: '/bundle.js',
    sleep: async () => {},
    startProxy: async ({ offline }) => {
      calls.proxies.push(offline);
      return { port: 4000, stop: async () => {} };
    },
    browser: {
      open: async (url) => { calls.visited.push(url); current = url; },
      goto: async (url) => {
        calls.visited.push(url);
        current = url;
        if (failOn.some((f) => url.includes(f))) throw new Error('net::ERR_FAILED');
      },
      eval: async (expression) => {
        if (expression.startsWith('(async')) return '"top"';
        if (expression === HEIGHT_EXPRESSION) {
          const n = pageOf(current);
          return JSON.stringify(n === 5 ? 20000 : treeOf(n).bounds.height);
        }
        if (expression.includes('captureVisualTree')) {
          const tree = treeOf(pageOf(current));
          return JSON.stringify(JSON.stringify({ data: tree, textFormat: 'BODY', nodeMap: {} }));
        }
        if (expression.startsWith('JSON.stringify([')) {
          const selectors = JSON.parse(/JSON\.stringify\((\[.*?\])\.map/.exec(expression)[1]);
          return JSON.stringify(JSON.stringify(selectors.map(() => 1)));
        }
        return '3';
      },
      screenshot: async (file, target) => {
        calls.shots.push([path.relative(process.cwd(), file), target ?? null]);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'png');
      },
      close: async () => {},
    },
  };
}

async function project() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mpipe-chrome-'));
  const { migration, pages, website } = await data(cwd);
  await migration.init(cwd, { origin: O });
  const urls = Array.from({ length: 10 }, (_, i) => urlOf(i + 1));
  await pages.upsert(cwd, [...urls, `${O}doc.pdf`, `${O}not-cached.html`].map((url) => ({
    url, discovered: { from: 'list', at: AT },
    kind: url.endsWith('.pdf') ? 'binary' : 'page',
    ...(url.includes('not-cached') ? {} : { cache: { at: AT, path: 'x', selection: 's' } }),
  })));
  await website.writeAccess(cwd, { browser: { engine: 'chromium' },
    overlays: [{ selector: '#onetrust-banner-sdk', action: 'hide', css: ['#x{}'] }],
    verifiedOn: [] });
  return cwd;
}

test('the pure pieces: expressions, node finding, fragments of variants, flags', () => {
  assert.match(captureExpression(), /captureVisualTree\(250\)/);
  assert.match(preparedAtTop('x()'), /^\(async \(\) => \{ await \(x\(\)\);/);
  assert.match(outlineExpression(['#a']), /outline = "4px solid #e00"/);
  assert.match(resolveExpression(['#a', '.b']), /\["#a","\.b"\]/);
  const tree = siteTree(1);
  assert.equal(findNode(tree, ['div.siteFooter']).id, 'xf-1abcdef');
  assert.equal(findNode(tree, ['nope']), null);
  const variants = [
    { members: [{ selector: '#u', bounds: box(0, 53) }], optional: [{ selector: '.cta' }],
      pages: ['a', 'b'] },
    { members: [{ selector: '#v', bounds: box(0, 53) }], optional: [], pages: ['c'] },
  ];
  const two = fragmentsOf('header', variants, (p, seed) => `${p}-${seed.replace(/\W/g, '')}`);
  assert.deepEqual(two.map((f) => [f.id, f.label, f.selectors, f.optional, f.pages]), [
    [undefined, 'header design 1', ['#u'], ['.cta'], 2],
    ['frg-templateheader2', 'header design 2', ['#v'], [], 1],
  ], 'two designs: both labelled, the second with its own id');
  const one = fragmentsOf('footer', variants.slice(0, 1), () => 'x');
  assert.deepEqual([one[0].id, one[0].label, one[0].part], [undefined, undefined, 'footer']);
  const flags = flagsOf({ without: { header: ['a'], footer: ['a', 'b', 'zzz'] } },
    new Map([['a', 'pag-a'], ['b', 'pag-b']]));
  assert.deepEqual(flags, {
    'pag-a': [{ code: 'no-header', kind: 'flag' }, { code: 'no-footer', kind: 'flag' }],
    'pag-b': [{ code: 'no-footer', kind: 'flag' }],
  });
  const frag = { id: 'frg-000000000001', selectors: ['div.utility'], variant: {
    pages: [urlOf(1)], members: [{ selector: 'div.utility', selectors: [], bounds: box(0, 53) },
      { selector: 'div.experiencefragment', selectors: [], bounds: box(53, 80) }] } };
  const comp = pageComposition({ url: urlOf(1), tree }, [frag], AT);
  assert.deepEqual(comp.fragments, [{ ref: 'frg-000000000001', selector: 'div.utility',
    bounds: box(0, 133) }], 'the bands united into one box on this page');
  assert.deepEqual([comp.sections, comp.omitted], [[], []]);
  assert.deepEqual(pageComposition({ url: 'other', tree }, [frag], AT).fragments, []);
});

test('the worker: trees captured offline, chrome detected, written in EDS terms', async () => {
  const cwd = await project();
  const io = fakeIo(siteTree);
  assert.deepEqual((await pending(cwd)).length, 10, 'ten cached pages without a tree');
  assert.deepEqual(await check(cwd), { pass: false, note: '10 page(s) without a visual tree' });
  const out = await workerMain(cwd, { io });
  assert.match(out.summary,
    /^10 tree\(s\) captured, 0 failed; 10 pages read; header: 2, 1 without; footer: 1, 1 without/);
  assert.deepEqual(io.calls.proxies, [true], 'offline only');
  assert.equal(io.calls.visited.length, 10 + 3, 'ten pages, then one per fragment for evidence');
  const { website, composition, pages, trees, notes, runs } = await data(cwd);
  assert.equal((await trees.list(cwd)).length, 10);
  const frags = await website.readFragments(cwd);
  assert.deepEqual(frags.fragments.map((f) => [f.part, f.label ?? null, f.pages, f.selectors]), [
    ['header', 'header design 1', 7, ['div.utility', 'div.experiencefragment']],
    ['header', 'header design 2', 2, ['div.utility', 'div.experiencefragment']],
    ['footer', null, 9, ['div.experiencefragment']],
  ]);
  const [h1, h2, footer] = frags.fragments;
  assert.notEqual(h1.id, h2.id);
  assert.equal(footer.id, website.fragmentId('template', 'footer'));
  assert.deepEqual(h1.evidence, [`fragments/${h1.id}/shots/page.png`,
    `fragments/${h1.id}/shots/band-1.png`, `fragments/${h1.id}/shots/band-2.png`]);
  assert.deepEqual(await readdir(path.join(cwd, 'migration', 'fragments', h1.id, 'shots')),
    ['band-1.png', 'band-2.png', 'page.png']);
  assert.equal((await composition.readFragment(cwd, h1.id)).sections.length, 2, 'two bands');
  assert.equal((await composition.readFragment(cwd, footer.id)).sections[0].selector,
    'div.experiencefragment');
  const table = await pages.read(cwd);
  const p1 = table.pages.find((p) => p.url === urlOf(1));
  assert.deepEqual(p1.fragments.sort(), [h1.id, footer.id].sort());
  assert.deepEqual(p1.composition, { method: 'visual-tree', at: p1.composition.at, sections: 0,
    omitted: 0 });
  const page1 = await composition.read(cwd, p1.id);
  assert.deepEqual(page1.fragments.find((f) => f.ref === h1.id).bounds, box(0, 133));
  const blog = table.pages.find((p) => p.url === urlOf(8));
  assert.ok(blog.fragments.includes(h2.id), 'the blog pages carry the second design');
  const landing = table.pages.find((p) => p.url === urlOf(10));
  assert.deepEqual(landing.verdict.reasons.map((r) => [r.code, r.kind, r.by]),
    [['no-header', 'flag', 'chrome'], ['no-footer', 'flag', 'chrome']]);
  const tall = table.pages.find((p) => p.url === urlOf(5));
  assert.deepEqual(tall.verdict.reasons.map((r) => [r.code, r.detail]),
    [['too-tall', '20000 px > 16384']], 'parked: no honest picture of it');
  const facts = (id) => trees.read(cwd, id).then((t) => t.page);
  const tallFacts = await facts(tall.id);
  assert.deepEqual([tallFacts.scrollHeight, tallFacts.shot], [20000, null]);
  const p1Facts = await facts(p1.id);
  assert.deepEqual([p1Facts.scrollHeight, p1Facts.shot], [3131, `pages/${p1.id}/shots/page.jpg`]);
  assert.deepEqual(Object.keys(p1Facts.timings), ['goto', 'prepare', 'tree', 'shot'],
    'every phase timed');
  assert.ok(io.calls.shots.some(([f]) => f.endsWith(`${p1.id}/shots/page.jpg`)));
  assert.equal(io.calls.shots.filter(([f]) => f.endsWith('page.jpg')).length, 9,
    'not the tall one');
  assert.match(out.summary, /1 too tall/);
  assert.equal(landing.verdict.status, 'in', 'a flag is a flag, not an exclusion');
  assert.equal((await website.readWebsite(cwd)).counts.composed, 0, 'fragments only: not read');
  const [note] = await notes.list(cwd, { step: 'chrome' });
  const body = await notes.body(cwd, note.id);
  assert.match(body, /## header: 2 design\(s\)/);
  assert.match(body, /Pages without a footer: 1\n- https:\/\/site.example\/campaign\/10.html/);
  assert.match(body, /## Limits of the method/);
  const [run] = await runs.list(cwd, { step: 'chrome' });
  assert.equal(run.state, 'done');
  assert.deepEqual(await pending(cwd), [], 'detection matches the stored trees');
  assert.deepEqual(await check(cwd), { pass: true });
  // A new cached page: one tree to capture, then a stale detection; a rerun captures it only.
  await pages.upsert(cwd, [{ url: `${O}not-cached.html`, cache: { at: AT, path: 'y',
    selection: 's' } }]);
  assert.deepEqual(await check(cwd), { pass: false, note: '1 page(s) without a visual tree' });
  const again = fakeIo(siteTree, { pageOf: (url) => numberOf(url) || 3 });
  const second = await workerMain(cwd, { io: again });
  assert.match(second.summary, /^1 tree\(s\) captured/);
  assert.equal((await trees.list(cwd)).length, 11);
  assert.deepEqual(await check(cwd), { pass: true });
  // What a capture renders changed: an overlay rule added, a cache run done → all stale.
  await new Promise((r) => { setTimeout(r, 5); });
  await website.addOverlay(cwd, { selector: '#chat', action: 'hide' });
  assert.equal((await pagesToCapture(cwd)).length, 11, 'every tree older than the rule');
  const thirdIo = fakeIo(siteTree, { pageOf: (u) => numberOf(u) || 3 });
  const third = await workerMain(cwd, { io: thirdIo });
  assert.match(third.summary, /^11 tree\(s\) captured/);
  assert.deepEqual(await pagesToCapture(cwd), []);
  await new Promise((r) => { setTimeout(r, 5); });
  const { runs: runsOf } = await data(cwd);
  const filled = await runsOf.start(cwd, 'cache', { fill: true });
  await runsOf.finish(cwd, filled.id, { state: 'done', summary: 'filled' });
  assert.equal((await pagesToCapture(cwd)).length, 11, 'every tree older than the fill');
});

test('capture failures: a dead page is skipped, five in a row end the run as failed', async () => {
  const cwd = await project();
  const io = fakeIo(siteTree, { failOn: ['/p/2.html'] });
  const out = await workerMain(cwd, { io });
  assert.match(out.summary, /^9 tree\(s\) captured, 1 failed; 9 pages read/);
  assert.equal((await pagesToCapture(cwd)).length, 1, 'the failed page is still to capture');
  const dead = fakeIo(siteTree, { failOn: ['.html'] });
  const fresh = await project();
  await assert.rejects(workerMain(fresh, { io: dead }), /5 captures failed in a row/);
  const { runs } = await data(fresh);
  const [run] = await runs.list(fresh, { step: 'chrome' });
  assert.equal(run.state, 'failed');
  assert.equal(run.failed.length, 5);
});

test('several sessions deal the pages from one queue; the run counts stay whole', async () => {
  const cwd = await project();
  const { migration } = await data(cwd);
  await migration.setting(cwd, 'sessions', 3);
  const io = fakeIo(siteTree);
  const seen = [];
  io.browsers = [1, 2, 3].map((n) => ({
    ...io.browser,
    open: async (url) => { seen.push([n, 'open']); await io.browser.open(url); },
    goto: async (url) => { seen.push([n, 'goto']); await io.browser.goto(url); },
  }));
  const out = await workerMain(cwd, { io });
  assert.match(out.summary, /^10 tree\(s\) captured, 0 failed/);
  assert.deepEqual(seen.filter(([, k]) => k === 'open').map(([n]) => n).sort(), [1, 2, 3],
    'each session opened once');
  const bySession = [1, 2, 3].map((n) => seen.filter(([s]) => s === n).length);
  assert.ok(bySession.every((c) => c >= 1) && bySession.reduce((a, b) => a + b) >= 10,
    `every session took pages: ${bySession}`);
  const { runs } = await data(cwd);
  const [run] = await runs.list(cwd, { step: 'chrome' });
  assert.deepEqual([run.done, run.total, run.failed.length], [10, 10, 0]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CRITERIA, MERGE, METHOD, WORDING, alike, candidates, cut, decide, derive, facts, layoutOf,
  questions, siblings, stateOf, structure, structurePage, treeOf,
} from './structure.mjs';
import { data } from './data.mjs';

const O = 'https://site.example/';
const AT = '2026-10-10T10:00:00.000Z';
const box = (x, y, width, height) => ({ x, y, width, height });
const node = (tag, selector, bounds, children = []) => ({ tag, selector, bounds, children });

// A page: header, then a main with four siblings — a hero image, a breadcrumb, an article
// beside a sidebar (two siblings sharing a vertical range) — then a footer.
const TREE = node('BODY', 'body', box(0, 0, 1280, 4000), [
  node('HEADER', 'body > header', box(0, 0, 1280, 100)),
  node('MAIN', 'body > main', box(0, 100, 1280, 3700), [
    node('DIV', 'main > div.wrap', box(0, 100, 1280, 3700), [
      node('DIV', 'div.hero', box(0, 100, 1280, 600)),
      node('DIV', 'div.breadcrumb', box(0, 700, 1280, 60)),
      node('DIV', 'div.article', box(60, 800, 760, 3000), [
        node('H1', 'div.article > h1', box(60, 820, 700, 40)),
        ...Array.from({ length: 6 }, (_, i) => node('P', `div.article > p:nth-of-type(${i + 1})`,
          box(60, 900 + i * 300, 700, 200))),
      ]),
      node('ASIDE', 'aside.side', box(900, 800, 320, 900), [
        node('H3', 'aside.side > h3', box(900, 820, 300, 30)),
        node('UL', 'aside.side > ul', box(900, 860, 300, 60)),
      ]),
    ]),
  ]),
  node('FOOTER', 'body > footer', box(0, 3800, 1280, 200)),
]);
const BODY = { top: 100, bottom: 3800 };

const leaf = (x, y, w, h, extra) => ({ x, y, w, h, ...extra });
const CAPTURE = {
  W: 1280, H: 4000, pageBg: 'rgb(255, 255, 255)', updatedAt: AT,
  leaves: [
    leaf(0, 100, 1280, 600, { m: true, e: 'IMG' }),
    leaf(60, 710, 300, 20, { t: 'Home › Guides › This page', e: 'A' }),
    leaf(60, 820, 700, 40, { t: 'A title of the article', e: 'H1' }),
    ...Array.from({ length: 6 }, (_, i) => leaf(60, 900 + i * 300, 700, 200,
      { t: 'A paragraph of running text long enough to count as prose for the facts here, and'
        + ' more.', e: 'P' })),
    leaf(900, 820, 300, 30, { t: 'Related', e: 'H3' }),
    leaf(900, 860, 300, 20, { t: 'A related link', e: 'A' }),
    leaf(900, 900, 300, 20, { t: 'Another related link', e: 'A' }),
  ],
  bgs: [], paths: ['body'],
  analysis: { base: null, gap: 40, gutter: 24, bands: [], rails: [] },
};

test('siblings and candidates: wrappers are walked through, side-by-side siblings form one band',
  () => {
    assert.deepEqual(siblings(TREE, BODY).map((n) => n.selector),
      ['div.hero', 'div.breadcrumb', 'div.article', 'aside.side']);
    const cands = candidates(TREE, BODY);
    assert.deepEqual(cands.map((c) => [c.id, c.top, c.bottom, c.parts.length]),
      [['C1', 100, 700, 1], ['C2', 700, 800, 1], ['C3', 800, 3800, 2]],
      'gaps go to the band above; the last ends at the footer');
    assert.deepEqual(cands[2].parts.map((p) => p.selector), ['div.article', 'aside.side']);
    assert.deepEqual([cands[0].left, cands[0].right], [0, 1280], 'the first level is page-wide');
    const article = node('MAIN', 'main', box(0, 100, 1280, 900), [
      node('H1', 'main > h1', box(0, 100, 1280, 60)),
      ...Array.from({ length: 4 }, (_, i) => node('P', `main > p:nth-of-type(${i + 1})`,
        box(0, 160 + i * 100, 1280, 100))),
      node('DIV', 'main > div.cards', box(0, 560, 1280, 440)),
    ]);
    assert.deepEqual(candidates(article, { top: 100, bottom: 1000 })
      .map((c) => [c.top, c.bottom, Boolean(c.text)]), [[100, 560, true], [560, 1000, false]],
    'a body of paragraphs is one run at the first level too');
  });

test('cut, at any depth: parts side by side are columns; one node is cut through its wrappers',
  () => {
    const [hero, , article] = candidates(TREE, BODY);
    const two = cut(article);
    assert.equal(two.side, true);
    assert.deepEqual(two.kids.map((k) => [k.parts[0].selector, k.left, k.right, k.top, k.bottom]),
      [['div.article', 60, 820, 800, 3800], ['aside.side', 900, 1220, 800, 1700]],
      'each column its own extent');
    const inner = cut(two.kids[0]);
    assert.deepEqual([inner.side, inner.kids.length, inner.kids[0].text], [false, 1, true],
      'a heading and paragraphs are one run of text');
    assert.equal(inner.kids[0].nodes.length, 7);
    assert.deepEqual(cut(hero).kids, [], 'a node without children: nothing to cut');
    const wrapped = node('DIV', 'div.outer', box(0, 0, 1280, 800), [
      node('DIV', 'div.inner', box(0, 0, 1280, 800), [
        node('DIV', 'div.text', box(40, 0, 700, 800), [node('P', 'p', box(40, 0, 700, 100))]),
        node('DIV', 'div.cards', box(780, 0, 460, 800), [node('UL', 'ul', box(780, 0, 460, 400))]),
      ]),
    ]);
    const lifted = cut({ top: 0, bottom: 800, left: 0, right: 1280, nodes: [wrapped],
      parts: [{ x: 0, w: 1280, selector: 'div.outer' }] });
    assert.deepEqual([lifted.side, lifted.kids.map((k) => k.parts[0].selector)],
      [true, ['div.text', 'div.cards']], 'siblings side by side under wrappers make columns');
    const margin = node('DIV', 'div.grid', box(0, 0, 1280, 800), [
      node('DIV', 'div.side', box(58, 0, 332, 800), [node('P', 'p', box(60, 0, 300, 100))]),
      node('DIV', 'div.main', box(349, 0, 873, 800), [node('P', 'p', box(360, 0, 800, 100))]),
    ]);
    assert.equal(cut({ top: 0, bottom: 800, left: 0, right: 1280, nodes: [margin],
      parts: [{ x: 0, w: 1280, selector: 'div.grid' }] }).side, true,
    'grid columns overlapping by a margin are still side by side');
    const layered = node('DIV', 'div.hero', box(0, 0, 1280, 600), [
      node('DIV', 'div.bg', box(0, 0, 1280, 600)),
      node('DIV', 'div.fg', box(20, 0, 1240, 600), [
        node('H2', 'h2', box(40, 100, 600, 60)), node('DIV', 'div.cta', box(40, 300, 600, 80)),
      ]),
    ]);
    const through = cut({ top: 0, bottom: 600, left: 0, right: 1280, nodes: [layered],
      parts: [{ x: 0, w: 1280, selector: 'div.hero' }] });
    assert.deepEqual(through.kids.map((k) => [k.parts[0].selector, Boolean(k.text)]),
      [['h2', true], ['div.cta', false]], 'a background layer is passed through to the content');
    const crumb = node('DIV', 'div.crumb', box(0, 0, 1280, 50),
      [node('A', 'a', box(20, 10, 200, 20))]);
    const section = node('DIV', 'div.article', box(0, 25, 1280, 900), [
      node('DIV', 'div.part1', box(0, 60, 1280, 400)),
      node('DIV', 'div.part2', box(0, 460, 1280, 465)),
    ]);
    const overlapping = cut({ top: 0, bottom: 925, left: 0, right: 1280, nodes: [crumb, section],
      parts: [{ x: 0, w: 1280, selector: 'div.crumb' }] });
    assert.deepEqual(overlapping.kids.map((k) => k.parts[0].selector),
      ['div.crumb', 'div.part1', 'div.part2'],
      'a breadcrumb over the top of the section below is carried along, not lost');
  });

test('facts and layout: a hero is image-only and full-bleed; the article has a side column', () => {
  const [hero, crumb, article] = candidates(TREE, BODY);
  const fh = facts(hero, CAPTURE);
  assert.equal(fh.imageOnly, true);
  assert.equal(fh.fullBleed, true);
  assert.equal(fh.layout, 'single');
  const fa = facts(article, CAPTURE);
  assert.equal(fa.layout, 'main-left', 'a 760 px part beside a 320 px one');
  assert.equal(fa.long, 6);
  assert.equal(fa.headings, 2);
  const fc = facts(crumb, CAPTURE);
  assert.equal(fc.layout, 'single');
  assert.equal(layoutOf({ ...article, bottom: 1200 }, CAPTURE, []), 'main-left',
    'the parts alone say so, 400 px is enough');
  assert.equal(layoutOf({ ...crumb, bottom: 760 }, CAPTURE, []), 'single');
});

test('a side layout needs height; rails the dump set aside count as a side column', () => {
  const short = { id: 'C9', top: 800, bottom: 1000,
    parts: [{ x: 60, w: 760 }, { x: 900, w: 320 }] };
  assert.equal(layoutOf(short, CAPTURE, []), 'single', '200 px is a byline, not a layout');
  const railed = { ...CAPTURE, analysis: { ...CAPTURE.analysis,
    rails: [{ side: 'right', x0: 900, x1: 1220, y0: 800, y1: 1700 }] } };
  const plain = { id: 'C9', top: 800, bottom: 3800, parts: [{ x: 60, w: 760 }] };
  assert.equal(layoutOf(plain, railed, []), 'main-left');
});

test('the state is words: picture, text, headings, layout', () => {
  const [hero, , article] = candidates(TREE, BODY);
  const sh = stateOf(hero, CAPTURE);
  assert.equal(sh.picture, 'one large image covering most of the band');
  assert.equal(sh.text, 'no text');
  const sa = stateOf(article, CAPTURE);
  assert.equal(sa.layout, 'a main column with a narrower side column on the right');
  assert.match(sa.text, /^paragraphs of running text \(six\)/);
  assert.equal(sa.headings, 'two headings');
  assert.ok(sa.content.some((t) => /A title of the article/.test(t)));
});

test('questions: the layout one only side by side, the merge one only with a previous', () => {
  assert.deepEqual(Object.keys(questions(true)),
    ['is_default', 'is_block', 'is_section', 'title_above', 'merge']);
  assert.deepEqual(Object.keys(questions(false)),
    ['is_default', 'is_block', 'is_section', 'title_above']);
  assert.deepEqual(Object.keys(questions(false, true)),
    ['is_default', 'is_block', 'is_section', 'title_above', 'is_layout']);
  assert.match(questions(false, true).is_layout.instructions, /side by side/);
  assert.match(questions(true).is_block.instructions, new RegExp(CRITERIA.block.slice(0, 20)));
  assert.match(WORDING, /^[0-9a-f]{8}$/);
});

const answers = (d, b, s, t = 0.1, m = 0.1, l) => ({ is_default: { noul: d },
  is_block: { noul: b }, is_section: { noul: s }, title_above: { noul: t }, merge: { noul: m },
  ...(l === undefined ? {} : { is_layout: { noul: l } }) });
const F = (over = {}) => ({ inside: [1], sideBySide: false, imageOnly: false, fullBleed: false,
  loneHeading: false, ...over });

test('decide: the most probable kind, a layout when the model says so, then the content', () => {
  assert.equal(decide(answers(0.2, 0.8, 0.3), F()).kind, 'block');
  assert.equal(decide(answers(0.2, 0.8, 0.3, 0.7), F()).kind, 'section',
    'a block with a heading introducing it is a section');
  const layout = decide(answers(0.9, 0.1, 0.1, 0.1, 0.1, 0.8), F({ sideBySide: true }));
  assert.deepEqual([layout.kind, layout.judged, layout.rule], ['layout', 'layout', null]);
  assert.equal(decide(answers(0.1, 0.9, 0.1, 0.1, 0.1, 0.2), F({ sideBySide: true })).kind,
    'block', 'one component laid out in a row: a hero beside its text');
  const split = decide(answers(0.1, 0.2, 0.9, 0.1, 0.1, 0.3), F({ sideBySide: true }));
  assert.deepEqual([split.kind, split.judged, split.rule],
    ['layout', 'section', 'section side by side'], 'several things side by side are a layout');
  assert.equal(decide(answers(0.1, 0.1, 0.9), F()).kind, 'section', 'stacked, a section');
  assert.equal(decide(answers(0.1, 0.9, 0.1), F({ loneHeading: true })).rule, 'lone heading');
  assert.equal(decide(answers(0.1, 0.9, 0.1), F({ imageOnly: true, fullBleed: true })).kind,
    'block');
  assert.equal(decide(answers(0.1, 0.9, 0.1), F({ imageOnly: true })).kind, 'default_content',
    'an image in flow');
  assert.deepEqual(Object.keys(decide(answers(0.1, 0.9, 0.1), F()).probabilities),
    ['default_content', 'block', 'section', 'title_above'], 'no layout asked, none recorded');
  const empty = decide(answers(0.3, 0.3, 0.3, 0.1, 0.0), F({ inside: [] }));
  assert.deepEqual([empty.merge, empty.empty], [1, true], 'an empty band always merges');
});

test('alike: parts of one shape, sized within a quarter of each other, most of the inside',
  () => {
    const n = (cls, w, h, tag = 'DIV') => ({ tag, className: cls,
      bounds: { width: w, height: h } });
    const row = (...nodes) => ({ nodes });
    assert.equal(alike([row(n('card', 300, 300)), row(n('card', 300, 280)),
      row(n('card', 300, 310))], false), true);
    assert.equal(alike([row(n('card', 300, 300)), row(n('card', 300, 280))], false), false,
      'two are a pair');
    assert.equal(alike([row(n('card', 300, 300)), row(n('card', 300, 100)),
      row(n('card', 300, 300))], false), false, 'sizes apart');
    const grid = [row(n('a', 380, 330), n('a', 380, 330), n('a', 380, 330)),
      row(n('a', 380, 330), n('a', 380, 330), n('a', 380, 330)), row(n('nav', 600, 40))];
    assert.equal(alike(grid, false), true, 'cards in rows, with the pagination below');
    assert.equal(alike([row(n('card energy', 300, 300)), row(n('card mobility', 300, 300)),
      row(n('card steel', 300, 300))], false), true, 'the first class names the card');
    assert.equal(alike([row(n('h2', 600, 40, 'H2')), row(n('card', 300, 300)),
      row(n('card', 300, 300)), row(n('card', 300, 300))], false), false,
    'a heading over three cards: a section of a heading and a block');
    assert.equal(alike([{ nodes: [n('', 700, 100, 'P'), n('', 700, 100, 'P'),
      n('', 700, 100, 'P')], text: true }], false), false, 'a run of paragraphs is prose');
    assert.equal(alike([row(n('col', 400, 900)), row(n('col', 400, 300)),
      row(n('col', 380, 600))], true), true, 'side by side: the widths count');
    assert.deepEqual([decide(answers(0.9, 0.1, 0.1), F({ alikeParts: true })).kind,
      decide(answers(0.9, 0.1, 0.1), F({ alikeParts: true })).rule], ['block', 'alike items']);
    assert.equal(decide(answers(0.1, 0.9, 0.1), F({ imageOnly: true, alikeParts: true })).kind,
      'block', 'a gallery of alike images is one component, not images in flow');
  });

test('derive: merges by the answer; mixed kinds, or several containers, make a section', () => {
  const c = (id, top, bottom) => ({ id, top, bottom, left: 0, right: 1280 });
  const cands = [c('C1', 0, 100), c('C2', 100, 400), c('C3', 400, 500), c('C4', 500, 900),
    c('C5', 900, 1000)];
  const d = (kind, merge) => ({ kind, merge });
  const bands = derive(cands, [d('default_content', 0), d('block', MERGE),
    d('default_content', 0.2), d('layout', 0), d('layout', MERGE)]);
  assert.deepEqual(bands.map((b) => [b.members, b.kind, b.top, b.bottom]), [
    [['C1', 'C2'], 'section', 0, 400],
    [['C3'], 'default_content', 400, 500],
    [['C4', 'C5'], 'section', 500, 1000],
  ]);
  assert.deepEqual(derive(cands.slice(0, 2), [d('block', 0), d('block', 0.9)])
    .map((b) => b.kind), ['block'], 'two pieces of one block are one block');
  const prose = [d('default_content', 0), d('default_content', 0.1), d('block', 0.1),
    d('default_content', 0.1)];
  assert.equal(derive(cands.slice(0, 4), prose).length, 4, 'columns: the merge answers only');
  assert.deepEqual(derive(cands.slice(0, 4), prose, { ground: true }).map((b) => b.members),
    [['C1', 'C2'], ['C3'], ['C4']], 'at the first level, default next to default on one ground');
  const grounds = [{ ...prose[0], background: null },
    { ...prose[1], background: 'color:rgb(240, 240, 240)' }];
  assert.equal(derive(cands.slice(0, 2), grounds, { ground: true }).length, 2,
    'a change of background is a section break: the model\'s merge stands');
  assert.deepEqual(derive(cands.slice(0, 4), prose, { runs: true })
    .map((b) => [b.members, b.kind]), [[['C1', 'C2'], 'default_content'], [['C3'], 'block'],
    [['C4'], 'default_content']], 'inside a container, default content next to default is one run');
});

async function project(tree = TREE) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mpipe-structure-'));
  const { migration, pages, website, trees, bands, composition, selections } = await data(cwd);
  await migration.init(cwd, { origin: O });
  const url = `${O}guide.html`;
  await pages.upsert(cwd, [{ url, discovered: { from: 'list', at: AT }, kind: 'page',
    cache: { at: AT, path: 'x', selection: 's' } }]);
  const [page] = (await pages.read(cwd)).pages;
  await website.writeAccess(cwd, { browser: { engine: 'chromium' }, overlays: [], verifiedOn: [] });
  await website.writeFragments(cwd, { method: { name: 'test', at: AT, inputs: 'x' }, fragments: [
    { id: 'frg-000000000001', part: 'header', placement: 'template', selectors: ['body > header'],
      optional: [], pages: 1 },
    { id: 'frg-000000000002', part: 'footer', placement: 'template', selectors: ['body > footer'],
      optional: [], pages: 1 },
  ], rejected: [] });
  await trees.write(cwd, page.id, { minWidth: 250, version: 11, url, capturedAt: AT, tree,
    text: 'BODY', nodeMap: {}, page: { scrollHeight: 4000,
      shot: `pages/${page.id}/shots/page.jpg`, timings: {} } });
  await bands.writeCapture(cwd, page.id, { url, ...CAPTURE });
  await composition.write(cwd, page.id, {
    method: { name: 'chrome', version: '1', at: AT, inputs: 'x' },
    fragments: [
      { ref: 'frg-000000000001', selector: 'body > header', bounds: box(0, 0, 1280, 100) },
      { ref: 'frg-000000000002', selector: 'body > footer', bounds: box(0, 3800, 1280, 200) },
    ], sections: [], omitted: [] });
  await selections.create(cwd, 'ten', [page.id]);
  return { cwd, page };
}

test('structurePage: asked, dug into until nothing is a container, composition read off the tree',
  async () => {
    const { cwd, page } = await project();
    const asked = [];
    const io = {
      crop: async (shot, b) => `data:image/jpeg;base64,${b.top}-${b.bottom}:${b.left}-${b.right}`,
      askQuestions: async (dep, { state, questions: qs, images }) => {
        asked.push({ state, qs: Object.keys(qs), images });
        // the hero: a block; the breadcrumb: default; the article beside its side column: a
        // layout; in it, the article a section and the side column default content
        const byPicture = {
          'one large image covering most of the band': answers(0.1, 0.9, 0.2),
          'no image': state.band.parts ? answers(0.3, 0.1, 0.6, 0.1, 0.1, 0.8)
            : /paragraphs/.test(state.band.text) ? answers(0.3, 0.1, 0.7)
              : answers(0.9, 0.1, 0.1),
        };
        const a = byPicture[state.band.picture] ?? answers(0.5, 0.3, 0.3);
        if (!('merge' in qs)) delete a.merge;
        return { answers: a, usage: { inputTokens: 1000 } };
      },
    };
    const out = await structure(cwd, 'ten', { io, dep: { model: 'fake' } });
    assert.deepEqual(out, [{ id: page.id, candidates: 8, bands: 3, tree: 'b d l[d d]',
      tokens: 6000 }], 'the article section holds one run of text: it is that run');
    assert.deepEqual(asked.map((a) => a.qs.includes('is_layout')),
      [false, false, true, false, false, false],
      'the layout asked only where parts sit side by side');
    assert.deepEqual(asked[2].images, ['data:image/jpeg;base64,800-3800:0-1280',
      'data:image/jpeg;base64,700-3800:0-1280'], 'the band, then the previous above it');
    assert.deepEqual(asked[3].images, ['data:image/jpeg;base64,800-3800:60-820'],
      'a column alone: its own extent, no merge with the column beside it');
    assert.equal(asked[4].state.band.text, 'no text', 'the side column sees its own leaves');
    assert.deepEqual([asked[4].images.length, asked[4].qs.includes('merge')], [1, false],
      'columns side by side are not a stack: never merged');
    const { bands, composition } = await data(cwd);
    const s = await bands.readStructure(cwd, page.id);
    assert.equal(s.method.name, METHOD);
    const [, , split] = s.bands;
    assert.deepEqual(split.children.map((k) => [k.id, k.kind, k.collapsed ?? false]),
      [['B3.1', 'default_content', true], ['B3.2', 'default_content', false]],
      'the side column, a heading and a list, checked inside: plain default content');
    assert.deepEqual(s.candidates.filter((c) => c.parent === 'B3:C2').map((c) => c.rule),
      ['text run', null], 'its heading a run unasked, its list asked, under the candidate');
    const run = s.candidates.find((c) => c.parent === 'B3.1');
    assert.deepEqual([run.depth, run.rule, run.probabilities], [3, 'text run', null]);
    assert.equal(s.candidates.find((c) => c.id === 'C3').probabilities.layout, 0.8);
    const comp = await composition.read(cwd, page.id);
    assert.deepEqual(comp.sections[2].items.map((i) => [i.role, i.selector]), [
      ['content', 'div.article'], ['content', 'aside.side'],
    ], 'the leaves of the tree under the band, in reading order');
    assert.equal(comp.fragments.length, 2, 'the chrome stays as placed');
    assert.equal(treeOf({ kind: 'section', unresolved: true }), 's?');
  });

test('structurePage: parts side by side under a wrapper are seen before the reader is asked',
  async () => {
    const wrap = (n) => ({ ...n, children: n.children.map((k) => (k.selector !== 'main > div.wrap'
      ? k : { ...k, children: [...k.children.slice(0, 2),
        node('DIV', 'div.columns', box(60, 800, 1160, 3000), k.children.slice(2))] })) });
    const { cwd } = await project({ ...TREE, children: TREE.children.map((k) => (
      k.selector === 'body > main' ? wrap(k) : k)) });
    const asked = [];
    const io = {
      crop: async () => 'data:image/jpeg;base64,x',
      askQuestions: async (dep, { state, questions: qs }) => {
        asked.push({ parts: state.band.parts, qs: Object.keys(qs) });
        const a = state.band.parts ? answers(0.3, 0.1, 0.6, 0.1, 0.1, 0.8)
          : answers(0.9, 0.1, 0.1);
        if (!('merge' in qs)) delete a.merge;
        return { answers: a, usage: { inputTokens: 10 } };
      },
    };
    const [out] = await structure(cwd, 'ten', { io, dep: { model: 'fake' } });
    assert.equal(out.tree, 'b d l[d d]');
    assert.equal(asked[2].parts, 'two parts side by side, 59 %, 25 % of the width');
    assert.ok(asked[2].qs.includes('is_layout'));
  });

test('structurePage: a column without content is the grid, not a part', async () => {
  const grid = node('DIV', 'div.grid', box(0, 700, 1280, 100), [
    node('DIV', 'div.crumb', box(0, 700, 960, 100), [node('A', 'a', box(60, 710, 300, 20))]),
    node('DIV', 'div.empty', box(960, 700, 320, 100)),
  ]);
  const tree = { ...TREE, children: TREE.children.map((k) => (k.selector !== 'body > main' ? k
    : { ...k, children: k.children.map((w) => ({ ...w, children: w.children.map((x) => (
      x.selector === 'div.breadcrumb' ? grid : x)) })) })) };
  const { cwd, page } = await project(tree);
  const asked = [];
  const io = {
    crop: async () => 'data:image/jpeg;base64,x',
    askQuestions: async (dep, { state, questions: qs }) => {
      asked.push({ parts: state.band.parts, qs: Object.keys(qs) });
      const a = answers(0.9, 0.1, 0.1);
      if (!('merge' in qs)) delete a.merge;
      return { answers: a, usage: { inputTokens: 10 } };
    },
  };
  await structure(cwd, 'ten', { io, dep: { model: 'fake' } });
  assert.deepEqual([asked[1].parts, asked[1].qs.includes('is_layout')], [undefined, false]);
  const { bands } = await data(cwd);
  const s = await bands.readStructure(cwd, page.id);
  assert.deepEqual(s.candidates[1].parts.map((p) => p.selector), ['div.crumb']);
});

test('structurePage: default content checked inside; a block found there makes a section',
  async () => {
    const featured = node('DIV', 'div.featured', box(0, 700, 1280, 100), [
      node('H2', 'div.featured > h2', box(60, 700, 600, 20)),
      node('DIV', 'div.cards', box(60, 720, 1160, 80)),
    ]);
    const tree = { ...TREE, children: TREE.children.map((k) => (k.selector !== 'body > main' ? k
      : { ...k, children: k.children.map((w) => ({ ...w, children: w.children.map((x) => (
        x.selector === 'div.breadcrumb' ? featured : x)) })) })) };
    const { cwd, page } = await project(tree);
    const io = {
      crop: async (shot, b) => `${b.top}`,
      askQuestions: async (dep, { questions: qs, images }) => {
        const a = images[0] === '720' ? answers(0.2, 0.9, 0.1) : answers(0.9, 0.1, 0.1);
        if (!('merge' in qs)) delete a.merge;
        return { answers: a, usage: { inputTokens: 10 } };
      },
    };
    const [out] = await structure(cwd, 'ten', { io, dep: { model: 'fake' } });
    assert.match(out.tree, /^b s\[d b\] /, 'judged default, holds a heading and a block');
    const { bands } = await data(cwd);
    const s = await bands.readStructure(cwd, page.id);
    assert.deepEqual([s.bands[1].checked, s.candidates[1].kind, s.candidates[1].judged,
      s.candidates[1].rule], [true, 'section', 'default_content', 'checked: holds more than text'],
    'the model\'s answer stays on record; the decision is what was found inside');
    assert.deepEqual(s.bands[1].children.map((k) => k.id), ['B2.1', 'B2.2'],
      'the checked children under the band\'s id');
  });

test('structurePage returns null for a page without a capture or a shot', async () => {
  const { cwd, page } = await project();
  const { trees } = await data(cwd);
  await trees.write(cwd, page.id, { minWidth: 250, version: 11, url: `${O}guide.html`,
    capturedAt: AT, tree: TREE, text: 'BODY', nodeMap: {}, page: { scrollHeight: 4000, shot: null,
      timings: {} } });
  assert.equal(await structurePage(cwd, page.id, { io: {}, dep: { model: 'fake' } }), null);
});

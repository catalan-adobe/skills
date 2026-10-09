import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CRITERIA, MERGE, METHOD, WORDING, candidates, decide, derive, facts, layoutOf, questions,
  siblings, stateOf, structure, structurePage,
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
      node('DIV', 'div.article', box(60, 800, 760, 3000)),
      node('ASIDE', 'aside.side', box(900, 800, 320, 900)),
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

test('questions: five with a previous, four without; the wording hashes', () => {
  assert.deepEqual(Object.keys(questions(true)),
    ['is_default', 'is_block', 'is_section', 'title_above', 'merge']);
  assert.deepEqual(Object.keys(questions(false)),
    ['is_default', 'is_block', 'is_section', 'title_above']);
  assert.match(questions(true).is_block.instructions, new RegExp(CRITERIA.block.slice(0, 20)));
  assert.match(WORDING, /^[0-9a-f]{8}$/);
});

const answers = (d, b, s, t = 0.1, m = 0.1) => ({ is_default: { noul: d }, is_block: { noul: b },
  is_section: { noul: s }, title_above: { noul: t }, merge: { noul: m } });
const F = (over = {}) => ({ inside: [1], layout: 'single', imageOnly: false, fullBleed: false,
  loneHeading: false, ...over });

test('decide: the most probable kind, then what the page settles', () => {
  assert.equal(decide(answers(0.2, 0.8, 0.3), F()).kind, 'block');
  assert.equal(decide(answers(0.2, 0.8, 0.3, 0.7), F()).kind, 'section',
    'a block with a heading introducing it is a section');
  assert.equal(decide(answers(0.9, 0.1, 0.1), F({ layout: 'main-right' })).kind, 'section',
    'a side layout is a section');
  assert.equal(decide(answers(0.1, 0.9, 0.1), F({ layout: 'main-left' })).kind, 'block',
    'unless one block fills both parts: a hero beside its text panel');
  const columns = decide(answers(0.9, 0.1, 0.1), F({ layout: 'columns' }));
  assert.deepEqual([columns.kind, columns.judged], ['block', 'default_content'],
    'equal columns of plain content are a columns block; the judgement is kept');
  assert.equal(decide(answers(0.1, 0.9, 0.1), F({ loneHeading: true })).kind, 'default_content');
  assert.equal(decide(answers(0.1, 0.9, 0.1), F({ imageOnly: true, fullBleed: true })).kind,
    'block');
  assert.equal(decide(answers(0.1, 0.9, 0.1), F({ imageOnly: true })).kind, 'default_content',
    'an image in flow');
  const empty = decide(answers(0.3, 0.3, 0.3, 0.1, 0.0), F({ inside: [] }));
  assert.deepEqual([empty.merge, empty.empty], [1, true], 'an empty band always merges');
});

test('derive: merges by the answer, mixed kinds make a section, the widest layout wins', () => {
  const cands = [{ id: 'C1', top: 0, bottom: 100 }, { id: 'C2', top: 100, bottom: 400 },
    { id: 'C3', top: 400, bottom: 500 }];
  const d = (kind, merge, layout = 'single') => ({ kind, merge, layout });
  const bands = derive(cands, [d('default_content', 0), d('block', MERGE, 'columns'),
    d('default_content', 0.2)]);
  assert.deepEqual(bands.map((b) => [b.id, b.members, b.kind, b.layout, b.top, b.bottom]), [
    ['B1', ['C1', 'C2'], 'section', 'columns', 0, 400],
    ['B2', ['C3'], 'default_content', 'single', 400, 500],
  ]);
});

async function project() {
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
  await trees.write(cwd, page.id, { minWidth: 250, version: 11, url, capturedAt: AT, tree: TREE,
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

test('structurePage: candidates asked with facts and crops, bands derived, composition written',
  async () => {
    const { cwd, page } = await project();
    const asked = [];
    const io = {
      crop: async (shot, top, bottom) => `data:image/jpeg;base64,${top}-${bottom}`,
      askQuestions: async (dep, { state, questions: qs, images }) => {
        asked.push({ state, qs: Object.keys(qs), images });
        // the hero: a block; the breadcrumb: default; the article: prose with a side column
        const byPicture = {
          'one large image covering most of the band': answers(0.1, 0.9, 0.2),
          'no image': state.band.text === 'no text' ? answers(0.9, 0.1, 0.1)
            : answers(0.8, 0.1, 0.4),
        };
        const a = byPicture[state.band.picture] ?? answers(0.5, 0.3, 0.3);
        if (!('merge' in qs)) delete a.merge;
        return { answers: a, usage: { inputTokens: 1000 } };
      },
    };
    const out = await structure(cwd, 'ten', { io, dep: { model: 'fake' } });
    assert.deepEqual(out, [{ id: page.id, candidates: 3, bands: 3, kinds: 'b d s/main-left',
      tokens: 3000 }]);
    assert.equal(asked.length, 3);
    assert.deepEqual(asked[0].qs, ['is_default', 'is_block', 'is_section', 'title_above']);
    assert.deepEqual(asked[2].images, ['data:image/jpeg;base64,800-3800',
      'data:image/jpeg;base64,700-3800'], 'the band, then the previous above it');
    assert.equal(asked[2].state.previous.text, 'no text', 'a breadcrumb is links, not text');
    assert.equal(asked[2].state.previous.links, 'one link or button');
    const { bands, composition } = await data(cwd);
    const s = await bands.readStructure(cwd, page.id);
    assert.equal(s.method.name, METHOD);
    assert.deepEqual(s.bands.map((b) => [b.kind, b.layout]),
      [['block', 'single'], ['default_content', 'single'], ['section', 'main-left']]);
    assert.equal(s.candidates[0].facts.imageOnly, true);
    assert.equal(s.candidates[2].answers.merge, 0.1);
    const comp = await composition.read(cwd, page.id);
    assert.equal(comp.sections.length, 3);
    assert.deepEqual(comp.sections[2].style, { background: 'none', layout: 'main-left' });
    assert.deepEqual(comp.sections[2].items.map((i) => i.role), ['content']);
    assert.equal(comp.sections[2].selector, 'div.article, aside.side');
    assert.equal(comp.fragments.length, 2, 'the chrome stays as placed');
  });

test('structurePage returns null for a page without a capture or a shot', async () => {
  const { cwd, page } = await project();
  const { trees } = await data(cwd);
  await trees.write(cwd, page.id, { minWidth: 250, version: 11, url: `${O}guide.html`,
    capturedAt: AT, tree: TREE, text: 'BODY', nodeMap: {}, page: { scrollHeight: 4000, shot: null,
      timings: {} } });
  assert.equal(await structurePage(cwd, page.id, { io: {}, dep: { model: 'fake' } }), null);
});

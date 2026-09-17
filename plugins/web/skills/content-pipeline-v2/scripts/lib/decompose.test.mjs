import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decompose, sections } from './decompose.mjs';
import { DEFAULT_RULES, mergeRules, readRules, seedRules } from './elements-rules.mjs';
import { resolveProject } from './project.mjs';

const W = 1200;
const node = (selector, y, height, children = [], extra = {}) => ({
  tag: 'DIV', selector, bounds: { x: 0, y, width: W, height }, children, ...extra,
});
const text = (tag, selector, y, h = 30) => ({
  tag, selector, bounds: { x: 0, y, width: W, height: h }, children: [],
});
const capture = (children, height = 3000) => ({
  url: 'https://site.example/p', tree: node('body', 0, height, children),
});
const ids = (list) => list.map((n) => n.selector);

test('chrome members are dropped and the wrappers around them peeled', () => {
  const header = node('body > header', 0, 100);
  const footer = node('body > div.wrap > footer', 2800, 200);
  const content = node('body > div.wrap > main', 100, 2700, [
    node('body > div.wrap > main > section.a', 100, 1000,
      [node('x1', 100, 500), node('x2', 600, 500)]),
    node('body > div.wrap > main > section.b', 1100, 1700,
      [node('y1', 1100, 800), node('y2', 1900, 900)]),
  ]);
  const cap = capture([header, node('body > div.wrap', 100, 2900, [content, footer])]);
  const got = sections(cap, { chromeSelectors: [header.selector, footer.selector] });
  assert.deepEqual(ids(got),
    ['body > div.wrap > main > section.a', 'body > div.wrap > main > section.b']);
});

test('a dominant container is peeled and the node escaped next to it stays a section', () => {
  const hero = node('body > div.hero-img', 0, 400);
  const container = node('body > div.container', 0, 2800, [
    node('body > div.container > div.s1', 0, 1400, [node('a', 0, 700), node('b', 700, 700)]),
    node('body > div.container > div.s2', 1400, 1400, [node('c', 1400, 700), node('d', 2100, 700)]),
  ]);
  const got = sections(capture([hero, container]));
  assert.deepEqual(ids(got),
    ['body > div.hero-img', 'body > div.container > div.s1', 'body > div.container > div.s2']);
});

test('a leaf component is never peeled, however tall or lone', () => {
  const article = node('body > div.text', 0, 2900, [
    text('H1', 'h', 0), text('P', 'p1', 40, 1400), text('P', 'p2', 1440, 1400),
  ]);
  assert.deepEqual(ids(sections(capture([article]))), ['body > div.text']);
});

test('hairlines, zero-width and off-page nodes are not sections', () => {
  const rule = node('body > hr', 500, 4);
  const empty = node('body > div.empty', 600, 100, [],
    { bounds: { x: 0, y: 600, width: 0, height: 100 } });
  const offPage = node('body > div.sr-live', 0, 100, [],
    { bounds: { x: -10000, y: 0, width: 1, height: 100 } });
  const a = node('body > div.a', 0, 500, [node('a1', 0, 250), node('a2', 250, 250)]);
  const b = node('body > div.b', 700, 1500, [node('b1', 700, 750), node('b2', 1450, 750)]);
  assert.deepEqual(ids(sections(capture([a, rule, empty, offPage, b]))),
    ['body > div.a', 'body > div.b']);
});

test('a node promoted out of a sibling section is a part of it, not a section', () => {
  const banner = node('body > div.banner', 0, 600,
    [node('body > div.banner > div.t', 0, 300), node('body > div.banner > div.u', 300, 300)]);
  const promoted = node('body > div.banner > div > div.banner-img', 0, 600);
  const viaChain = node('body > div.c > div.inner > div.track', 600, 500);
  const collapsed = node('body > div.c', 600, 500, [node('k1', 600, 250), node('k2', 850, 250)],
    { collapsed: [{ selector: 'body > div.c' }, { selector: 'body > div.c > div.inner' }] });
  const rest = node('body > div.rest', 1100, 1500, [node('r1', 1100, 750), node('r2', 1850, 750)]);
  const got = sections(capture([banner, promoted, collapsed, viaChain, rest]));
  assert.deepEqual(ids(got), ['body > div.banner', 'body > div.c', 'body > div.rest']);
});

test('rules: a chrome selector the chrome step missed, and a rejected selector', () => {
  const bar = node('body > div.cookie-bar', 0, 80);
  const promo = node('body > div.promo', 80, 120);
  const a = node('body > div.a', 200, 1400, [node('a1', 200, 700), node('a2', 900, 700)]);
  const b = node('body > div.b', 1600, 1400, [node('b1', 1600, 700), node('b2', 2300, 700)]);
  const cap = capture([bar, promo, a, b]);
  assert.deepEqual(ids(sections(cap)),
    ['body > div.cookie-bar', 'body > div.promo', 'body > div.a', 'body > div.b']);
  const rules = mergeRules({ chrome: ['body > div.cookie-bar'], reject: ['body > div.promo'] });
  assert.deepEqual(ids(sections(cap, { rules })), ['body > div.a', 'body > div.b']);
});

test('rules: defaults without a file, overrides on top, unknown keys refused', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-rules-'));
  const p = resolveProject(root);
  const defaults = await readRules(p);
  assert.equal(defaults.containerShare, DEFAULT_RULES.containerShare);
  assert.ok(defaults.leafTags.has('P'));
  await mkdir(p.step('elements'), { recursive: true });
  await writeFile(path.join(p.step('elements'), 'rules.json'),
    JSON.stringify({
      _example: { merge: { 't-1': 't-2' } }, containerShare: 0.5, reject: ['body > x'],
    }));
  const rules = await readRules(p);
  assert.equal(rules.containerShare, 0.5);
  assert.ok(rules.reject.has('body > x'));
  assert.equal(rules.recurrence, 2);
  assert.throws(() => mergeRules({ containerShar: 0.5 }),
    /unknown key\(s\) containerShar; known: containerShare/);
  await writeFile(path.join(p.step('elements'), 'rules.json'), '{ nope');
  await assert.rejects(readRules(p), /rules.json: not valid JSON/);
});

test('rules: wrong shapes, invalid expressions and merge chains are refused by name', () => {
  assert.throws(() => mergeRules({ reject: 'body > div.promo' }),
    /rules.json: reject must be a list of strings/);
  assert.throws(() => mergeRules({ containerShare: '0.5' }), /containerShare must be a number/);
  assert.throws(() => mergeRules({ identityExclusions: ['('] }),
    /identityExclusions\[0\] "\(" is not a valid regular expression/);
  assert.throws(() => mergeRules({ merge: ['a'] }), /merge must be an object/);
  assert.throws(() => mergeRules({ merge: { 't-a': 't-b', 't-b': 't-c' } }),
    /merge: target t-b is itself merged into t-c; point t-a at t-c/);
  assert.throws(() => mergeRules({ merge: { 't-a': 't-b', 't-b': 't-a' } }), /merge: target/);
  assert.ok(mergeRules({ merge: { 't-a': 't-c', 't-b': 't-c' } }), 'two sources, one target');
});

test('decompose reports what it dropped and why; the chrome step\'s members are not news', () => {
  const header = node('body > header', 0, 100);
  const bar = node('body > div.cookie-bar', 100, 80);
  const rule = node('body > hr', 180, 4);
  const helper = node('body > div.sr', 0, 50, [],
    { bounds: { x: 0, y: -9999, width: 100, height: 50 } });
  const a = node('body > div.a', 200, 1400, [node('a1', 200, 700), node('a2', 900, 700)]);
  const part = node('body > div.a > div > img.hero', 200, 300);
  const b = node('body > div.b', 1600, 1400, [node('b1', 1600, 700), node('b2', 2300, 700)]);
  const rules = mergeRules({ chrome: ['body > div.cookie-bar'] });
  const { sections: got, rejected } = decompose(capture([header, bar, rule, helper, a, part, b]),
    { chromeSelectors: [header.selector], rules });
  assert.deepEqual(ids(got), ['body > div.a', 'body > div.b']);
  assert.deepEqual(rejected, [
    { selector: 'body > div.cookie-bar', reason: 'rules.chrome' },
    { selector: 'body > hr', reason: 'hairline' },
    { selector: 'body > div.sr', reason: 'off-page' },
    { selector: 'body > div.a > div > img.hero', reason: 'part', of: 'body > div.a' },
  ]);
});

test('a dominant container with a single non-leaf child is still a container', () => {
  const hero = node('body > div.hero-img', 0, 400);
  const grid = node('body > div.c > div.grid', 0, 2800, [
    node('body > div.c > div.grid > div.s1', 0, 1400, [node('a', 0, 700), node('b', 700, 700)]),
    node('body > div.c > div.grid > div.s2', 1400, 1400,
      [node('c', 1400, 700), node('d', 2100, 700)]),
  ]);
  const got = sections(capture([hero, node('body > div.c', 0, 2800, [grid])]));
  assert.deepEqual(ids(got), ['body > div.hero-img', 'body > div.c > div.grid > div.s1',
    'body > div.c > div.grid > div.s2']);
});

test('containers and fragments: decomposition continues into them, within recorded', () => {
  const column = node('body > div.column', 0, 2000, [
    text('H2', 'body > div.column > h2', 0, 60),
    node('body > div.column > div.cards', 60, 900, [node('c1', 60, 450), node('c2', 510, 450)]),
    node('body > div.column > div.xf', 960, 1040, [
      node('body > div.column > div.xf > div.banner', 960, 500,
        [node('b1', 960, 250), node('b2', 1210, 250)]),
      node('body > div.column > div.xf > hr', 1460, 2),
      node('body > div.column > div.xf > div.faq', 1462, 538,
        [node('f1', 1462, 269), node('f2', 1731, 269)]),
    ], { className: 'xf' }),
  ], { className: 'column' });
  const aside = node('body > div.aside', 0, 900, [node('a1', 0, 450), node('a2', 450, 450)]);
  const cap = capture([column, aside], 5000);
  assert.deepEqual(ids(sections(cap)), ['body > div.column', 'body > div.aside']);
  const rules = mergeRules({ containers: ['DIV#.column'], fragments: ['DIV#.xf'] });
  const { sections: got, rejected } = decompose(cap, { rules });
  assert.deepEqual(ids(got), ['body > div.column > h2', 'body > div.column > div.cards',
    'body > div.column > div.xf > div.banner', 'body > div.column > div.xf > div.faq',
    'body > div.aside']);
  assert.deepEqual(got[0].within,
    [{ kind: 'container', identity: 'DIV#.column', selector: 'body > div.column' }]);
  assert.deepEqual(got[2].within.map((w) => w.kind), ['container', 'fragment']);
  assert.equal(got[4].within, undefined);
  assert.deepEqual(rejected, [{ selector: 'body > div.column > div.xf > hr', reason: 'hairline' }]);
  const empty = node('body > div.xf', 0, 500, [], { className: 'xf' });
  assert.deepEqual(ids(sections(capture([empty, aside], 5000), { rules })),
    ['body > div.xf', 'body > div.aside'], 'a fragment without visible children stays a section');
});

test('the first run seeds rules.json with the vocabulary; a second does not touch it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-seed-'));
  const p = resolveProject(root);
  await mkdir(p.step('elements'), { recursive: true });
  assert.equal(await seedRules(p), true);
  const text = await readFile(path.join(p.step('elements'), 'rules.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['_example']);
  const rules = await readRules(p);
  assert.equal(rules.containers.size, 0, 'the example is not a rule');
  await writeFile(path.join(p.step('elements'), 'rules.json'), '{"reject":["x"]}');
  assert.equal(await seedRules(p), false);
  assert.ok((await readRules(p)).reject.has('x'));
});

test('through a collapsed chain: wrappers in the chain are peeled, the first other is the section',
  () => {
    // page-tree folded xf > cmp-xf > grid > banner > wrapper into one node whose box and
    // children are the innermost wrapper's; the banner is in the chain, not a child.
    const chain = [
      { tag: 'DIV', className: 'xf', selector: '#xf-1' },
      { tag: 'DIV', className: 'cmp-xf', selector: '#xf-1 > div.cmp-xf' },
      { tag: 'DIV', className: 'banner image', selector: '#banner-1' },
      { tag: 'DIV', className: 'wrapper', selector: '#banner-1 > div.wrapper' },
    ];
    const folded = node('#banner-1 > div.wrapper', 0, 500, [
      node('#banner-1 > div.wrapper > div.text', 0, 250, [], { className: 'text' }),
      node('#banner-1 > div.wrapper > div.cta', 250, 250, [], { className: 'cta' }),
    ], { className: 'xf', collapsed: chain });
    const part = node('#banner-1 > div > div.banner-img', 0, 500, [], { className: 'banner-img' });
    const rest = node('body > div.rest', 500, 1400, [node('r1', 500, 700), node('r2', 1200, 700)],
      { className: 'rest' });
    const cap = capture([folded, part, rest], 5000);
    const rules = mergeRules({ fragments: ['DIV#.xf'], containers: ['DIV#.cmp-xf'] });
    const { sections: got, rejected } = decompose(cap, { rules });
    assert.deepEqual(ids(got), ['#banner-1 > div.wrapper', 'body > div.rest']);
    assert.deepEqual(got[0].collapsed.map((c) => c.className), ['banner image', 'wrapper'],
      're-headed at the banner: its identity and selectors are the banner\'s');
    assert.deepEqual(got[0].within.map((w) => `${w.kind}:${w.identity}@${w.selector}`),
      ['fragment:DIV#.xf@#banner-1 > div.wrapper', 'container:DIV#.cmp-xf@#xf-1 > div.cmp-xf']);
    assert.deepEqual(rejected, [{ selector: '#banner-1 > div > div.banner-img', reason: 'part',
      of: '#banner-1 > div.wrapper' }], 'the promoted image is a part of the banner again');
    const all = mergeRules({ fragments: ['DIV#.xf'],
      containers: ['DIV#.cmp-xf', 'DIV#.banner.image', 'DIV#.wrapper'] });
    assert.deepEqual(ids(sections(cap, { rules: all })),
      ['#banner-1 > div.wrapper > div.text', '#banner-1 > div.wrapper > div.cta',
        '#banner-1 > div > div.banner-img', 'body > div.rest'],
      'a chain of containers all the way down falls to the children; the image, promoted out'
        + ' of a peeled banner, is content of its own');
  });

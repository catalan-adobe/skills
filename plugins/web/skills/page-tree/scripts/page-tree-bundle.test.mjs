// The bundle is browser code; its pure functions are tested here by loading it into a vm
// with a bare `window`. Run: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./page-tree-bundle.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, { window });
const {
  collapseSingleChildren, processTree, promoteEscapedNodes, pruneZeroHeightLeaves,
} = window.__visualTree;

const node = (tag, selector, bounds, children = [], extra = {}) => ({
  tag, selector, bounds, children, ...extra,
});
const box = (x, y, width, height) => ({ x, y, width, height });

test('a zero-height wrapper collapsing onto its visible child takes the child\'s box', () => {
  // A transparent header: the sticky wrapper is 0 px high, the absolutely positioned nav
  // inside it is 1280×80 at the top of the page.
  const nav = node('DIV', '#topNav', box(0, 53, 1280, 80), [], { id: 'topNav', text: 'Why us' });
  const wrapper = node('DIV', 'div.sticky-nav', box(0, 53, 1280, 0), [nav],
    { className: 'experiencefragment sticky-nav' });
  const hero = node('DIV', 'div.hero', box(0, 53, 1280, 700));
  const body = node('BODY', 'body', box(0, 0, 1280, 4000), [wrapper, hero]);
  collapseSingleChildren(body);
  pruneZeroHeightLeaves(body);
  assert.equal(body.children.length, 2, 'the nav survives next to the hero');
  const [first] = body.children;
  assert.deepEqual(first.bounds, box(0, 53, 1280, 80), 'with the child\'s geometry');
  assert.equal(first.selector, '#topNav');
  assert.equal(first.id, 'topNav');
  assert.equal(first.text, 'Why us');
});

test('a wrapper that contains its single child keeps its own box and identity', () => {
  const inner = node('DIV', 'div.inner', box(10, 10, 1260, 60), [], { className: 'inner' });
  const outer = node('DIV', 'div.outer', box(0, 0, 1280, 80), [inner], { className: 'outer' });
  const body = node('BODY', 'body', box(0, 0, 1280, 1000),
    [outer, node('DIV', 'x', box(0, 80, 1280, 900))]);
  collapseSingleChildren(body);
  const [first] = body.children;
  assert.deepEqual(first.bounds, box(0, 0, 1280, 80));
  assert.equal(first.selector, 'div.outer');
  assert.equal(first.className, 'outer');
});

test('a child escaping a parent that has area is not collapsed: promotion lifts it', () => {
  // A menu trigger with its dropdown overflowing below it: two visible things, not one.
  const menu = node('DIV', 'div.menu', box(0, 20, 1280, 400), [], { className: 'menu' });
  const trigger = node('DIV', 'div.trigger', box(0, 0, 1280, 20), [menu], { className: 'trigger' });
  const body = node('BODY', 'body', box(0, 0, 1280, 1000),
    [trigger, node('DIV', 'y', box(0, 420, 1280, 500))]);
  collapseSingleChildren(body);
  assert.equal(body.children[0].selector, 'div.trigger', 'the trigger keeps its own box');
  assert.deepEqual(body.children[0].bounds, box(0, 0, 1280, 20));
  assert.equal(body.children[0].children[0].selector, 'div.menu', 'and its child');
  const promoted = promoteEscapedNodes(body);
  assert.deepEqual([...promoted].map((n) => n.selector), ['div.menu'],
    'the escaped dropdown is promoted to the root as an overlay');
  assert.equal(body.children.length, 3);
});

test('a collapsed node lists every element it absorbed, whichever one owns the box', () => {
  const nav = node('DIV', '#topNav', box(0, 53, 1280, 80), [], { id: 'topNav' });
  const contained = node('DIV', 'div.wrap', box(0, 53, 1280, 80), [nav], { className: 'wrap' });
  const empty = node('DIV', 'div.wrap', box(0, 53, 1280, 0), [nav], { className: 'wrap' });
  for (const wrapper of [contained, empty]) {
    const body = node('BODY', 'body', box(0, 0, 1280, 1000),
      [wrapper, node('DIV', 'z', box(0, 133, 1280, 800))]);
    collapseSingleChildren(body);
    assert.deepEqual(JSON.parse(JSON.stringify(body.children[0].collapsed)), [
      { tag: 'DIV', selector: 'div.wrap', className: 'wrap' },
      { tag: 'DIV', selector: '#topNav', id: 'topNav' },
    ]);
  }
  assert.equal(contained.selector, 'div.wrap', 'the containing wrapper keeps its identity');
  assert.equal(empty.selector, '#topNav', 'the empty wrapper takes the child\'s');
});

test('nested collapses keep the whole chain, and the chain does not depend on heights', () => {
  const build = (h) => {
    const nav = node('DIV', '#topNav', box(0, 53, 1280, 80), [], { id: 'topNav' });
    const grid = node('DIV', 'div.grid', box(0, 53, 1280, h), [nav], { className: 'grid' });
    const cmp = node('DIV', 'div.cmp', box(0, 53, 1280, h), [grid], { className: 'cmp' });
    const wrap = node('DIV', 'div.wrap', box(0, 53, 1280, h), [cmp], { className: 'wrap' });
    const body = node('BODY', 'body', box(0, 0, 1280, 1000),
      [wrap, node('DIV', 'z', box(0, 133, 1280, 800))]);
    collapseSingleChildren(body);
    return body.children[0];
  };
  const tall = build(80);
  const flat = build(0);
  const names = (n) => JSON.parse(JSON.stringify(n.collapsed.map((c) => c.selector)));
  assert.deepEqual(names(tall), ['div.wrap', 'div.cmp', 'div.grid', '#topNav']);
  assert.deepEqual(names(flat), names(tall), 'zero-height intermediates leave the same chain');
  assert.equal(tall.selector, 'div.wrap');
  assert.equal(flat.selector, '#topNav');
});

// ---- processTree: the pure pipeline as captureVisualTree runs it, on whole pages ----

const plain = (n) => JSON.parse(JSON.stringify(n));
const ids = (nodeMap) => Object.keys(nodeMap);
const page = (children, height = 4000) => (
  node('BODY', 'body', box(0, 0, 1280, height), children));
const utility = () => node('DIV', '#utility', box(0, 0, 1280, 53), [], { id: 'utility' });
const content = (y, h) => (
  node('DIV', 'div.content', box(0, y, 1280, h), [], { className: 'content' }));
const footer = (height) => node('DIV', 'div.footer', box(0, height - 600, 1280, 600), [],
  { className: 'footer' });

test('processTree: a transparent header over a hero keeps the nav next to the hero', () => {
  const nav = node('DIV', '#topNav', box(0, 53, 1280, 80), [], { id: 'topNav' });
  const grid = node('DIV', 'div.grid', box(0, 53, 1280, 0), [nav], { className: 'grid' });
  const wrapper = node('DIV', 'div.sticky-nav', box(0, 53, 1280, 0), [grid],
    { className: 'experiencefragment sticky-nav' });
  const hero = node('DIV', 'div.hero', box(0, 53, 1280, 700), [], { className: 'hero' });
  const { root, nodeMap } = processTree(page([utility(), wrapper, hero, footer(4000)]));
  assert.deepEqual(Array.from(root.children, (c) => c.selector),
    ['#utility', '#topNav', 'div.hero', 'div.footer']);
  assert.deepEqual(plain(root.children[1].bounds), box(0, 53, 1280, 80));
  assert.deepEqual(plain(root.children[1].collapsed).map((c) => c.selector),
    ['div.sticky-nav', 'div.grid', '#topNav']);
  assert.deepEqual(ids(nodeMap), ['r', 'rc1', 'rc2', 'rc3', 'rc4']);
});

test('processTree: the same header with an 80 px wrapper keeps the wrapper identity', () => {
  const nav = node('DIV', '#topNav', box(0, 53, 1280, 80), [], { id: 'topNav' });
  const wrapper = node('DIV', 'div.sticky-nav', box(0, 53, 1280, 80), [nav],
    { className: 'experiencefragment sticky-nav' });
  const { root } = processTree(page([utility(), wrapper, content(133, 3000), footer(4000)]));
  assert.equal(root.children[1].selector, 'div.sticky-nav');
  assert.deepEqual(plain(root.children[1].collapsed).map((c) => c.selector),
    ['div.sticky-nav', '#topNav'], 'the chain still names the nav');
});

test('processTree: a dropdown overflowing its trigger is promoted and marked as occluding', () => {
  const menu = node('DIV', 'div.menu', box(0, 133, 1280, 400), [], { className: 'menu' });
  const trigger = node('DIV', 'div.trigger', box(0, 53, 1280, 80), [menu],
    { className: 'trigger' });
  const { root, nodeMap, promotedToRoot } = processTree(
    page([utility(), trigger, content(133, 3000), footer(4000)]),
  );
  assert.deepEqual(Array.from(root.children, (c) => c.selector),
    ['#utility', 'div.trigger', 'div.content', 'div.footer', 'div.menu']);
  assert.deepEqual([...promotedToRoot].map((n) => n.selector), ['div.menu']);
  assert.deepEqual(plain(nodeMap.rc5.overlay), { occluding: ['rc3'] },
    'the menu covers the content');
  assert.equal(nodeMap.rc2.overlay, undefined);
});

test('processTree: a fixed cookie banner at the bottom is promoted to the root', () => {
  const banner = node('DIV', '#cmp', box(0, 3800, 1280, 200), [], { id: 'cmp' });
  const deep = node('DIV', 'div.a', box(0, 133, 1280, 100), [
    node('DIV', 'div.b', box(0, 133, 1280, 100), [], { className: 'b' }),
    banner,
  ], { className: 'a' });
  const { root, promotedToRoot } = processTree(page([utility(), deep, footer(4000)]));
  assert.deepEqual([...promotedToRoot].map((n) => n.selector), ['#cmp']);
  assert.ok(root.children.includes(banner));
  assert.deepEqual(plain(root.children[1].children).map((c) => c.selector), ['div.b']);
});

test('processTree: a hairline stays a node here (consumers decide what is structure)', () => {
  const bar = node('DIV', 'div.pb_table', box(0, 128, 1280, 5), [], { className: 'pb_table' });
  const nav = node('DIV', 'div.nav', box(0, 53, 1280, 80), [], { className: 'nav' });
  const wrapper = node('DIV', 'div.wrap', box(0, 53, 1280, 80), [nav, bar], { className: 'wrap' });
  const { root } = processTree(page([utility(), wrapper, content(133, 3000), footer(4000)]));
  assert.deepEqual(plain(root.children[1].children).map((c) => c.bounds.height), [80, 5]);
});

test('processTree: zero-area leaves go; a zero-area shell with two children hands them up', () => {
  const empty = node('DIV', 'div.empty', box(0, 133, 1280, 0), [], { className: 'empty' });
  const shell = node('DIV', 'div.shell', box(0, 133, 0, 0), [
    node('DIV', 'div.x', box(0, 133, 1280, 100), [], { className: 'x' }),
    node('DIV', 'div.y', box(0, 233, 1280, 100), [], { className: 'y' }),
  ], { className: 'shell' });
  const { root, promotedToRoot } = processTree(page([utility(), empty, shell, footer(4000)]));
  assert.deepEqual(Array.from(root.children, (c) => c.selector),
    ['#utility', 'div.footer', 'div.x', 'div.y'],
    'the empty leaf is gone; the shell cannot contain its children, so they are promoted');
  assert.deepEqual([...promotedToRoot].map((n) => n.selector), ['div.x', 'div.y']);
});

test('processTree: an escaped child lands on the nearest ancestor that contains it', () => {
  const inner = node('DIV', 'div.inner', box(0, 400, 1280, 100), [], { className: 'inner' });
  const small = node('DIV', 'div.small', box(0, 133, 1280, 50), [
    node('DIV', 'div.s1', box(0, 133, 1280, 50), [], { className: 's1' }), inner,
  ], { className: 'small' });
  const section = node('DIV', 'div.section', box(0, 133, 1280, 1000), [
    small, node('DIV', 'div.s2', box(0, 600, 1280, 100), [], { className: 's2' }),
  ], { className: 'section' });
  const { root, promotedToRoot } = processTree(page([utility(), section, footer(4000)]));
  assert.equal(promotedToRoot.size, 0, 'not promoted to the root');
  assert.deepEqual(plain(root.children[1].children).map((c) => c.selector),
    ['div.small', 'div.s2', 'div.inner'], 'it moved up one level, to the section');
});

test('processTree: a fixed element is never absorbed by a collapse; it floats to root', () => {
  const banner = node('DIV', '#cmp', box(0, 520, 1280, 200), [], { id: 'cmp', fixed: true });
  const deeper = node('DIV', 'div.deeper', box(0, 133, 1280, 0), [banner],
    { className: 'deeper' });
  const body = page([utility(), node('DIV', 'div.content', box(0, 53, 1280, 3000), [deeper],
    { className: 'content' }), footer(4000)]);
  const { root, nodeMap, promotedToRoot } = processTree(body);
  assert.deepEqual([...promotedToRoot].map((n) => n.selector), ['#cmp']);
  assert.deepEqual(Array.from(root.children, (c) => c.selector),
    ['#utility', 'div.content', 'div.footer', '#cmp']);
  assert.deepEqual(plain(nodeMap.rc4.overlay), { occluding: ['rc2'] });
});

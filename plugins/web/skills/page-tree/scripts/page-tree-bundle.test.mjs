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
  collapseSingleChildren, promoteEscapedNodes, pruneZeroHeightLeaves,
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

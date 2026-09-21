import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidates, chromeCandidates, fingerprint, stableId, structuralChildren, tokens, walk,
} from './chrome.mjs';

const box = (y, height, width = 1280, x = 0) => ({ x, y, width, height });
const el = (tag, className, bounds, children = [], extra = {}) => ({
  tag, className, selector: `${tag.toLowerCase()}.${className.split(' ')[0]}`, bounds,
  children, ...extra,
});

// A page: utility bar, nav, a hero (not on every page), content of varying length, footer.
function page(n, { height = 3000 + n * 137, nav = 'nav-top', hero = true, footer = true } = {}) {
  const children = [
    el('DIV', 'container-fluid', box(0, 53), [], { id: 'utility-nav-bar' }),
    el('DIV', `experiencefragment ${n % 2 ? 'is-open' : ''}`, box(53, 80),
      [el('DIV', nav, box(53, 80))]),
  ];
  if (hero) children.push(el('DIV', 'banner', box(133, 500), [], { id: `banner-${n}a1b2c3` }));
  children.push(el('DIV', 'card', box(700 + n * 90, 300)));
  children.push(el('DIV', 'card', box(1100 + n * 90, 300)));
  if (footer) {
    children.push(el('DIV', 'experiencefragment', box(height - 500, 500), [
      el('DIV', 'siteFooter row', box(height - 500, 400), [],
        { id: `experiencefragment-${n}9f8e7d` }),
    ]));
  }
  return {
    url: `https://site.example/p${n}.html`, tree: el('BODY', 'page', box(0, height), children),
  };
}

test('tokens drop state and generated names; stableId drops hashed ids', () => {
  assert.deepEqual(tokens('nav active is-open experiencefragment cmp-123456 b'), [
    'b', 'experiencefragment', 'nav',
  ]);
  assert.equal(stableId('utility-nav-bar'), 'utility-nav-bar');
  assert.equal(stableId('experiencefragment-ce27f6bfde'), '');
  assert.equal(stableId(undefined), '');
});

test('fingerprint ignores text, bounds, active classes and generated ids; sees structure', () => {
  const a = el('DIV', 'nav active', box(0, 80), [el('A', 'link', box(0, 20))], { text: 'Home' });
  const b = el('DIV', 'nav', box(900, 80), [el('A', 'link', box(0, 20))], { text: 'Blog' });
  assert.equal(fingerprint(a), fingerprint(b));
  const link = () => el('A', 'link', box(0, 20));
  const two = el('DIV', 'nav', box(0, 80), [link(), link()]);
  const three = el('DIV', 'nav', box(0, 80), [link(), link(), link()]);
  assert.notEqual(fingerprint(a), fingerprint(two), 'a lone child is descended into');
  assert.equal(fingerprint(two), fingerprint(three),
    'one more of the same child is repetition, not another structure: a footer with four link'
    + ' columns and one with five are one footer');
  const d = el('DIV', 'nav', box(0, 80), [link(), el('SPAN', 'badge', box(0, 20))]);
  assert.notEqual(fingerprint(two), fingerprint(d), 'a different kind of child is structure');
  const e = el('DIV', 'nav', box(0, 80), [el('SPAN', 'badge', box(0, 20)), link()]);
  assert.equal(fingerprint(d), fingerprint(e), 'order does not count either');
  assert.equal(fingerprint({ tag: 'DIV', id: 'x-a1b2c3d4', bounds: box(0, 1) }),
    fingerprint({ tag: 'DIV', id: 'x-e5f6a7b8', bounds: box(0, 1) }));
});

test('a hairline child or a single-child chain does not change the structure', () => {
  const nav = el('DIV', 'nav-top', box(53, 80));
  const bar = el('DIV', 'pb_table', box(128, 5));
  const plain = el('DIV', 'experiencefragment', box(53, 80), [nav]);
  const withBar = el('DIV', 'experiencefragment', box(53, 80), [nav, bar]);
  const collapsed = el('DIV', 'experiencefragment', box(53, 80));
  assert.deepEqual(structuralChildren(withBar), [], 'the bar is dropped, the lone nav collapsed');
  assert.equal(fingerprint(plain), fingerprint(withBar), 'a 5 px progress bar is not structure');
  assert.equal(fingerprint(plain), fingerprint(collapsed),
    'page-tree collapses a single child; so does the fingerprint');
  const two = el('DIV', 'experiencefragment', box(53, 80), [nav, el('DIV', 'search', box(53, 80))]);
  assert.notEqual(fingerprint(plain), fingerprint(two), 'a second real child is structure');
});

test('walk yields every node with its parent fingerprint and bottom offset', () => {
  const nodes = walk(page(1).tree, 3137);
  assert.equal(nodes[0].parent, null);
  assert.equal(nodes[1].parent, nodes[0].fp);
  const footer = nodes.find((n) => n.node.className === 'experiencefragment' && n.y > 1000);
  assert.equal(footer.bottomOffset, 0);
});

test('candidates: recurring elements at a stable position, anchored top or bottom', () => {
  const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => page(n, { hero: n <= 3 }));
  const all = candidates(pages);
  const utility = all.find((c) => c.selectors.includes('div.container-fluid'));
  assert.deepEqual([utility.support, utility.anchored, utility.stable, utility.topSpread],
    [1, 'top', true, 0]);
  const footer = all.find((c) => c.tags.includes('DIV') && c.bounds.bottomOffset === 0
    && c.bounds.height === 500);
  assert.deepEqual([footer.support, footer.anchored, footer.stable, footer.bottomSpread],
    [1, 'bottom', true, 0]);
  assert.ok(footer.topSpread > 1000, 'its y wanders with page length');
  const cards = all.filter((c) => c.selectors.includes('div.card'));
  assert.ok(cards.every((c) => c.support <= 0.2),
    'a drifting card lands in many small buckets, never in one with support');
  const hero = all.find((c) => c.selectors.some((s) => s.startsWith('div.banner')));
  assert.deepEqual([hero.support, hero.stable], [0.3, true], 'a template hero: stable, low');
});

test('chromeCandidates keeps stable ones above the support line, drops same-page children', () => {
  const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => page(n, { hero: n <= 3 }));
  const kept = chromeCandidates(candidates(pages));
  const selectors = kept.flatMap((c) => c.selectors);
  assert.ok(selectors.includes('div.container-fluid'), 'utility bar');
  assert.ok(selectors.includes('div.experiencefragment'), 'nav wrapper and footer wrapper');
  assert.ok(!selectors.includes('div.nav-top'),
    'the nav inner element recurs on exactly the pages of its parent: a child, not chrome');
  assert.ok(!selectors.some((s) => s.startsWith('div.banner')), 'hero under 50 % is out');
  assert.ok(!selectors.includes('div.card'), 'cards are out');
  assert.equal(kept.filter((c) => c.stable === false).length, 0);
});

test('a header that differs on some pages is two candidates at the same position', () => {
  const pages = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => page(n)),
    ...[9, 10].map((n) => {
      const p = page(n);
      const wrapper = p.tree.children[1];
      wrapper.children.push(el('DIV', 'locale-switch', box(53, 80)));
      return p;
    }),
  ];
  const kept = chromeCandidates(candidates(pages), { minSupport: 0.15 });
  const atNav = kept.filter((c) => c.bounds.y === 53 && c.bounds.height === 80 && c.depth === 1);
  assert.equal(atNav.length, 2);
  assert.deepEqual(atNav.map((c) => c.support).sort(), [0.2, 0.8]);
});

test('pages without a footer lower its support but do not break the position', () => {
  const pages = [1, 2, 3, 4, 5].map((n) => page(n, { footer: n !== 5 }));
  const footer = candidates(pages)
    .find((c) => c.bounds.bottomOffset === 0 && c.bounds.height === 500);
  assert.equal(footer.support, 0.8);
  assert.equal(footer.stable, true);
});

test('two different elements with the same fingerprint at the top and the bottom both stay', () => {
  const pages = [1, 2, 3, 4, 5].map((n) => page(n));
  const all = candidates(pages);
  const wrappers = all.filter((c) => c.selectors.includes('div.experiencefragment')
    && c.support === 1);
  assert.deepEqual(wrappers.map((c) => c.anchored).sort(), ['bottom', 'top'],
    'the nav wrapper and the footer wrapper share a fingerprint but are two candidates');
});

test('a collapsed node is identified by its outermost element, not by who owns the box', () => {
  const chain = [
    { tag: 'DIV', selector: 'div.wrap', className: 'experiencefragment sticky-nav' },
    { tag: 'DIV', selector: '#topNav', id: 'topNav' },
  ];
  const asWrapper = el('DIV', 'experiencefragment sticky-nav', box(0, 53, 1280, 80), [],
    { collapsed: chain });
  const asNav = { ...el('DIV', '', box(0, 53, 1280, 80), [], { id: 'topNav', collapsed: chain }) };
  assert.equal(fingerprint(asWrapper), fingerprint(asNav));
  const plainWrapper = el('DIV', 'experiencefragment sticky-nav', box(0, 53, 1280, 80));
  assert.equal(fingerprint(asWrapper), fingerprint(plainWrapper),
    'identity is the outermost element, however deep the collapse went on this page');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidates, chromeCandidates, fingerprint, stableId, tokens, walk,
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
  const c = el('DIV', 'nav', box(0, 80),
    [el('A', 'link', box(0, 20)), el('A', 'link', box(0, 20))]);
  assert.notEqual(fingerprint(a), fingerprint(c), 'a second child changes the structure');
  assert.equal(fingerprint({ tag: 'DIV', id: 'x-a1b2c3d4', bounds: box(0, 1) }),
    fingerprint({ tag: 'DIV', id: 'x-e5f6a7b8', bounds: box(0, 1) }));
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
    ...[9, 10].map((n) => page(n, { nav: 'nav-top other-locale' })),
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

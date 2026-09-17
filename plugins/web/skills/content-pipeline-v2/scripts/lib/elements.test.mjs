import test from 'node:test';
import assert from 'node:assert/strict';
import { identity, inventory, summary, typeId, variantKey } from './elements.mjs';
import { mergeRules } from './elements-rules.mjs';

const W = 1200;
const el = (tag, className, selector, y, height, children = []) => ({
  tag, className, selector, bounds: { x: 0, y, width: W, height }, children,
});
const card = (n, y, withImage = true) => el('DIV', 'card', `c${n}`, y, 200, [
  ...(withImage ? [el('IMG', '', `c${n} > img`, y, 100)] : []),
  el('P', '', `c${n} > p`, y + 100, 100),
]);
// A page: two sections side by side under a body, each with two structural children.
const page = (url, sectionsList) => ({
  url, tree: el('BODY', '', 'body', 0, 1000, sectionsList),
});
const cards = (sel, y, count, cls = 'cards col-sm-4') => el('DIV', cls, sel, y, 400,
  Array.from({ length: count }, (_, i) => card(`${sel}-${i}`, y + i * 10)));
const text = (sel, y) => el('DIV', 'text', sel, y, 300,
  [el('H2', '', `${sel} > h2`, y, 50), el('P', '', `${sel} > p`, y + 50, 250)]);

test('identity is the element itself: width tokens out, children never in', () => {
  const rules = mergeRules();
  assert.equal(identity(cards('a', 0, 3), rules), 'DIV#.cards');
  assert.equal(identity(cards('a', 0, 3, 'cards aem-GridColumn--default--12'), rules),
    'DIV#.cards');
  assert.equal(identity(cards('a', 0, 5), rules), identity(cards('b', 0, 2), rules));
  const collapsed = { ...cards('a', 0, 1), collapsed: [{ tag: 'SECTION', className: 'outer' }] };
  assert.equal(identity(collapsed, rules), 'SECTION#.outer', 'the outermost of the chain');
  assert.equal(identity(cards('a', 0, 1), mergeRules({ noiseClasses: ['cards'] })), 'DIV#.');
  assert.match(typeId('DIV#.cards'), /^t-[0-9a-f]{8}$/);
});

test('variant is the set of children identities: three cards and five are one variant', () => {
  const rules = mergeRules();
  assert.deepEqual(variantKey(cards('a', 0, 3), rules), ['DIV#.card']);
  assert.deepEqual(variantKey(cards('a', 0, 5), rules), variantKey(cards('b', 0, 2), rules));
  const mixed = el('DIV', 'cards', 'm', 0, 400, [card('m1', 0), text('m > t', 200)]);
  assert.deepEqual(variantKey(mixed, rules), ['DIV#.card', 'DIV#.text']);
});

test('inventory: types by pages, recurring, variants, coverage and compositions', () => {
  const pages = [
    page('u1', [cards('s1', 0, 3), text('s2', 400)]),
    page('u2', [cards('s1', 0, 5), text('s2', 400)]),
    page('u3', [text('s2', 0), el('DIV', 'promo', 'x', 300, 300,
      [el('DIV', '', 'x > a', 300, 150), el('DIV', '', 'x > b', 450, 150)])]),
  ];
  const out = inventory(pages, { groupOf: (u) => (u === 'u3' ? 'other' : 'main') });
  assert.deepEqual(out.types.map((t) => [t.identity, t.pages, t.recurring, t.variants.length]), [
    ['DIV#.text', 3, true, 1], ['DIV#.cards', 2, true, 1], ['DIV#.promo', 1, false, 1],
  ]);
  assert.deepEqual(out.types[1].groups, { main: 2 });
  assert.deepEqual(out.types[1].heightRange, [400, 400]);
  assert.deepEqual(out.pages.map((p) => [p.url, p.coverage, p.covered]), [
    ['u1', 1, 'full'], ['u2', 1, 'full'], ['u3', 0.5, 'partial'],
  ]);
  assert.deepEqual(out.compositions.map((c) => [c.pages, c.groups]),
    [[2, { main: 2 }], [1, { other: 1 }]]);
  assert.deepEqual(summary(out), {
    pages: 3, sections: 6, types: 3, recurring: 2,
    covered: { full: 2, partial: 1, none: 0 }, unique: { types: 1, pages: 1 },
  });
});

test('a merge rule joins two identities into one type and records both', () => {
  const pages = [page('u1', [cards('s1', 0, 3), text('s2', 400)]),
    page('u2', [cards('s1', 0, 3, 'tiles'), text('s2', 400)])];
  const plain = inventory(pages);
  assert.equal(plain.types.length, 3);
  const rules = mergeRules({ merge: { [typeId('DIV#.tiles')]: typeId('DIV#.cards') } });
  const merged = inventory(pages, { rules });
  assert.equal(merged.types.length, 2);
  const cardsType = merged.types.find((t) => t.id === typeId('DIV#.cards'));
  assert.deepEqual([cardsType.pages, cardsType.mergedFrom.sort()],
    [2, ['DIV#.cards', 'DIV#.tiles']]);
});

test('recurrence counts pages, not instances; a page of unique sections has no coverage', () => {
  const out = inventory([page('u1', [text('s2', 0), text('s3', 300)]),
    page('u2', [el('DIV', 'one', 'o', 0, 500, [el('DIV', '', 'o > a', 0, 250),
      el('DIV', '', 'o > b', 250, 250)])])]);
  assert.deepEqual(out.pages.map((p) => p.covered), ['none', 'none'], 'text is on one page');
  const withThird = inventory([...[page('u1', [text('s2', 0), text('s3', 300)]),
    page('u3', [text('s2', 0), text('s3', 300)])]]);
  assert.deepEqual(withThird.pages.map((p) => p.covered), ['full', 'full']);
});

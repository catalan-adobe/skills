import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containerLeafTypes, deriveInventory, mappableTypes, renderMappingMd, seedMapping,
  validateMapping,
} from './mapping.mjs';

const type = (id, identity, extra = {}) => ({
  id, identity, recurring: true, pages: 2, instances: 3, medianHeight: 200, variants: [{}],
  sample: { url: 'https://x.example/a', selector: `#${id}` },
  screenshots: { instances: [`screenshots/type-${id}-1.png`] }, ...extra,
});
const section = (t, within) => ({
  type: t, selector: `#${t}`, height: 100, ...(within ? { within } : {}),
});
const elements = {
  types: [
    type('t-hero', 'DIV#.banner'),
    type('t-text', 'DIV#.text', { instances: 40, pages: 3 }),
    type('t-cards', 'DIV#.cards'),
    type('t-odd', 'TR#.row', { pages: 2 }),
    type('t-once', 'DIV#.once', { recurring: false, pages: 1 }),
    type('t-xf', 'DIV#.cmp-xf--cta'),
  ],
  fragments: [{ identity: 'DIV#.xf', contents: [{ types: ['t-xf'], instances: 2, pages: 2 }] }],
  pages: [
    { url: 'https://x.example/a',
      sections: [section('t-hero'), section('t-text'), section('t-cards')] },
    { url: 'https://x.example/b', sections: [section('t-text'), section('t-odd')] },
    { url: 'https://x.example/c',
      sections: [section('t-text'), section('t-xf', ['fragment:DIV#.xf'])] },
  ],
};

test('mappable types are the recurring ones outside fragments; seeding keeps decisions', () => {
  assert.deepEqual(mappableTypes(elements).map((t) => t.id),
    ['t-hero', 't-text', 't-cards', 't-odd']);
  const seeded = seedMapping(elements);
  assert.deepEqual(seeded, { types: {
    't-hero': { kind: null }, 't-text': { kind: null }, 't-cards': { kind: null },
    't-odd': { kind: null },
  } });
  const previous = { types: {
    't-hero': { kind: 'block', block: 'hero' }, 't-gone': { kind: 'skip' },
    't-null': { kind: null },
  } };
  const again = seedMapping(elements, previous);
  assert.deepEqual(again.types['t-hero'], { kind: 'block', block: 'hero' }, 'a decision stays');
  assert.deepEqual(again.types['t-gone'], { kind: 'skip' }, 'a decided orphan stays too');
  assert.equal(again.types['t-null'], undefined, 'an undecided orphan is no decision');
  assert.deepEqual(again.types['t-text'], { kind: null });
});

test('validation names each fault and passes a good file', () => {
  assert.deepEqual(validateMapping({ types: {
    't-a': { kind: 'block', block: 'hero', notes: 'x' }, 't-b': { kind: 'default-content' },
    't-c': { kind: 'skip' }, 't-d': { kind: null },
  } }), []);
  assert.match(validateMapping([])[0], /object with a "types" map/);
  assert.match(validateMapping({ types: [] })[0], /keyed by type id/);
  const bad = validateMapping({ types: {
    't-a': { kind: 'component' }, 't-b': { kind: 'block' }, 't-c': { kind: 'block', block: 'Hero' },
    't-d': { kind: 'block', block: 'footer' }, 't-e': { kind: 'skip', block: 'x' },
    't-f': { kind: 'default-content', notes: 3 }, 't-g': 'block',
  } });
  assert.equal(bad.length, 7);
  assert.match(bad[0], /kind must be one of block, default-content, skip/);
  assert.match(bad[1], /a block needs a name/);
  assert.match(bad[2], /a block needs a name/);
  assert.match(bad[3], /"footer" is not a block name/);
  assert.match(bad[4], /only a block has a block name/);
  assert.match(bad[5], /notes must be a string/);
  assert.match(bad[6], /decision must be an object/);
});

test('the inventory: blocks with their numbers, coverage per page, undecided and orphans', () => {
  const mapping = { types: {
    't-hero': { kind: 'block', block: 'hero', notes: 'image left' },
    't-cards': { kind: 'block', block: 'cards' },
    't-text': { kind: 'default-content' },
    't-odd': { kind: null },
    't-gone': { kind: 'skip' },
  } };
  const inv = deriveInventory(elements, mapping);
  assert.deepEqual(inv.blocks.map((b) => b.name), ['cards', 'hero'], 'by pages, then name');
  const hero = inv.blocks.find((b) => b.name === 'hero');
  assert.deepEqual([hero.types, hero.instances, hero.pages, hero.variants, hero.notes],
    [['t-hero'], 3, 1, 1, ['image left']]);
  assert.deepEqual(hero.sample, { url: 'https://x.example/a', selector: '#t-hero' });
  assert.deepEqual(hero.screenshots, ['screenshots/type-t-hero-1.png']);
  assert.deepEqual(inv.defaultContent, { types: ['t-text'], instances: 40, pages: 3 });
  assert.deepEqual(inv.undecided, ['t-odd']);
  assert.deepEqual(inv.orphaned, ['t-gone']);
  assert.deepEqual(inv.coverage, { pages: 3, covered: 2, uncovered: [
    { url: 'https://x.example/b', types: ['t-odd'], leaves: [] },
  ] }, 'the fragment section on page c does not count against it');
  assert.deepEqual(inv.containerLeaves, []);
  const skipped = deriveInventory(elements, {
    types: { ...mapping.types, 't-odd': { kind: 'skip', notes: 'tree split' } },
  });
  assert.equal(skipped.coverage.covered, 2, 'a skipped section leaves its page uncovered');
  assert.deepEqual(skipped.skipped.map((s) => [s.id, s.notes]), [['t-odd', 'tree split']]);
  assert.deepEqual(skipped.undecided, []);
});

test('two types, one block: the block sums them and keeps the lead sample', () => {
  const inv = deriveInventory(elements, { types: {
    't-hero': { kind: 'block', block: 'teaser' }, 't-cards': { kind: 'block', block: 'teaser' },
  } });
  assert.equal(inv.blocks.length, 1);
  assert.deepEqual([inv.blocks[0].types, inv.blocks[0].instances, inv.blocks[0].variants],
    [['t-hero', 't-cards'], 6, 2]);
});

test('the report has every section and stays within the line limit', () => {
  const inv = deriveInventory(elements, { types: {
    't-hero': { kind: 'block', block: 'hero' }, 't-text': { kind: 'default-content' },
    't-odd': { kind: 'skip', notes: 'rows' }, 't-gone': { kind: 'skip' },
  } });
  const md = renderMappingMd(inv, elements);
  for (const h of ['# Block inventory', '## Blocks', '## Default content', '## Skipped',
    '## Coverage', '## Undecided', '## Orphaned decisions']) assert.ok(md.includes(h), h);
  assert.match(md, /1 blocks, 1 default content types, 1 skipped, 1 undecided; 1 of 3 pages/);
  assert.match(md, /\| hero \| `DIV#\.banner` \| 3 \| 1 \(33 %\) \| 1 \| 200 px \| https/);
  assert.match(md, /- `DIV#\.cards` \(t-cards\)/, 'undecided named by identity');
  assert.match(md, /`TR#\.row` \(t-odd\): 2 pages, 3 instances — rows/);
  md.split('\n').forEach((l) => assert.ok(l.length <= 100, l));
});

test('a container whose instances are all leaves is nothing to decide, and keeps pages open',
  () => {
    const leafy = {
      ...elements,
      types: [...elements.types,
        type('t-col', 'DIV#.column', { variants: [{ children: [] }, { children: [] }] }),
        type('t-row', 'DIV#.row', { variants: [{ children: [] }, { children: ['DIV#.x'] }] })],
      pages: [...elements.pages,
        { url: 'https://x.example/d', sections: [section('t-text'), section('t-col')] }],
    };
    const containers = new Set(['DIV#.column', 'DIV#.row']);
    assert.deepEqual(containerLeafTypes(leafy, containers).map((t) => t.id), ['t-col'],
      'a container with any child anywhere is not a leaf type');
    assert.ok(!mappableTypes(leafy, containers).some((t) => t.id === 't-col'));
    assert.ok(mappableTypes(leafy, containers).some((t) => t.id === 't-row'));
    assert.equal(seedMapping(leafy, undefined, containers).types['t-col'], undefined);
    const inv = deriveInventory(leafy, { types: {
      't-hero': { kind: 'block', block: 'hero' }, 't-cards': { kind: 'block', block: 'cards' },
      't-text': { kind: 'default-content' }, 't-odd': { kind: 'skip' },
      't-row': { kind: 'block', block: 'columns' },
    } }, containers);
    assert.deepEqual(inv.containerLeaves,
      [{ id: 't-col', identity: 'DIV#.column', pages: 2, instances: 3 }]);
    assert.deepEqual(inv.coverage.uncovered.find((u) => u.url.endsWith('/d')),
      { url: 'https://x.example/d', types: [], leaves: ['t-col'] }, 'unseen content keeps d open');
    const stale = deriveInventory(leafy, { types: { 't-text': { kind: 'default-content' },
      't-col': { kind: 'default-content' } } }, containers);
    assert.ok(stale.coverage.uncovered.some((u) => u.url.endsWith('/d')),
      'a stale decision on a leaf covers nothing');
    assert.deepEqual(stale.orphaned, ['t-col']);
    const withEmpty = {
      ...leafy, pages: [...leafy.pages, { url: 'https://x.example/e', sections: [] }],
    };
    const emptyInv = deriveInventory(withEmpty,
      { types: { 't-text': { kind: 'default-content' } } });
    assert.deepEqual(emptyInv.coverage.uncovered.find((u) => u.url.endsWith('/e')),
      { url: 'https://x.example/e', types: [], leaves: [], empty: true }, 'an empty page is open');
    assert.match(renderMappingMd(emptyInv, withEmpty), /x\.example\/e \| no section at all/);
    const md = renderMappingMd(inv, leafy);
    assert.match(md, /## Container leaves\n\n[^\n]+\n\n- `DIV#\.column` \(t-col\): 2 pages/);
    assert.match(md, /\| https:\/\/x\.example\/d \|  \| `DIV#\.column` \|/);
    assert.equal(deriveInventory(leafy, { types: {} }).containerLeaves.length, 0,
      'without the rules, no type is a container leaf');
  });

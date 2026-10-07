import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { write as writeComposition } from './composition.mjs';
import { decide, typeId, writeTypes } from './elements.mjs';
import { SCHEMA, read, write } from './inventory.mjs';
import { init } from './migration.mjs';
import { pageId, upsert } from './pages.mjs';
import { classOf } from './schema.mjs';
import { fragmentId, writeFragments } from './website.mjs';

const O = 'https://a.example/';
const AT = '2026-09-22T10:00:00.000Z';
const type = (identity, pages, extra = {}) => ({
  identity, pages, instances: pages, support: pages / 4, recurring: pages >= 2,
  variants: [{ id: 'v', children: [], instances: pages, pages }],
  sample: { page: pageId(`${O}a`), selector: `.${identity}` },
  evidence: [`elements/evidence/${identity}.png`], ...extra,
});
const T = {
  hero: typeId('hero'), blogHero: typeId('blogHero'), text: typeId('text'), band: typeId('band'),
  grid: typeId('grid'), xf: typeId('xf'), top: typeId('top'), cards: typeId('cards'),
};

test('the inventory is the EDS reading: per kind, with coverage read from compositions',
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-inv-'));
    await init(cwd, { origin: O });
    assert.equal(classOf(SCHEMA), 'derived');
    await assert.rejects(write(cwd), /no elements\/types\.json/);
    await upsert(cwd, ['a', 'b', 'c', 'd'].map((n) => (
      { url: `${O}${n}`, discovered: { from: 'list', at: AT }, kind: 'page' })));
    await writeTypes(cwd, { method: { name: 'm', at: AT }, types: [
      type('hero', 3), type('blogHero', 2), type('text', 4), type('band', 3), type('grid', 3),
      type('xf', 2), type('top', 2), type('cards', 2), type('once', 1),
    ] });
    await decide(cwd, T.hero, { kind: 'block', block: 'hero', notes: 'CTA optional' });
    await decide(cwd, T.blogHero, { kind: 'block', block: 'hero', notes: 'article variant' });
    await decide(cwd, T.text, { kind: 'default-content' });
    await decide(cwd, T.band, { kind: 'section', style: 'light-grey' });
    await decide(cwd, T.grid, { kind: 'wrapper' });
    await decide(cwd, T.xf, { kind: 'fragment', fragment: 'contact-cta' });
    await decide(cwd, T.top, { kind: 'skip', notes: 'generated back-to-top' });
    // cards stays undecided
    await writeFragments(cwd, { method: { name: 'm', at: AT }, fragments: [
      { placement: 'inline', name: 'contact-cta', selectors: ['.xf'], pages: 2 }] });
    const comp = (items) => ({ method: { name: 'm', at: AT }, fragments: [], omitted: [],
      sections: [{ id: 's1', selector: 'main', items }] });
    const block = (t) => ({ role: 'block', type: t, selector: `.${t}` });
    await writeComposition(cwd, pageId(`${O}a`), comp([block(T.hero), block(T.text)]));
    await writeComposition(cwd, pageId(`${O}b`), comp([block(T.cards), block(T.text)]));
    await writeComposition(cwd, pageId(`${O}c`), comp([]));
    const inv = await write(cwd);
    assert.deepEqual(inv.blocks, [{
      block: 'hero', types: [T.hero, T.blogHero], instances: 5, pages: 5, variants: 2,
      sample: { page: pageId(`${O}a`), selector: '.hero' },
      evidence: ['elements/evidence/hero.png', 'elements/evidence/blogHero.png'],
      notes: ['CTA optional', 'article variant'],
    }], 'two types, one block');
    assert.deepEqual(inv.sections.map((s) => [s.style, s.pages]), [['light-grey', 3]]);
    assert.deepEqual(inv.fragments, [{
      fragment: 'contact-cta', id: fragmentId('inline', 'contact-cta'),
      types: [T.xf], instances: 2, pages: 2 }], 'linked to the shared document by name');
    assert.deepEqual(inv.defaultContent, { types: [T.text], instances: 4, pages: 4 });
    assert.deepEqual(inv.wrappers, [T.grid]);
    assert.deepEqual(inv.skipped, [{ id: T.top, identity: 'top', pages: 2, instances: 2,
      notes: 'generated back-to-top' }]);
    assert.deepEqual(inv.undecided, [T.cards]);
    assert.deepEqual(inv.orphaned, []);
    assert.deepEqual(inv.coverage, { pages: 4, composed: 3, read: 1, open: [
      { page: pageId(`${O}b`), types: [T.cards] },
      { page: pageId(`${O}c`), types: [], empty: true },
    ] }, 'a read page: every block item decided, nothing undecided, not empty');
    assert.equal(inv.summary, '1 blocks, 1 section styles, 1 inline fragments, 1 default content'
      + ' types, 1 wrappers, 1 skipped, 1 undecided; 1 of 3 composed pages fully read (4 known).');
    assert.deepEqual(await read(cwd), inv);
    assert.ok(inv.derivedFrom.types && inv.derivedFrom.elements);
  });

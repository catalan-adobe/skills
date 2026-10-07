import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ELEMENTS_SCHEMA, KINDS, METHOD_SCHEMA, TYPES_SCHEMA, decide, readDecisions, readMethod,
  readTypes, typeId, undecided, writeMethod, writeTypes,
} from './elements.mjs';
import { init } from './migration.mjs';
import { classOf, faults, schemaOf } from './schema.mjs';

const AT = '2026-09-22T10:00:00.000Z';
const fresh = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-el-'));
  await init(cwd, { origin: 'https://a.example/' });
  return cwd;
};
const type = (identity, pages, extra = {}) => ({
  identity, pages, instances: pages * 2, support: pages / 10, recurring: pages >= 2,
  heights: { median: 300, min: 100, max: 900 },
  variants: [{ id: 'v-1', children: ['DIV#.a'], instances: pages * 2, pages }],
  sample: { page: 'pag-000000000001', selector: `.${identity}` }, ...extra,
});

test('types.json is the method\'s vocabulary; writing it seeds the decisions', async () => {
  const cwd = await fresh();
  assert.equal(classOf(TYPES_SCHEMA), 'derived');
  assert.equal(classOf(ELEMENTS_SCHEMA), 'decision');
  const t = await writeTypes(cwd, { method: { name: 'visual-tree', at: AT }, types: [
    type('DIV#.hero', 8, { evidence: ['elements/evidence/x.png'] }),
    type('DIV#.text', 10), type('DIV#.once', 1),
  ] });
  assert.deepEqual(t.types.map((x) => x.id),
    [typeId('DIV#.hero'), typeId('DIV#.text'), typeId('DIV#.once')]);
  assert.equal(t.summary,
    '3 element types, 2 recurring (on 2+ pages), 3 variants; 1 seen on one page only.');
  assert.deepEqual(await readTypes(cwd), t);
  const d = await readDecisions(cwd);
  assert.deepEqual(d.types,
    { [typeId('DIV#.hero')]: { kind: null }, [typeId('DIV#.text')]: { kind: null } },
    'recurring types seeded undecided; the one-off is not a decision');
  assert.deepEqual(await undecided(cwd), [typeId('DIV#.hero'), typeId('DIV#.text')]);
});

test('six kinds, each with its one field; names checked; reruns keep decisions', async () => {
  const cwd = await fresh();
  const hero = typeId('DIV#.hero');
  const band = typeId('DIV#.band');
  await writeTypes(cwd, { method: { name: 'm', at: AT }, types: [
    type('DIV#.hero', 5), type('DIV#.band', 5), type('DIV#.grid', 5), type('DIV#.xf', 5)] });
  assert.deepEqual(KINDS, ['section', 'block', 'default-content', 'fragment', 'wrapper', 'skip']);
  await decide(cwd, hero, { kind: 'block', block: 'hero', notes: 'CTA optional' });
  await decide(cwd, band, { kind: 'section', style: 'light-grey' });
  await decide(cwd, typeId('DIV#.grid'), { kind: 'wrapper' });
  await decide(cwd, typeId('DIV#.xf'), { kind: 'fragment', fragment: 'contact-cta' });
  await assert.rejects(decide(cwd, hero, { kind: 'block', block: 'footer' }),
    /"footer" is not a name for a block/);
  const noShape = /must match exactly one shape/;
  await assert.rejects(decide(cwd, hero, { kind: 'block' }), noShape, 'a block needs its name');
  await assert.rejects(decide(cwd, hero, { kind: 'block', block: 'Hero' }), noShape);
  await assert.rejects(decide(cwd, hero, { kind: 'section', block: 'x' }), noShape);
  await assert.rejects(decide(cwd, 'typ-000000000000', { kind: 'skip' }), /not a type to decide/);
  assert.deepEqual(await undecided(cwd), []);
  // A rerun: hero gone, a new type appears, band stays decided, the new one is undecided.
  await writeTypes(cwd, { method: { name: 'm', at: AT },
    types: [type('DIV#.band', 6), type('DIV#.cards', 4)] });
  const d = await readDecisions(cwd);
  assert.deepEqual(Object.keys(d.types).sort(),
    [band, typeId('DIV#.cards'), hero, typeId('DIV#.grid'), typeId('DIV#.xf')].sort(),
    'decided orphans are kept');
  assert.deepEqual(d.types[band], { kind: 'section', style: 'light-grey' });
  assert.deepEqual(d.types[typeId('DIV#.cards')], { kind: null });
  const { schema } = schemaOf(ELEMENTS_SCHEMA);
  assert.deepEqual(faults({ schema: ELEMENTS_SCHEMA, types: { 'typ-x': { kind: 'chrome' } } },
    schema), ['$.types.typ-x: must match exactly one shape (matched 0)'],
  'chrome is not a kind: a fragment is');
});

test('a method keeps its own knobs under its name', async () => {
  const cwd = await fresh();
  assert.equal(classOf(METHOD_SCHEMA), 'decision');
  const m = await writeMethod(cwd, 'visual-tree',
    { identityExclusions: ['-bg$'], merge: {}, reject: ['A#.scroll-to-top'] });
  assert.deepEqual(await readMethod(cwd, 'visual-tree'), m);
  assert.equal(await readMethod(cwd, 'dom-only'), null);
  await assert.rejects(writeMethod(cwd, 'Visual Tree', {}), /\$\.name: must match/);
});

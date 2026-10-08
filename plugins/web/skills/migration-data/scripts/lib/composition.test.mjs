import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DOCUMENT_KINDS, ROLES, SCHEMA, file, fragmentRefs, items, read, readFragment, write,
  writeFragment, writeMany,
} from './composition.mjs';
import { init } from './migration.mjs';
import { get, pageId, upsert } from './pages.mjs';
import { classOf, faults, schemaOf } from './schema.mjs';

const ORIGIN = 'https://a.example/';
const AT = '2026-09-22T10:00:00.000Z';
const box = (y, height) => ({ x: 0, y, width: 1280, height });
const fresh = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-comp-'));
  await init(cwd, { origin: ORIGIN });
  await upsert(cwd, ['p', 'q'].map((n) => (
    { url: `${ORIGIN}${n}`, discovered: { from: 'list', at: AT }, kind: 'page' })));
  return cwd;
};
const composition = {
  method: { name: 'visual-tree', version: '1.2', at: AT, inputs: 'sha-of-tree' },
  fragments: [
    { ref: 'frg-000000000001', selector: '#utility', bounds: box(0, 53) },
    { ref: 'frg-000000000002', selector: 'footer', bounds: box(3000, 500) },
  ],
  sections: [
    { id: 's1', selector: 'main > div:nth-child(1)', bounds: box(53, 900),
      style: { background: '#2d1b69' },
      items: [
        { role: 'block', type: 'typ-000000000001', variant: 'v-a', selector: '.banner',
          bounds: box(53, 500) },
        { role: 'content', selector: '.text', bounds: box(553, 400) },
      ] },
    { id: 's2', selector: 'main > div:nth-child(2)',
      items: [{ role: 'fragment', ref: 'frg-000000000003', selector: '#xf' }] },
  ],
  omitted: [{ selector: '.pb_table', bounds: box(128, 5), reason: 'hairline' }],
};

test('the schema is the EDS document shape: fixed depth, closed roles, located nodes', () => {
  assert.equal(classOf(SCHEMA), 'derived');
  assert.deepEqual(ROLES, ['content', 'block', 'fragment']);
  assert.deepEqual(DOCUMENT_KINDS, ['page', 'fragment']);
  const { schema } = schemaOf(SCHEMA);
  const doc = (kind, id) => ({ kind, id });
  const full = { ...composition, schema: SCHEMA, document: doc('page', 'pag-000000000001') };
  assert.deepEqual(faults({ ...full, document: doc('fragment', 'frg-000000000009') }, schema),
    [], 'a fragment is a document too');
  assert.deepEqual(faults({ ...full, document: { kind: 'page', id: 'frg-000000000009' } }, schema),
    ['$.document: must match exactly one shape (matched 0)'], 'a page has a page id');
  assert.deepEqual(faults(full, schema), []);
  const bad = (patch) => faults({ ...full, ...patch }, schema);
  const one = (item) => bad({ sections: [{ id: 's1', selector: 'x', items: [item] }] });
  const noShape = ['$.sections[0].items[0]: must match exactly one shape (matched 0)'];
  assert.deepEqual(one({ role: 'block', selector: 'y' }), noShape, 'a block names its type');
  assert.deepEqual(one({ role: 'section', selector: 'y' }), noShape, 'no section in a section');
  assert.deepEqual(one({ role: 'content' }), noShape, 'a selector always');
  assert.deepEqual(bad({ sections: [{ id: 'one', selector: 'x', items: [] }] }),
    ['$.sections[0].id: must match ^s\\d+$']);
  assert.deepEqual(bad({ fragments: [{ selector: 'x' }] }), ['$.fragments[0].ref: required']);
  assert.deepEqual(bad({ omitted: [{ selector: 'x' }] }), ['$.omitted[0].reason: required']);
  assert.deepEqual(bad({ method: { name: 'Visual Tree', at: AT } }),
    ['$.method.name: must match ^[a-z][a-z0-9-]*$']);
  const negative = { x: 0, y: 0, width: -1, height: 1 };
  assert.deepEqual(one({ role: 'content', selector: 'y', bounds: negative }), noShape,
    'bounds are checked');
  assert.deepEqual(one({ role: 'content', selector: 'y' }), [], 'bounds are optional');
});

test('write lands the composition under the page and reflects it on the record', async () => {
  const cwd = await fresh();
  const id = pageId(`${ORIGIN}p`);
  await assert.rejects(write(cwd, 'pag-000000000009', composition), /no page pag-0000/);
  const written = await write(cwd, id, composition);
  assert.deepEqual([written.schema, written.document], [SCHEMA, { kind: 'page', id }]);
  assert.deepEqual(await read(cwd, id), written);
  assert.deepEqual(await readdir(path.join(cwd, 'migration', 'pages', id)), ['composition.json']);
  const page = await get(cwd, id);
  assert.deepEqual(page.fragments, ['frg-000000000001', 'frg-000000000002', 'frg-000000000003'],
    'template-placed and embedded fragments alike');
  assert.deepEqual(fragmentRefs(written), page.fragments);
  assert.deepEqual(page.composition, { method: 'visual-tree', at: AT, sections: 2, omitted: 1 });
  assert.deepEqual(items(written).map((i) => [i.section, i.role]),
    [['s1', 'block'], ['s1', 'content'], ['s2', 'fragment']]);
  // Another method's reading sits beside the current one and leaves the record alone.
  const other = { ...composition, method: { name: 'dom-only', at: AT }, fragments: [],
    sections: [{ id: 's1', selector: 'main', items: [{ role: 'content', selector: 'main' }] }] };
  await write(cwd, id, other, { current: false });
  assert.equal(file('page', id, 'dom-only'), `pages/${id}/composition.dom-only.json`);
  assert.deepEqual((await readdir(path.join(cwd, 'migration', 'pages', id))).sort(),
    ['composition.dom-only.json', 'composition.json']);
  assert.equal((await read(cwd, id, 'dom-only')).method.name, 'dom-only');
  assert.deepEqual((await get(cwd, id)).composition.method, 'visual-tree', 'still current');
  assert.equal(await read(cwd, id, 'nope'), null);
  await assert.rejects(write(cwd, id, { ...composition, sections: 'x' }),
    /\$\.sections: must be array/);
  // A header is a document: two bands, one fragment, its own composition.
  const header = {
    method: { name: 'visual-tree', at: AT }, fragments: [], omitted: [],
    sections: [
      { id: 's1', selector: '#utility',
        items: [{ role: 'block', type: 'typ-000000000010', selector: '#utility' }] },
      { id: 's2', selector: '.nav-top',
        items: [{ role: 'block', type: 'typ-000000000011', selector: '.nav-top' }] },
    ],
  };
  const h = await writeFragment(cwd, 'frg-000000000001', header);
  assert.deepEqual(h.document, { kind: 'fragment', id: 'frg-000000000001' });
  assert.equal(file('fragment', 'frg-000000000001'), 'fragments/frg-000000000001/composition.json');
  assert.deepEqual(await readFragment(cwd, 'frg-000000000001'), h);
  assert.equal((await readFragment(cwd, 'frg-000000000001')).sections.length, 2);
  assert.deepEqual((await get(cwd, id)).fragments.length, 3, 'a fragment write leaves pages alone');
  // Many pages in one pass over the table; a composition of fragments only has no sections.
  const q = pageId(`${ORIGIN}q`);
  const chromeOnly = { ...composition, sections: [], omitted: [] };
  assert.equal(await writeMany(cwd, [{ pageId: id, composition: chromeOnly },
    { pageId: q, composition: chromeOnly }]), 2);
  assert.deepEqual((await get(cwd, q)).composition, { method: 'visual-tree', at: AT, sections: 0,
    omitted: 0 });
  assert.deepEqual((await get(cwd, q)).fragments, ['frg-000000000001', 'frg-000000000002']);
  await assert.rejects(writeMany(cwd, [{ pageId: 'pag-000000000009', composition }]), /no page/);
});

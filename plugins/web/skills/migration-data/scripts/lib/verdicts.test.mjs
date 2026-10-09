import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classOf } from './schema.mjs';
import { CATEGORIES, CONSTRUCTS, LAYOUTS, SCHEMA, importFile, read, upsert } from './verdicts.mjs';

test('verdicts: a decision per page, closed words, the latest word wins', async () => {
  assert.equal(classOf(SCHEMA), 'decision');
  assert.deepEqual(CATEGORIES, ['document', 'bands', 'composed']);
  assert.equal(LAYOUTS.length, 4);
  assert.ok(CONSTRUCTS.includes('cards'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-verdicts-'));
  assert.equal(await read(cwd), null);
  const a = 'pag-0000000000aa';
  const b = 'pag-0000000000bb';
  await assert.rejects(upsert(cwd, [{ page: a, category: 'document', layout: 'single' }], {}),
    /name who judged/);
  await assert.rejects(upsert(cwd, [{ page: a, category: 'article', layout: 'single' }],
    { by: 'me' }), /category: must be one of/);
  await assert.rejects(upsert(cwd, [{ page: a, category: 'document' }], { by: 'me' }),
    /says category and layout, or names a problem/);
  const flagged = await upsert(cwd, [{ page: a, problem: 'capture-fault', note: 'cut short' }],
    { by: 'me' });
  assert.deepEqual([flagged.verdicts[0].problem, flagged.verdicts[0].category],
    ['capture-fault', undefined]);
  assert.match(flagged.summary, /1 with a problem$/);
  const first = await upsert(cwd, [
    { page: a, category: 'document', layout: 'main-right', constructs: ['toc', 'toc'], bands: 3 },
    { page: b, sameAs: a, category: 'document', layout: 'main-right', note: 'same as a' },
  ], { by: 'me' });
  assert.equal(first.summary, '2 page(s): 2 document, 0 bands, 0 composed; 1 template(s)');
  assert.deepEqual(first.verdicts[0].constructs, ['toc'], 'once each');
  assert.equal(first.verdicts[1].sameAs, a);
  const again = await importFile(cwd, { by: 'you', verdicts: [
    { page: a, category: 'composed', layout: 'single', constructs: ['hero', 'cards'] }] });
  assert.equal(again.verdicts.length, 2, 'replaced, not added');
  assert.deepEqual([again.verdicts.find((v) => v.page === a).category,
    again.verdicts.find((v) => v.page === a).by], ['composed', 'you']);
  await assert.rejects(importFile(cwd, { by: 'x' }), /verdicts array/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { init } from './migration.mjs';
import { classOf } from './schema.mjs';
import { SCHEMA, create, list, pagesOf, read } from './selections.mjs';

const fresh = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-sel-'));
  await init(cwd, { origin: 'https://a.example/' });
  return cwd;
};
const P = ['pag-000000000001', 'pag-000000000002', 'pag-000000000003'];

test('a selection freezes ids with its criteria; names are checked and never reused', async () => {
  const cwd = await fresh();
  assert.equal(classOf(SCHEMA), 'decision');
  await assert.rejects(create(cwd, 'Bad Name', P), /lowercase letters, digits and dashes/);
  await assert.rejects(create(cwd, 'empty', []), /selection empty: no pages/);
  const s = await create(cwd, 'sample-2', [P[0], P[1], P[0]],
    { criteria: { count: 2, exclude: ['zh-tw'] }, summary: 'two pages, one per group' });
  assert.match(s.id, /^sel-[0-9a-f]{12}$/);
  assert.deepEqual([s.name, s.pages, s.criteria, s.summary],
    ['sample-2', [P[0], P[1]], { count: 2, exclude: ['zh-tw'] }, 'two pages, one per group']);
  await assert.rejects(create(cwd, 'sample-2', [P[2]]), /sample-2 exists and is frozen/);
  assert.deepEqual(await read(cwd, 'sample-2'), s);
  assert.equal(await read(cwd, 'nope'), null);
  const b = await create(cwd, 'blogs', [P[2]]);
  assert.equal(b.summary, '1 pages', 'a summary by default');
  assert.deepEqual((await list(cwd)).map((x) => x.name), ['blogs', 'sample-2']);
  assert.deepEqual([...await pagesOf(cwd, ['sample-2', 'blogs'])], P);
  await assert.rejects(pagesOf(cwd, ['nope']), /no selection nope; existing: blogs, sample-2/);
  assert.deepEqual(await list(await fresh()), []);
});

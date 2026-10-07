import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { init } from './migration.mjs';
import { AUTHORS, SCHEMA, add, body, index, list } from './notes.mjs';
import { upsert } from './pages.mjs';
import { classOf } from './schema.mjs';
import { INDEX, SCHEMA as VIEWS_SCHEMA, renderReport, write, writeReport } from './views.mjs';
import { openStore } from './store.mjs';

const O = 'https://a.example/';
const fresh = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-notes-'));
  await init(cwd, { origin: O });
  return cwd;
};

test('a note is a body on disk and an entry in the index; the index is history', async () => {
  const cwd = await fresh();
  assert.equal(classOf(SCHEMA), 'history');
  assert.deepEqual(AUTHORS, ['agent', 'operator', 'runner']);
  await assert.rejects(add(cwd, { step: 'elements', author: 'agent', body: '  ' }), /needs a body/);
  const n = await add(cwd, { step: 'elements', author: 'agent',
    body: '# Rules, second pass\n\nPeeled the grid wrappers; three types became blocks.' });
  assert.match(n.id, /^not-[0-9a-f]{12}$/);
  assert.deepEqual([n.step, n.author, n.file, n.summary],
    ['elements', 'agent', `notes/${n.id}.md`, 'Rules, second pass']);
  assert.equal(await body(cwd, n.id),
    '# Rules, second pass\n\nPeeled the grid wrappers; three types became blocks.\n');
  const o = await add(cwd, { step: 'cache', author: 'operator',
    body: 'Cache the blogs group first.', summary: 'operator: blogs first',
    page: 'pag-000000000001' });
  assert.deepEqual((await index(cwd)).notes.map((x) => x.id), [n.id, o.id], 'oldest first');
  assert.deepEqual((await list(cwd, { author: 'operator' })).map((x) => x.summary),
    ['operator: blogs first']);
  assert.deepEqual((await list(cwd, { page: 'pag-000000000001' })).length, 1);
  assert.deepEqual((await list(cwd, { step: 'nope' })), []);
  await assert.rejects(body(cwd, 'not-000000000000'), /no note not-0000/);
  assert.deepEqual((await readdir(path.join(cwd, 'migration', 'notes'))).sort(),
    [`${n.id}.md`, `${o.id}.md`, 'notes.json'].sort());
});

test('the report is rendered from the data and the notes, indexed as a view, never edited',
  async () => {
    const cwd = await fresh();
    assert.equal(classOf(VIEWS_SCHEMA), 'derived');
    const empty = await renderReport(cwd);
    assert.match(empty, /^# Migration report — https:\/\/a\.example\/\n/);
    assert.match(empty, /## Website\n\nNo website summary yet/);
    assert.match(empty, /## Shared documents\n\nNone found yet\./);
    assert.match(empty, /## Inventory\n\nNo inventory yet\./);
    assert.match(empty, /## Notes\n\nNone yet\./);
    await upsert(cwd, [{ url: `${O}a`, discovered: { from: 'list', at: '2026-09-22T10:00:00Z' } }]);
    await add(cwd, { step: 'discover', author: 'runner', body: 'One URL from the operator list.' });
    const entry = await writeReport(cwd, { checks: { discover: async () => ({ pass: true }) } });
    assert.equal(entry.file, 'views/report.md');
    assert.ok(entry.from.includes('notes/notes.json'));
    const text = await readFile(openStore(cwd).path('views/report.md'), 'utf8');
    assert.match(text, /\| discover \| done \|/);
    assert.match(text, /## Pages\n\n1 URLs in 1 groups/);
    assert.match(text, /## Notes\n\n- .* · discover · runner: One URL from the operator list\./);
    const again = await write(cwd, 'report', 'replaced', ['x']);
    const idx = await openStore(cwd).read(INDEX, VIEWS_SCHEMA);
    assert.deepEqual(idx.views.map((v) => v.file), ['views/report.md'], 'one entry per view');
    assert.deepEqual(idx.views[0].from, ['x']);
    assert.equal(again.file, 'views/report.md');
  });

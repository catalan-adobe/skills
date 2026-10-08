import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { data } from './data.mjs';
import { check, render } from './report.mjs';

test('the report renders both views; stale once the data moves on', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mpipe-report-'));
  const { migration, pages, notes } = await data(cwd);
  await migration.init(cwd, { origin: 'https://a.example/' });
  assert.deepEqual(await check(cwd), { pass: false, note: 'no report rendered yet' });
  const out = await render(cwd);
  assert.deepEqual([out.md.file, out.html.file], ['views/report.md', 'views/report.html']);
  const html = await readFile(path.join(cwd, 'migration', 'views', 'report.html'), 'utf8');
  assert.match(html, /<h1>https:\/\/a.example\/<\/h1>/);
  assert.deepEqual(await check(cwd), { pass: true });
  await notes.add(cwd, { step: 'cache', author: 'operator', body: 'Later.' });
  const later = new Date(Date.now() + 5000);
  await utimes(path.join(cwd, 'migration', 'notes', 'notes.json'), later, later);
  assert.deepEqual(await check(cwd),
    { pass: false, note: 'the data changed since the report was rendered' });
  await render(cwd);
  await pages.upsert(cwd, [{ url: 'https://a.example/p',
    discovered: { from: 'list', at: '2026-09-22T10:00:00.000Z' } }]);
  await utimes(path.join(cwd, 'migration', 'pages', 'pages.json'), later, later);
  assert.equal((await check(cwd)).pass, false);
});

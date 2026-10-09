import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderAnnotate } from './annotate-html.mjs';
import { init } from './migration.mjs';
import { pageId, upsert } from './pages.mjs';
import { create } from './selections.mjs';
import { upsert as judge } from './verdicts.mjs';
import { writeAnnotate } from './views.mjs';

const O = 'https://a.example/';
const AT = '2026-09-22T10:00:00.000Z';

test('the annotation sheet: a card per page, prior verdicts prefilled', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-annot-'));
  await init(cwd, { origin: O });
  await upsert(cwd, ['a', 'b', 'c'].map((n) => ({ url: `${O}${n}`, kind: 'page',
    discovered: { from: 'list', at: AT }, cache: { at: AT, path: 'x', selection: 's' } })));
  await assert.rejects(renderAnnotate(cwd, 'nope'), /no selection nope/);
  await create(cwd, 'judge-3', ['a', 'b', 'c'].map((n) => pageId(`${O}${n}`)));
  await judge(cwd, [{ page: pageId(`${O}a`), category: 'document', layout: 'single' }],
    { by: 'me' });
  const html = await renderAnnotate(cwd, 'judge-3');
  assert.equal((html.match(/<section class="page"/g) ?? []).length, 3);
  assert.match(html, /shots\/body-thumb\.jpg/);
  assert.match(html, /<option value="">new template<\/option><option value="pag-[0-9a-f]{12}">\/a</,
    'the second page may be the same as the first');
  assert.match(html, /"category":"document"/, 'the prior verdict rides along');
  assert.match(html, /data-file="verdicts-judge-3.json"/);
  const entry = await writeAnnotate(cwd, 'judge-3');
  assert.equal(entry.file, 'views/annotate-judge-3.html');
  assert.ok((await readFile(path.join(cwd, 'migration', entry.file), 'utf8')).includes('<script>'));
});

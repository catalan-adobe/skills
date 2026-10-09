import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CANDIDATES_SCHEMA, CHOICE_SCHEMA, candidateId, choiceHash, choose, readCandidates, readChoice,
  writeCandidates,
} from './chrome.mjs';
import { classOf } from './schema.mjs';

const AT = '2026-09-22T10:00:00.000Z';
const cand = (key, anchored, verdict, extra = {}) => ({
  id: candidateId(key, anchored), selector: key.split('>').at(-1), anchored, support: 0.9,
  pages: 9, widthShare: 1, textStability: 1,
  bounds: { y: 0, height: 80, width: 1280, bottomOffset: 2900 }, verdict, ...extra,
});

test('the candidate sheet is derived; the choice a decision among its ids', async () => {
  assert.equal(classOf(CANDIDATES_SCHEMA), 'derived');
  assert.equal(classOf(CHOICE_SCHEMA), 'decision');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-chrome-'));
  assert.equal(await readCandidates(cwd), null);
  assert.equal(choiceHash(null), '');
  const a = cand('BODY#>HEADER#.top', 'top', 'header');
  const b = cand('BODY#>DIV#.title', 'top', 'rejected', { reason: 'text differs across pages' });
  const c = cand('BODY#>FOOTER#.bottom', 'bottom', 'footer');
  assert.equal(a.id, candidateId('BODY#>HEADER#.top', 'top'), 'the same id on every run');
  const sheet = await writeCandidates(cwd, { method: { name: 'visual-tree', at: AT },
    candidates: [a, b, c] });
  assert.equal(sheet.summary, '3 candidate(s): 1 header, 1 rejected, 1 footer');
  await assert.rejects(choose(cwd, 'header', [a.id]), /names who made it/);
  await assert.rejects(choose(cwd, 'sidebar', [a.id], { by: 'x' }), /a part is one of/);
  await assert.rejects(choose(cwd, 'header', ['cnd-000000000000'], { by: 'x' }),
    /not on the candidate sheet/);
  const first = await choose(cwd, 'header', [a.id, b.id], { by: 'claude-haiku-5.5',
    note: 'the title band is part of the masthead on this site' });
  assert.deepEqual(first.parts.header.candidates, [a.id, b.id]);
  assert.equal(first.parts.header.note, 'the title band is part of the masthead on this site');
  const second = await choose(cwd, 'footer', [], { by: 'operator', label: 'no footer' });
  assert.deepEqual(Object.keys(second.parts), ['header', 'footer']);
  assert.match(second.summary, /header: cnd-\w+, cnd-\w+ \(claude-haiku-5.5\); footer: none/);
  const h1 = choiceHash(second);
  assert.match(h1, /^[0-9a-f]{12}$/);
  await choose(cwd, 'header', [a.id], { by: 'operator' });
  assert.notEqual(choiceHash(await readChoice(cwd)), h1, 'another choice, another hash');
});

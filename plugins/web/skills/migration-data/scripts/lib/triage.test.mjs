import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classOf } from './schema.mjs';
import { QUESTIONS, SCHEMA, flagsOf, list, read, write } from './triage.mjs';

const AT = '2026-09-22T10:00:00.000Z';
const method = { name: 'system1', model: '@cf/cloudflare/clef', at: AT };

test('a triage is four probabilities with how the picture was given; flags at 0.5', async () => {
  assert.equal(classOf(SCHEMA), 'derived');
  assert.deepEqual(QUESTIONS, ['header', 'footer', 'broken', 'empty']);
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-triage-'));
  const id = 'pag-0123456789ab';
  assert.deepEqual(await list(cwd), []);
  const t = await write(cwd, id, { method,
    answers: { header: 0.97, footer: 0.91, broken: 0.02, empty: 0.03 },
    images: { slices: 3, scale: 1, quality: 80, bytes: 310000 }, usage: { inputTokens: 3100 } });
  assert.deepEqual((await read(cwd, id)).answers, t.answers);
  assert.deepEqual(await list(cwd), [id]);
  await assert.rejects(write(cwd, id, { method,
    answers: { header: 1.2, footer: 0, broken: 0, empty: 0 },
    images: { slices: 1, scale: 1, quality: 80 } }), /answers\.header/);
  await assert.rejects(write(cwd, id, { method, answers: { header: 1, footer: 0, broken: 0 },
    images: { slices: 1, scale: 1, quality: 80 } }), /empty: required/);
  assert.deepEqual(flagsOf({ header: 0.97, footer: 0.91, broken: 0.02, empty: 0.1 }), []);
  assert.deepEqual(flagsOf({ header: 0.2, footer: 0.5, broken: 0.5, empty: 0.9 }), [
    { code: 'no-header', kind: 'flag', detail: 'seen in the picture: 20 %' },
    { code: 'broken', kind: 'flag', detail: 'seen in the picture: 50 %' },
    { code: 'empty', kind: 'flag', detail: 'seen in the picture: 90 %' },
  ], 'the threshold is yes for a presence, yes for broken and empty');
  assert.equal(flagsOf({ header: 0.6, footer: 0.6, broken: 0.1, empty: 0 }, 0.7).length, 2);
});

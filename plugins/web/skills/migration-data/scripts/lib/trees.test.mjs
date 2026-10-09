import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { head, list, read, write } from './trees.mjs';

test('a tree is stored under its page, its width readable from the head, listed', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-trees-'));
  const id = 'pag-0123456789ab';
  assert.equal(await head(cwd, id), null);
  assert.deepEqual(await list(cwd), []);
  const tree = { tag: 'BODY', bounds: { x: 0, y: 0, width: 1280, height: 3000 }, children: [] };
  await write(cwd, id, { minWidth: 250, url: 'https://a.example/', capturedAt:
    '2026-09-22T10:00:00.000Z', tree, text: 'BODY', nodeMap: { 1: 'body' } });
  assert.deepEqual(await head(cwd, id), { minWidth: 250, version: 1,
    capturedAt: '2026-09-22T10:00:00.000Z', facts: false }, 'no page facts: to be captured again');
  assert.deepEqual((await read(cwd, id)).tree, tree);
  assert.equal((await read(cwd, id)).rootBackground, null);
  assert.deepEqual(await list(cwd), [id]);
  await write(cwd, id, { minWidth: 250, url: 'https://a.example/', capturedAt:
    '2026-09-22T10:00:00.000Z', tree, text: 'BODY', nodeMap: {},
    page: { scrollHeight: 17000, shot: null } });
  assert.deepEqual((await read(cwd, id)).page, { scrollHeight: 17000, shot: null });
  assert.equal((await head(cwd, id)).facts, true);
  await write(cwd, id, { minWidth: 250, version: 2, url: 'https://a.example/', capturedAt:
    '2026-09-22T10:00:00.000Z', tree, text: 'BODY', nodeMap: {},
    page: { scrollHeight: 100, shot: null } });
  assert.equal((await head(cwd, id)).version, 2);
  await assert.rejects(write(cwd, id, { url: 'x', tree }), /minWidth|capturedAt/);
});

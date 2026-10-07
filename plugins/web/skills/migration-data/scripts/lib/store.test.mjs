import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HEAD, register } from './schema.mjs';
import { id, openStore, runId } from './store.mjs';

register('test/note', 1, 'derived', {
  type: 'object',
  required: ['schema', 'text'],
  additionalProperties: false,
  properties: { ...HEAD, text: { type: 'string' } },
});

const fresh = () => mkdtemp(path.join(os.tmpdir(), 'mdata-'));

test('ids: a three-letter prefix and twelve hex of the seed, stable; run ids sort by time', () => {
  assert.equal(id('pag', 'https://x.example/a'), id('pag', 'https://x.example/a'));
  assert.match(id('pag', 'https://x.example/a'), /^pag-[0-9a-f]{12}$/);
  assert.notEqual(id('pag', 'https://x.example/a'), id('pag', 'https://x.example/b'));
  assert.notEqual(id('pag', 'u'), id('typ', 'u'), 'the prefix is part of the id');
  const a = runId('capture', new Date('2026-09-22T10:15:00.123Z'));
  assert.equal(a, 'run-20260922T101500Z-capture');
  assert.ok(a < runId('capture', new Date('2026-09-22T10:16:00Z')));
});

test('read: absent is null, broken JSON and schema faults name the file', async () => {
  const cwd = await fresh();
  const store = openStore(cwd);
  assert.equal(await store.read('x.json'), null);
  await mkdir(store.root, { recursive: true });
  await writeFile(path.join(store.root, 'x.json'), '{');
  await assert.rejects(store.read('x.json'), /migration\/x\.json is not valid JSON/);
  await writeFile(path.join(store.root, 'x.json'), '{"schema":"test/note@1"}');
  await assert.rejects(store.read('x.json'), /migration\/x\.json: 1 fault\(s\).*text: required/);
  await writeFile(path.join(store.root, 'x.json'), '{"schema":"test/note@1","text":"hi"}');
  await assert.rejects(store.read('x.json', 'other@1'), /is test\/note@1, expected other@1/);
  assert.deepEqual(await store.read('x.json', 'test/note@1'),
    { schema: 'test/note@1', text: 'hi' });
});

test('write: validates first, stamps updatedAt, lands atomically, makes directories', async () => {
  const cwd = await fresh();
  let tick = 0;
  const store = openStore(cwd, { now: () => new Date(2026, 8, 22, 10, 0, tick++) });
  await assert.rejects(store.write('a/b.json', { schema: 'test/note@1' }), /\$\.text: required/);
  assert.equal(await store.exists('a/b.json'), false, 'nothing written when invalid');
  const written = await store.write('a/b.json', { schema: 'test/note@1', text: 'one' });
  assert.ok(written.updatedAt.startsWith('2026-09-22T'));
  const onDisk = JSON.parse(await readFile(path.join(store.root, 'a/b.json'), 'utf8'));
  assert.deepEqual(onDisk, written);
  assert.deepEqual(await readdir(path.join(store.root, 'a')), ['b.json'], 'no temp file left');
  const again = await store.write('a/b.json', { schema: 'test/note@1', text: 'two' });
  assert.notEqual(again.updatedAt, written.updatedAt);
  assert.deepEqual(await store.list('a'), ['b.json']);
  assert.deepEqual(await store.list('nope'), []);
  await store.remove('a/b.json');
  assert.equal(await store.exists('a/b.json'), false);
});

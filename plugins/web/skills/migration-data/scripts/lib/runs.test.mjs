import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DIR, FINISHED, SCHEMA, STATES, finish, list, liveness, newest, read, start, update,
} from './runs.mjs';
import { classOf } from './schema.mjs';

const fresh = () => mkdtemp(path.join(os.tmpdir(), 'mdata-runs-'));

test('a run goes queued → running → finished through validated writes, and stays', async () => {
  const cwd = await fresh();
  const run = await start(cwd, 'capture', { selection: 'sample-50', minWidth: 250 }, { pid: 4242 });
  assert.equal(run.schema, SCHEMA);
  assert.equal(classOf(SCHEMA), 'run');
  assert.match(run.id, /^run-\d{8}T\d{6}Z-capture$/);
  assert.deepEqual([run.state, run.total, run.done, run.failed, run.current, run.finished],
    ['queued', null, 0, [], null, null]);
  assert.deepEqual(run.input, { selection: 'sample-50', minWidth: 250 });
  assert.equal(run.pid, 4242);
  const running = await update(cwd, run.id,
    { state: 'running', total: 48, done: 3, current: 'pag-1' });
  assert.deepEqual([running.state, running.total, running.done, running.current],
    ['running', 48, 3, 'pag-1']);
  const failed = await update(cwd, run.id, { done: 4, fail: { id: 'pag-2', error: 'timeout' } });
  assert.deepEqual(failed.failed, [{ id: 'pag-2', error: 'timeout' }]);
  await assert.rejects(update(cwd, run.id, { state: 'done' }), /cannot set state done; use finish/);
  await assert.rejects(finish(cwd, run.id, { state: 'failed' }), /a failed run needs its error/);
  await assert.rejects(finish(cwd, run.id, { state: 'paused' }), /finish needs one of done/);
  const done = await finish(cwd, run.id, { state: 'done', summary: '47 of 48 pages captured' });
  assert.deepEqual([done.state, done.current, done.summary, done.error],
    ['done', null, '47 of 48 pages captured', null]);
  assert.ok(done.finished);
  await assert.rejects(update(cwd, run.id, { done: 5 }), /is done; it cannot change/);
  assert.deepEqual(await read(cwd, run.id), done, 'a finished run stays: the history');
  assert.deepEqual(await readdir(path.join(cwd, 'migration', DIR)), [`${run.id}.json`]);
  await assert.rejects(update(cwd, 'run-00000000T000000Z-x', {}), /no run run-0000/);
  assert.equal(await read(cwd, 'run-00000000T000000Z-x'), null);
  assert.deepEqual([STATES, FINISHED],
    [['queued', 'running', 'done', 'stopped', 'failed'], ['done', 'stopped', 'failed']]);
});

test('list is oldest first and per step; newest is the last of a step', async () => {
  const cwd = await fresh();
  const times = ['2026-09-22T10:00:00Z', '2026-09-22T10:05:00Z', '2026-09-22T10:10:00Z'];
  // Distinct ids need distinct seconds: start through a store clock per run.
  const { openStore } = await import('./store.mjs');
  const starts = [];
  for (const [i, t] of times.entries()) {
    const step = i === 1 ? 'chrome' : 'capture';
    const store = openStore(cwd, { now: () => new Date(t) });
    const id = `run-${t.replace(/[-:]/g, '')}-${step}`;
    starts.push(await store.write(`${DIR}/${id}.json`, {
      schema: SCHEMA, id, step, state: 'done', started: t, finished: t, total: 1, done: 1,
      failed: [], current: null, input: {}, summary: 's', error: null,
    }));
  }
  assert.deepEqual((await list(cwd)).map((r) => r.id), starts.map((r) => r.id));
  assert.deepEqual((await list(cwd, { step: 'capture' })).map((r) => r.started),
    [times[0], times[2]]);
  assert.equal((await newest(cwd, 'capture')).started, times[2]);
  assert.equal((await newest(cwd, 'chrome')).started, times[1]);
  assert.equal(await newest(cwd, 'elements'), null);
  assert.deepEqual(await list(await fresh()), [], 'no runs directory yet: none');
});

test('liveness: recorded state, or interrupted by a dead pid or a stale heartbeat', () => {
  const at = (iso) => new Date(iso);
  const base = { state: 'running', updatedAt: '2026-09-22T10:00:00.000Z' };
  const now = at('2026-09-22T10:05:00Z');
  assert.equal(liveness({ ...base, pid: 1 }, { now, processAlive: () => true }), 'running');
  assert.equal(liveness({ ...base, pid: 1 }, { now, processAlive: () => false }), 'interrupted');
  assert.equal(liveness(base, { now }), 'running', 'no pid: the heartbeat alone decides');
  assert.equal(liveness(base, { now: at('2026-09-22T10:11:00Z') }), 'interrupted',
    'a heartbeat older than ten minutes');
  assert.equal(liveness(base, { now: at('2026-09-22T10:11:00Z'), staleAfterMs: 20 * 60000 }),
    'running');
  assert.equal(liveness({ ...base, state: 'queued' }, { now }), 'queued');
  for (const state of ['done', 'stopped', 'failed']) {
    assert.equal(liveness({ ...base, state, pid: 1 }, { now, processAlive: () => false }), state,
      'a finished run is what it says');
  }
});

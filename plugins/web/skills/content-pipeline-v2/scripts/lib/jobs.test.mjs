import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject } from './project.mjs';
import {
  alive, enqueue, readJobs, readWorker, recordWorker, runWorker, unfinished, updateJob,
} from './jobs.mjs';

const fresh = async () => resolveProject(await mkdtemp(path.join(os.tmpdir(), 'cpv2-jobs-')));
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick += 1));

test('enqueue keeps order, deduplicates open selections, and readJobs flags dead workers',
  async () => {
    const p = await fresh();
    const a = await enqueue(p, {
      selection: 'blogs', urls: ['https://x/a', 'https://x/b'],
    }, { now: clock });
    const b = await enqueue(p, { selection: 'ja-jp', urls: ['https://x/ja'] }, { now: clock });
    const dup = await enqueue(p, { selection: 'blogs', urls: ['https://x/a'] }, { now: clock });
    assert.equal(a.added, true);
    assert.equal(dup.added, false);
    assert.equal(dup.job.id, a.job.id);
    let jobs = await readJobs(p);
    assert.deepEqual(jobs.map((j) => [j.selection, j.state, j.total]),
      [['blogs', 'queued', 2], ['ja-jp', 'queued', 1]]);
    await updateJob(p, a.job.id, { state: 'running', pid: 999999 });
    jobs = await readJobs(p, () => false);
    assert.equal(jobs[0].state, 'interrupted', 'running with a dead pid reads as interrupted');
    assert.equal((await readJobs(p, () => true))[0].state, 'running');
    const again = await enqueue(p, { selection: 'blogs', urls: [] }, {
      now: clock, isAlive: () => true,
    });
    assert.equal(again.added, false, 'a running job is still an open one');
    const resumed = await enqueue(p, { selection: 'blogs', urls: [] }, { now: clock });
    assert.equal(resumed.added, true, 'an interrupted job is not open: re-enqueue resumes');
    assert.equal(b.job.id > a.job.id, true);
  });

test('runWorker takes queued jobs in order, records progress per URL, and marks done', async () => {
  const p = await fresh();
  await enqueue(p, { selection: 'blogs', urls: ['https://x/a', 'https://x/b'] }, { now: clock });
  await enqueue(p, { selection: 'ja-jp', urls: ['https://x/ja'] }, { now: clock });
  const seen = [];
  const run = async (job, hooks) => {
    let done = 0;
    for (const url of job.urls) {
      await hooks.onProgress({ current: url });
      const mid = (await readJobs(p, () => true)).find((j) => j.id === job.id);
      seen.push([job.selection, mid.state, mid.current, mid.pid]);
      done += 1;
      await hooks.onProgress({ done, current: null });
    }
    return { cached: done };
  };
  const summary = await runWorker(p, run, { pid: 4242, now: clock });
  assert.deepEqual(summary.map((s) => s.state), ['done', 'done']);
  assert.deepEqual(seen, [
    ['blogs', 'running', 'https://x/a', 4242], ['blogs', 'running', 'https://x/b', 4242],
    ['ja-jp', 'running', 'https://x/ja', 4242],
  ]);
  const jobs = await readJobs(p);
  assert.deepEqual(jobs.map((j) => [j.state, j.done, j.result.cached]),
    [['done', 2, 2], ['done', 1, 1]]);
  assert.ok(jobs[0].finished <= jobs[1].started);
  assert.equal(await readWorker(p), null, 'worker.json is removed when the loop ends');
});

test('runWorker marks a cut-short job stopped, a throwing job failed, and leaves the rest queued',
  async () => {
    const p = await fresh();
    await enqueue(p, { selection: 'a', urls: ['https://x/1', 'https://x/2'] }, { now: clock });
    await enqueue(p, { selection: 'b', urls: ['https://x/3'] }, { now: clock });
    let stop = false;
    const run = async (job, hooks) => {
      await hooks.onProgress({ done: 1 });
      stop = true;
      return {};
    };
    await runWorker(p, run, { stopping: () => stop, now: clock });
    let jobs = await readJobs(p);
    assert.deepEqual(jobs.map((j) => j.state), ['stopped', 'queued']);
    stop = false;
    await runWorker(p, async () => { throw new Error('proxy exited'); }, { now: clock });
    jobs = await readJobs(p);
    assert.deepEqual(jobs.map((j) => [j.state, j.error ?? null]),
      [['stopped', null], ['failed', 'proxy exited']]);
    const raw = JSON.parse(await readFile(path.join(p.work, 'warm', `${jobs[1].id}.json`)));
    assert.equal(raw.current, null);
  });

test('recordWorker makes a just-spawned worker visible before it runs; no .tmp file remains',
  async () => {
    const p = await fresh();
    await recordWorker(p, 4242, clock);
    assert.equal((await readWorker(p, () => true)).pid, 4242);
    assert.equal(await readWorker(p, () => false), null, 'a dead pid is no worker');
    const { readdir } = await import('node:fs/promises');
    assert.ok((await readdir(path.join(p.work, 'warm'))).every((n) => !n.includes('.tmp')));
  });

test('unfinished lists selections whose last job stopped, unless a later job finished them',
  async () => {
    const p = await fresh();
    const a = await enqueue(p, { selection: 'a', urls: ['u1', 'u2'] }, { now: clock });
    const b = await enqueue(p, { selection: 'b', urls: ['u3'] }, { now: clock });
    await updateJob(p, a.job.id, { state: 'stopped', done: 1 });
    await updateJob(p, b.job.id, { state: 'running', pid: 999999 });
    assert.deepEqual((await unfinished(p, () => false)).map((j) => [j.selection, j.state]),
      [['a', 'stopped'], ['b', 'interrupted']]);
    const again = await enqueue(p, { selection: 'a', urls: ['u2'] }, { now: clock });
    await updateJob(p, again.job.id, { state: 'done', done: 1 });
    assert.deepEqual((await unfinished(p, () => false)).map((j) => j.selection), ['b']);
  });

test('claimWorker hands the start to exactly one concurrent caller and replaces stale claims',
  async () => {
    const { claimWorker } = await import('./jobs.mjs');
    const p = await fresh();
    const results = await Promise.all([1, 2, 3, 4].map(() => claimWorker(p, clock)));
    assert.equal(results.filter((r) => r.claimed).length, 1);
    await recordWorker(p, 4242, clock);
    const later = await claimWorker(p, clock, () => true);
    assert.deepEqual([later.claimed, later.worker.pid], [false, 4242]);
    const dead = await claimWorker(p, clock, () => false);
    assert.equal(dead.claimed, true, 'a dead worker\'s file is replaced');
    const stale = await claimWorker(p, () => new Date(Date.UTC(2027, 0, 1)));
    assert.equal(stale.claimed, true, 'an unfulfilled claim older than 10 s is replaced');
  });

test('alive: this process is, a never-used pid and no pid are not', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(2 ** 22 - 1), false);
  assert.deepEqual([alive(null), alive(0), alive(undefined)], [false, false, false]);
});

test('the worker rewrites cache/progress.json after every URL, without the URL lists', async () => {
  const p = await fresh();
  await enqueue(p, { selection: 'blogs', urls: ['https://x/a', 'https://x/b'] }, { now: clock });
  const { progressFile } = await import('./jobs.mjs');
  const snapshots = [];
  const run = async (job, hooks) => {
    for (const [i, url] of job.urls.entries()) {
      await hooks.onProgress({ current: url });
      snapshots.push(JSON.parse(await readFile(progressFile(p), 'utf8')));
      await hooks.onProgress({ done: i + 1, current: null });
    }
    return {};
  };
  await runWorker(p, run, { now: clock, isAlive: () => true });
  assert.deepEqual(snapshots.map((s) => [s.open, s.running.current, s.running.done]),
    [[true, 'https://x/a', 0], [true, 'https://x/b', 1]]);
  assert.equal('urls' in snapshots[0].jobs[0], false, 'no URL lists in the progress file');
  const final = JSON.parse(await readFile(progressFile(p), 'utf8'));
  assert.deepEqual([final.open, final.running, final.jobs[0].state], [false, null, 'done']);
  assert.ok(final.updatedAt);
});

test('a job stopped after 2 of 3 visits, one of them failed, is stopped — not done', async () => {
  const p = await fresh();
  await enqueue(p, { selection: 'a', urls: ['u1', 'u2', 'u3'] }, { now: clock });
  let stop = false;
  await runWorker(p, async (job, hooks) => {
    await hooks.onProgress({ done: 2 });
    stop = true;
    await hooks.onProgress({ failed: 1 });
    return {};
  }, { stopping: () => stop, now: clock, isAlive: () => true });
  const [job] = await readJobs(p);
  assert.deepEqual([job.state, job.done, job.failed], ['stopped', 2, 1]);
  assert.deepEqual((await unfinished(p)).map((j) => j.selection), ['a']);
  await updateJob(p, job.id, { state: 'running', pid: process.pid });
  const { openWork } = await import('./jobs.mjs');
  assert.equal((await openWork(p, () => true)).label, '2/3 (a)', 'done counts visits');
});

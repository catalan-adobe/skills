import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject } from './project.mjs';
import {
  enqueue, readJobs, readWorker, runWorker, updateJob,
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

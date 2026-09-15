// Cache jobs: one file per approved selection under migration/.work/warm/, consumed in order
// by a single detached worker. States: queued → running → done | stopped | failed;
// a `running` job whose worker died reads as `interrupted`.
import {
  mkdir, readdir, readFile, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const jobsDir = (project) => path.join(project.work, 'warm');
const workerFile = (project) => path.join(jobsDir(project), 'worker.json');
const jobFile = (project, id) => path.join(jobsDir(project), `${id}.json`);

export function alive(pid) {
  if (!pid) return false;
  try { return process.kill(pid, 0); } catch { return false; }
}

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);
async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Every job, oldest first; a running job with a dead worker is reported `interrupted`. */
export async function readJobs(project, isAlive = alive) {
  const names = await readdir(jobsDir(project)).catch(() => []);
  const jobs = await Promise.all(names
    .filter((n) => n.endsWith('.json') && n !== 'worker.json')
    .map((n) => readJson(path.join(jobsDir(project), n))));
  return jobs.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)).map((job) => (
    job.state === 'running' && !isAlive(job.pid) ? { ...job, state: 'interrupted' } : job));
}

export const readWorker = async (project, isAlive = alive) => {
  const worker = await readJson(workerFile(project));
  return worker && isAlive(worker.pid) ? worker : null;
};

/**
 * Adds a job for `selection` over `urls` unless one for the same selection is already
 * queued or running. Returns `{ job, added }`.
 */
export async function enqueue(project, { selection, urls, pace }, {
  now = () => new Date(), isAlive = alive,
} = {}) {
  const open = (await readJobs(project, isAlive)).find((j) => (
    j.selection === selection && (j.state === 'queued' || j.state === 'running')));
  if (open) return { job: open, added: false };
  const stamp = now().toISOString();
  const id = `${stamp.replace(/[-:.]/g, '').slice(0, 15)}-${selection.replace(/[^\w]+/g, '_')}`;
  const job = {
    id, selection, urls, pace, total: urls.length, done: 0, failed: 0, current: null,
    state: 'queued', queued: stamp, started: null, finished: null, pid: null,
  };
  await writeJson(jobFile(project, id), job);
  return { job, added: true };
}

export async function updateJob(project, id, patch) {
  const job = { ...(await readJson(jobFile(project, id))), ...patch };
  await writeJson(jobFile(project, id), job);
  return job;
}

export const clearJobs = (project) => rm(jobsDir(project), { recursive: true, force: true });

/**
 * The worker loop: takes queued jobs in order and runs each through `run(job, hooks)`,
 * where hooks are `onProgress({ done, failed, current })` and `shouldStop()`. Stops taking
 * jobs once `stopping()` is true; a job cut short is `stopped`, a job that threw is
 * `failed` with the message. Records itself in worker.json for `warm.mjs status|stop`.
 */
export async function runWorker(project, run, {
  pid = process.pid, stopping = () => false, now = () => new Date(), isAlive = alive,
} = {}) {
  await writeJson(workerFile(project), { pid, started: now().toISOString() });
  const summary = [];
  try {
    for (;;) {
      if (stopping()) break;
      const job = (await readJobs(project, isAlive)).find((j) => j.state === 'queued');
      if (!job) break;
      await updateJob(project, job.id, { state: 'running', pid, started: now().toISOString() });
      const hooks = {
        onProgress: (p) => updateJob(project, job.id, p),
        shouldStop: stopping,
      };
      const outcome = await run(job, hooks).then(
        async (result) => {
          const progress = await readJson(jobFile(project, job.id));
          const cut = stopping() && progress.done + progress.failed < job.total;
          return { state: cut ? 'stopped' : 'done', result };
        },
        (err) => ({ state: 'failed', error: err.message }),
      );
      await updateJob(project, job.id, {
        ...outcome, finished: now().toISOString(), current: null,
      });
      summary.push({ id: job.id, state: outcome.state });
    }
  } finally {
    await rm(workerFile(project), { force: true });
  }
  return summary;
}

/**
 * The jobs still holding the cache step, as one line for status displays:
 * `12/50 (blogs) · queued: ja-jp`, or null when nothing is queued or running.
 */
export async function openWork(project, isAlive = alive) {
  const jobs = await readJobs(project, isAlive);
  const running = jobs.find((j) => j.state === 'running');
  const queued = jobs.filter((j) => j.state === 'queued');
  if (!running && !queued.length) return null;
  const head = running
    ? `${running.done + running.failed}/${running.total} (${running.selection})`
    : 'worker not started';
  const tail = queued.length ? ` · queued: ${queued.map((j) => j.selection).join(', ')}` : '';
  return { label: `${head}${tail}`, running: running ?? null, queued };
}

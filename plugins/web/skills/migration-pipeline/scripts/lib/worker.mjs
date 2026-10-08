// Long steps run in a detached worker process: the caller returns at once, the run file
// carries progress and a heartbeat, `status` and `stop` act on the newest run of a step.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { data } from './data.mjs';

export const WORKER_SCRIPT = fileURLToPath(new URL('../pipeline.mjs', import.meta.url));
const ALIVE = ['queued', 'running'];

/** The newest run of a step with its liveness; null without one. */
export async function newest(cwd, step) {
  const { runs } = await data(cwd);
  const run = await runs.newest(cwd, step);
  return run ? { ...run, liveness: runs.liveness(run) } : null;
}

export const isAlive = (run) => Boolean(run && ALIVE.includes(run.liveness));

/**
 * Starts `pipeline <step> --worker` detached unless a run of the step is alive; its output
 * goes to `migration/.work/<step>/worker.log`.
 */
export async function start(cwd, step, { io = { spawn }, mode } = {}) {
  const run = await newest(cwd, step);
  if (isAlive(run)) return { started: false, run: run.id, note: `a ${step} run is alive` };
  const work = path.join(cwd, 'migration', '.work', step);
  await mkdir(work, { recursive: true });
  const log = openSync(path.join(work, 'worker.log'), 'a');
  const child = io.spawn(process.execPath,
    [WORKER_SCRIPT, step, ...(mode ? [mode] : []), '--worker'],
    { cwd, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  return { started: true, pid: child.pid };
}

/** Ends an alive worker after its current page; the run is marked stopped. */
export async function stop(cwd, step, { kill = process.kill } = {}) {
  const run = await newest(cwd, step);
  if (!isAlive(run) || !run.pid) return { stopped: false };
  kill(run.pid, 'SIGTERM');
  const { runs } = await data(cwd);
  await runs.finish(cwd, run.id, { state: 'stopped', summary: 'stopped by the operator' });
  return { stopped: true, run: run.id };
}

/**
 * The `<step> [status|stop|<mode>]` command: status, stop, or start when there is work;
 * any other word is a mode the step knows, handed to `pending` and to the worker.
 */
export async function command(cwd, step, positional, { pending, worker, flags }) {
  const mode = ['status', 'stop'].includes(positional[0]) ? undefined : positional[0];
  if (flags['--worker']) {
    await worker(cwd, mode);
    return { worker: 'done' };
  }
  if (positional[0] === 'status') return (await newest(cwd, step)) ?? { runs: 0 };
  if (positional[0] === 'stop') return stop(cwd, step);
  const work = await pending(cwd, mode);
  if (!work.length) return { started: false, note: `nothing to do for ${step}` };
  const started = await start(cwd, step, { mode });
  return started.started ? { ...started, pending: work } : started;
}

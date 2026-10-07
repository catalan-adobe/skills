// Runs: one execution of one step, one shape for every step, kept after it finished — the
// runs directory is the migration's history. Liveness is two signals: a pid when the
// worker is a local process, and updatedAt as the heartbeat the worker refreshes.
import { HEAD, register } from './schema.mjs';
import { openStore, runId } from './store.mjs';

export const DIR = 'runs';
export const SCHEMA = 'runs/run@1';
export const STATES = ['queued', 'running', 'done', 'stopped', 'failed'];
export const FINISHED = ['done', 'stopped', 'failed'];
/** A running run whose heartbeat is older than this reads as interrupted. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

register('runs/run', 1, 'run', {
  type: 'object',
  required: ['schema', 'id', 'step', 'state', 'started', 'finished', 'total', 'done', 'failed',
    'current', 'input', 'summary', 'error'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    id: { type: 'string', pattern: '^run-\\d{8}T\\d{6}Z-[a-z][a-z0-9-]*$' },
    step: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    state: { enum: STATES },
    started: { type: 'string', format: 'date-time' },
    finished: { type: ['string', 'null'], format: 'date-time' },
    pid: { type: 'integer', minimum: 1 },
    total: { type: ['integer', 'null'], minimum: 0 },
    done: { type: 'integer', minimum: 0 },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'error'],
        additionalProperties: false,
        properties: { id: { type: 'string' }, error: { type: 'string' } },
      },
    },
    current: { type: ['string', 'null'] },
    input: { type: 'object' },
    summary: { type: ['string', 'null'] },
    error: { type: ['string', 'null'] },
  },
});

const file = (id) => `${DIR}/${id}.json`;

/** Starts a run of `step` on `input`, queued; `pid` when the worker is a local process. */
export async function start(cwd, step, input = {}, { pid } = {}) {
  const store = openStore(cwd);
  const now = store.now();
  const id = runId(step, now);
  return store.write(file(id), {
    schema: SCHEMA, id, step, state: 'queued', started: now.toISOString(), finished: null,
    ...(pid ? { pid } : {}), total: null, done: 0, failed: [], current: null, input,
    summary: null, error: null,
  });
}

/** The run by id, or null. */
export const read = (cwd, id) => openStore(cwd).read(file(id), SCHEMA);

/**
 * Progress: any of `state` (to `running`), `pid`, `total`, `done`, `current`, a failure to
 * append (`fail: { id, error }`). Every update refreshes `updatedAt`, the heartbeat.
 */
export async function update(cwd, id, patch) {
  const store = openStore(cwd);
  const run = await read(cwd, id);
  if (!run) throw new Error(`no run ${id}`);
  if (FINISHED.includes(run.state)) throw new Error(`run ${id} is ${run.state}; it cannot change`);
  const { fail, ...rest } = patch;
  if (rest.state && !['queued', 'running'].includes(rest.state)) {
    throw new Error(`update cannot set state ${rest.state}; use finish`);
  }
  return store.write(file(id), {
    ...run, ...rest, failed: fail ? [...run.failed, fail] : run.failed,
  });
}

/** Ends a run: done, stopped or failed, with what it did in words, and the error if any. */
export async function finish(cwd, id, { state, summary = null, error = null }) {
  const store = openStore(cwd);
  const run = await read(cwd, id);
  if (!run) throw new Error(`no run ${id}`);
  if (!FINISHED.includes(state)) throw new Error(`finish needs one of ${FINISHED.join(', ')}`);
  if (state === 'failed' && !error) throw new Error('a failed run needs its error');
  return store.write(file(id), {
    ...run, state, finished: store.now().toISOString(), current: null, summary, error,
  });
}

/** Every run, oldest first (ids sort by time); optionally one step's. */
export async function list(cwd, { step } = {}) {
  const store = openStore(cwd);
  const names = await store.list(DIR);
  const runs = await Promise.all(names.filter((n) => n.endsWith('.json'))
    .map((n) => store.read(`${DIR}/${n}`, SCHEMA)));
  return runs.filter((r) => r && (!step || r.step === step));
}

/** The newest run of a step, or null. */
export async function newest(cwd, step) {
  return (await list(cwd, { step })).at(-1) ?? null;
}

/**
 * What a run is doing now: its recorded state, or `interrupted` for a running run whose
 * local process is gone or whose heartbeat is older than `staleAfterMs`.
 */
export function liveness(run, {
  now = new Date(), staleAfterMs = STALE_AFTER_MS, processAlive = defaultProcessAlive,
} = {}) {
  if (!['queued', 'running'].includes(run.state)) return run.state;
  if (run.pid && !processAlive(run.pid)) return 'interrupted';
  if (now - new Date(run.updatedAt) > staleAfterMs) return 'interrupted';
  return run.state;
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

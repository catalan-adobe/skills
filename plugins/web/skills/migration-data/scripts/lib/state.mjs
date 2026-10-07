// The migration's state: the process a migration goes through (the step registry) and
// each step's state computed from the data, the runs and the approvals — written to
// state.json for clients that cannot compute it. A step is done when its check finds its
// outcome in the data; the checks arrive with the units that own the data.
import { open as openMigration } from './migration.mjs';
import { liveness, newest } from './runs.mjs';
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';

export const FILE = 'state.json';
export const SCHEMA = 'state/state@1';

/**
 * The process: what a migration goes through, in dependency order. `gate` marks a step
 * that waits for the operator's approval. Setup and tooling are a client's business.
 */
export const STEPS = [
  { id: 'discover', dependsOn: [], gate: false },
  { id: 'access', dependsOn: [], gate: false },
  { id: 'cache', dependsOn: ['discover', 'access'], gate: true },
  { id: 'chrome', dependsOn: ['cache'], gate: false },
  { id: 'elements', dependsOn: ['chrome'], gate: true },
  { id: 'blocks', dependsOn: ['elements'], gate: false },
  { id: 'report', dependsOn: ['discover'], gate: false },
];
export const STEP_IDS = STEPS.map((s) => s.id);
export const STATES = ['done', 'ready', 'blocked', 'waiting-operator', 'running'];

register('state/state', 1, 'derived', {
  type: 'object',
  required: ['schema', 'generatedAt', 'summary', 'steps'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    generatedAt: { type: 'string', format: 'date-time' },
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'state', 'blockedBy', 'run', 'progress', 'note'],
        additionalProperties: false,
        properties: {
          id: { enum: STEP_IDS },
          state: { enum: STATES },
          blockedBy: { type: 'array', items: { enum: STEP_IDS } },
          run: { type: ['string', 'null'] },
          progress: { type: ['string', 'null'] },
          note: { type: ['string', 'null'] },
        },
      },
    },
  },
});

/** A check: `(cwd) => Promise<{ pass: boolean, note?: string }>`; absent means not done. */
export const NO_CHECKS = Object.freeze({});

/**
 * Every step's state, from the checks (done), the newest run (running, or interrupted
 * as a note), the dependencies (blocked), the gate and the approvals (waiting-operator),
 * else ready.
 */
export async function compute(cwd, checks = NO_CHECKS, { now = new Date() } = {}) {
  const migration = await openMigration(cwd);
  const results = {};
  for (const step of STEPS) {
    // eslint-disable-next-line no-await-in-loop
    results[step.id] = checks[step.id] ? await checks[step.id](cwd) : { pass: false };
  }
  const done = (id) => results[id].pass;
  const steps = [];
  for (const step of STEPS) {
    // eslint-disable-next-line no-await-in-loop
    const run = await newest(cwd, step.id);
    const live = run ? liveness(run, { now }) : null;
    const entry = {
      id: step.id, state: 'ready', blockedBy: [], run: null, progress: null,
      note: results[step.id].note ?? null,
    };
    if (done(step.id)) {
      entry.state = 'done';
    } else if (live === 'queued' || live === 'running') {
      entry.state = 'running';
      entry.run = run.id;
      entry.progress = run.total ? `${run.done}/${run.total}` : live;
    } else {
      if (live === 'interrupted') {
        entry.note = `run ${run.id} was interrupted; start the step again`;
      }
      entry.blockedBy = step.dependsOn.filter((d) => !done(d));
      if (entry.blockedBy.length) entry.state = 'blocked';
      else if (step.gate && !migration.approvals[step.id]) entry.state = 'waiting-operator';
    }
    steps.push(entry);
  }
  return { schema: SCHEMA, generatedAt: now.toISOString(), summary: summarise(steps), steps };
}

/** The migration in a sentence or two. */
export function summarise(steps) {
  const by = (state) => steps.filter((s) => s.state === state).map((s) => s.id);
  const parts = [];
  const doneIds = by('done');
  if (doneIds.length) parts.push(`done: ${doneIds.join(', ')}`);
  for (const s of steps.filter((x) => x.state === 'running')) {
    parts.push(`${s.id} running${s.progress ? ` (${s.progress})` : ''}`);
  }
  const waiting = by('waiting-operator');
  if (waiting.length) parts.push(`waiting for the operator: ${waiting.join(', ')}`);
  const ready = by('ready');
  if (ready.length) parts.push(`ready: ${ready.join(', ')}`);
  const blocked = by('blocked');
  if (blocked.length) parts.push(`blocked: ${blocked.join(', ')}`);
  return parts.length ? `${parts.join('; ')}.` : 'Nothing yet.';
}

/** Computes and writes state.json; returns it. */
export async function write(cwd, checks = NO_CHECKS, options = {}) {
  const state = await compute(cwd, checks, options);
  return openStore(cwd).write(FILE, state);
}

/** The state as a table for people. */
export function asText(state) {
  const width = Math.max(...state.steps.map((s) => s.id.length));
  const rows = state.steps.map((s) => {
    const extra = [s.progress, s.blockedBy.length ? `by ${s.blockedBy.join(', ')}` : null, s.note]
      .filter(Boolean).join(' · ');
    return `${s.id.padEnd(width)}  ${s.state.padEnd(16)} ${extra}`.trimEnd();
  });
  return [`${'step'.padEnd(width)}  state`, ...rows, '', state.summary].join('\n');
}

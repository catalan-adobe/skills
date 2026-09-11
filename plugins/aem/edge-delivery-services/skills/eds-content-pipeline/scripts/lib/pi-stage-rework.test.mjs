import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Loads workflows/pi/stage.mjs's body (minus its `export const meta` line) and runs it as
// an async function with stubbed pi runtime globals, matching how pi actually executes it
// (the script body already runs inside an async function; see runtime.md).
const scriptPath = fileURLToPath(new URL('../../workflows/pi/stage.mjs', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function loadStageRunner() {
  const src = await readFile(scriptPath, 'utf8');
  const body = src.replace(/^export const meta[\s\S]*?;\n/, '');
  return new AsyncFunction('agent', 'parallel', 'workflow', 'phase', 'log', 'args', 'cwd', body);
}

function makePlan() {
  return {
    stage: 'template',
    params: {},
    timeouts: {},
    units: [
      {
        id: 'author-transformer', kind: 'run', dependsOn: [],
        resolvedCommand: 'cmd-at', doneWhen: 'dw-at', resolvedDoneWhen: 'dw-at-resolved',
        rework: { max_rounds: 2 },
      },
      {
        id: 'review', kind: 'run', dependsOn: ['author-transformer'],
        resolvedCommand: 'cmd-review', doneWhen: 'dw-review',
        resolvedDoneWhen: 'dw-review-resolved',
      },
    ],
  };
}

/** Fails review's own check, and fails author-transformer's check only during a rework run. */
function makeAgentStub(plan) {
  return async (prompt, opts) => {
    const { label } = opts;
    if (label === 'plan') return plan;
    if (label === 'record-run') return { ok: true };
    if (label.endsWith(':check1') || label.endsWith(':check2')) {
      if (label.startsWith('review') && !label.includes(':rework')) {
        return { ok: false, stderrTail: 'review failed' };
      }
      if (label.startsWith('author-transformer:rework')) {
        return { ok: false, stderrTail: 'transformer failed' };
      }
      return { ok: true };
    }
    return { exitCode: 0, stdoutJson: null, stderrTail: '' };
  };
}

test('rework loop does not duplicate a unit entry when transformer fails mid-rework', async () => {
  const run = await loadStageRunner();
  const plan = makePlan();
  const parallelStub = async (fns) => Promise.all(fns.map((fn) => fn()));
  const args = { stage: 'template', params: {}, skill: '/skill', repo: '/repo' };
  const result = await run(
    makeAgentStub(plan), parallelStub, async () => {}, () => {}, () => {}, args, '/repo',
  );
  assert.deepEqual(result, {
    stage: 'template',
    params: {},
    units: [
      { id: 'author-transformer', verdict: 'done' },
      { id: 'review', verdict: 'failed' },
      { id: 'author-transformer', verdict: 'failed' },
    ],
    stopped: 'author-transformer',
  });
});

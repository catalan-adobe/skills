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

test('a run unit whose command exits non-zero fails even if done_when would pass', async () => {
  const run = await loadStageRunner();
  const plan = {
    stage: 'bulk',
    params: { template: 'product' },
    timeouts: {},
    units: [{
      id: 'run', kind: 'run', dependsOn: [],
      resolvedCommand: 'cmd-run', doneWhen: 'dw-run', resolvedDoneWhen: 'dw-run-resolved',
    }],
  };
  const seen = [];
  const agentStub = async (prompt, { label }) => {
    seen.push(label);
    if (label === 'plan') return plan;
    if (label === 'record-run') return { ok: true };
    if (label.includes(':check')) return { ok: true };
    return { exitCode: 1, stdoutJson: null, stderrTail: 'DA_TOKEN is unset' };
  };
  const args = { stage: 'bulk', params: { template: 'product' }, skill: '/skill', repo: '/repo' };
  const result = await run(agentStub, async (fns) => Promise.all(fns.map((f) => f())),
    async () => {}, () => {}, () => {}, args, '/repo');
  assert.deepEqual(result.units, [{ id: 'run', verdict: 'failed' }]);
  assert.equal(result.stopped, 'run');
  assert.ok(!seen.some((l) => l.includes(':check')), 'done_when not consulted after a failure');
  assert.deepEqual(seen.filter((l) => l.startsWith('run:act')), ['run:act1', 'run:act2']);
});

const runtime = (agentStub, args) => loadStageRunner().then((run) => run(
  agentStub, async (fns) => Promise.all(fns.map((f) => f())),
  async () => {}, () => {}, () => {}, args, '/repo',
));

test('an llm unit is dispatched on its mapped tier with the prompt file and inputs', async () => {
  const plan = {
    stage: 'template',
    params: { template: 'product' },
    timeouts: { unit_minutes: 3 },
    units: [{
      id: 'analyse', kind: 'llm', role: 'prompts/analyst.md', tier: 'high', dependsOn: [],
      inputs: ['data/templates.json'], outputs: ['templates/product/analysis.md'],
      doneWhen: 'dw', resolvedDoneWhen: 'dw-resolved',
    }],
  };
  const calls = [];
  const agentStub = async (prompt, opts) => {
    calls.push({ prompt, opts });
    if (opts.label === 'plan') return plan;
    if (opts.label === 'record-run') return { ok: true };
    if (opts.label.includes(':check')) return { ok: true };
    return 'analysis written';
  };
  const result = await runtime(agentStub, {
    stage: 'template', params: { template: 'product' }, skill: '/skill', repo: '/repo',
  });
  assert.deepEqual(result.units, [{ id: 'analyse', verdict: 'done' }]);
  const act = calls.find((c) => c.opts.label === 'analyse:act1');
  assert.equal(act.opts.tier, 'big', 'high maps to the big pi tier');
  assert.equal(act.opts.timeoutMs, 3 * 60000);
  assert.match(act.prompt, /^Read \/skill\/prompts\/analyst\.md and follow it\. Repo: \/repo\./);
  assert.match(act.prompt, /Inputs: data\/templates\.json\. Outputs: templates\/product\/analysis/);
  assert.equal(act.opts.schema, undefined, 'llm units are free text');
  const check = calls.find((c) => c.opts.label === 'analyse:check1');
  assert.equal(check.opts.tier, 'small');
  assert.match(check.prompt, /cd '\/repo' && dw-resolved$/);
});

test('rework stops after exactly max_rounds when review keeps failing', async () => {
  const plan = makePlan();
  const agentStub = async (prompt, { label }) => {
    if (label === 'plan') return plan;
    if (label === 'record-run') return { ok: true };
    if (label.includes(':check')) {
      return label.startsWith('review') ? { ok: false, stderrTail: 'still wrong' } : { ok: true };
    }
    return { exitCode: 0, stdoutJson: null, stderrTail: '' };
  };
  const result = await runtime(agentStub, {
    stage: 'template', params: {}, skill: '/skill', repo: '/repo',
  });
  assert.deepEqual(result.units.map((u) => `${u.id}:${u.verdict}`), [
    'author-transformer:done',
    'review:failed', 'author-transformer:done',
    'review:failed', 'author-transformer:done',
    'review:failed',
  ], 'two rework rounds, then the review failure stands');
  assert.equal(result.stopped, 'review');
});

test('a repo path with spaces and quotes is quoted in every agent command', async () => {
  const plan = {
    stage: 'bulk', params: { template: 'p' }, timeouts: {},
    units: [{ id: 'dry-run', kind: 'run', dependsOn: [], resolvedCommand: 'node x',
      doneWhen: 'dw', resolvedDoneWhen: 'dw' }],
  };
  const prompts = [];
  const agentStub = async (prompt, { label }) => {
    prompts.push(prompt);
    if (label === 'plan') return plan;
    if (label === 'record-run') return { ok: true };
    if (label.includes(':check')) return { ok: true };
    return { exitCode: 0, stdoutJson: null, stderrTail: '' };
  };
  const repo = "/tmp/it's a repo";
  await runtime(agentStub, { stage: 'bulk', params: { template: 'p' }, skill: '/s', repo });
  const act = prompts.find((p) => p.endsWith('node x'));
  assert.ok(act.includes(`cd '/tmp/it'\\''s a repo' && node x`), act);
});

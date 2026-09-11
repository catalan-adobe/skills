export const meta = { name: 'eds_stage', description: 'Runs a stage: plan, units, gate, rework.' }

// args: { stage: 'discover'|'template'|'bulk', params: object, skill: string, repo: string }
// skill = absolute path of the installed skill; repo = absolute path of the EDS repo.

const TIERS = { low: 'small', medium: 'medium', high: 'big' };

const PLAN_SCHEMA = {
  type: 'object',
  required: ['stage', 'params', 'units'],
  properties: {
    stage: { type: 'string' },
    params: { type: 'object' },
    timeouts: { type: 'object' },
    units: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'dependsOn', 'doneWhen', 'resolvedDoneWhen'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['run', 'llm'] },
          command: { type: 'string' },
          resolvedCommand: { type: 'string' },
          role: { type: 'string' },
          tier: { type: 'string' },
          parallel: { type: 'boolean' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          inputs: { type: 'array', items: { type: 'string' } },
          outputs: { type: 'array', items: { type: 'string' } },
          doneWhen: { type: 'string' },
          resolvedDoneWhen: { type: 'string' },
          rework: { type: ['object', 'null'] },
        },
      },
    },
  },
};

const RUN_SCHEMA = {
  type: 'object',
  required: ['exitCode'],
  properties: {
    exitCode: { type: 'number' },
    stdoutJson: {},
    stderrTail: { type: 'string' },
  },
};

const CHECK_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    exitCode: { type: 'number' },
    stderrTail: { type: 'string' },
  },
};

const RECORD_SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };

const RUN_RULES = 'Run exactly this command from the repo root (cwd = the repo). Do not edit, '
  + 'create or delete any files. Return only JSON matching the schema: exitCode (the command\'s '
  + 'exit code), stdoutJson (its stdout parsed as JSON, or null when it is not JSON), stderrTail '
  + '(the last few lines of stderr, or an empty string). Command: ';

const CHECK_RULES = 'Run exactly this command from the repo root (cwd = the repo) to check '
  + 'whether a unit is done. Do not edit, create or delete any files. Return only JSON matching '
  + 'the schema: ok (true when the command exits 0), exitCode, stderrTail (the last few lines '
  + 'of stderr, or an empty string). Command: ';

/** Prompt for an `llm` unit: point the agent at the skill's prompt file, not at the text of it. */
function llmPrompt(unit, ctx) {
  const inputs = unit.inputs.length ? unit.inputs.join(', ') : 'none';
  const outputs = unit.outputs.length ? unit.outputs.join(', ') : 'none';
  return `Read ${ctx.skill}/${unit.role} and follow it. Repo: ${ctx.repo}. `
    + `Params: ${JSON.stringify(ctx.params)}. Inputs: ${inputs}. Outputs: ${outputs}.`;
}

/**
 * Runs one unit's action once, checks `done_when`, and on failure retries the whole unit once.
 * `tag` disambiguates labels for a reworked re-run; `isolation` is `'worktree'` for a unit that
 * ran as part of a `parallel: true` batch.
 */
async function settleUnit(unit, ctx, tag = '', isolation) {
  const iso = isolation ? { isolation } : {};
  const base = `${unit.id}${tag}`;
  const runPrompt = `${RUN_RULES}${unit.resolvedCommand}`;
  const checkPrompt = `${CHECK_RULES}${unit.resolvedDoneWhen}`;
  const act = (n) => {
    const label = `${base}:act${n}`;
    return unit.kind === 'run'
      ? agent(runPrompt, { tier: 'small', schema: RUN_SCHEMA, label: label, ...iso })
      : agent(llmPrompt(unit, ctx), {
        tier: TIERS[unit.tier], timeoutMs: ctx.timeoutMs, label: label, ...iso,
      });
  };
  const check = (n) => {
    const label = `${base}:check${n}`;
    return agent(checkPrompt, { tier: 'small', schema: CHECK_SCHEMA, label: label, ...iso });
  };
  await act(1);
  let result = await check(1);
  if (!result.ok) {
    await act(2);
    result = await check(2);
  }
  if (result.ok) return { id: unit.id, verdict: 'done' };
  return {
    id: unit.id,
    verdict: 'failed',
    stop: { stopped: unit.id, doneWhen: unit.doneWhen, stderrTail: result.stderrTail ?? '' },
  };
}

/**
 * Owns the rework loop: a `review` unit whose `done_when` fails is retried by re-running
 * `author-transformer` then `review` again, up to `author-transformer`'s `rework.max_rounds`.
 */
async function settleReview(reviewUnit, transformerUnit, ctx) {
  const maxRounds = transformerUnit?.rework?.max_rounds ?? 0;
  const extra = [];
  let round = 0;
  let outcome = await settleUnit(reviewUnit, ctx);
  while (outcome.verdict === 'failed' && transformerUnit && round < maxRounds) {
    round += 1;
    extra.push({ id: reviewUnit.id, verdict: outcome.verdict });
    const authored = await settleUnit(transformerUnit, ctx, `:rework${round}`);
    extra.push({ id: transformerUnit.id, verdict: authored.verdict });
    if (authored.verdict === 'failed') return { outcome: authored, extra };
    outcome = await settleUnit(reviewUnit, ctx, `:rework${round}`);
  }
  return { outcome, extra };
}

/**
 * Ledger phase: appends the `runs` row via `stage.mjs record-run`. The clock read is the
 * shell's `date`, not this script's — this script never calls a clock or random function.
 */
async function recordRun(ctx, outcome) {
  const runIdExpr = `${ctx.stage}-${ctx.params.template ?? 'run'}-$(date +%s)`;
  const prompt = `Run exactly: cd ${ctx.repo} && node ${ctx.skill}/scripts/lib/stage.mjs `
    + `record-run ${ctx.stage} --run-id ${runIdExpr} --outcome ${outcome} and return `
    + '{"ok": true} if it exits 0, otherwise {"ok": false}.';
  return agent(prompt, { tier: 'small', schema: RECORD_SCHEMA, label: 'record-run' });
}

const { stage, params, skill, repo } = args;

phase('Plan');
const kv = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ');
const planCmd = kv ? `plan ${stage} ${kv}` : `plan ${stage}`;
const planPrompt = `Run exactly: cd ${repo} && node ${skill}/scripts/lib/stage.mjs ${planCmd} and `
  + 'return its stdout JSON verbatim.';
const plan = await agent(planPrompt, { tier: 'small', schema: PLAN_SCHEMA, label: 'plan' });

phase('Units');
const ctx = {
  stage,
  params: plan.params,
  skill,
  repo,
  timeoutMs: plan.timeouts?.unit_minutes ? plan.timeouts.unit_minutes * 60000 : null,
};
const transformerUnit = plan.units.find((u) => u.id === 'author-transformer');
const results = [];
let stopped = null;
let i = 0;
while (i < plan.units.length && !stopped) {
  const unit = plan.units[i];
  if (unit.parallel) {
    const batch = [];
    let j = i;
    while (j < plan.units.length && plan.units[j].parallel) { batch.push(plan.units[j]); j += 1; }
    const outcomes = await parallel(batch.map((u) => () => settleUnit(u, ctx, '', 'worktree')));
    for (const outcome of outcomes) {
      results.push({ id: outcome.id, verdict: outcome.verdict });
      if (outcome.stop && !stopped) stopped = outcome.stop;
    }
    i = j;
  } else if (unit.id === 'review') {
    const { outcome, extra } = await settleReview(unit, transformerUnit, ctx);
    results.push(...extra, { id: outcome.id, verdict: outcome.verdict });
    if (outcome.stop) stopped = outcome.stop;
    i += 1;
  } else {
    const outcome = await settleUnit(unit, ctx);
    results.push({ id: outcome.id, verdict: outcome.verdict });
    if (outcome.stop) stopped = outcome.stop;
    i += 1;
  }
}

phase('Ledger');
await recordRun(ctx, stopped ? 'stopped' : 'complete');

return {
  stage, params: plan.params, units: results, stopped: stopped?.stopped ?? null,
};

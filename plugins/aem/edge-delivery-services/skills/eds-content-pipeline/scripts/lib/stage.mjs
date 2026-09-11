/*
 * Stage specs (`stages/*.yaml`) turn a fixed unit list into a runnable plan for one stage:
 * discover, template or bulk. `loadStage`/`validateStages` check the YAML against the schema
 * below; `planStage` resolves `<param>` placeholders and orders units by `depends_on`.
 *
 * A unit is either `role:` (an LLM reads a prompt file) or `run:` (a shell command) — never
 * both. `done_when` is the command whose exit code decides whether the unit is finished; it
 * runs with `cwd` = the EDS repo root. Paths in `inputs`/`outputs` are relative to `migration/`.
 * `scripts/lib/...` inside `run`/`done_when` refers to the installed skill's `scripts/lib`; the
 * plan carries both the command as written and its `resolvedCommand`/`resolvedDoneWhen` with
 * that prefix made absolute, for an executor that does not know the skill's install path.
 *
 * The subcommands other than `plan` and `validate` are implemented in a follow-up task; they
 * are listed here so the CLI's usage line is complete from the start.
 */
import {
  readdir, readFile, access,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

const TIERS = new Set(['low', 'medium', 'high']);
const STAGE_KEYS = new Set(['stage', 'params', 'timeouts', 'units']);
const UNIT_KEYS = new Set([
  'id', 'role', 'run', 'tier', 'parallel', 'depends_on', 'inputs', 'outputs', 'done_when',
  'rework',
]);
const exists = (p) => access(p).then(() => true, () => false);

/**
 * Reads and structurally validates one stage spec. Throws on the first schema error.
 *
 * @param {string} name Stage id (`discover`, `template` or `bulk`).
 * @param {object} options
 * @param {string} options.skillRoot Absolute path of the installed skill.
 * @returns {Promise<object>} The parsed YAML.
 */
export async function loadStage(name, { skillRoot }) {
  const file = path.join(skillRoot, 'stages', `${name}.yaml`);
  const spec = YAML.parse(await readFile(file, 'utf8'));
  const errors = schemaErrors(spec, `${name}.yaml`);
  if (errors.length) throw new Error(errors.join('\n'));
  return spec;
}

function schemaErrors(spec, label) {
  const errors = [];
  for (const key of Object.keys(spec ?? {})) {
    if (!STAGE_KEYS.has(key)) errors.push(`${label}: unknown key "${key}"`);
  }
  if (!Array.isArray(spec?.units) || !spec.units.length) {
    errors.push(`${label}: units required`);
  }
  for (const unit of spec?.units ?? []) {
    const at = `${label} unit "${unit?.id ?? '?'}"`;
    for (const key of Object.keys(unit)) {
      if (!UNIT_KEYS.has(key)) errors.push(`${at}: unknown key "${key}"`);
    }
    if (!unit.id) errors.push(`${label}: every unit needs an id`);
    if (Boolean(unit.role) === Boolean(unit.run)) {
      errors.push(`${at}: exactly one of role: or run:`);
    }
    if (unit.role && !TIERS.has(unit.tier)) {
      errors.push(`${at}: tier "${unit.tier}" must be low|medium|high`);
    }
    if (unit.run && unit.tier) errors.push(`${at}: run units take no tier`);
    if (!unit.done_when) errors.push(`${at}: done_when required`);
  }
  return errors;
}

const resolve = (text, params) => String(text).replace(/<([a-z_]+)>/g, (m, key) => {
  if (!(key in params)) throw new Error(`param "${key}" is required`);
  return params[key];
});

/**
 * Orders units by `depends_on` (stable topological sort).
 *
 * @param {object[]} units Raw unit specs.
 * @returns {object[]} The same units, dependency order.
 * @throws {Error} On a cycle or a `depends_on` id that names no unit.
 */
export function orderUnits(units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const done = new Set();
  const visiting = new Set();
  const out = [];
  const visit = (unit, chain) => {
    if (done.has(unit.id)) return;
    if (visiting.has(unit.id)) {
      throw new Error(`dependency cycle: ${[...chain, unit.id].join(' -> ')}`);
    }
    visiting.add(unit.id);
    for (const dep of unit.depends_on ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`unit "${unit.id}" depends on unknown unit "${dep}"`);
      }
      visit(byId.get(dep), [...chain, unit.id]);
    }
    visiting.delete(unit.id);
    done.add(unit.id);
    out.push(unit);
  };
  units.forEach((u) => visit(u, []));
  return out;
}

/**
 * Resolves params into a concrete, ordered unit list for one stage run.
 *
 * @param {object} spec A validated stage spec (see {@link loadStage}).
 * @param {object} params Values for every name in `spec.params`.
 * @param {object} options
 * @param {string} options.skillRoot Absolute path of the installed skill.
 * @returns {{stage: string, params: object, timeouts: object, units: object[]}}
 * @throws {Error} When a param is missing or a `depends_on` id is unknown/cyclic.
 */
export function planStage(spec, params, { skillRoot }) {
  for (const name of spec.params ?? []) {
    if (!(name in params)) {
      throw new Error(`param "${name}" is required by stage ${spec.stage}`);
    }
  }
  const lib = path.join(skillRoot, 'scripts', 'lib');
  const resolveCommand = (cmd) => cmd.replace(/scripts\/lib\//g, `${lib}/`);
  const units = orderUnits(spec.units).map((u) => ({
    id: u.id,
    kind: u.run ? 'run' : 'llm',
    ...(u.run
      ? { command: resolve(u.run, params), resolvedCommand: resolveCommand(resolve(u.run, params)) }
      : { role: u.role, tier: u.tier }),
    parallel: u.parallel === true,
    dependsOn: u.depends_on ?? [],
    inputs: (u.inputs ?? []).map((i) => resolve(i, params)),
    outputs: (u.outputs ?? []).map((o) => resolve(o, params)),
    doneWhen: resolve(u.done_when, params).trim(),
    resolvedDoneWhen: resolveCommand(resolve(u.done_when, params).trim()),
    rework: u.rework ?? null,
  }));
  return {
    stage: spec.stage, params, timeouts: spec.timeouts ?? {}, units,
  };
}

/**
 * Validates every `stages/*.yaml` and the files they reference.
 *
 * @param {object} options
 * @param {string} options.skillRoot Absolute path of the installed skill.
 * @returns {Promise<{ok: boolean, stages: string[], errors: string[]}>}
 */
export async function validateStages({ skillRoot }) {
  const dir = path.join(skillRoot, 'stages');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  const errors = [];
  const stages = [];
  for (const file of files) {
    const spec = YAML.parse(await readFile(path.join(dir, file), 'utf8'));
    errors.push(...schemaErrors(spec, file));
    stages.push(spec?.stage ?? file);
    for (const unit of spec?.units ?? []) {
      if (unit.role && !(await exists(path.join(skillRoot, unit.role)))) {
        errors.push(`${file} unit "${unit.id}": ${unit.role} does not exist`);
      }
      const combined = `${unit.run ?? ''} ${unit.done_when ?? ''}`;
      const runner = /scripts\/lib\/([a-z-]+\.mjs)/.exec(combined);
      if (runner && !(await exists(path.join(skillRoot, 'scripts', 'lib', runner[1])))) {
        errors.push(`${file} unit "${unit.id}": scripts/lib/${runner[1]} does not exist`);
      }
    }
    try {
      orderUnits(spec?.units ?? []);
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }
  return { ok: errors.length === 0, stages, errors };
}

const NOT_IMPLEMENTED = (name) => async () => {
  throw new Error(`${name}: not implemented yet`);
};

const USAGE = 'Usage: stage.mjs plan <stage> [key=value ...] | stage.mjs validate | '
  + 'stage.mjs check-transformer <template> | stage.mjs check-review <template> | '
  + 'stage.mjs check-coverage <template> | stage.mjs check-fidelity <template> | '
  + 'stage.mjs sample-fidelity <template> [--pages N] | stage.mjs run <stage> [key=value ...] | '
  + 'stage.mjs record-run <stage> --run-id <id> --outcome <outcome>';

const COMMANDS = {
  async plan(argv, { skillRoot }) {
    const [stage, ...rest] = argv;
    if (!stage) throw new Error(USAGE);
    const params = Object.fromEntries(rest.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
    const spec = await loadStage(stage, { skillRoot });
    return planStage(spec, params, { skillRoot });
  },
  async validate(argv, { skillRoot }) {
    const result = await validateStages({ skillRoot });
    if (!result.ok) process.exitCode = 1;
    return result;
  },
  'check-transformer': NOT_IMPLEMENTED('check-transformer'),
  'check-review': NOT_IMPLEMENTED('check-review'),
  'check-coverage': NOT_IMPLEMENTED('check-coverage'),
  'check-fidelity': NOT_IMPLEMENTED('check-fidelity'),
  'sample-fidelity': NOT_IMPLEMENTED('sample-fidelity'),
  run: NOT_IMPLEMENTED('run'),
  'record-run': NOT_IMPLEMENTED('record-run'),
};

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const run = COMMANDS[cmd];
  if (!run) throw new Error(USAGE);
  const skillRoot = path.resolve(import.meta.dirname, '../..');
  return run(rest, { skillRoot });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

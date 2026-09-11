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
  readdir, readFile, access, mkdir, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { flag, positiveIntFlag } from './args.mjs';
import { loadConfig, originAliasHosts } from './config.mjs';
import { createDaClient, docPath, loadToken } from './da.mjs';
import { compare, contentSet } from './fidelity.mjs';
import { appendRow, readRows } from './ledger.mjs';
import { resolvePaths } from './paths.mjs';
import { writeProgress } from './progress.mjs';
import { captureSlug, listRecords } from './state.mjs';
import { loadTransformer, transformHtml } from './transform.mjs';

const execFileP = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

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

/**
 * Reads the `## Not Migrated` selectors an analysis.md names, e.g. `selector: nav.breadcrumbs`.
 * Everything else under the heading is prose for the operator, not a fidelity exclusion.
 *
 * @param {string} template Template name.
 * @param {ReturnType<typeof resolvePaths>} paths
 * @returns {Promise<string[]>} CSS selectors to drop before comparing content.
 */
async function ignoreSelectors(template, paths) {
  const file = path.join(paths.siteDir, 'templates', template, 'analysis.md');
  const text = await readFile(file, 'utf8').catch(() => '');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Not Migrated/i.test(l.trim()));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l.trim()));
  const section = end < 0 ? rest : rest.slice(0, end);
  return section.map((l) => l.trim())
    .filter((l) => /^selector:/i.test(l))
    .map((l) => l.replace(/^selector:/i, '').trim());
}

/**
 * Transforms every capture of a template and checks recall/precision against
 * `thresholds.fidelity`, ignoring the selectors `analysis.md` names as not migrated.
 *
 * @param {string} template Template name.
 * @param {ReturnType<typeof resolvePaths>} [paths]
 * @returns {Promise<{template: string, pages: object[], pass: boolean}>}
 */
export async function checkTransformer(template, paths = resolvePaths()) {
  const config = await loadConfig(paths.configPath);
  const templateConfig = config.templates[template];
  if (!templateConfig) throw new Error(`No templates.${template} in site.config.json`);
  const transformer = await loadTransformer(template, {
    dir: path.join(paths.siteDir, 'transformers'),
  });
  const ignore = await ignoreSelectors(template, paths);
  const dir = path.join(paths.dataDir, 'captures', template);
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.html')).sort();
  const bySlug = new Map(
    (await listRecords('urls', { where: { template }, paths })).map((u) => [captureSlug(u.url), u]),
  );
  const pages = [];
  for (const file of files) {
    const record = bySlug.get(file.replace(/\.html$/, ''));
    if (!record) continue;
    const html = await readFile(path.join(dir, file), 'utf8');
    const doc = await transformHtml({
      html, url: record.url, transformer, params: { sourceRoot: templateConfig.sourceRoot },
      hosts: originAliasHosts(config),
    });
    const { recall, precision } = compare(
      contentSet(html, templateConfig.sourceRoot, ignore), contentSet(doc.html, 'main'),
    );
    const pass = recall >= config.thresholds.fidelity.recall
      && precision >= config.thresholds.fidelity.precision && doc.warnings.length === 0;
    pages.push({
      url: record.url, warnings: doc.warnings, recall, precision, pass,
    });
  }
  return { template, pages, pass: pages.length > 0 && pages.every((p) => p.pass) };
}

async function recordRework(template, reason, paths) {
  const rows = await readRows('rework', paths);
  const round = rows
    .filter((r) => r.template === template && r.unit === 'author-transformer').length + 1;
  await appendRow('rework', {
    runId: `check-review-${template}-${Date.now()}`,
    stage: 'template',
    unit: 'author-transformer',
    template,
    round,
    reason,
  }, paths);
}

/**
 * Gates the `review` unit on `templates/<template>/review.md`'s first line.
 *
 * @param {string} template Template name.
 * @param {ReturnType<typeof resolvePaths>} [paths]
 * @returns {Promise<{ok: boolean, template: string, reason?: string}>}
 * @throws {Error} With `exitCode: 2` when the file's first line is neither verdict.
 */
export async function checkReview(template, paths = resolvePaths()) {
  const file = path.join(paths.siteDir, 'templates', template, 'review.md');
  const text = await readFile(file, 'utf8').catch(() => {
    throw new Error(`${file} does not exist`);
  });
  const lines = text.split('\n');
  const first = (lines[0] ?? '').trim();
  if (first === 'verdict: ready') return { ok: true, template };
  if (first === 'verdict: needs-work') {
    const reason = lines.slice(1).map((l) => l.trim()).find(Boolean) ?? 'needs-work';
    await recordRework(template, reason, paths);
    return { ok: false, template, reason };
  }
  const err = new Error(`${file} must start with verdict: ready | needs-work`);
  err.exitCode = 2;
  throw err;
}

/**
 * Gates the bulk `dry-run` unit on `data/bulk/<template>-dryrun.json`'s coverage.
 *
 * @param {string} template Template name.
 * @param {ReturnType<typeof resolvePaths>} [paths]
 * @returns {Promise<{template: string, coverage: number, threshold: number, pass: boolean}>}
 */
export async function checkCoverage(template, paths = resolvePaths()) {
  const config = await loadConfig(paths.configPath);
  const file = path.join(paths.dataDir, 'bulk', `${template}-dryrun.json`);
  const report = JSON.parse(await readFile(file, 'utf8').catch(() => {
    throw new Error(`No dry-run report at ${file}; run bulk.mjs --template ${template} --dry-run`);
  }));
  return {
    template,
    coverage: report.coverage,
    threshold: config.thresholds.coverage,
    pass: report.coverage >= config.thresholds.coverage,
  };
}

const DONE_URL_STATUSES = ['previewed', 'uploaded', 'verified'];

/**
 * Samples up to `pages` published URLs of a template, compares each against its capture, and
 * writes `reports/bulk-<template>-fidelity.json`. Reads the rendered preview when the DA client
 * exposes one; `da.mjs` currently only reads the source, so this reads the produced
 * `migration/content/<docPath>.html` instead and records that as `source: 'content'`.
 *
 * @param {string} template Template name.
 * @param {ReturnType<typeof resolvePaths>} [paths]
 * @param {{pages?: number}} [options]
 * @returns {Promise<{template: string, generatedAt: string, pages: object[]}>}
 * @throws {import('./da.mjs').DaTokenError} When no DA token is available.
 */
export async function sampleFidelity(template, paths = resolvePaths(), { pages = 5 } = {}) {
  const config = await loadConfig(paths.configPath);
  const templateConfig = config.templates[template];
  const { token, expiresAt, source } = await loadToken();
  const da = createDaClient({
    da: config.da, token, expiresAt, tokenSource: source,
  });
  const ignore = await ignoreSelectors(template, paths);
  const eligible = (await listRecords('urls', { where: { template }, paths }))
    .filter((u) => DONE_URL_STATUSES.includes(u.status))
    .slice(0, pages);
  const results = [];
  for (const record of eligible) {
    const doc = docPath(record.docPath ?? record.path);
    const useContent = typeof da.getPreview !== 'function';
    const contentFile = path.join(paths.siteDir, 'content', `${doc.replace(/^\//, '')}.html`);
    const html = useContent
      ? await readFile(contentFile, 'utf8')
      : (await da.getPreview({ path: doc })).html;
    const capture = await readFile(
      path.join(paths.dataDir, 'captures', template, `${captureSlug(record.url)}.html`), 'utf8',
    );
    const { recall, precision } = compare(
      contentSet(capture, templateConfig.sourceRoot, ignore), contentSet(html, 'main'),
    );
    const pass = recall >= config.thresholds.fidelity.recall
      && precision >= config.thresholds.fidelity.precision;
    results.push({
      url: record.url, source: useContent ? 'content' : 'preview', recall, precision, pass,
    });
  }
  const report = { template, generatedAt: new Date().toISOString(), pages: results };
  const file = path.join(paths.docsDir, 'reports', `bulk-${template}-fidelity.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/**
 * Gates the bulk `sample-fidelity` unit: every sampled page of the report must pass.
 *
 * @param {string} template Template name.
 * @param {ReturnType<typeof resolvePaths>} [paths]
 * @returns {Promise<{template: string, pages: number, pass: boolean}>}
 */
export async function checkFidelity(template, paths = resolvePaths()) {
  const file = path.join(paths.docsDir, 'reports', `bulk-${template}-fidelity.json`);
  const report = JSON.parse(await readFile(file, 'utf8').catch(() => {
    throw new Error(`No fidelity report at ${file}; run sample-fidelity first`);
  }));
  return {
    template,
    pages: report.pages.length,
    pass: report.pages.length > 0 && report.pages.every((p) => p.pass),
  };
}

/** True when a failed `run:` unit failed because no DA token is available (see `da.mjs`). */
function isDaTokenError(err) {
  return /DA_TOKEN/.test(`${err?.stderr ?? ''}${err?.message ?? ''}`);
}

async function runOnce(command, cwd) {
  try {
    const { stdout } = await execFileP('sh', ['-c', command], {
      cwd, env: process.env, maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout };
  } catch (err) {
    if (isDaTokenError(err)) return { ok: 'no-da' };
    return { ok: false, exitCode: err.code ?? 1, stderr: (err.stderr ?? err.message ?? '').trim() };
  }
}

/**
 * Evaluates one unit's `done_when` shell command.
 *
 * @param {object} unit A planned unit (see {@link planStage}).
 * @param {string} cwd Repo root; `done_when` always runs there.
 * @returns {Promise<{ok: boolean, exitCode?: number, stderr?: string}>}
 */
export async function evalDoneWhen(unit, cwd) {
  try {
    await execFileP('sh', ['-c', unit.resolvedDoneWhen], { cwd, env: process.env });
    return { ok: true };
  } catch (err) {
    return { ok: false, exitCode: err.code ?? 1, stderr: (err.stderr ?? err.message ?? '').trim() };
  }
}

async function attemptUnit(unit, cwd) {
  const result = await runOnce(unit.resolvedCommand, cwd);
  if (result.ok === 'no-da') return { verdict: 'skipped-no-da' };
  if (!result.ok) return { verdict: 'failed', exitCode: result.exitCode, stderr: result.stderr };
  const done = await evalDoneWhen(unit, cwd);
  if (done.ok) return { verdict: 'done' };
  return { verdict: 'failed', exitCode: done.exitCode, stderr: done.stderr };
}

async function recordUnit(ctx, unit, verdict) {
  await appendRow('units', {
    unitId: `${ctx.runId}:${unit.id}`, runId: ctx.runId, kind: 'stage-unit', ref: unit.id, verdict,
  }, ctx.paths);
  await writeProgress({
    runId: ctx.runId, stage: ctx.stage, unit: unit.id, status: verdict,
  }, ctx.paths);
}

/**
 * Runs one `run:` kind unit, retrying once (rerunning the command and re-evaluating
 * `done_when`) on failure.
 *
 * @param {object} unit A planned unit.
 * @param {{runId: string, stage: string, cwd: string, paths: object}} ctx
 * @returns {Promise<{verdict: string, stop?: object}>}
 */
export async function runUnit(unit, ctx) {
  let outcome = await attemptUnit(unit, ctx.cwd);
  if (outcome.verdict === 'failed') outcome = await attemptUnit(unit, ctx.cwd);
  await recordUnit(ctx, unit, outcome.verdict);
  if (outcome.verdict !== 'failed') return { verdict: outcome.verdict };
  return {
    verdict: 'failed',
    stop: {
      stopped: unit.id, doneWhen: unit.doneWhen, exitCode: outcome.exitCode, stderr: outcome.stderr,
    },
  };
}

/**
 * Settles one unit: `run:` units execute for real (see {@link runUnit}); `llm:` units execute
 * only without `--skip-llm` (an operator must run the prompt), otherwise they are recorded
 * `skipped` and `done_when` decides whether the plan may continue.
 *
 * @param {object} unit A planned unit.
 * @param {{runId: string, stage: string, cwd: string, paths: object, skipLlm: boolean}} ctx
 * @returns {Promise<{verdict: string|null, stop?: object}>}
 */
export async function settleUnit(unit, ctx) {
  if (unit.kind !== 'llm') return runUnit(unit, ctx);
  if (!ctx.skipLlm) return { verdict: null, stop: { stopped: 'llm-unit', unit: unit.id } };
  await recordUnit(ctx, unit, 'skipped');
  const done = await evalDoneWhen(unit, ctx.cwd);
  if (done.ok) return { verdict: 'skipped' };
  return {
    verdict: 'skipped',
    stop: {
      stopped: unit.id, doneWhen: unit.doneWhen, exitCode: done.exitCode, stderr: done.stderr,
    },
  };
}

/**
 * Picks the units of `units` whose `depends_on` ids are all in `settledIds`.
 *
 * @param {object[]} units Remaining units, in plan order.
 * @param {Set<string>} settledIds Ids already processed.
 * @returns {object[]} Ready units, in plan order.
 */
export function nextUnits(units, settledIds) {
  return units.filter((u) => u.dependsOn.every((d) => settledIds.has(d)));
}

/**
 * Runs one stage's plan sequentially. `run:` units execute for real; `llm:` units execute only
 * without `--skip-llm`. Stops on the first unit whose action or `done_when` fails, or on the
 * first `llm:` unit reached without `--skip-llm`. Always returns the units it settled, even
 * when it stopped partway through. A failed `review` stops the run after `check-review` has
 * recorded the rework request; re-running the transformer author is the executor's loop
 * (`workflows/pi/stage.mjs`), not this runner's.
 *
 * @param {string} stageName `discover`, `template` or `bulk`.
 * @param {object} params Stage params, e.g. `{ template: 'product' }`.
 * @param {object} [options]
 * @param {string} [options.skillRoot] Installed skill root; defaults to this file's `../..`.
 * @param {boolean} [options.skipLlm] Skip `llm:` units instead of stopping on them.
 * @param {string} [options.runId] Run id; defaults to `<stage>-<template>-<timestamp>`.
 * @returns {Promise<{stage: string, runId: string, units: {id: string, verdict: string}[],
 *   stopped?: string, doneWhen?: string, exitCode?: number, stderr?: string}>}
 */
export async function runStage(stageName, params, options = {}) {
  const skillRoot = options.skillRoot ?? path.resolve(import.meta.dirname, '../..');
  const paths = resolvePaths();
  const spec = await loadStage(stageName, { skillRoot });
  const plan = planStage(spec, params, { skillRoot });
  const runId = options.runId ?? `${stageName}-${params.template ?? 'stage'}-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const ctx = {
    runId, stage: stageName, cwd: paths.repoRoot, paths, skipLlm: options.skipLlm === true,
  };
  const remaining = [...plan.units];
  const settledIds = new Set();
  const units = [];
  let stop = null;
  while (remaining.length && !stop) {
    const [unit] = nextUnits(remaining, settledIds);
    if (!unit) {
      stop = { stopped: 'blocked', units: remaining.map((u) => u.id) };
      break;
    }
    remaining.splice(remaining.indexOf(unit), 1);
    const outcome = await settleUnit(unit, ctx);
    settledIds.add(unit.id);
    if (outcome.verdict !== null) units.push({ id: unit.id, verdict: outcome.verdict });
    if (outcome.stop) stop = outcome.stop;
  }
  await appendRow('runs', {
    runId,
    stage: stageName,
    startedAt,
    outcome: stop ? 'stopped' : 'complete',
  }, paths);
  return { stage: stageName, runId, units, ...(stop ?? {}) };
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
  'check-transformer': async (argv) => {
    const [template] = argv;
    const result = await checkTransformer(template, resolvePaths());
    if (!result.pass) process.exitCode = 1;
    return result;
  },
  'check-review': async (argv) => {
    const [template] = argv;
    const result = await checkReview(template, resolvePaths());
    if (!result.ok) process.exitCode = 1;
    return result;
  },
  'check-coverage': async (argv) => {
    const [template] = argv;
    const result = await checkCoverage(template, resolvePaths());
    if (!result.pass) process.exitCode = 1;
    return result;
  },
  'check-fidelity': async (argv) => {
    const [template] = argv;
    const result = await checkFidelity(template, resolvePaths());
    if (!result.pass) process.exitCode = 1;
    return result;
  },
  'sample-fidelity': async (argv) => {
    const [template, ...rest] = argv;
    const pages = positiveIntFlag(rest, '--pages', 5);
    return sampleFidelity(template, resolvePaths(), { pages });
  },
  async run(argv, { skillRoot }) {
    const [stageName, ...rest] = argv;
    if (!stageName) throw new Error(USAGE);
    const runId = flag(rest, '--run-id');
    const skipLlm = rest.includes('--skip-llm');
    const kvPairs = rest.filter((a) => !a.startsWith('--') && a.includes('='));
    const params = Object.fromEntries(kvPairs.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
    return runStage(stageName, params, { skillRoot, skipLlm, runId });
  },
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
      process.exit(err.exitCode ?? 1);
    });
}

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolvePaths } from '../../../scripts/lib/paths.mjs';
import { readJson, updateJson } from '../../../scripts/lib/state.mjs';
import { flag } from '../../../scripts/lib/args.mjs';

const ESCAPES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const TOOL_CATEGORIES = [
  ['harness', 'Harness'], ['extensions', 'Extensions'], ['skills', 'Skills'],
  ['scripts', 'Scripts'], ['cli', 'CLI'], ['models', 'Models'], ['sources', 'Web sources'],
];
const SUMMARY_CAP = 200;
const REPORT_TO_REPO = '../../../../';

/** Escapes text for safe insertion into HTML. */
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Path of the retro JSON file of a stage. */
function retroFile(paths, stage) {
  return path.join(paths.dataDir, 'retros', `${stage}.json`);
}

function agentList(agents) {
  if (Array.isArray(agents)) return agents;
  if (agents && typeof agents === 'object') return Object.values(agents);
  return [];
}

function countModels(agents) {
  const counts = {};
  for (const agent of agents) {
    const model = agent?.model;
    if (model) counts[model] = (counts[model] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function runNumbers(journal) {
  const usage = journal.tokenUsage ?? {};
  return {
    tokens: Number(usage.total) || 0,
    cost: Number(usage.cost) || 0,
    durationMs: Number(journal.durationMs) || 0,
  };
}

/**
 * Reduces a pi-dynamic-workflows run journal to the facts a retro reports.
 *
 * @param {object} journal Parsed run journal.
 * @returns {{runId: string, name: string, status: string, agents: number, tokens: number,
 *   cost: number, durationMs: number, startedAt: string, models: Record<string, number>}}
 */
export function summarizeRun(journal) {
  const agents = agentList(journal.agents);
  return {
    runId: journal.runId ?? '',
    name: journal.workflowName ?? '',
    status: journal.status ?? 'unknown',
    agents: agents.length,
    ...runNumbers(journal),
    startedAt: journal.startedAt ?? '',
    models: countModels(agents),
  };
}

/**
 * Merges run entries by `runId`, replacing existing ones and keeping first-appearance order.
 *
 * @param {object[]} existing Runs already recorded.
 * @param {object[]} incoming Freshly collected runs.
 * @returns {object[]} Merged runs.
 */
export function mergeRuns(existing, incoming) {
  const byId = new Map(existing.map((run) => [run.runId, run]));
  for (const run of incoming) byId.set(run.runId, run);
  return [...byId.values()];
}

/**
 * Sums the run facts of a retro.
 *
 * @param {object[]} runs Run entries.
 * @returns {{runs: number, agents: number, tokens: number, cost: number, durationMs: number}}
 */
export function computeTotals(runs) {
  const sum = (field) => runs.reduce((acc, run) => acc + (Number(run[field]) || 0), 0);
  return {
    runs: runs.length,
    agents: sum('agents'),
    tokens: sum('tokens'),
    cost: sum('cost'),
    durationMs: sum('durationMs'),
  };
}

async function readJournal(runsDir, runId) {
  const file = path.join(runsDir, `${runId}.json`);
  const journal = await readJson(file, null);
  if (!journal) throw new Error(`Run journal not found: ${file}`);
  return journal;
}

/**
 * Collects run facts into `data/retros/<stage>.json`, creating the file when absent.
 *
 * @param {object} options
 * @param {string} options.stage Stage name.
 * @param {string[]} options.runIds Run ids to read from `runsDir`.
 * @param {string} options.runsDir Directory holding `<runId>.json` run journals.
 * @param {ReturnType<typeof resolvePaths>} [options.paths]
 * @returns {Promise<{stage: string, runs: number, totals: object}>}
 */
export async function collectRuns({
  stage, runIds, runsDir, paths = resolvePaths(),
}) {
  const journals = await Promise.all(runIds.map((id) => readJournal(runsDir, id)));
  const collected = journals.map(summarizeRun);
  const fallback = { schemaVersion: 1, stage, title: stage };
  const next = await updateJson(retroFile(paths, stage), fallback, (retro) => {
    const runs = mergeRuns(retro.runs ?? [], collected);
    return { ...retro, runs, totals: computeTotals(runs) };
  });
  return { stage, runs: next.runs.length, totals: next.totals };
}

function parseUsageEntry(line) {
  if (!line.trim()) return null;
  try {
    const entry = JSON.parse(line);
    return entry.message?.usage ? entry : null;
  } catch {
    return null;
  }
}

function inWindow(entry, { since, until }) {
  return (!since || entry.timestamp >= since) && (!until || entry.timestamp <= until);
}

const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function addUsage(totals, entry) {
  const { usage, provider, model } = entry.message;
  totals.turns += 1;
  USAGE_FIELDS.forEach((field) => {
    totals[field] += Number(usage[field]) || 0;
  });
  totals.cost += Number(usage.cost?.total) || 0;
  const key = `${provider ?? '?'}/${model ?? '?'}`;
  totals.models[key] = (totals.models[key] ?? 0) + 1;
  return totals;
}

/**
 * Sums the orchestrator session's own usage from a Pi session transcript (JSONL). Each
 * `message` line carries `message.usage` with token counts and `cost.total`.
 *
 * @param {string} text Transcript contents.
 * @param {{since?: string, until?: string}} [window] ISO bounds (inclusive) on `timestamp`.
 * @returns {{turns: number, input: number, output: number, cacheRead: number, cacheWrite: number,
 *   cost: number, models: Record<string, number>}}
 */
export function summarizeSession(text, window = {}) {
  const empty = {
    turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: {},
  };
  return text.split('\n')
    .map(parseUsageEntry)
    .filter((entry) => entry && inWindow(entry, window))
    .reduce(addUsage, empty);
}

/**
 * Records the orchestrator's own spend (from a Pi session transcript) into the retro JSON.
 *
 * @param {object} options
 * @param {string} options.stage
 * @param {string} options.sessionFile Path to the session `.jsonl`.
 * @param {{since?: string, until?: string}} [options.window]
 * @param {ReturnType<typeof resolvePaths>} [options.paths]
 */
export async function collectOrchestrator({
  stage, sessionFile, window = {}, paths = resolvePaths(),
}) {
  const text = await readFile(sessionFile, 'utf8');
  const orchestrator = {
    ...summarizeSession(text, window), sessionFile: path.basename(sessionFile),
  };
  const fallback = { schemaVersion: 1, stage, title: stage };
  await updateJson(retroFile(paths, stage), fallback, (retro) => ({ ...retro, orchestrator }));
  return { stage, orchestrator };
}

/**
 * Turns an artifact or evidence reference into an href usable from the report location
 * (`data/retros/`). URLs are returned unchanged.
 *
 * @param {string} pathOrUrl Repo-relative path, absolute repo path or URL.
 * @returns {string} The href.
 */
export function relativeLink(pathOrUrl) {
  const ref = String(pathOrUrl ?? '').trim();
  if (!ref) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#')) return ref;
  return REPORT_TO_REPO + ref.replace(/^\/+/, '');
}

function link(ref, text) {
  const href = relativeLink(ref);
  if (!href) return esc(text ?? '');
  return `<a href="${esc(href)}">${esc(text ?? ref)}</a>`;
}

function badge(value) {
  if (!value) return '';
  return `<span class="badge badge-${esc(value)}">${esc(value)}</span>`;
}

function section(title, body) {
  return body ? `<section><h2>${esc(title)}</h2>${body}</section>` : '';
}

function table(headers, tableRows) {
  if (!tableRows.length) return '';
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const cell = (c) => `<td>${c}</td>`;
  const body = tableRows.map((cells) => `<tr>${cells.map(cell).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function list(items) {
  return items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '';
}

function listOf(retro, key) {
  const value = retro[key];
  return Array.isArray(value) ? value : [];
}

function formatDuration(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatNumber(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

function formatCost(value) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

function totalsOf(retro) {
  return retro.totals ?? computeTotals(listOf(retro, 'runs'));
}

function renderOrchestratorLine(retro) {
  const o = retro.orchestrator;
  if (!o) return '<p class="totals warn">Orchestrator spend: not collected</p>';
  const subCost = totalsOf(retro).cost ?? 0;
  const models = Object.keys(o.models ?? {}).join(', ');
  const line = `Orchestrator: ${formatNumber(o.turns)} turns`
    + ` · ${formatNumber(o.cacheRead)} cache-read tokens`
    + ` · ${formatNumber(o.output)} output tokens · ${formatCost(o.cost)} (${models})`;
  const grand = `Total stage cost: ${formatCost(subCost + (o.cost ?? 0))}`;
  return `<p class="totals">${esc(line)}</p><p class="totals grand">${esc(grand)}</p>`;
}

function renderHeader(retro) {
  const totals = totalsOf(retro);
  const period = retro.period?.start || retro.period?.end
    ? `<p class="meta">${esc(retro.period.start ?? '')} → ${esc(retro.period.end ?? '')}</p>`
    : '';
  const totalsLine = [
    `${formatNumber(totals.runs)} runs`, `${formatNumber(totals.agents)} agents`,
    `${formatNumber(totals.tokens)} tokens`, formatCost(totals.cost),
    formatDuration(totals.durationMs),
  ].join(' · ');
  return `<header><h1>${esc(retro.title)}</h1>`
    + `<p class="meta">Stage <strong>${esc(retro.stage)}</strong> ${badge(retro.verdict)}</p>`
    + `${period}<p class="totals">Subagents: ${esc(totalsLine)}</p>`
    + `${renderOrchestratorLine(retro)}</header>`;
}

function renderSummary(retro) {
  const paragraphs = String(retro.summary ?? '').split(/\n{2,}/).filter(Boolean);
  return section('Summary', paragraphs
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''));
}

function renderMetrics(retro) {
  return section('Metrics', table(['Metric', 'Value'], listOf(retro, 'metrics')
    .map((m) => [esc(m.label), esc(m.value)])));
}

function renderAccomplished(retro) {
  return section('What was accomplished', list(listOf(retro, 'accomplished').map((item) => {
    const evidence = item.evidence ? ` <span class="meta">${link(item.evidence)}</span>` : '';
    return `<strong>${esc(item.title)}</strong> — ${esc(item.detail)}${evidence}`;
  })));
}

function renderCritique(retro) {
  return section('Critique', table(['Area', 'Verdict', 'Assessment'], listOf(retro, 'critique')
    .map((c) => [esc(c.area), badge(c.verdict), esc(c.text)])));
}

function renderWentWell(retro) {
  return section('What went well', list(listOf(retro, 'wentWell').map((item) => esc(item))));
}

function renderStruggles(retro) {
  return section('Struggles and blockers', table(
    ['Struggle', 'Impact', 'Resolution'],
    listOf(retro, 'struggles').map((s) => [esc(s.title), esc(s.impact), esc(s.resolution)]),
  ));
}

function renderImprovements(retro) {
  return section('Improvements', table(
    ['Improvement', 'Action', 'Status', 'Owner'],
    listOf(retro, 'improvements')
      .map((i) => [esc(i.title), esc(i.action), badge(i.status), esc(i.owner)]),
  ));
}

function renderLearnings(retro) {
  return section('Learnings', list(listOf(retro, 'learnings').map((l) => {
    const ref = l.ref ? ` <span class="meta">${link(l.ref)}</span>` : '';
    return `${badge(l.tag)} ${esc(l.title)}${ref}`;
  })));
}

function renderTools(retro) {
  const tools = retro.tools ?? {};
  const body = TOOL_CATEGORIES
    .filter(([key]) => Array.isArray(tools[key]) && tools[key].length)
    .map(([key, label]) => `<p><strong>${esc(label)}</strong> `
      + `${tools[key].map((t) => `<code>${esc(t)}</code>`).join(' ')}</p>`)
    .join('');
  return section('Tools used', body);
}

function renderRuns(retro) {
  return section('Runs', table(
    ['Run', 'Workflow', 'Status', 'Agents', 'Tokens', 'Cost', 'Duration', 'Models'],
    listOf(retro, 'runs').map((r) => [
      esc(r.runId), esc(r.name), badge(r.status), formatNumber(r.agents), formatNumber(r.tokens),
      formatCost(r.cost), formatDuration(r.durationMs),
      Object.entries(r.models ?? {}).map(([m, n]) => `${esc(m)} ×${n}`).join(', '),
    ]),
  ));
}

function renderArtifacts(retro) {
  return section('Artifacts', list(listOf(retro, 'artifacts')
    .map((a) => `${link(a.path)} — ${esc(a.description ?? '')}`)));
}

const STYLE = `body{margin:0;padding:32px;font-family:system-ui,-apple-system,sans-serif;
color:#131313;line-height:1.5}main{max-width:960px;margin:0 auto}h1{margin:0 0 8px}
h2{margin:32px 0 8px;font-size:20px;border-bottom:1px solid #ddd;padding-bottom:4px}
p{margin:8px 0}code{background:#f2f2f2;padding:1px 4px;border-radius:3px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px;margin:8px 0}
th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
ul{margin:8px 0;padding-left:20px}li{margin:4px 0}.meta{color:#555;font-size:13px}
.totals{font-variant-numeric:tabular-nums;font-weight:600}
.totals.grand{font-size:1.1em}.totals.warn{color:#8a5a00}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;
background:#eee;color:#333}
.badge-strong,.badge-success,.badge-done,.badge-completed{background:#d8f0d8;color:#14611a}
.badge-adequate,.badge-partial,.badge-planned{background:#fdeecd;color:#7a4b00}
.badge-weak,.badge-failed,.badge-error{background:#fadada;color:#8b1111}`;

/**
 * Renders a stage retrospective as a self-contained HTML document; empty sections are skipped.
 *
 * @param {object} retro Retro record (see the retro JSON contract).
 * @returns {string} Complete HTML document.
 */
export function renderRetro(retro) {
  const body = [
    renderHeader, renderSummary, renderMetrics, renderAccomplished, renderCritique,
    renderWentWell, renderStruggles, renderImprovements, renderLearnings, renderTools,
    renderRuns, renderArtifacts,
  ].map((render) => render(retro)).join('');
  return ['<!DOCTYPE html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>Retro — ${esc(retro.title)}</title>`, `<style>${STYLE}</style>`, '</head>',
    `<body><main>${body}</main></body>`, '</html>'].join('\n');
}

/**
 * Builds the dashboard index entry of a retro.
 *
 * @param {object} retro Retro record.
 * @param {string} generatedAt ISO timestamp.
 * @returns {{stage: string, title: string, verdict: string, generatedAt: string, html: string,
 *   summary: string}}
 */
export function indexEntry(retro, generatedAt) {
  return {
    stage: retro.stage,
    title: retro.title ?? retro.stage,
    verdict: retro.verdict ?? '',
    generatedAt,
    html: `retros/${retro.stage}.html`,
    summary: String(retro.summary ?? '').slice(0, SUMMARY_CAP),
  };
}

/**
 * Writes `<stage>.html` and replaces the stage entry in `retros/index.json`.
 *
 * @param {object} options
 * @param {object} options.retro Retro record.
 * @param {ReturnType<typeof resolvePaths>} [options.paths]
 * @returns {Promise<{stage: string, html: string, index: number}>}
 */
export async function writeReport({ retro, paths = resolvePaths() }) {
  const dir = path.join(paths.dataDir, 'retros');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${retro.stage}.html`), renderRetro(retro));
  const entry = indexEntry(retro, new Date().toISOString());
  const index = await updateJson(path.join(dir, 'index.json'), [], (existing) => [
    ...existing.filter((e) => e.stage !== retro.stage), entry,
  ].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))));
  return { stage: retro.stage, html: entry.html, index: index.length };
}

function requireFlag(argv, name) {
  const value = flag(argv, name);
  if (!value) throw new Error(`Missing ${name}: pass ${name} <value>`);
  return value;
}

function resolveRunsDir(argv, env = process.env) {
  const dir = flag(argv, '--runs-dir', env.MIGRATION_RUNS_DIR);
  if (!dir) {
    throw new Error('Missing runs directory: pass --runs-dir <dir> or set MIGRATION_RUNS_DIR to '
      + 'the workflow run journals, e.g. ~/.pi/workflows/projects/<project>/runs');
  }
  return path.resolve(dir);
}

async function renderCommand(argv, paths) {
  const stage = requireFlag(argv, '--stage');
  const file = retroFile(paths, stage);
  const retro = await readJson(file, null);
  if (!retro) {
    throw new Error(`No retro at ${file}; run retro.mjs collect --stage ${stage} first`);
  }
  return writeReport({ retro: { ...retro, stage }, paths });
}

async function cli(argv) {
  const [cmd] = argv;
  const paths = resolvePaths();
  if (cmd === 'collect') {
    const runIds = requireFlag(argv, '--runs').split(',').map((s) => s.trim()).filter(Boolean);
    const result = await collectRuns({
      stage: requireFlag(argv, '--stage'), runIds, runsDir: resolveRunsDir(argv), paths,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === 'render') {
    console.log(JSON.stringify(await renderCommand(argv, paths), null, 2));
    return;
  }
  if (cmd === 'orchestrator') {
    const sessionFile = flag(argv, '--session', process.env.PI_SESSION_FILE);
    if (!sessionFile) {
      throw new Error('Missing session: pass --session <file> or set PI_SESSION_FILE');
    }
    const result = await collectOrchestrator({
      stage: requireFlag(argv, '--stage'),
      sessionFile: path.resolve(sessionFile),
      window: { since: flag(argv, '--since'), until: flag(argv, '--until') },
      paths,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error('Usage: retro.mjs collect --stage <s> --runs <id,id> [--runs-dir <dir>]'
    + ' | retro.mjs orchestrator --stage <s> [--session <file>] [--since <iso>] [--until <iso>]'
    + ' | retro.mjs render --stage <s>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flag, positiveIntFlag } from './args.mjs';
import { loadConfig, originAliasHosts } from './config.mjs';
import { createDaClient, loadToken } from './da.mjs';
import { createClient } from './http.mjs';
import { appendRow } from './ledger.mjs';
import { fixDocument } from './media.mjs';
import { resolvePaths } from './paths.mjs';
import { mapPool } from './pool.mjs';
import {
  captureSlug, listFeedback, listRecords, readJson, setFeedback, upsertRecords,
} from './state.mjs';
import { contentHash, loadTransformer, transformHtml } from './transform.mjs';
import { validateFile } from './validate.mjs';

const DONE_STATUSES = new Set(['uploaded', 'previewed', 'verified']);
/**
 * Stages whose failure means the deterministic path cannot express the page, so it joins the
 * long tail. A `media` failure is not one of them: an asset the converters refuse is a converter
 * defect fixed in `media.mjs` and retried deterministically (one 20 MB composite SVG once cost
 * an LLM import 47 minutes and the page its hero).
 */
const LONG_TAIL_STAGES = new Set(['transform', 'validate']);
const USAGE = 'Usage: bulk.mjs --template <t> (--dry-run | --run) [--limit n] [--force] '
  + '[--concurrency 4] [--max-minutes m] [--accept-coverage]';

/** One failed pipeline step for a single URL; `stage` names the step that failed. */
export class BulkStepError extends Error {
  /**
   * @param {string} stage One of fetch, capture, transform, validate, upload, preview.
   * @param {string} message What failed.
   */
  constructor(stage, message) {
    super(message);
    this.name = 'BulkStepError';
    this.stage = stage;
  }
}

/**
 * Groups one failure into a stable class and the URL status it implies.
 *
 * URLs and digits are masked so 42 individual messages collapse into a handful of classes.
 *
 * @param {string} stage Step that failed.
 * @param {string} message Error message.
 * @returns {{class: string, status: string, message: string}} `status` is long-tail or failed.
 */
export function classifyFailure(stage, message) {
  const head = String(message).split('\n')[0].trim();
  const masked = head.replace(/https?:\/\/\S+/g, '<url>').replace(/\d+/g, 'N');
  return {
    class: `${stage}: ${masked.slice(0, 80)}`,
    status: LONG_TAIL_STAGES.has(stage) ? 'long-tail' : 'failed',
    message: head,
  };
}

/**
 * Selects the URL records one bulk pass may touch.
 *
 * @param {object[]} records Records of one template, as stored in `urls.json`.
 * @param {{limit?: number}} [options] `limit` caps the batch size.
 * @returns {object[]} Records in file order, `excluded` and `published` ones removed.
 */
export function selectRecords(records, { limit } = {}) {
  const eligible = records.filter((r) => r.status !== 'excluded' && r.status !== 'published');
  return typeof limit === 'number' ? eligible.slice(0, limit) : eligible;
}

/**
 * Counts the images one produced document references.
 *
 * @param {string} html Serialized DA document.
 * @returns {{images: number, remote: number, svg: number}} Media counts for the report.
 */
export function mediaStats(html) {
  const srcs = [...html.matchAll(/<img\b[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);
  return {
    images: srcs.length,
    remote: srcs.filter((src) => /^https?:\/\//.test(src)).length,
    svg: srcs.filter((src) => /\.svg(\?|#|$)/i.test(src)).length,
  };
}

const rethrow = (stage) => (err) => {
  if (err.name === 'DaTokenError') {
    err.checkpoint = stage === 'preview' ? 'uploaded' : 'transformed';
    throw err;
  }
  throw new BulkStepError(stage, err.message);
};

function isUpToDate(ctx, record, hash) {
  if (ctx.force || ctx.forcedUrls.has(record.url)) return false;
  if (record.contentHash !== hash) return false;
  if (record.transformerVersion !== ctx.transformer.version) return false;
  return DONE_STATUSES.has(record.status);
}

async function fetchSource(ctx, url) {
  const res = await ctx.http.get(url);
  if (res.status !== 200) throw new BulkStepError('fetch', `GET ${url} -> ${res.status}`);
  return res.body;
}

/**
 * Keeps the fetched source page under `data/captures/<template>/<slug>.html` so evidence
 * checks and fidelity runs read the exact HTML the transformer saw. Existing files are kept.
 */
async function captureSource(ctx, url, html) {
  const dir = path.join(ctx.paths.dataDir, 'captures', ctx.template);
  const file = path.join(dir, `${captureSlug(url)}.html`);
  const exists = await access(file).then(() => true, () => false);
  if (exists) return file;
  await mkdir(dir, { recursive: true });
  await writeFile(file, html);
  return file;
}

async function transformOne(ctx, record, html) {
  try {
    // `transformHtml` is async: without the await the rejection escapes this try and `doc` is
    // a Promise, so `writeDocument` would throw and every URL would land in the long tail.
    return await transformHtml({
      html, url: record.url, transformer: ctx.transformer, params: ctx.params, hosts: ctx.hosts,
    });
  } catch (err) {
    throw new BulkStepError('transform', err.message);
  }
}

async function writeDocument(ctx, doc) {
  const file = path.join(ctx.contentDir, `${doc.path.replace(/^\//, '')}.html`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, doc.html);
  return file;
}

// The source page rides along: the leakage rule needs it to tell a quoted email template
// ("Dear [First Name]") from transformer scaffolding (validate.mjs `leakMatch`).
async function checkDocument(ctx, file, doc, sourceHtml) {
  return validateFile(file, {
    origin: ctx.origin,
    rulesDir: ctx.rulesDir,
    docPath: doc.path,
    sourceHtml,
    fetch: ctx.fetchImpl,
  });
}

function validationError(verdict) {
  const first = verdict.issues.find((issue) => issue.severity === 'error');
  return new BulkStepError('validate', `${first.rule}: ${first.message}`);
}

const isMediaOnly = (verdict) => verdict.issues
  .filter((issue) => issue.severity === 'error')
  .every((issue) => issue.rule === 'media');

// Over-cap SVGs and 20-31 MB originals are a source quirk, not a transformer bug: repairing them
// here keeps the URL in the run instead of parking it in the long tail for a manual media pass.
async function repairMedia(ctx, file, doc) {
  const slug = doc.path.split('/').filter(Boolean).pop();
  const { html, fixed } = await ctx.fixMedia({
    html: doc.html,
    scope: `${ctx.template}/${slug}`,
    da: ctx.daConfig,
    client: ctx.da,
    io: { fetch: ctx.fetchImpl, log: (msg) => console.error(`[bulk] ${msg}`) },
  });
  doc.html = html;
  await writeFile(file, html);
  return fixed.length;
}

const mediaIssueCount = (verdict) => verdict.issues.filter((i) => i.rule === 'media').length;

/**
 * Validates a transformed document, repairing media-only failures when a DA client is available.
 * Without one (dry runs) a media-only failure is not a transformer failure: the run phase repairs
 * it, so the document counts as transformed with `mediaPending` repairs.
 */
async function validateDocument(ctx, file, doc, sourceHtml) {
  const verdict = await checkDocument(ctx, file, doc, sourceHtml);
  if (verdict.pass) return { mediaFixed: 0, mediaPending: 0 };
  if (!isMediaOnly(verdict)) throw validationError(verdict);
  if (!ctx.fixMedia) return { mediaFixed: 0, mediaPending: mediaIssueCount(verdict) };
  const mediaFixed = await repairMedia(ctx, file, doc).catch(rethrow('media'));
  const after = await checkDocument(ctx, file, doc, sourceHtml);
  if (!after.pass) throw validationError(after);
  return { mediaFixed, mediaPending: 0 };
}

async function publishDocument(ctx, doc) {
  await ctx.da.putSource({ path: doc.path, html: doc.html }).catch(rethrow('upload'));
  await ctx.da.preview({ path: doc.path }).catch(rethrow('preview'));
}

async function processUrl(ctx, record) {
  const html = await fetchSource(ctx, record.url);
  await captureSource(ctx, record.url, html).catch(rethrow('capture'));
  const hash = contentHash(html, ctx.params.sourceRoot);
  if (isUpToDate(ctx, record, hash)) {
    return {
      url: record.url, status: record.status, hash, docPath: record.docPath, skipped: true,
    };
  }
  const doc = await transformOne(ctx, record, html);
  const file = await writeDocument(ctx, doc);
  const { mediaFixed, mediaPending } = await validateDocument(ctx, file, doc, html);
  const base = {
    url: record.url,
    hash,
    docPath: doc.path,
    mediaFixed,
    mediaPending,
    media: mediaStats(doc.html),
    warnings: doc.warnings,
    skipped: false,
  };
  if (ctx.mode === 'dry-run') return { ...base, status: 'transformed' };
  await publishDocument(ctx, doc);
  return { ...base, status: 'previewed' };
}

async function recordOutcome(ctx, record, outcome) {
  if (ctx.mode !== 'run') return;
  await upsertRecords('urls', [{
    url: record.url,
    path: record.path,
    sitemapType: record.sitemapType,
    template: record.template,
    status: outcome.status,
    contentHash: outcome.hash ?? record.contentHash ?? null,
    transformerVersion: ctx.transformer.version,
    docPath: outcome.docPath ?? null,
    mediaFixed: outcome.mediaFixed ?? 0,
    error: outcome.error ?? null,
  }], ctx.paths);
  await appendRow('units', {
    unitId: `${ctx.runId}:${record.path}`,
    runId: ctx.runId,
    kind: 'page',
    ref: record.url,
    verdict: outcome.status,
    detail: ctx.acceptCoverage ? 'bulk run (coverage accepted)' : `bulk ${ctx.mode}`,
    at: ctx.generatedAt,
  }, ctx.paths);
}

function failureOutcome(record, err) {
  const failure = classifyFailure(err.stage ?? 'transform', err.message);
  return {
    url: record.url, status: failure.status, failure, error: failure.message, skipped: false,
  };
}

async function runOne(ctx, record) {
  if (Date.now() > ctx.deadline) {
    return {
      url: record.url, status: record.status, skipped: true, reason: 'deadline',
    };
  }
  try {
    const outcome = await processUrl(ctx, record);
    await recordOutcome(ctx, record, outcome);
    return outcome;
  } catch (err) {
    if (err.name === 'DaTokenError') {
      await recordOutcome(ctx, record, {
        url: record.url,
        status: err.checkpoint ?? 'transformed',
        error: err.message,
        skipped: false,
      });
      throw err;
    }
    const outcome = failureOutcome(record, err);
    await recordOutcome(ctx, record, outcome);
    return outcome;
  }
}

function countStatuses(results) {
  const counts = {};
  for (const result of results) {
    const key = result.skipped ? 'skipped' : result.status;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function groupFailures(results) {
  const byClass = new Map();
  for (const { failure, url } of results.filter((r) => r.failure)) {
    const entry = byClass.get(failure.class)
      ?? {
        class: failure.class, count: 0, exampleUrl: url, message: failure.message,
      };
    entry.count += 1;
    byClass.set(failure.class, entry);
  }
  return [...byClass.values()].sort((a, b) => b.count - a.count);
}

function sumMedia(results) {
  const totals = {
    images: 0, remote: 0, svg: 0, fixed: 0, pending: 0,
  };
  for (const r of results.filter((x) => x.media)) {
    totals.images += r.media.images;
    totals.remote += r.media.remote;
    totals.svg += r.media.svg;
    totals.fixed += r.mediaFixed ?? 0;
    totals.pending += r.mediaPending ?? 0;
  }
  return totals;
}

/**
 * Builds the machine-readable bulk report from the per-URL outcomes.
 *
 * @param {object} ctx Run context carrying `template`, `mode`, `runId` and `generatedAt`.
 * @param {object[]} results One outcome per selected URL, in `urls.json` order.
 * @returns {object} Report with counts, coverage, failure classes, media, long tail, samples.
 */
export function buildReport(ctx, results) {
  const attempted = results.filter((r) => !r.skipped);
  const done = attempted.filter((r) => !r.failure);
  return {
    template: ctx.template,
    mode: ctx.mode,
    runId: ctx.runId,
    generatedAt: ctx.generatedAt,
    total: results.length,
    counts: countStatuses(results),
    coverage: attempted.length ? Number((done.length / attempted.length).toFixed(3)) : 1,
    failures: groupFailures(results),
    media: sumMedia(results),
    longTail: results.filter((r) => r.status === 'long-tail').map((r) => r.url),
    samplePaths: done.map((r) => r.docPath).filter(Boolean).slice(0, 3),
    stopped: results.some((r) => r.reason === 'deadline') ? 'deadline' : null,
  };
}

function listLines(items, render) {
  return items.length ? items.map(render) : ['None.'];
}

/**
 * Renders the operator-facing dry-run report.
 *
 * @param {object} report Report from {@link buildReport}.
 * @returns {string} Markdown for `docs/migration/reports/bulk-<template>-dryrun.md`.
 */
export function renderDryRunReport(report) {
  const failureRows = listLines(
    report.failures,
    (f) => `| ${f.class} | ${f.count} | ${f.exampleUrl} |`,
  );
  return [
    `# Bulk dry run \u2014 ${report.template}`,
    '',
    `Generated ${report.generatedAt} (run ${report.runId}).`,
    '',
    `- URLs selected: ${report.total}`,
    `- Transform coverage: ${(report.coverage * 100).toFixed(1)} %`,
    `- Long tail: ${report.longTail.length}`,
    `- Media: ${report.media.images} images, ${report.media.remote} absolute, `
      + `${report.media.svg} svg, ${report.media.fixed} repaired, `
      + `${report.media.pending} repair(s) pending the run phase`,
    '',
    '## Failure classes',
    '',
    '| Class | Count | Example |',
    '| --- | --- | --- |',
    ...failureRows,
    '',
    '## Long tail',
    '',
    ...listLines(report.longTail, (url) => `- ${url}`),
    '',
    '## Sample documents',
    '',
    ...listLines(report.samplePaths, (docPath) => `- \`${docPath}\``),
    '',
  ].join('\n');
}

/**
 * Groups the long-tail URLs by their coarse fingerprint (written by `cluster.mjs`); a group of
 * `newTemplateMin` or more pages is a template proposal for the next `discover` pass.
 *
 * @param {object[]} results Per-URL outcomes of one bulk pass.
 * @param {object[]} urls The template's `urls.json` records, carrying `fingerprint`.
 * @param {{newTemplateMin: number}} thresholds From `site.config.json`.
 * @returns {{groups: {fingerprint: string, urls: string[], proposedTemplate: boolean}[],
 *   markdown: string}} Largest group first.
 */
export function longTailReport(results, urls, { newTemplateMin }) {
  const fpOf = new Map(urls.map((u) => [u.url, u.fingerprint ?? '']));
  const groups = new Map();
  for (const r of results.filter((x) => x.status === 'long-tail')) {
    const fp = fpOf.get(r.url) ?? '';
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(r.url);
  }
  const list = [...groups].map(([fingerprint, us]) => ({
    fingerprint, urls: us, proposedTemplate: us.length >= newTemplateMin,
  })).sort((a, b) => b.urls.length - a.urls.length);
  const total = list.reduce((n, g) => n + g.urls.length, 0);
  const proposed = list.filter((g) => g.proposedTemplate)
    .map((g) => `- ${g.urls.length} pages share \`${g.fingerprint}\`\n`
      + g.urls.map((u) => `  - ${u}`).join('\n'));
  const rest = list.filter((g) => !g.proposedTemplate)
    .flatMap((g) => g.urls.map((u) => `- ${u} (\`${g.fingerprint}\`)`));
  const md = [
    '# Long tail', '', `${total} URLs matched no transformer.`, '',
    '## Proposed new templates', ...listLines(proposed, (line) => line), '',
    '## Singletons and small groups', ...listLines(rest, (line) => line),
  ];
  return { groups: list, markdown: `${md.join('\n')}\n` };
}

async function writeArtifacts(ctx, report, urls) {
  await mkdir(ctx.reportsDir, { recursive: true });
  const longTail = path.join(ctx.reportsDir, `bulk-${ctx.template}-longtail.md`);
  const results = report.longTail.map((url) => ({ url, status: 'long-tail' }));
  await writeFile(longTail, longTailReport(results, urls, ctx.thresholds).markdown);
  if (ctx.mode !== 'dry-run') return;
  const json = path.join(ctx.paths.dataDir, 'bulk', `${ctx.template}-dryrun.json`);
  const md = path.join(ctx.reportsDir, `bulk-${ctx.template}-dryrun.md`);
  await mkdir(path.dirname(json), { recursive: true });
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(md, renderDryRunReport(report));
}

/**
 * Whether one feedback item asks for this URL to be re-transformed.
 *
 * @param {{scope: string}} item Feedback record (`global`, `template:<t>` or `page:<path>`).
 * @param {{template: string, path?: string, docPath?: string}} target The URL record.
 * @returns {boolean} True when the scope covers the URL.
 */
export function feedbackForces(item, { template, path: sourcePath, docPath }) {
  if (item.scope === 'global') return true;
  if (item.scope === `template:${template}`) return true;
  const page = item.scope.startsWith('page:') ? item.scope.slice(5) : null;
  return page !== null && (page === docPath || page === sourcePath);
}

/**
 * Applied feedback that has not been re-run yet forces its URLs through the pipeline again.
 *
 * A `global` item always qualifies; a `template:<t>` item qualifies when `<t>` is this
 * template; a `page:<p>` item qualifies only when `<p>` matches a record of THIS template in
 * `stored` (every stored record, not just the eligible `records`) — a page owned by another
 * template is left untouched. Forced URLs are still only those found in `records`.
 *
 * @param {object} ctx
 * @param {object[]} records Eligible URL records for this pass (`selectRecords` output).
 * @param {object[]} stored Every stored record of this template; decides page ownership.
 * @returns {Promise<{item: object, urls: string[]}[]>} Items with the URLs they force.
 */
async function forceByFeedback(ctx, records, stored) {
  if (ctx.mode !== 'run') return [];
  const pending = (await listFeedback({ status: 'applied' }, ctx.paths))
    .filter((item) => !item.appliedRun);
  const target = (r) => ({ template: ctx.template, ...r });
  const owned = (item) => item.scope === 'global'
    || item.scope === `template:${ctx.template}`
    || stored.some((r) => feedbackForces(item, target(r)));
  return pending.filter(owned).map((item) => {
    const urls = records.filter((r) => feedbackForces(item, target(r))).map((r) => r.url);
    urls.forEach((url) => ctx.forcedUrls.add(url));
    return { item, urls };
  });
}

/**
 * Marks a `template:`/`page:` item applied when every URL it forced ended in a done status
 * this run (vacuously true when it forced none). `global` items are never auto-settled: they
 * may still be pending against templates that have not run yet, so an operator settles them
 * explicitly once every affected template has re-run.
 */
async function settleFeedback(ctx, forced, results) {
  const byUrl = new Map(results.map((r) => [r.url, r]));
  for (const { item, urls } of forced) {
    if (item.scope === 'global') continue;
    const clean = urls.every((url) => {
      const r = byUrl.get(url);
      return r && !r.skipped && DONE_STATUSES.has(r.status);
    });
    if (clean) await setFeedback(item.id, { appliedRun: ctx.runId }, ctx.paths);
  }
}

async function resolveClients({
  config, mode, io, paths,
}) {
  const http = io.http ?? createClient({
    requestsPerSecond: config.rateLimit.requestsPerSecond, cacheDir: paths.cacheDir,
  });
  if (io.da || mode !== 'run') return { http, da: io.da ?? null };
  const { token, expiresAt, source } = await loadToken();
  return {
    http,
    da: createDaClient({
      da: config.da,
      token,
      expiresAt,
      tokenSource: source,
      io: { concurrency: config.concurrency.da, log: (msg) => console.error(`[bulk] ${msg}`) },
    }),
  };
}

function resolveDirs(paths, io) {
  return {
    contentDir: io.contentDir ?? path.join(paths.siteDir, 'content'),
    rulesDir: io.rulesDir ?? path.join(paths.siteDir, 'rules'),
    reportsDir: io.reportsDir ?? path.join(paths.docsDir, 'reports'),
  };
}

function bulkOptions(options, template) {
  const {
    force = false, concurrency = 4, maxMinutes = 30, runId = `bulk-${template}`,
    acceptCoverage = false,
  } = options;
  return {
    force, concurrency, runId, deadline: Date.now() + maxMinutes * 60000, acceptCoverage,
  };
}

/**
 * Refuses `--run` when the template has no dry-run report, or its coverage is below
 * `thresholds.coverage`; `--accept-coverage` (`ctx.acceptCoverage`) bypasses both checks.
 */
async function ensureCoverage(ctx) {
  if (ctx.mode !== 'run' || ctx.acceptCoverage) return;
  const file = path.join(ctx.paths.dataDir, 'bulk', `${ctx.template}-dryrun.json`);
  const report = await readJson(file, null);
  if (!report) {
    throw new Error(`Run bulk.mjs --template ${ctx.template} --dry-run first: `
      + `no dry-run report at ${file}`);
  }
  if (report.coverage < ctx.thresholds.coverage) {
    throw new Error(`Dry-run coverage ${report.coverage} is below thresholds.coverage `
      + `${ctx.thresholds.coverage}; fix the long tail or pass --accept-coverage`);
  }
}

async function createContext({
  template, mode, options, io,
}) {
  const paths = io.paths ?? resolvePaths();
  const config = await loadConfig(paths.configPath);
  const transformer = io.transformer ?? await loadTransformer(template);
  const clients = await resolveClients({
    config, mode, io, paths,
  });
  return {
    template,
    mode,
    paths,
    transformer,
    origin: config.origin,
    hosts: originAliasHosts(config),
    thresholds: config.thresholds,
    daConfig: config.da,
    forcedUrls: new Set(),
    // Repairs need somewhere to put the converted asset: without a DA client (dry run) an
    // over-cap image stays a validation failure.
    fixMedia: io.fixMedia ?? (clients.da ? fixDocument : null),
    // The transformer is developed against the `transform.mjs` CLI, which seeds `sourceRoot`
    // from the template config; seed it identically here or `document.querySelector(undefined)`
    // throws on every URL. The same root feeds `contentHash`, so bulk's stored hash matches the
    // one `transformHtml` returns.
    params: {
      sourceRoot: config.templates?.[template]?.sourceRoot ?? 'main',
      ...(options.params ?? {}),
    },
    fetchImpl: io.fetchImpl,
    generatedAt: new Date().toISOString(),
    ...clients,
    ...resolveDirs(paths, io),
    ...bulkOptions(options, template),
  };
}

async function runAll(ctx, records, urls) {
  const results = [];
  try {
    await mapPool(records, ctx.concurrency, async (record, index) => {
      results[index] = await runOne(ctx, record);
    });
  } catch (err) {
    await writeArtifacts(ctx, buildReport(ctx, results.filter(Boolean)), urls);
    throw err;
  }
  return results;
}

/**
 * Runs one bulk pass over every eligible URL of a template.
 *
 * `dry-run` transforms and validates only; `run` also uploads to DA, previews and checkpoints
 * each URL in `urls.json` plus a `units.jsonl` row, and re-transforms the URLs that applied
 * feedback (`feedback.json`, status `applied`, no `appliedRun`) points at. Both modes write
 * `reports/bulk-<template>-longtail.md`.
 *
 * @param {object} options
 * @param {string} options.template Template name, e.g. `case-study`.
 * @param {string} [options.mode] `dry-run` (default) or `run`.
 * @param {object} [options.options] `{limit, force, concurrency, maxMinutes, runId, params}`.
 * @param {object} [options.io] Injection: `{paths, http, da, transformer, contentDir, rulesDir,
 *   reportsDir, fetchImpl, fixMedia}`.
 * @returns {Promise<object>} The report from {@link buildReport}.
 * @throws {import('./da.mjs').DaTokenError} On a 401, after checkpointing the current URL.
 */
export async function runBulk({
  template, mode = 'dry-run', options = {}, io = {},
}) {
  const ctx = await createContext({
    template, mode, options, io,
  });
  await ensureCoverage(ctx);
  const stored = await listRecords('urls', { where: { template }, paths: ctx.paths });
  const selected = selectRecords(stored, options);
  const forced = await forceByFeedback(ctx, selected, stored);
  const results = await runAll(ctx, selected, stored);
  const report = buildReport(ctx, results);
  await writeArtifacts(ctx, report, stored);
  await settleFeedback(ctx, forced, results);
  return report;
}

function parseCli(argv) {
  const template = flag(argv, '--template');
  const run = argv.includes('--run');
  if (!template || run === argv.includes('--dry-run')) throw new Error(USAGE);
  return {
    template,
    mode: run ? 'run' : 'dry-run',
    options: {
      limit: positiveIntFlag(argv, '--limit'),
      force: argv.includes('--force'),
      concurrency: positiveIntFlag(argv, '--concurrency', 4),
      maxMinutes: positiveIntFlag(argv, '--max-minutes', 30),
      runId: flag(argv, '--run-id', `bulk-${template}-cli`),
      acceptCoverage: argv.includes('--accept-coverage'),
    },
  };
}

async function cli(argv) {
  const report = await runBulk(parseCli(argv));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

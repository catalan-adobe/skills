import {
  access, mkdir, mkdtemp, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flag, positiveIntFlag } from './args.mjs';
import { createBrowser } from './browser.mjs';
import { loadConfig } from './config.mjs';
import {
  clusterRecords, fingerprintFromTree, nameCluster, pickRepresentatives,
} from './fingerprint.mjs';
import { resolvePaths } from './paths.mjs';
import {
  captureSlug, listRecords, upsertRecords, writeJsonAtomic,
} from './state.mjs';

const POLL = '() => JSON.stringify(window.__treeResult || window.__treeError || null)';

/**
 * Snippet injected after the page-tree bundle. Init scripts run at document start, before any
 * DOM exists, so the capture waits for `load` (plus a short settle for late layout) and parks
 * the tree in `window.__treeResult` or the failure in `window.__treeError`.
 *
 * @param {number} [minWidth=900] Minimum box width the visual tree keeps.
 * @param {number} [settleMs=500] Delay after `load` before capturing.
 * @returns {string} JavaScript source for the browser.
 */
export function treeBootstrap(minWidth = 900, settleMs = 500) {
  return `(() => {
  const capture = () => {
    try { window.__treeResult = window.__visualTree.captureVisualTree(${minWidth}); }
    catch (err) { window.__treeError = { error: String((err && err.stack) || err) }; }
  };
  const later = () => setTimeout(capture, ${settleMs});
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
})();`;
}

/** Parses the poll payload; null while pending, throws on a captured error.
 */
export function treeFromPoll(payload) {
  const value = payload ? JSON.parse(payload) : null;
  if (value?.error) throw new Error(value.error);
  return value;
}

async function writeInitScripts(config, paths) {
  const bundleFile = path.resolve(
    paths.repoRoot,
    config.bundles.pageTree
  );
  await access(bundleFile).catch(() => {
    throw new Error(
      `page-tree bundle not found at ${bundleFile}; run init.mjs or: ` +
      'upskill adobe/skills --path plugins/web/skills --skill page-tree'
    );
  });
  const dir = await mkdtemp(
    path.join(os.tmpdir(), 'migration-cluster-')
  );
  const bootstrap = path.join(dir, 'bootstrap.js');
  await writeFile(bootstrap, treeBootstrap());
  return {
    dir,
    scripts: [bundleFile, bootstrap],
  };
}

function selectCandidates(urls, { limit, type, force }) {
  return urls
    .filter((u) => !u.excluded && (force || (!u.fingerprint && !u.fingerprintError)))
    .filter((u) => !type || u.sitemapType === type)
    .slice(0, limit);
}

// With --force every in-scope URL must be re-fingerprinted during *this* run, so anything still
// carrying a stamp from before `startedAt` counts as remaining and blocks finalization.
function countRemaining(urls, { type, force, startedAt }) {
  if (!force) return selectCandidates(urls, { limit: Infinity, type, force: false }).length;
  return urls
    .filter((u) => !u.excluded)
    .filter((u) => !type || u.sitemapType === type)
    // `<=` so a stamp written in the same millisecond as `startedAt` still counts as stale.
    .filter((u) => !u.fingerprintedAt || u.fingerprintedAt <= startedAt)
    .length;
}

async function fingerprintOne(browser, record, paths) {
  const now = new Date().toISOString();
  try {
    await browser.goto(record.url);
    const result = await browser.pollJson(POLL, { timeoutMs: 45000 });
    if (result?.error) throw new Error(result.error);
    const tree = treeFromPoll(JSON.stringify(result));
    const treeFile = path.join(paths.dataDir, 'visual-trees',
      `${captureSlug(record.url)}.json`);
    await writeJsonAtomic(treeFile, tree);
    const fp = fingerprintFromTree(tree);
    await upsertRecords('urls', [{
      url: record.url,
      fingerprint: fp.coarse,
      fingerprintFine: fp.fine,
      features: fp.features,
      fingerprintedAt: now,
      fingerprintError: null,
    }], paths);
    return true;
  } catch (err) {
    await upsertRecords('urls', [{
      url: record.url, fingerprintError: err.message, fingerprintedAt: now,
    }], paths);
    return false;
  }
}

async function runWorkers({
  candidates, config, paths, browserFactory, initScripts, deadline, log,
}) {
  const queue = [...candidates];
  const tally = { processed: 0, errors: 0 };
  const workerCount = Math.max(1, Math.min(config.concurrency.browser, queue.length));
  const runWorker = async (i) => {
    const browser = browserFactory({ session: `migration-cluster-${i}` });
    let opened = false;
    try {
      while (queue.length && Date.now() < deadline) {
        const record = queue.shift();
        if (!opened) {
          await browser.open(record.url, { initScripts });
          await browser.resize(...config.viewports.desktop);
          opened = true;
        }
        const ok = await fingerprintOne(browser, record, paths);
        tally.processed += 1;
        if (!ok) tally.errors += 1;
        if (tally.processed % 25 === 0) {
          log(`fingerprinted ${tally.processed}/${candidates.length}`);
        }
      }
    } finally {
      if (opened) await browser.close();
    }
  };
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) workers.push(runWorker(i));
  await Promise.all(workers);
  return tally;
}


/**
 * Groups fingerprinted URLs into templates, names them from the sitemap seeds and picks
 * representatives; writes `templates.json` and updates each URL's template.
 *
 * @param {{config: object, paths: ReturnType<typeof resolvePaths>}} options
 * @returns {Promise<object[]>} The templates written.
 */
async function finalizeTemplates({ config, paths }) {
  const urls = (await listRecords('urls', { paths }))
    .filter((u) => !u.excluded && u.fingerprint !== undefined);
  const byUrl = new Map(urls.map((u) => [u.url, u]));
  // The coarse fingerprint (top-level boxes) tells site sections apart; the fine one (two
  // levels, with layout and class tokens) tells templates apart — pages that share a header,
  // one main box and a footer are not one template.
  const fine = urls.map((u) => ({ ...u, fingerprint: u.fingerprintFine ?? u.fingerprint }));
  const clusters = clusterRecords(fine, { threshold: config.thresholds.clusterSimilarity });
  const templates = clusters.map((cluster) => {
    const seed = config.templateSeeds[cluster.sitemapType] ?? cluster.sitemapType;
    const members = cluster.members
      .map((url) => ({ url, features: byUrl.get(url).features ?? [] }));
    return {
      name: nameCluster(seed, cluster.index),
      sitemapTypes: [cluster.sitemapType],
      urlCount: cluster.members.length,
      representatives: pickRepresentatives(members, config.thresholds.representativesPerTemplate),
      fingerprint: cluster.fingerprint,
      small: cluster.members.length < config.thresholds.minClusterSize,
      status: 'todo',
      description: '',
    };
  });
  await upsertRecords('templates', templates, paths);
  const updates = templates.flatMap((t, i) => clusters[i].members.map((url) => ({
    url, template: t.name, representative: t.representatives.includes(url), status: 'analyzed',
  })));
  await upsertRecords('urls', updates, paths);
  return templates;
}

const SHOT_SETTLE_TIMEOUT_MS = 10000;

async function missingShots(templates, dir) {
  const urls = templates.flatMap((t) => t.representatives);
  const checks = await Promise.all(urls.map(async (url) => {
    const file = path.join(dir, `${captureSlug(url)}.jpg`);
    const exists = await stat(file).then(() => true, () => false);
    return exists ? null : { url, file };
  }));
  return checks.filter(Boolean);
}

// Resumable: representatives that already have a screenshot are skipped, so a killed run
// only redoes the in-flight capture.
async function shootRepresentatives({
  templates, config, paths, browserFactory, initScripts, log,
}) {
  const dir = path.join(paths.dataDir, 'screenshots', 'representatives');
  await mkdir(dir, { recursive: true });
  const todo = await missingShots(templates, dir);
  if (!todo.length) return;
  const browser = browserFactory({ session: 'migration-cluster-shots' });
  try {
    await browser.open(todo[0].url, { initScripts });
    await browser.resize(...config.viewports.desktop);
    for (const { url, file } of todo) {
      await browser.goto(url);
      await browser.pollJson(POLL, { timeoutMs: SHOT_SETTLE_TIMEOUT_MS }).catch(() => null);
      await browser.screenshot(file);
    }
    log(`captured ${todo.length} representative screenshots`);
  } finally {
    await browser.close();
  }
}

/**
 * Fingerprints not-yet-fingerprinted URLs (time-boxed, resumable) and finalizes templates once
 * every active URL has been attempted.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {ReturnType<typeof resolvePaths>} options.paths
 * @param {(opts: {session: string}) => ReturnType<typeof createBrowser>} [options.browserFactory]
 * @param {number} [options.limit=Infinity]
 * @param {string} [options.type] Restrict to one sitemap type.
 * @param {number} [options.maxMinutes=10]
 * @param {boolean} [options.force=false] Re-fingerprint everything.
 * @param {boolean} [options.shots=true] Capture representative screenshots at finalization.
 * @param {(msg: string) => void} [options.log]
 */
export async function runCluster({
  config, paths, browserFactory = createBrowser, limit = Infinity, type = null,
  maxMinutes = 10, force = false, shots = true, log = () => {},
}) {
  const startedAt = new Date().toISOString();
  const urls = await listRecords('urls', { paths });
  const candidates = selectCandidates(urls, { limit, type, force });
  const { dir, scripts } = await writeInitScripts(config, paths);
  const deadline = Date.now() + maxMinutes * 60000;
  let tally = { processed: 0, errors: 0 };
  try {
    if (candidates.length) {
      tally = await runWorkers({
        candidates, config, paths, browserFactory, initScripts: scripts, deadline, log,
      });
    }
    const after = await listRecords('urls', { paths });
    const remaining = countRemaining(after, { type, force, startedAt });
    const failed = after.filter((u) => !u.excluded && u.fingerprintError).length;
    let templates = [];
    // A URL that failed to fingerprint belongs to no template and is never migrated; `failed`
    // makes that visible so the operator re-runs (`--force`) or excludes those URLs.
    if (remaining === 0) {
      templates = await finalizeTemplates({ config, paths });
      if (shots) {
        await shootRepresentatives({
          templates, config, paths, browserFactory, initScripts: scripts, log,
        });
      }
    }
    return {
      processed: tally.processed,
      errors: tally.errors,
      remaining,
      failed,
      finalized: remaining === 0,
      templates: templates.length,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function cli(argv) {
  const paths = resolvePaths();
  const config = await loadConfig(paths.configPath);
  const concurrency = positiveIntFlag(argv, '--concurrency', config.concurrency.browser);
  const summary = await runCluster({
    config: { ...config, concurrency: { ...config.concurrency, browser: concurrency } },
    paths,
    limit: positiveIntFlag(argv, '--limit', Infinity),
    type: flag(argv, '--type', null),
    maxMinutes: positiveIntFlag(argv, '--max-minutes', 10),
    force: argv.includes('--force'),
    shots: !argv.includes('--no-shots'),
    log: (msg) => console.error(`[cluster] ${msg}`),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

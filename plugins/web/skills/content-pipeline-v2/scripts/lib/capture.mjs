// The capture step: every verified page rendered from the local cache, its visual tree
// (page-tree bundle) stored under capture/<sha8>.json — the project's visual-tree store,
// read by chrome and by every later analysis of page structure. Runs detached, one browser
// session on the offline proxy; a rerun captures only what is missing or stale.
import { createHash } from 'node:crypto';
import { mkdir, open as openFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { proxiedUrl } from './cache-server.mjs';
import { readInventory } from './inventory.mjs';
import { alive, writeJson } from './jobs.mjs';
import { pageExpression, parseEval } from './warm.mjs';

// A 1280 px viewport puts a four-up grid column and a quarter-width rail at ~290 px; 300
// missed both and left their content out of the store. 250 sees them; 200 saw nothing more.
export const MIN_WIDTH = 250;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const captureExpression = (minWidth = MIN_WIDTH) => (
  `JSON.stringify(window.__visualTree.captureVisualTree(${minWidth}))`);
// A run whose process must be alive: `readRun` turns these into `interrupted` when it is not.
const OPEN_STATES = ['queued', 'running', 'analysing'];

export const capturesDir = (project) => project.step('capture');
export const capturesMd = (project) => path.join(capturesDir(project), 'captures.md');
export const runDir = (project, kind = 'capture') => path.join(project.work, kind);
export const runFile = (project, kind = 'capture') => path.join(runDir(project, kind), 'run.json');
export const captureFile = (project, url) => path.join(
  capturesDir(project), `${createHash('sha256').update(url).digest('hex').slice(0, 8)}.json`,
);

/**
 * The `minWidth` a stored capture was taken at — the first key the writer emits, so the head
 * of the file is enough; 0 for a capture without one (an old store); null for no file.
 */
export async function storedMinWidth(file) {
  const fh = await openFile(file).catch(() => null);
  if (!fh) return null;
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0);
    const m = buffer.toString('utf8', 0, bytesRead).match(/"minWidth":\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  } finally {
    await fh.close();
  }
}

/**
 * The store against the cache: verified pages, those captured at `minWidth`, those without
 * a capture (`missing`) and those captured at another width (`stale`).
 */
async function verifiedPages(project) {
  const records = await readInventory(project.step('urls'));
  return records.filter((r) => r.kind === 'page' && r.cache?.verified).map((r) => r.url);
}

export async function storeStatus(project, minWidth = MIN_WIDTH) {
  const pages = await verifiedPages(project);
  const status = { verified: pages.length, captured: 0, missing: [], stale: [], minWidth };
  for (const url of pages) {
    const stored = await storedMinWidth(captureFile(project, url));
    if (stored === null) status.missing.push(url);
    else if (stored !== minWidth) status.stale.push(url);
    else status.captured += 1;
  }
  return status;
}

/** Verified cached pages minus those captured at `minWidth` (all of them with `force`). */
export async function pagesToCapture(project, { force = false, minWidth = MIN_WIDTH } = {}) {
  if (force) return verifiedPages(project);
  const status = await storeStatus(project, minWidth);
  return [...status.missing, ...status.stale];
}

/** Where setup.json says the page-tree bundle is. */
export async function bundlePath(project) {
  const setup = JSON.parse(await readFile(project.setupFile, 'utf8'));
  const skill = setup.skills?.['page-tree']?.path;
  if (!skill) {
    throw new Error('setup.json lacks the page-tree skill; run status.mjs setup --install');
  }
  return path.join(path.dirname(skill), 'scripts', 'page-tree-bundle.js');
}

/** The prep step's recipe as one expression: hide rules and scroll fix; null without one. */
export async function prepExpression(project) {
  const recipe = await readFile(path.join(project.step('prep'), 'page-prep.json'), 'utf8')
    .then(JSON.parse, () => null);
  return {
    prepare: recipe ? pageExpression(recipe) : null,
    consentSelectors: (recipe?.overlays ?? []).map((o) => o.selector).filter(Boolean),
  };
}

/** Every stored capture. */
export async function readCaptures(project) {
  const dir = capturesDir(project);
  const files = await readdir(dir).catch(() => []);
  return Promise.all(files.filter((f) => f.endsWith('.json'))
    .map((f) => readFile(path.join(dir, f), 'utf8').then(JSON.parse)));
}

/** The recorded run, with `interrupted` when its process is gone before it finished. */
export async function readRun(project, isAlive = alive, kind = 'capture') {
  const run = await readFile(runFile(project, kind), 'utf8').then(JSON.parse, () => null);
  if (!run) return null;
  if (OPEN_STATES.includes(run.state) && !isAlive(run.pid)) return { ...run, state: 'interrupted' };
  return run;
}

/**
 * Renders each page through the proxy and stores its visual tree. `browser` is playwright
 * (goto, eval); `origin`/`port` address the offline server; `prepare` is the eval that
 * applies the prep step's hide rules and scrolls, when there is one. Progress goes to
 * run.json after every page; five failures in a row end the run.
 */
export async function captureAll(project,
  { browser, origin, port, prepare = null, minWidth = MIN_WIDTH, now = () => new Date() },
  { urls, shouldStop = () => false }) {
  await mkdir(capturesDir(project), { recursive: true });
  const run = {
    ...(await readRun(project)), state: 'running', total: urls.length, done: 0, failed: [],
    minWidth, startedAt: now().toISOString(),
  };
  let streak = 0;
  const record = async (patch) => writeJson(runFile(project), Object.assign(run, patch));
  for (const url of urls) {
    if (shouldStop()) { await record({ state: 'stopped', current: null }); return run; }
    await record({ current: url });
    try {
      await browser.goto(proxiedUrl(origin, url, port));
      // The prep expression scrolls to the bottom (lazy content); back to the top before
      // capturing, or a sticky nav is recorded where it stuck.
      if (prepare) await browser.eval(`${prepare}, window.scrollTo(0, 0)`);
      const captured = parseEval(await browser.eval(captureExpression(minWidth)));
      if (!captured?.data?.tag) {
        throw new Error('the page-tree bundle returned no tree (was it injected?)');
      }
      // The bundle's shape: data (the node tree), textFormat, nodeMap, rootBackground.
      await writeJson(captureFile(project, url), {
        minWidth, url, capturedAt: now().toISOString(), tree: captured.data,
        text: captured.textFormat, nodeMap: captured.nodeMap,
        rootBackground: captured.rootBackground ?? null,
      });
      streak = 0;
    } catch (err) {
      run.failed.push({ url, error: String(err.message).split('\n')[0] });
      streak += 1;
      if (streak >= MAX_CONSECUTIVE_FAILURES) {
        await record({
          state: 'failed', current: null,
          error: `${MAX_CONSECUTIVE_FAILURES} pages failed in a row; last: ${err.message}`,
        });
        return run;
      }
    }
    await record({ done: run.done + 1 });
  }
  await record({ state: 'done', current: null, finishedAt: now().toISOString() });
  return run;
}

/** `capture/captures.md`: the store against the cache, for the operator. */
export async function writeCapturesMd(project, { minWidth = MIN_WIDTH, now = () => new Date() }
  = {}) {
  const status = await storeStatus(project, minWidth);
  const run = await readRun(project);
  const lines = [
    '# Visual-tree store', '',
    `Captured ${now().toISOString().slice(0, 16)}Z at min-width ${minWidth} px.`, '',
    `- verified cached pages: ${status.verified}`,
    `- captured at ${minWidth} px: ${status.captured}`,
    `- without a capture: ${status.missing.length}`,
    `- captured at another width (stale): ${status.stale.length}`,
    `- failed in the last run: ${run?.failed?.length ?? 0}`,
  ];
  for (const f of run?.failed ?? []) lines.push(`  - ${f.url} — ${f.error}`);
  await writeFile(capturesMd(project), `${lines.join('\n')}\n`);
  return status;
}

/**
 * The playwright-cli config for the capture session: the cache's browser config (proxy
 * only) plus the page-tree bundle as init script.
 */
export async function writeCaptureConfig(project, browserConfig, bundle) {
  const base = JSON.parse(await readFile(browserConfig, 'utf8'));
  const config = { ...base, browser: { ...base.browser, initScript: [bundle] } };
  const file = path.join(runDir(project), 'browser-config.json');
  await mkdir(runDir(project), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/**
 * Starts a detached worker of `kind` unless one is alive; its output goes to worker.log
 * and its state to run.json (`queued` → `running` with the pid, then whatever the worker
 * records). `run` seeds run.json.
 */
export async function startWorker(project, kind, workerScript, args, run = {}, io = {}) {
  const current = await readRun(project, io.alive ?? alive, kind);
  if (OPEN_STATES.includes(current?.state)) return { started: false, run: current };
  await mkdir(runDir(project, kind), { recursive: true });
  await writeJson(runFile(project, kind), { ...run, state: 'queued' });
  const log = await openFile(path.join(runDir(project, kind), 'worker.log'), 'a');
  try {
    const child = (io.spawn ?? spawn)(process.execPath, [workerScript, '--worker', ...args],
      { cwd: project.root, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref();
    await writeJson(runFile(project, kind), { ...run, state: 'running', pid: child.pid });
    return { started: true, pid: child.pid, ...run };
  } finally {
    await log.close();
  }
}

/** Starts the capture worker for the missing and stale pages (all of them with `force`). */
export async function startCapture(project, workerScript,
  { force = false, minWidth = MIN_WIDTH } = {}, io = {}) {
  const urls = await pagesToCapture(project, { force, minWidth });
  const args = [...(force ? ['--force'] : []), '--min-width', String(minWidth)];
  return startWorker(project, 'capture', workerScript, args,
    { total: urls.length, done: 0, failed: [], force, minWidth }, io);
}

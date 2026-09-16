// The chrome step's capture: every verified page rendered from the local cache, its visual
// tree (page-tree bundle) stored under chrome/.captures/<sha8>.json. Runs detached, one
// browser session on the offline proxy; a rerun captures only what is missing.
import { createHash } from 'node:crypto';
import { access, mkdir, open as openFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { proxiedUrl } from './cache-server.mjs';
import { readInventory } from './inventory.mjs';
import { alive, writeJson } from './jobs.mjs';
import { parseEval } from './warm.mjs';

export const MIN_WIDTH = 900;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const captureExpression = (minWidth = MIN_WIDTH) => (
  `JSON.stringify(window.__visualTree.captureVisualTree(${minWidth}))`);
export const CAPTURE_EXPRESSION = captureExpression();

export const capturesDir = (project) => path.join(project.step('chrome'), '.captures');
export const runDir = (project) => path.join(project.work, 'chrome');
export const runFile = (project) => path.join(runDir(project), 'run.json');
export const captureFile = (project, url) => path.join(
  capturesDir(project), `${createHash('sha256').update(url).digest('hex').slice(0, 8)}.json`,
);

/** Verified cached pages, minus those with a capture on disk (all of them with `force`). */
export async function pagesToCapture(project, { force = false } = {}) {
  const records = await readInventory(project.step('urls'));
  const pages = records.filter((r) => r.kind === 'page' && r.cache?.verified).map((r) => r.url);
  if (force) return pages;
  const missing = [];
  for (const url of pages) {
    const stored = await access(captureFile(project, url)).then(() => true, () => false);
    if (!stored) missing.push(url);
  }
  return missing;
}

/** The recorded run, with `interrupted` when its process is gone before it finished. */
export async function readRun(project, isAlive = alive) {
  const run = await readFile(runFile(project), 'utf8').then(JSON.parse, () => null);
  if (!run) return null;
  if (run.state === 'running' && !isAlive(run.pid)) return { ...run, state: 'interrupted' };
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
    startedAt: now().toISOString(),
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
        url, capturedAt: now().toISOString(), minWidth, tree: captured.data,
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
 * Starts the detached worker unless a run is alive; its output goes to worker.log. With
 * nothing left to capture the worker goes straight to the analysis, so a rerun refreshes
 * chrome.json from the captures on disk.
 */
export async function startCapture(project, workerScript,
  { force = false, minWidth = null } = {}, io = {}) {
  const current = await readRun(project, io.alive ?? alive);
  if (current?.state === 'running') return { started: false, run: current };
  const urls = await pagesToCapture(project, { force });
  await mkdir(runDir(project), { recursive: true });
  await writeJson(runFile(project), {
    state: 'queued', total: urls.length, done: 0, failed: [], force,
  });
  const log = await openFile(path.join(runDir(project), 'worker.log'), 'a');
  try {
    const child = (io.spawn ?? spawn)(process.execPath, [
      workerScript, '--worker', ...(force ? ['--force'] : []),
      ...(minWidth ? ['--min-width', String(minWidth)] : []),
    ], { cwd: project.root, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref();
    await writeJson(runFile(project), {
      state: 'running', pid: child.pid, total: urls.length, done: 0, failed: [], force,
    });
    return { started: true, pid: child.pid, total: urls.length };
  } finally {
    await log.close();
  }
}

/** Forgets a finished run (its captures stay). */
export const clearRun = (project) => rm(runFile(project), { force: true });

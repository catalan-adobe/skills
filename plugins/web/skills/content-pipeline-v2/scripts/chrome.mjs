#!/usr/bin/env node
// The chrome step, in the background: `chrome.mjs` starts one detached worker that renders
// every verified cached page through the offline cache server and stores its visual tree
// under migration/chrome/.captures/, then returns at once.
// Usage: node chrome.mjs [--force] | status | stop   (from the project root)
// A rerun captures only the pages without a capture; --force recaptures all.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectOrigin, proxiedUrl, serveCache } from './lib/cache-server.mjs';
import {
  captureAll, capturesDir, pagesToCapture, readRun, startCapture, writeCaptureConfig,
} from './lib/chrome-capture.mjs';
import { candidates, chromeCandidates } from './lib/chrome.mjs';
import { freePort } from './lib/ports.mjs';
import { resolveProject } from './lib/project.mjs';
import { defaultIo, playwright, setupPaths } from './lib/warm-cli.mjs';

export const HELP = `chrome.mjs [--force]
    capture every verified cached page's visual tree in the background; a rerun does the rest
chrome.mjs status
    the capture run: state, done/total, failures
chrome.mjs stop
    end the worker after its current page
chrome.mjs candidates [--min-support 0.5]
    dry run: recurring, stably placed elements over the captures, by support`;

const WORKER_SCRIPT = fileURLToPath(import.meta.url);

/** Where setup.json says the page-tree bundle is. */
export async function bundlePath(project) {
  const setup = JSON.parse(await readFile(project.setupFile, 'utf8'));
  const skill = setup.skills?.['page-tree']?.path;
  if (!skill) {
    throw new Error('setup.json lacks the page-tree skill; run status.mjs setup --install');
  }
  return path.join(path.dirname(skill), 'scripts', 'page-tree-bundle.js');
}

/** The worker: the offline server, one browser session with the bundle, every page. */
export async function workerMain(project, argv, io = defaultIo) {
  const { proxyScript, cli } = await setupPaths(project);
  const bundle = await bundlePath(project);
  const origin = await projectOrigin(project);
  const server = await serveCache(project, proxyScript, freePort);
  const config = await writeCaptureConfig(project, server.browserConfig, bundle);
  const urls = await pagesToCapture(project, { force: argv.includes('--force') });
  let stopping = false;
  io.onSignal(() => { stopping = true; });
  const browser = playwright(cli, io, project.work, 'chrome');
  await browser.open(proxiedUrl(origin, urls[0] ?? origin, server.port), { config });
  try {
    return await captureAll(project, { browser, origin, port: server.port },
      { urls, shouldStop: () => stopping });
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Every stored capture. */
export async function readCaptures(project) {
  const dir = capturesDir(project);
  const files = await readdir(dir).catch(() => []);
  return Promise.all(files.filter((f) => f.endsWith('.json'))
    .map((f) => readFile(path.join(dir, f), 'utf8').then(JSON.parse)));
}

function renderCandidates(list) {
  const rows = list.map((c) => [
    `${Math.round(c.support * 100)}%`.padStart(4), `d${c.depth}`, c.anchored.padEnd(6),
    `y${c.bounds.y} h${c.bounds.height} bottom${c.bounds.bottomOffset}`.padEnd(26),
    `${c.pages.length} pages`.padEnd(9), c.sample.selector,
  ].join(' '));
  return ['support depth anchor position                   pages     sample selector', ...rows]
    .join('\n');
}

export async function main(argv, project, io = defaultIo) {
  if (argv.includes('--help') || argv[0] === 'help') return HELP;
  if (argv[0] === 'candidates') {
    const captures = await readCaptures(project);
    if (!captures.length) throw new Error('no captures yet; run chrome.mjs first');
    const i = argv.indexOf('--min-support');
    const minSupport = i >= 0 ? Number(argv[i + 1]) : 0.5;
    return renderCandidates(chromeCandidates(candidates(captures), { minSupport }));
  }
  if (argv[0] === '--worker') return workerMain(project, argv, io);
  if (argv[0] === 'status') return (await readRun(project)) ?? { state: 'never run' };
  if (argv[0] === 'stop') {
    const run = await readRun(project);
    if (run?.state !== 'running') return { stopped: false, reason: 'no capture is running' };
    io.kill(run.pid, 'SIGTERM');
    return { stopped: true, pid: run.pid, note: 'the worker finishes its current page' };
  }
  return startCapture(project, WORKER_SCRIPT, { force: argv.includes('--force') }, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), resolveProject())
    .then((out) => console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

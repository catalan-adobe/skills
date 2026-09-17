#!/usr/bin/env node
// The chrome step, in the background: `chrome.mjs` starts one detached worker that detects
// header and footer over the visual-tree store (capture/), screenshots each variant on its
// representative page and writes chrome/, then returns at once.
// Usage: node chrome.mjs | status | stop | candidates   (from the project root)
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectOrigin, proxiedUrl, serveCache } from './lib/cache-server.mjs';
import {
  capturesDir, prepExpression, readCaptures, readRun, runFile, startWorker,
} from './lib/capture.mjs';
import { candidates, chromeCandidates } from './lib/chrome.mjs';
import { analyse } from './lib/chrome-report.mjs';
import { writeJson } from './lib/jobs.mjs';
import { freePort } from './lib/ports.mjs';
import { resolveProject } from './lib/project.mjs';
import { defaultIo, playwright, sessionName, setupPaths } from './lib/warm-cli.mjs';

export const HELP = `chrome.mjs
    in the background: detect header and footer over the visual-tree store, take the
    screenshots, write chrome/chrome.json, chrome.md and the report section
chrome.mjs status
    the run: state, failures
chrome.mjs stop
    end the worker
chrome.mjs candidates [--min-support 0.5]
    dry run: recurring, stably placed elements over the store, by support`;

const WORKER_SCRIPT = fileURLToPath(import.meta.url);
const KIND = 'chrome';

/** The worker: the offline server, one browser session, detection, screenshots, outputs. */
export async function workerMain(project, io = defaultIo) {
  const { proxyScript, cli } = await setupPaths(project);
  const origin = await projectOrigin(project);
  const server = await serveCache(project, proxyScript, freePort);
  const { prepare, consentSelectors } = await prepExpression(project);
  const browser = playwright(cli, io, project.work, sessionName(project, KIND));
  await browser.open(proxiedUrl(origin, origin, server.port), { config: server.browserConfig });
  try {
    await writeJson(runFile(project, KIND), { ...(await readRun(project, undefined, KIND)),
      state: 'analysing' });
    const port = server.port;
    const result = await analyse(project, { browser, origin, port, prepare, consentSelectors });
    const summary = {
      header: result.header.length, footer: result.footer.length,
      defects: [...result.header, ...result.footer].filter((v) => v.screenshotError).length,
    };
    await writeJson(runFile(project, KIND), { state: 'done', analysed: summary });
    return { state: 'done', analysed: summary };
  } catch (err) {
    await writeJson(runFile(project, KIND), { state: 'failed', error: err.message });
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
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
    if (!captures.length) throw new Error('no captures yet; run capture.mjs first');
    const i = argv.indexOf('--min-support');
    const minSupport = i >= 0 ? Number(argv[i + 1]) : 0.5;
    return renderCandidates(chromeCandidates(candidates(captures), { minSupport }));
  }
  if (argv[0] === '--worker') return workerMain(project, io);
  if (argv[0] === 'status') {
    return (await readRun(project, undefined, KIND)) ?? { state: 'never run' };
  }
  if (argv[0] === 'stop') {
    const run = await readRun(project, undefined, KIND);
    if (!['running', 'analysing'].includes(run?.state)) {
      return { stopped: false, reason: 'no chrome run is open' };
    }
    io.kill(run.pid, 'SIGTERM');
    return { stopped: true, pid: run.pid };
  }
  const stored = await readdir(capturesDir(project)).catch(() => []);
  if (!stored.some((f) => f.endsWith('.json'))) {
    throw new Error('the visual-tree store is empty; run capture.mjs first');
  }
  return startWorker(project, KIND, WORKER_SCRIPT, [], {}, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), resolveProject())
    .then((out) => console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

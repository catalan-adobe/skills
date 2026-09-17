#!/usr/bin/env node
// The capture step, in the background: `capture.mjs` starts one detached worker that renders
// every verified cached page through the offline cache server and stores its visual tree
// under migration/capture/ — the project's visual-tree store — then returns at once.
// Usage: node capture.mjs [--force] [--min-width 300] | status | stop   (from the project root)
// A rerun captures only the pages without a capture at that width; --force recaptures all.
import { fileURLToPath } from 'node:url';
import { projectOrigin, proxiedUrl, serveCache } from './lib/cache-server.mjs';
import {
  MIN_WIDTH, bundlePath, captureAll, pagesToCapture, prepExpression, readRun, runFile,
  startCapture, writeCaptureConfig, writeCapturesMd,
} from './lib/capture.mjs';
import { writeJson } from './lib/jobs.mjs';
import { freePort } from './lib/ports.mjs';
import { isMain, resolveProject } from './lib/project.mjs';
import { defaultIo, playwright, sessionName, setupPaths } from './lib/warm-cli.mjs';

export const HELP = `capture.mjs [--force] [--min-width ${MIN_WIDTH}]
    in the background: render every verified cached page and store its visual tree under
    capture/ (a rerun: only pages without a capture at this width; --force: all pages);
    --min-width: elements narrower than this are folded into their parent
capture.mjs status
    the run: state, done/total, failures
capture.mjs stop
    end the worker after its current page`;

const WORKER_SCRIPT = fileURLToPath(import.meta.url);

export const minWidthArg = (argv) => {
  const i = argv.indexOf('--min-width');
  return i >= 0 ? Number(argv[i + 1]) : MIN_WIDTH;
};

/** The worker: the offline server, one browser session with the bundle, every page. */
export async function workerMain(project, argv, io = defaultIo) {
  const { proxyScript, cli } = await setupPaths(project);
  const bundle = await bundlePath(project);
  const origin = await projectOrigin(project);
  const server = await serveCache(project, proxyScript, freePort);
  const config = await writeCaptureConfig(project, server.browserConfig, bundle);
  const minWidth = minWidthArg(argv);
  const urls = await pagesToCapture(project, { force: argv.includes('--force'), minWidth });
  const { prepare } = await prepExpression(project);
  let stopping = false;
  io.onSignal(() => { stopping = true; });
  const browser = playwright(cli, io, project.work, sessionName(project, 'capture'));
  await browser.open(proxiedUrl(origin, urls[0] ?? origin, server.port), { config });
  try {
    const run = await captureAll(project,
      { browser, origin, port: server.port, prepare, minWidth },
      { urls, shouldStop: () => stopping });
    await writeCapturesMd(project, { minWidth });
    return run;
  } catch (err) {
    const run = await readRun(project);
    await writeJson(runFile(project), { ...run, state: 'failed', error: err.message });
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function main(argv, project, io = defaultIo) {
  if (argv.includes('--help') || argv[0] === 'help') return HELP;
  if (argv[0] === '--worker') return workerMain(project, argv, io);
  if (argv[0] === 'status') return (await readRun(project)) ?? { state: 'never run' };
  if (argv[0] === 'stop') {
    const run = await readRun(project);
    if (run?.state !== 'running') return { stopped: false, reason: 'no capture is running' };
    io.kill(run.pid, 'SIGTERM');
    return { stopped: true, pid: run.pid, note: 'the worker finishes its current page' };
  }
  return startCapture(project, WORKER_SCRIPT,
    { force: argv.includes('--force'), minWidth: minWidthArg(argv) }, io);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2), resolveProject())
    .then((out) => console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

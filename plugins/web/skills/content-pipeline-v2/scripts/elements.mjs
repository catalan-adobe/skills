#!/usr/bin/env node
// The elements step, in the background: `elements.mjs` starts one detached worker that
// decomposes every captured page (seconds), crops the evidence for every recurring type
// through the offline cache server (minutes; only the crops not on disk yet) and writes
// migration/elements/, then returns at once.
// Usage: node elements.mjs | status | stop   (from the project root)
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectOrigin, proxiedUrl, serveCache } from './lib/cache-server.mjs';
import { prepExpression, readRun, runFile, startWorker } from './lib/capture.mjs';
import { writeEvaluation } from './lib/elements-evaluation.mjs';
import {
  buildElements, chromeSelectors, renderSection, writeOutputs,
} from './lib/elements-report.mjs';
import { seedRules } from './lib/elements-rules.mjs';
import { screenshotTypes } from './lib/elements-shots.mjs';
import { writeJson } from './lib/jobs.mjs';
import { freePort } from './lib/ports.mjs';
import { resolveProject } from './lib/project.mjs';
import { defaultIo, playwright, sessionName, setupPaths } from './lib/warm-cli.mjs';

export const HELP = `elements.mjs
    in the background: decompose every captured page over the visual-tree store, append a
    run to the previous inventory, crop the evidence for every recurring type (only what is
    missing), write elements/elements.json, elements.md, evaluation.md and the report section;
    the first run also writes elements/rules.json (empty, with the vocabulary as _example)
elements.mjs status
    the run: state, crops done/total, error
elements.mjs stop
    end the worker after its current page`;

const WORKER_SCRIPT = fileURLToPath(import.meta.url);
const KIND = 'elements';

/** The offline server and one browser session on it, for the crops. */
export async function openSession(project, io) {
  const { proxyScript, cli } = await setupPaths(project);
  const origin = await projectOrigin(project);
  const server = await serveCache(project, proxyScript, freePort);
  const { prepare } = await prepExpression(project);
  const browser = playwright(cli, io, project.work, sessionName(project, KIND));
  await browser.open(proxiedUrl(origin, origin, server.port), { config: server.browserConfig });
  return { browser, origin, port: server.port, prepare, hide: await chromeSelectors(project) };
}

/**
 * The worker: inventory first (written at once), then the crops, then the evaluation.
 * run.json ends `done`, `stopped` (a signal, honoured after the current page) or `failed`.
 */
export async function workerMain(project, io = defaultIo, open = openSession) {
  const record = async (patch) => writeJson(runFile(project, KIND),
    { ...(await readRun(project, undefined, KIND)), ...patch });
  let stopping = false;
  io.onSignal(() => { stopping = true; });
  const stop = () => { throw new Error('stopped'); };
  try {
    await mkdir(project.step('elements'), { recursive: true });
    await seedRules(project);
    const result = await writeOutputs(project, await buildElements(project));
    if (stopping) stop();
    await record({ state: 'analysing', phase: 'crops', done: 0, total: null });
    const session = await open(project, io);
    const { browser } = session;
    try {
      const shot = await screenshotTypes(project, result, {
        ...session,
        onProgress: async (done, total) => {
          await record({ done, total });
          if (stopping) stop();
        },
      });
      await writeOutputs(project, shot);
      await writeEvaluation(project, shot);
      const defects = shot.types.filter((t) => t.screenshotError).length;
      await record({ state: 'done', defects });
      return { state: 'done', defects, summary: renderSection(shot) };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    await record({ state: err.message === 'stopped' ? 'stopped' : 'failed', error: err.message });
    throw err;
  }
}

export async function main(argv, project, io = defaultIo) {
  if (argv.includes('--help') || argv[0] === 'help') return HELP;
  if (argv[0] === '--worker') return workerMain(project, io);
  if (argv[0] === 'status') {
    return (await readRun(project, undefined, KIND)) ?? { state: 'never run' };
  }
  if (argv[0] === 'stop') {
    const run = await readRun(project, undefined, KIND);
    if (!['running', 'analysing'].includes(run?.state)) {
      return { stopped: false, reason: 'no elements run is open' };
    }
    io.kill(run.pid, 'SIGTERM');
    return { stopped: true, pid: run.pid, note: 'the worker finishes its current page' };
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

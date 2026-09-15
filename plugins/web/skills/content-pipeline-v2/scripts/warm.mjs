#!/usr/bin/env node
// The cache step, always in the background: `warm.mjs` queues the approved selection as a
// job and makes sure one detached worker is running, then returns at once. The worker
// (`--worker`) takes jobs in order: proxy + browser + offline verification + cache.md.
// Usage: node warm.mjs [--pace <ms>] [--force] | status | stop   (from the project root)
// A rerun visits only the URLs not yet cached under the approved selection; --force visits all.
import { execFile, spawn } from 'node:child_process';
import { mkdir, open as openFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  claimWorker, enqueue, jobsDir, readJobs, readWorker, recordWorker, runWorker, updateJob,
} from './lib/jobs.mjs';
import { resolveProject } from './lib/project.mjs';
import { readInventory } from './lib/inventory.mjs';
import { approvedJob, pendingUrls, warm } from './lib/warm.mjs';
import { freePort } from './status.mjs';

const execFileP = promisify(execFile);
const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function setupPaths(project) {
  const setup = JSON.parse(await readFile(project.setupFile, 'utf8').catch(() => {
    throw new Error(`No ${project.setupFile}; run status.mjs setup --install first`);
  }));
  const skill = setup.skills?.['page-cache']?.path;
  const cli = setup.playwrightCli?.path;
  if (!skill || !cli) throw new Error('setup.json lacks the page-cache skill or playwright-cli');
  return { proxyScript: path.join(path.dirname(skill), 'scripts', 'page-cache.js'), cli };
}

/** Starts the page-cache proxy as a child of this process and waits until it answers. */
function proxyStarter(script, cacheDir) {
  return async ({ offline }) => {
    const port = await freePort(3001);
    const args = [
      script, '--port', String(port), '--cache', cacheDir, ...(offline ? ['--offline'] : []),
    ];
    const child = spawn('node', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    for (let i = 0; i < 50; i += 1) {
      if (child.exitCode !== null) throw new Error(`proxy exited: ${stderr.trim()}`);
      const ok = await fetch(`http://127.0.0.1:${port}/__status`).then((r) => r.ok, () => false);
      if (ok) break;
      await sleep(100);
    }
    return {
      port,
      stop: () => new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref();
      }),
    };
  };
}

/** The value playwright-cli printed for an eval: the text between `### Result` and `### Ran`. */
function evalResult(stdout) {
  const match = /### Result\s*\n([\s\S]*?)\n### Ran/.exec(stdout);
  return (match ? match[1] : stdout).trim();
}

/**
 * playwright-cli as the browser: one named session of its own (`-s=cache`), so the default
 * session stays free for whatever else runs meanwhile; one process per command.
 */
function playwright(cli) {
  const run = (...args) => execFileP(cli, ['-s=cache', ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    open: (url, { config, persistent }) => run('open', '--config', config,
      ...(persistent ? ['--persistent'] : []), url),
    goto: (url) => run('goto', url),
    eval: async (expression) => evalResult((await run('eval', expression)).stdout),
    close: () => run('close'),
  };
}

/**
 * Starts `warm.mjs --worker` detached unless one is alive. Its output goes to a log file,
 * never to our stdio: an inherited pipe would keep the caller's shell waiting.
 */
export async function ensureWorker(project, spawnImpl = spawn) {
  const { claimed, worker } = await claimWorker(project);
  if (!claimed) {
    return worker?.pid ? { ...worker, started: false }
      : { started: false, note: 'another caller is starting the worker' };
  }
  const log = await openFile(path.join(jobsDir(project), 'worker.log'), 'a');
  const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    cwd: project.root, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  child.unref();
  await log.close();
  await recordWorker(project, child.pid);
  return { pid: child.pid, started: true };
}

async function workerMain(project) {
  const { proxyScript, cli } = await setupPaths(project);
  const cacheDir = path.join(project.step('cache'), '.page-cache');
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return runWorker(project, (job, hooks) => warm(project, {
    startProxy: proxyStarter(proxyScript, cacheDir),
    browser: playwright(cli),
    pace: job.pace ?? 1500,
  }, { ...job, ...hooks }), { stopping: () => stopping });
}

async function main(argv) {
  const project = resolveProject();
  if (argv[0] === '--worker') return workerMain(project);
  if (argv[0] === 'status') {
    return { worker: await readWorker(project), jobs: await readJobs(project) };
  }
  if (argv[0] === 'stop') {
    const worker = await readWorker(project);
    if (!worker) return { stopped: false, reason: 'no worker is running' };
    process.kill(worker.pid, 'SIGTERM');
    return {
      stopped: true, pid: worker.pid,
      note: 'the worker finishes its current URL, verifies what it visited, then exits',
    };
  }
  await setupPaths(project);
  const job = await approvedJob(project);
  const urls = argv.includes('--force') ? job.urls
    : pendingUrls(await readInventory(project.step('urls')), job.urls);
  const alreadyCached = job.urls.length - urls.length;
  if (!urls.length) {
    // Recorded as a finished job so an earlier stopped or failed one no longer counts.
    const { job: complete, added } = await enqueue(project, { ...job, urls: [] });
    if (added) {
      await updateJob(project, complete.id, {
        state: 'done', done: 0, finished: new Date().toISOString(),
        note: 'every URL already stored',
      });
    }
    return {
      added: false, alreadyCached,
      note: `every URL of ${job.selection} is cached; rerun with --force to visit them again`,
    };
  }
  const pace = flag(argv, '--pace');
  const { job: queued, added } = await enqueue(project, {
    ...job, urls, ...(pace ? { pace: Number(pace) } : {}),
  });
  const worker = await ensureWorker(project);
  return {
    job: { id: queued.id, selection: queued.selection, total: queued.total, state: queued.state },
    added,
    alreadyCached,
    worker,
    next: 'status.mjs shows the cache step as running; warm.mjs status lists the jobs',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

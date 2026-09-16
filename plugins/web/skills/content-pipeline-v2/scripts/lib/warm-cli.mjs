// The cache command's adapters to the outside: the page-cache proxy as a child process,
// playwright-cli as the browser (its own named session), the detached worker, and the
// command itself. Every external call comes through `io` so tests can stand in for it.
import { execFile, spawn } from 'node:child_process';
import { mkdir, open as openFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  claimWorker, enqueue, jobsDir, readJobs, readWorker, recordWorker, runWorker, updateJob,
} from './jobs.mjs';
import { readInventory } from './inventory.mjs';
import { freePort } from './ports.mjs';
import { approvedJob, pendingUrls, warm } from './warm.mjs';

export const SESSION = 'cache';
export const WORKER_SCRIPT = fileURLToPath(new URL('../warm.mjs', import.meta.url));

export const defaultIo = {
  execFile: promisify(execFile),
  spawn,
  fetch: (...args) => fetch(...args),
  freePort,
  sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
  killDelayMs: 3000,
  now: () => new Date(),
  kill: (pid, signal) => process.kill(pid, signal),
  onSignal: (handler) => { process.on('SIGTERM', handler); process.on('SIGINT', handler); },
  execPath: process.execPath,
  workerScript: WORKER_SCRIPT,
};

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Where setup.json says the page-cache proxy script and playwright-cli are. */
export async function setupPaths(project) {
  const setup = JSON.parse(await readFile(project.setupFile, 'utf8').catch(() => {
    throw new Error(`No ${project.setupFile}; run status.mjs setup --install first`);
  }));
  const skill = setup.skills?.['page-cache']?.path;
  const cli = setup.playwrightCli?.path;
  if (!skill || !cli) throw new Error('setup.json lacks the page-cache skill or playwright-cli');
  return { proxyScript: path.join(path.dirname(skill), 'scripts', 'page-cache.js'), cli };
}

/**
 * Starts the page-cache proxy as a child process on a free port and waits until `/__status`
 * answers; a child that exits first is reported with its stderr. `stop` sends SIGTERM and
 * escalates to SIGKILL after 3 s.
 */
export function proxyStarter(script, cacheDir, io = defaultIo) {
  return async ({ offline }) => {
    const port = await io.freePort(3001);
    const args = [
      script, '--port', String(port), '--cache', cacheDir, ...(offline ? ['--offline'] : []),
    ];
    const child = io.spawn(io.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const stop = () => new Promise((resolve) => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      child.once('exit', finish);
      child.kill('SIGTERM');
      io.sleep(io.killDelayMs ?? 3000).then(() => {
        if (!finished) child.kill('SIGKILL');
        finish();
      });
    });
    let up = false;
    for (let i = 0; i < 50 && !up; i += 1) {
      if (child.exitCode !== null) throw new Error(`proxy exited: ${stderr.trim()}`);
      up = await io.fetch(`http://127.0.0.1:${port}/__status`).then((r) => r.ok, () => false);
      if (!up) await io.sleep(100);
    }
    if (!up) {
      await stop();
      throw new Error(`proxy did not answer on port ${port} within 5 s`);
    }
    return { port, stop };
  };
}

/** The value playwright-cli printed for an eval: the text between `### Result` and `### Ran`. */
export function evalResult(stdout) {
  const match = /### Result\s*\n([\s\S]*?)\n### Ran/.exec(stdout);
  return (match ? match[1] : stdout).trim();
}

/**
 * The line worth reporting from a failed playwright-cli call. execFile's message is
 * "Command failed: …" plus stderr, where the CLI's update banner drowns the real error; the
 * error itself is on stdout under a "### Error" heading.
 */
export function cliError(err, command) {
  const lines = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.split('\n')
    .map((l) => l.trim()).filter((l) => l && !/^(#|[║╔╚═])/.test(l));
  const reason = lines.find((l) => /error|fail|timeout|net::|refused/i.test(l)) ?? lines[0]
    ?? String(err.message).split('\n')[0];
  return new Error(`playwright-cli ${command}: ${reason}`);
}

/**
 * playwright-cli as the browser: one named session of its own (`-s=cache`), so the default
 * session stays free for whatever else runs meanwhile; one process per command, run from
 * `cwd` (the project's `.work/`): the CLI writes its logs and snapshots into its cwd.
 */
export function playwright(cli, io = defaultIo, cwd = process.cwd(), session = SESSION) {
  const run = (...args) => io.execFile(cli, [`-s=${session}`, ...args], {
    maxBuffer: 16 * 1024 * 1024, cwd,
  }).catch((err) => { throw cliError(err, `${args[0]} ${args.at(-1)}`); });
  return {
    open: (url, { config, persistent }) => run('open', '--config', config,
      ...(persistent ? ['--persistent'] : []), url),
    goto: (url) => run('goto', url),
    eval: async (expression) => evalResult((await run('eval', expression)).stdout),
    screenshot: (file, target) => run('screenshot', ...(target ? [target] : []),
      '--filename', file, ...(target ? [] : ['--full-page'])),
    close: () => run('close'),
  };
}

/**
 * Starts the worker detached unless one is alive or another caller is starting it. Its
 * output goes to a log file, never to our stdio: an inherited pipe would keep the caller's
 * shell waiting.
 */
export async function ensureWorker(project, io = defaultIo) {
  const { claimed, worker } = await claimWorker(project, io.now);
  if (!claimed) {
    return worker?.pid ? { ...worker, started: false }
      : { started: false, note: 'another caller is starting the worker' };
  }
  const log = await openFile(path.join(jobsDir(project), 'worker.log'), 'a');
  try {
    const child = io.spawn(io.execPath, [io.workerScript, '--worker'], {
      cwd: project.root, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    child.unref();
    await recordWorker(project, child.pid, io.now);
    return { pid: child.pid, started: true };
  } finally {
    await log.close();
  }
}

/** The worker: jobs in order, each through the real proxy and browser; stops on a signal. */
export async function workerMain(project, io = defaultIo) {
  const { proxyScript, cli } = await setupPaths(project);
  const cacheDir = path.join(project.step('cache'), '.page-cache');
  await mkdir(project.work, { recursive: true });
  let stopping = false;
  io.onSignal(() => { stopping = true; });
  return runWorker(project, (job, hooks) => warm(project, {
    startProxy: proxyStarter(proxyScript, cacheDir, io),
    browser: playwright(cli, io, project.work),
    pace: job.pace ?? 1500,
  }, { ...job, ...hooks }), { stopping: () => stopping, now: io.now });
}

/** `warm.mjs [--pace ms] [--force] | --worker | status | stop`. */
export const WARM_HELP = `warm.mjs [--pace ms] [--force]
    queue the approved selection as a background job; a rerun resumes what is left
warm.mjs status
    the jobs and the worker
warm.mjs stop
    end the worker after its current URL`;

export async function main(argv, project, io = defaultIo) {
  if (argv.includes('--help') || argv[0] === 'help') return WARM_HELP;
  if (argv[0] === '--worker') return workerMain(project, io);
  if (argv[0] === 'status') {
    return { worker: await readWorker(project), jobs: await readJobs(project) };
  }
  if (argv[0] === 'stop') {
    const worker = await readWorker(project);
    if (!worker) return { stopped: false, reason: 'no worker is running' };
    io.kill(worker.pid, 'SIGTERM');
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
    const { job: complete, added } = await enqueue(project, { ...job, urls: [] }, { now: io.now });
    if (added) {
      await updateJob(project, complete.id, {
        state: 'done', done: 0, finished: io.now().toISOString(),
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
  }, { now: io.now });
  const worker = await ensureWorker(project, io);
  return {
    job: { id: queued.id, selection: queued.selection, total: queued.total, state: queued.state },
    added,
    alreadyCached,
    worker,
    next: 'status.mjs shows the cache step as running; warm.mjs status lists the jobs',
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdir, mkdtemp, readFile, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, resolveProject } from './project.mjs';
import { writeInventory } from './inventory.mjs';
import { readJobs, readWorker } from './jobs.mjs';
import {
  cliError, ensureWorker, evalResult, main, playwright, proxyStarter, sessionName,
} from './warm-cli.mjs';

const fixture = JSON.parse(await readFile(
  fileURLToPath(new URL('./fixtures/playwright-cli-output.json', import.meta.url)), 'utf8',
));
const joined = (lines) => lines.join('\n');
const execFailure = (rec) => Object.assign(
  new Error(`Command failed: playwright-cli\n${joined(rec.stderr)}`),
  { stdout: joined(rec.stdout), stderr: joined(rec.stderr), code: rec.code },
);

test('playwright: every call runs in the cache session; eval reads recorded output', async () => {
  const calls = [];
  const cwds = new Set();
  const io = {
    execFile: async (cli, args, opts) => {
      calls.push([cli, ...args]);
      cwds.add(opts.cwd);
      return { stdout: joined(fixture.evalOk.stdout), stderr: joined(fixture.evalOk.stderr) };
    },
  };
  const browser = playwright('/bin/pw', io, '/project/migration/.work', 'cache-abc12345');
  await browser.open('http://127.0.0.1:1/', { config: 'c.json', persistent: true });
  await browser.goto('http://127.0.0.1:1/a');
  const value = await browser.eval('JSON.stringify(location.href)');
  await browser.close();
  assert.ok(calls.every((c) => c[0] === '/bin/pw' && c[1] === '-s=cache-abc12345'),
    'named session');
  assert.deepEqual([...cwds], ['/project/migration/.work'],
    'the CLI writes its logs into cwd, which must be the gitignored .work/');
  assert.deepEqual(calls[0].slice(2),
    ['open', '--config', 'c.json', '--persistent', 'http://127.0.0.1:1/']);
  assert.equal(value, '"\\"about:blank\\""', 'the CLI JSON-encodes the value once more');
});

test('playwright: a failed goto reports the real error line, not the update banner', async () => {
  const io = { execFile: async () => { throw execFailure(fixture.gotoFail); } };
  await assert.rejects(playwright('/bin/pw', io).goto('http://127.0.0.1:1/x.html'),
    /^Error: playwright-cli goto http:\/\/127\.0\.0\.1\/?.*: Error: net::ERR_UNSAFE_PORT/);
  const bannerOnly = cliError(execFailure({ ...fixture.gotoFail, stdout: [''] }), 'goto x');
  assert.match(bannerOnly.message, /^playwright-cli goto x: Command failed/);
  assert.doesNotMatch(bannerOnly.message, /Update available/);
});

test('evalResult takes the text between ### Result and ### Ran', () => {
  assert.equal(evalResult(joined(fixture.evalOk.stdout)), '"\\"about:blank\\""');
  assert.equal(evalResult('plain'), 'plain');
});

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); };
  child.unref = () => { child.unrefed = true; };
  child.pid = process.pid;
  return child;
}

test('proxyStarter: waits for /__status, passes --offline, reports an exiting child', async () => {
  const spawned = [];
  let polls = 0;
  const child = fakeChild();
  const io = {
    freePort: async () => 3456,
    execPath: '/bin/node',
    spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; },
    fetch: async () => {
      polls += 1;
      return { ok: polls >= 3, json: async () => ({ dir: '/c' }) };
    },
    sleep: async () => {},
  };
  const proxy = await proxyStarter('/skills/page-cache/scripts/page-cache.js', '/c', io)({
    offline: true,
  });
  assert.equal(proxy.port, 3456);
  assert.deepEqual(spawned[0].args,
    ['/skills/page-cache/scripts/page-cache.js', '--port', '3456', '--cache', '/c', '--offline']);
  assert.deepEqual(spawned[0].opts.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(polls, 3);
  const stopped = proxy.stop();
  child.emit('exit');
  await stopped;
  assert.deepEqual(child.killed, ['SIGTERM'], 'a child that exits on SIGTERM is not killed');

  const stubborn = fakeChild();
  const answer = async () => ({ ok: true, json: async () => ({ dir: '/c' }) });
  const slow = { ...io, spawn: () => stubborn, killDelayMs: 1, fetch: answer };
  await (await proxyStarter('/p.js', '/c', slow)({ offline: false })).stop();
  assert.deepEqual(stubborn.killed, ['SIGTERM', 'SIGKILL'], 'escalates when it does not exit');

  const mute = fakeChild();
  const silent = { ...io, spawn: () => mute, killDelayMs: 1, fetch: async () => ({ ok: false }) };
  await assert.rejects(proxyStarter('/p.js', '/c', silent)({ offline: false }),
    /proxy did not answer on port 3456 within 5 s/);
  assert.deepEqual(mute.killed, ['SIGTERM', 'SIGKILL'], 'a proxy that never answers is stopped');

  const dead = fakeChild();
  const dying = {
    ...io,
    spawn: () => dead,
    fetch: async () => {
      dead.exitCode = 1;
      dead.stderr.emit('data', 'EADDRINUSE 3456');
      return { ok: false };
    },
  };
  await assert.rejects(proxyStarter('/p.js', '/c', dying)({ offline: false }),
    /proxy exited: EADDRINUSE 3456/);
});

async function projectWithSelection(urls) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-cli-'));
  const project = resolveProject(root);
  await init({ origin: 'https://site.example/' }, project);
  await writeInventory(project.step('urls'), urls.map((url) => ({ url })));
  await mkdir(path.join(project.step('urls'), 'subsets'), { recursive: true });
  await writeFile(path.join(project.step('urls'), 'subsets', 'sel.txt'), `${urls.join('\n')}\n`);
  const data = JSON.parse(await readFile(project.projectFile, 'utf8'));
  await writeFile(project.projectFile, JSON.stringify({
    ...data, cacheSelection: ['sel'], approved: { cache: true },
  }));
  await writeFile(project.setupFile, JSON.stringify({
    skills: { 'page-cache': { path: '/skills/page-cache/SKILL.md' } },
    playwrightCli: { path: '/bin/pw' },
  }));
  return project;
}

const workerIo = (spawned) => ({
  now: () => new Date('2026-01-01T00:00:00Z'),
  execPath: '/bin/node',
  workerScript: '/skill/scripts/warm.mjs',
  kill: (pid, signal) => spawned.push({ killed: pid, signal }),
  spawn: (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return fakeChild();
  },
});

test('ensureWorker: one detached worker with stdio to the log, even for concurrent callers',
  async () => {
    const project = await projectWithSelection(['https://site.example/a']);
    const spawned = [];
    const io = workerIo(spawned);
    const results = await Promise.all([1, 2, 3].map(() => ensureWorker(project, io)));
    assert.equal(spawned.length, 1, 'one spawn');
    assert.equal(results.filter((r) => r.started).length, 1);
    const { cmd, args, opts } = spawned[0];
    assert.deepEqual([cmd, args], ['/bin/node', ['/skill/scripts/warm.mjs', '--worker']]);
    assert.equal(opts.detached, true);
    assert.equal(opts.cwd, project.root);
    assert.equal(opts.stdio[0], 'ignore');
    assert.ok(Number.isInteger(opts.stdio[1]) && opts.stdio[1] === opts.stdio[2],
      'stdout and stderr go to the log file, never inherited');
    assert.equal((await readWorker(project)).pid, process.pid);
    const again = await ensureWorker(project, io);
    assert.deepEqual([again.started, again.pid], [false, process.pid]);
    assert.equal(spawned.length, 1);
  });

test('main: queues the approved selection, resumes what is left, records a complete rerun',
  async () => {
    const urls = ['https://site.example/', 'https://site.example/a.html'];
    const project = await projectWithSelection(urls);
    const spawned = [];
    const io = workerIo(spawned);
    const first = await main(['--pace', '500'], project, io);
    assert.deepEqual([first.added, first.job.total, first.worker.started], [true, 2, true]);
    assert.equal((await readJobs(project, () => true))[0].pace, 500);
    const dup = await main([], project, io);
    assert.deepEqual([dup.added, dup.worker.started], [false, false], 'same open job, same worker');
    const status = await main(['status'], project, io);
    assert.equal(status.jobs.length, 1);
    const stopped = await main(['stop'], project, io);
    assert.equal(stopped.stopped, true);
    assert.deepEqual(spawned.at(-1), { killed: process.pid, signal: 'SIGTERM' });

    await writeInventory(project.step('urls'), urls.map((url) => ({
      url, cache: { path: 'x', selection: 'sel' },
    })));
    const { clearJobs } = await import('./jobs.mjs');
    await clearJobs(project);
    const nothing = await main([], project, io);
    assert.equal(nothing.added, false);
    assert.match(nothing.note, /every URL of sel is cached; rerun with --force/);
    const jobs = await readJobs(project);
    assert.deepEqual([jobs.at(-1).state, jobs.at(-1).note], ['done', 'every URL already stored']);
    const forced = await main(['--force'], project, io);
    assert.deepEqual([forced.added, forced.job.total, forced.alreadyCached], [true, 2, 0]);
  });

test('main: stop with no worker says so; a missing setup.json is the first error', async () => {
  const project = await projectWithSelection(['https://site.example/']);
  assert.deepEqual(await main(['stop'], project, workerIo([])),
    { stopped: false, reason: 'no worker is running' });
  const bare = resolveProject(await mkdtemp(path.join(os.tmpdir(), 'cpv2-cli-')));
  await assert.rejects(main([], bare, workerIo([])), /run status\.mjs setup --install first/);
});

test('sessionName is per project and per kind, so two projects never share a session', () => {
  const a = sessionName({ root: '/a' }, 'chrome');
  const b = sessionName({ root: '/b' }, 'chrome');
  assert.match(a, /^chrome-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(a, sessionName({ root: '/a' }, 'chrome'));
  assert.notEqual(a, sessionName({ root: '/a' }, 'cache'));
});

test('proxyStarter refuses a port where another project\'s proxy answers', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit'); };
  const io = {
    freePort: async () => 3005, execPath: 'node', spawn: () => child, killDelayMs: 1,
    fetch: async () => ({ ok: true, json: async () => ({ dir: '/someone/elses/cache' }) }),
    sleep: async () => {},
  };
  await assert.rejects(proxyStarter('/p.js', '/c', io)({ offline: false }),
    /port 3005 is held by another cache proxy \(\/someone\/elses\/cache\)/);
});

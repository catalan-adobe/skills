import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  access, mkdir, mkdtemp, readFile, writeFile, symlink,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProject } from './project.mjs';
import { setup } from '../status.mjs';

const execFileP = promisify(execFile);
const cliPath = fileURLToPath(new URL('../status.mjs', import.meta.url));

async function cli(cwd, ...args) {
  let options = { cwd };
  if (args.length && typeof args[args.length - 1] === 'object') {
    options = { cwd, ...args.pop() };
  }
  const { stdout } = await execFileP('node', [cliPath, ...args], options);
  try { return JSON.parse(stdout); } catch { return stdout; }
}

const fresh = () => mkdtemp(path.join(os.tmpdir(), 'cpv2-'));
const byId = (result) => Object.fromEntries(result.steps.map((s) => [s.id, s]));

// A PATH containing only a `node` symlink: real system PATH entries carry a real
// playwright-cli/upskill on this machine, which would defeat the "nothing installed yet"
// setup tests below. Built once and reused; only `node` needs to resolve through it.
const NODE_ONLY_DIR = await mktempNodeOnlyDir();

async function mktempNodeOnlyDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cpv2-node-only-'));
  await symlink(process.execPath, path.join(dir, 'node'));
  return dir;
}

// Isolates HOME too: detect() falls back to `~/.agents/skills`, and the machine running
// this suite may have the real skills already installed there (e.g. via `upskill`).
async function isolatedEnv(overrides = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cpv2-home-'));
  return {
    ...process.env, PATH: NODE_ONLY_DIR, HOME: home, ...overrides,
  };
}

/** Fakes every precondition `setup`'s detect() looks for, so its done-check passes. */
async function fakeSetupOk(cwd) {
  const work = path.join(cwd, 'migration', '.work', 'node_modules');
  await mkdir(path.join(work, '.bin'), { recursive: true });
  await writeFile(path.join(work, '.bin', 'playwright-cli'), '#!/bin/sh\n');
  await mkdir(path.join(work, 'franklin-bulk-shared'), { recursive: true });
  await writeFile(path.join(work, 'franklin-bulk-shared', 'package.json'), '{}');
  for (const name of ['browser-probe', 'page-prep', 'site-scan', 'page-cache']) {
    const dir = path.join(cwd, '.agents', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '# stub\n');
  }
}

test('status refuses before init and names the command to run', async () => {
  const cwd = await fresh();
  const err = await cli(cwd).catch((e) => e);
  assert.equal(err.code, 1);
  assert.match(err.stderr, /No project at .*migration\/project\.json; run status\.mjs init/);
});

test('init creates the project once; a second init keeps it', async () => {
  const cwd = await fresh();
  const first = await cli(cwd, 'init', '--origin', 'https://example.com/');
  assert.equal(first.created, true);
  const data = JSON.parse(await readFile(path.join(cwd, 'migration/project.json'), 'utf8'));
  assert.equal(data.origin, 'https://example.com/');
  assert.equal(data.cacheAllUpTo, 500);
  assert.match(await readFile(path.join(cwd, 'migration/.gitignore'), 'utf8'), /\.work\//);
  const second = await cli(cwd, 'init', '--origin', 'https://other.example/');
  assert.equal(second.created, false);
  assert.equal(second.data.origin, 'https://example.com/');
  const bad = await cli(cwd, 'init').catch((e) => e);
  assert.match(bad.stderr, /init needs --origin/);
});

test('status follows the artefacts on disk; approve opens the operator gate', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  let s = byId(await cli(cwd));
  assert.equal(s.setup.state, 'ready');
  assert.equal(s.probe.state, 'blocked');
  assert.deepEqual(s.probe.blockedBy, ['setup']);
  const m = path.join(cwd, 'migration');
  await fakeSetupOk(cwd);
  s = byId(await cli(cwd));
  assert.equal(s.probe.state, 'ready');
  assert.equal(s.scan.state, 'ready');
  assert.equal(s.prep.state, 'blocked');
  for (const dir of ['probe', 'prep', 'urls']) await mkdir(path.join(m, dir), { recursive: true });
  await writeFile(path.join(m, 'probe/browser-recipe.json'), '{"engine":"chromium"}');
  await writeFile(path.join(m, 'probe/probe.md'), 'x');
  await writeFile(path.join(m, 'prep/page-prep.json'), JSON.stringify({
    checked: ['https://example.com/'], overlays: [],
  }));
  await writeFile(path.join(m, 'prep/prep.md'), 'x');
  await writeFile(
    path.join(m, 'urls/urls.json'),
    JSON.stringify([{ url: 'https://example.com/' }]),
  );
  await writeFile(path.join(m, 'urls/urls.md'), 'x');
  s = byId(await cli(cwd));
  assert.equal(s.cache.state, 'waiting-operator');
  assert.equal(s.report.state, 'ready');
  await cli(cwd, 'approve', 'cache');
  s = byId(await cli(cwd));
  assert.equal(s.cache.state, 'ready');
  const noGate = await cli(cwd, 'approve', 'probe').catch((e) => e);
  assert.match(noGate.stderr, /needs no approval/);
  const text = await cli(cwd, '--text');
  assert.match(text, /^step\s+state/);
  assert.match(text, /cache\s+ready/);
  assert.match(text, /medium\s+via page-prep/);
});

test('approve cache <subset> persists the selection so check cache scopes to it', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const m = path.join(cwd, 'migration');
  const project = JSON.parse(await readFile(path.join(m, 'project.json'), 'utf8'));
  project.cacheAllUpTo = 1;
  await writeFile(path.join(m, 'project.json'), JSON.stringify(project, null, 2));
  await mkdir(path.join(m, 'urls'), { recursive: true });
  const entries = [
    { url: 'https://example.com/blog/a', level1: 'blog' },
    { url: 'https://example.com/blog/b', level1: 'blog' },
    { url: 'https://example.com/blog/c', level1: 'blog' },
    { url: 'https://example.com/docs/a', level1: 'docs' },
  ];
  await writeFile(path.join(m, 'urls/urls.json'), JSON.stringify(entries));
  const prop = await cli(cwd, 'urls');
  assert.equal(prop.all, false);
  assert.equal(prop.groups[0].prefix, 'blog');

  const approved = await cli(cwd, 'approve', 'cache', 'blog');
  assert.deepEqual(approved.cacheSelection, ['blog']);
  const data = JSON.parse(await readFile(path.join(m, 'project.json'), 'utf8'));
  assert.deepEqual(data.cacheSelection, ['blog']);

  await mkdir(path.join(m, 'cache'), { recursive: true });
  await writeFile(
    path.join(m, 'cache/cache.md'),
    '| https://example.com/blog/a | cached |\n'
    + '| https://example.com/blog/b | cached |\n'
    + '| https://example.com/blog/c | skipped |\n',
  );
  const passing = await cli(cwd, 'check', 'cache');
  assert.equal(passing.pass, true);

  await writeFile(
    path.join(m, 'cache/cache.md'),
    '| https://example.com/blog/a | cached |\n'
    + '| https://example.com/blog/b | cached |\n',
  );
  const failing = await cli(cwd, 'check', 'cache').catch((e) => e);
  assert.equal(failing.code, 1);
  assert.deepEqual(JSON.parse(failing.stdout).reasons, [
    'migration/cache/cache.md has no row for https://example.com/blog/c',
  ]);
});

test('check reports the missing artefacts and exits 1', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const failing = await cli(cwd, 'check', 'probe').catch((e) => e);
  assert.equal(failing.code, 1);
  const out = JSON.parse(failing.stdout);
  assert.equal(out.pass, false);
  assert.deepEqual(out.reasons, [
    'missing migration/probe/browser-recipe.json', 'missing migration/probe/probe.md',
  ]);
  const unknown = await cli(cwd, 'check', 'nope').catch((e) => e);
  assert.match(unknown.stderr, /Unknown step "nope"/);
});

test('a step is done only once its content check passes, not existence alone', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const m = path.join(cwd, 'migration');
  await fakeSetupOk(cwd);
  await mkdir(path.join(m, 'urls'), { recursive: true });
  await writeFile(path.join(m, 'urls/urls.json'), '[]');
  await writeFile(path.join(m, 'urls/urls.md'), 'x');
  let s = byId(await cli(cwd));
  assert.equal(s.scan.state, 'ready');
  await writeFile(
    path.join(m, 'urls/urls.json'),
    JSON.stringify([{ url: 'https://example.com/' }]),
  );
  s = byId(await cli(cwd));
  assert.equal(s.scan.state, 'done');
});

const NPM_STUB = `#!/usr/bin/env node
process.stderr.write('npm ERR! simulated network failure\\n');
process.exit(1);
`;

const NPX_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const name = args[args.indexOf('--skill') + 1];
const dir = path.join(process.cwd(), '.agents', 'skills', name);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'SKILL.md'), '# stub\\n');
`;

/** A PATH dir with stub `npm` (always fails) and `npx` (writes the skill stub, always ok). */
async function stubInstallerBin(cwd) {
  const bin = path.join(cwd, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'npm'), NPM_STUB, { mode: 0o755 });
  await writeFile(path.join(bin, 'npx'), NPX_STUB, { mode: 0o755 });
  return bin;
}

const SKILL_NAMES = ['browser-probe', 'page-prep', 'site-scan', 'page-cache'];

test('setup on a fresh project reports every missing precondition; writes setup.json', async () => {
  const cwd = await fresh();
  const env = await isolatedEnv();
  const failing = await cli(cwd, 'setup', { env }).catch((e) => e);
  assert.equal(failing.code, 1);
  const out = JSON.parse(failing.stdout);
  assert.deepEqual(out.installs, []);
  assert.ok(out.reasons.includes('playwright-cli not found'));
  assert.ok(out.reasons.includes('package franklin-bulk-shared not found'));
  for (const name of SKILL_NAMES) {
    assert.ok(out.reasons.includes(`skill ${name} not found`), name);
  }
  const onDisk = JSON.parse(await readFile(path.join(cwd, 'migration/setup.json'), 'utf8'));
  assert.deepEqual(onDisk, out.detection);
});

test('setup reports Node < 22 with the message; --install then runs no installer', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const project = resolveProject(cwd);
  const failing = await setup({ shouldInstall: false, nodeVersion: '18.0.0' }, project);
  assert.equal(failing.reasons[0], 'install Node >= 22; nothing else can proceed');
  assert.deepEqual(failing.detection.node, { ok: false, version: '18.0.0' });
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;

  const calls = [];
  const exec = async (...args) => { calls.push(args); return { ok: true }; };
  const installing = await setup({ shouldInstall: true, nodeVersion: '18.0.0', exec }, project);
  assert.deepEqual(calls, [], 'Node < 22 must never trigger a project-scope install');
  assert.equal(installing.installs.length, 1);
  assert.equal(installing.installs[0].target, 'node');
  assert.match(installing.installs[0].error, /install Node >= 22/);
  process.exitCode = 0;
  const workExists = await access(path.join(cwd, 'migration', '.work')).then(
    () => true,
    () => false,
  );
  assert.equal(workExists, false);
});

test('setup --install returns each installer\'s outcome, keeps going after a failure', async () => {
  const cwd = await fresh();
  const bin = await stubInstallerBin(cwd);
  const env = await isolatedEnv({ PATH: `${bin}${path.delimiter}${NODE_ONLY_DIR}` });
  const failing = await cli(cwd, 'setup', '--install', { env }).catch((e) => e);
  assert.equal(failing.code, 1);
  const out = JSON.parse(failing.stdout);

  const pw = out.installs.find((r) => r.target === 'playwrightCli');
  assert.equal(pw.ok, false);
  assert.match(pw.error, /npm ERR! simulated network failure/);
  const pkg = out.installs.find((r) => r.target === 'franklin-bulk-shared');
  assert.equal(pkg.ok, false);
  assert.match(pkg.error, /npm ERR! simulated network failure/);
  assert.ok(out.reasons.includes('playwright-cli not found'));
  assert.ok(out.reasons.includes('package franklin-bulk-shared not found'));

  for (const name of SKILL_NAMES) {
    const entry = out.installs.find((r) => r.target === `skill:${name}`);
    assert.deepEqual(entry.command, [
      'npx', '-y', 'upskill', 'adobe/skills', '--path', 'plugins/web/skills', '--skill', name,
    ]);
    assert.equal(entry.ok, true, name);
    assert.ok(!out.reasons.includes(`skill ${name} not found`), name);
  }

  const skillFile = path.join(cwd, '.agents', 'skills', 'browser-probe', 'SKILL.md');
  assert.match(await readFile(skillFile, 'utf8'), /stub/);
});

test('check setup re-detects instead of trusting setup.json', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const env = await isolatedEnv();

  const setupOut = JSON.parse(
    (await cli(cwd, 'setup', { env }).catch((e) => e)).stdout,
  );
  const freshCheck = await cli(cwd, 'check', 'setup', { env }).catch((e) => e);
  assert.equal(freshCheck.code, 1);
  const freshOut = JSON.parse(freshCheck.stdout);
  assert.equal(freshOut.pass, false);
  assert.deepEqual(freshOut.reasons, setupOut.reasons);

  // A hand-written setup.json claiming every precondition is met must not be trusted:
  // check setup re-runs detect() and still finds the real, missing preconditions.
  const fakeSkill = { ok: true, path: '/fake/SKILL.md' };
  const allOk = {
    node: { ok: true, version: process.version.slice(1) },
    playwrightCli: { ok: true, path: '/fake/playwright-cli' },
    packages: { 'franklin-bulk-shared': { ok: true, path: '/fake/package.json' } },
    skills: Object.fromEntries(SKILL_NAMES.map((name) => [name, fakeSkill])),
  };
  await writeFile(path.join(cwd, 'migration/setup.json'), JSON.stringify(allOk, null, 2));
  const stillFailing = await cli(cwd, 'check', 'setup', { env }).catch((e) => e);
  assert.equal(stillFailing.code, 1);
  assert.equal(JSON.parse(stillFailing.stdout).pass, false);

  await fakeSetupOk(cwd);
  const passing = await cli(cwd, 'check', 'setup', { env });
  assert.equal(passing.pass, true);
  assert.deepEqual(passing.reasons, []);
});

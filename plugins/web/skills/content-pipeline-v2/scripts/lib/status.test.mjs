import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  access, mkdir, mkdtemp, readFile, writeFile, symlink,
} from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { cacheRelativePath } from './checks.mjs';
import { resolveProject } from './project.mjs';
import { pickUrls, setup } from '../status.mjs';

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
  await writeFile(path.join(m, 'probe/probe.md'), 'Main content in initial HTML: yes.');
  await writeFile(path.join(m, 'prep/page-prep.json'), JSON.stringify({
    checked: ['https://example.com/'], overlays: [],
  }));
  await writeFile(path.join(m, 'prep/prep.md'), 'x');
  await writeFile(path.join(m, 'prep/home.png'), 'png');
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
    { url: 'https://example.com/blog/a', level1: 'blog', kind: 'page' },
    { url: 'https://example.com/blog/b', level1: 'blog', kind: 'page' },
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
  const htmlOnly = await cli(cwd, 'check', 'cache').catch((e) => e);
  assert.equal(htmlOnly.code, 1, 'no bodies on disk yet');
  for (const u of ['https://example.com/blog/a', 'https://example.com/blog/b']) {
    const body = path.join(m, 'cache/.page-cache', cacheRelativePath(u));
    await mkdir(path.dirname(body), { recursive: true });
    await writeFile(body, '<html></html>');
    await writeFile(`${body}.json`, '{"status":200,"headers":{}}');
  }
  const stillHtmlOnly = await cli(cwd, 'check', 'cache').catch((e) => e);
  assert.match(stillHtmlOnly.stdout, /warmed without a browser/);
  await writeFile(path.join(m, 'cache/.page-cache/example.com_x.css'), 'body{}');
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

test('setup --install records --skills-repo and --skills-ref in project.json for later runs',
  async () => {
    const cwd = await fresh();
    await cli(cwd, 'init', '--origin', 'https://example.com/');
    const project = resolveProject(cwd);
    const calls = [];
    const exec = async (file, args) => { calls.push([file, ...args]); return { ok: false }; };
    await setup({
      shouldInstall: true, nodeVersion: '24.0.0', exec,
      skillsRepo: 'someone/skills', skillsRef: 'wip',
    }, project);
    process.exitCode = 0;
    const data = JSON.parse(await readFile(path.join(cwd, 'migration/project.json'), 'utf8'));
    assert.deepEqual(data.skills, { repo: 'someone/skills', ref: 'wip' });
    assert.ok(calls.some((c) => c.includes('someone/skills') && c.includes('wip')));
    const again = [];
    await setup({
      shouldInstall: true,
      nodeVersion: '24.0.0',
      exec: async (f, a) => { again.push([f, ...a]); return { ok: false }; },
    }, project);
    process.exitCode = 0;
    assert.ok(again.some((c) => c.includes('someone/skills')), 'the recorded repo is reused');
  });

test('pick answers from urls.json through the CLI with the reachability check injected',
  async () => {
    const cwd = await fresh();
    await cli(cwd, 'init', '--origin', 'https://example.com/');
    const project = resolveProject(cwd);
    await mkdir(path.join(cwd, 'migration/urls'), { recursive: true });
    await writeFile(path.join(cwd, 'migration/urls/urls.json'), JSON.stringify([
      { url: 'https://example.com/' },
      { url: 'https://example.com/a/1' }, { url: 'https://example.com/a/2' },
      { url: 'https://example.com/b/1' },
    ]));
    const picks = await pickUrls(project, {
      count: 2, exclude: ['https://example.com/'], reachable: async () => true,
    });
    assert.deepEqual(picks.map((p) => [p.group, p.count]), [['a', 2], ['b', 1]]);
    const empty = await fresh();
    await cli(empty, 'init', '--origin', 'https://example.com/');
    const noList = await cli(empty, 'pick', '--count', '1').catch((e) => e);
    assert.equal(noList.code, 1);
    assert.match(noList.stderr, /missing migration\/urls\/urls\.json; run the scan step first/);
  });

test('init records --skills-repo and --skills-ref; every command rejects unknown flags',
  async () => {
    const cwd = await fresh();
    const out = await cli(cwd, 'init', '--origin', 'https://example.com/',
      '--skills-repo', 'someone/skills', '--skills-ref', 'wip');
    assert.deepEqual(out.data.skills, { repo: 'someone/skills', ref: 'wip' });
    const project = resolveProject(cwd);
    const calls = [];
    await setup({
      shouldInstall: true, nodeVersion: '24.0.0',
      exec: async (f, a) => { calls.push([f, ...a]); return { ok: false }; },
    }, project);
    process.exitCode = 0;
    assert.ok(calls.some((c) => c.includes('someone/skills') && c.includes('wip')),
      'setup reuses what init recorded');
    for (const args of [
      ['init', '--origin', 'https://example.com/', '--skill-repo', 'x'],
      ['setup', '--instal'],
      ['--txt'],
      ['pick', '--count', '2', '--excluded', 'u'],
    ]) {
      const err = await cli(cwd, ...args).catch((e) => e);
      assert.equal(err.code, 1, args.join(' '));
      assert.match(err.stderr, /Unknown flag/, args.join(' '));
    }
  });

test('setup writes its own "## setup" section into REPORT.md, once', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const project = resolveProject(cwd);
  await setup({ shouldInstall: false, nodeVersion: '24.0.0' }, project);
  await setup({ shouldInstall: false, nodeVersion: '24.0.0' }, project);
  process.exitCode = 0;
  const report = await readFile(path.join(cwd, 'migration/REPORT.md'), 'utf8');
  assert.equal((report.match(/^## setup$/gm) ?? []).length, 1);
  assert.match(report, /Node 24\.0\.0/);
  assert.match(report, /skill browser-probe not found/);
});

test('free-port answers a port nothing listens on, from the requested start', async () => {
  const cwd = await fresh();
  const out = await cli(cwd, 'free-port', '--from', '3001');
  assert.ok(Number.isInteger(out.port) && out.port >= 3001, JSON.stringify(out));
  const srv = createServer();
  await new Promise((r) => srv.listen(out.port, '127.0.0.1', r));
  try {
    const next = await cli(cwd, 'free-port', '--from', String(out.port));
    assert.ok(next.port > out.port, 'the busy port is skipped');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('approve cache needs an explicit selection over the threshold; "all" must be typed',
  async () => {
    const cwd = await fresh();
    await cli(cwd, 'init', '--origin', 'https://example.com/');
    const m = path.join(cwd, 'migration');
    const project = JSON.parse(await readFile(path.join(m, 'project.json'), 'utf8'));
    await writeFile(path.join(m, 'project.json'), JSON.stringify({ ...project, cacheAllUpTo: 2 }));
    await mkdir(path.join(m, 'urls/subsets'), { recursive: true });
    await writeFile(path.join(m, 'urls/urls.json'), JSON.stringify([
      { url: 'https://example.com/a/1' }, { url: 'https://example.com/a/2' },
      { url: 'https://example.com/b/1' },
    ]));
    await writeFile(path.join(m, 'urls/subsets/a.txt'), 'https://example.com/a/1\n');
    const bare = await cli(cwd, 'approve', 'cache').catch((e) => e);
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /3 URLs exceed cacheAllUpTo 2/);
    assert.match(bare.stderr, /subsets: a/);
    assert.match(bare.stderr, /approve cache all/);
    const named = await cli(cwd, 'approve', 'cache', 'a');
    assert.deepEqual(named.cacheSelection, ['a']);
    const all = await cli(cwd, 'approve', 'cache', 'all');
    assert.equal(all.cacheSelection, 'all');
    const missing = await cli(cwd, 'approve', 'cache', 'nope').catch((e) => e);
    assert.match(missing.stderr, /no subset file urls\/subsets\/nope\.txt/);
  });

test('approve cache with no selection under the threshold means all', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const m = path.join(cwd, 'migration');
  await mkdir(path.join(m, 'urls'), { recursive: true });
  const one = JSON.stringify([{ url: 'https://example.com/' }]);
  await writeFile(path.join(m, 'urls/urls.json'), one);
  assert.equal((await cli(cwd, 'approve', 'cache')).cacheSelection, 'all');
});

test('pick --write builds a subset file of N pages that approve cache accepts', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const project = resolveProject(cwd);
  await mkdir(path.join(cwd, 'migration/urls'), { recursive: true });
  await writeFile(path.join(cwd, 'migration/urls/urls.json'), JSON.stringify([
    { url: 'https://example.com/' },
    { url: 'https://example.com/a/1' }, { url: 'https://example.com/a/2' },
    { url: 'https://example.com/b/1' }, { url: 'https://example.com/b/doc.pdf' },
  ]));
  const out = await pickUrls(project, {
    count: 3, exclude: [], write: 'sample', reachable: async () => true,
  });
  assert.equal(out.count, 3);
  const text = await readFile(path.join(cwd, 'migration/urls/subsets/sample.txt'), 'utf8');
  assert.deepEqual(text.trim().split('\n'), [
    'https://example.com/a/1', 'https://example.com/b/1', 'https://example.com/',
  ]);
  const approved = await cli(cwd, 'approve', 'cache', 'sample');
  assert.deepEqual(approved.cacheSelection, ['sample']);
});

test('section upserts one REPORT.md section from stdin and refuses unknown steps', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const run = (args, input) => new Promise((resolve) => {
    const child = spawn('node', [cliPath, ...args], { cwd });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
  assert.equal((await run(['section', 'probe'], 'Loads headless.\n')).code, 0);
  assert.equal((await run(['section', 'probe'], 'Loads headless, no protection.\n')).code, 0);
  const report = await readFile(path.join(cwd, 'migration/REPORT.md'), 'utf8');
  assert.equal((report.match(/^## probe$/gm) ?? []).length, 1);
  assert.match(report, /no protection/);
  assert.ok(!report.includes('Loads headless.\n'));
  const bad = await run(['section', 'nope'], 'x');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown step "nope"/);
  const empty = await run(['section', 'probe'], '   ');
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /empty/);
});

test('setup records the model the harness reports, never a guess', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const project = resolveProject(cwd);
  await setup({ shouldInstall: false, nodeVersion: '24.0.0', env: { PI_MODEL: 'some-model-1' } },
    project);
  process.exitCode = 0;
  let report = await readFile(path.join(cwd, 'migration/REPORT.md'), 'utf8');
  assert.match(report, /Model reported by the harness: some-model-1/);
  await setup({ shouldInstall: false, nodeVersion: '24.0.0', env: {} }, project);
  process.exitCode = 0;
  report = await readFile(path.join(cwd, 'migration/REPORT.md'), 'utf8');
  assert.match(report, /Model reported by the harness: unknown \(not exposed/);
});

test('section accepts "next" for the report step and check report requires it', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const project = resolveProject(cwd);
  await setup({ shouldInstall: false, nodeVersion: '24.0.0', env: {} }, project);
  process.exitCode = 0;
  const before = await cli(cwd, 'check', 'report').catch((e) => e);
  assert.equal(before.code, 1);
  assert.match(before.stdout, /no \\"## next\\" section/);
  await new Promise((resolve) => {
    const child = spawn('node', [cliPath, 'section', 'next'], { cwd });
    child.on('close', resolve);
    child.stdin.end('cache waits for approval.\n');
  });
  assert.equal((await cli(cwd, 'check', 'report')).pass, true);
});

test('section --file reads the body from a file instead of stdin', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  await writeFile(path.join(cwd, 'body.md'), 'Loads headless.\n');
  const out = await cli(cwd, 'section', 'probe', '--file', 'body.md');
  assert.equal(out.section, 'probe');
  const report = await readFile(path.join(cwd, 'migration/REPORT.md'), 'utf8');
  assert.match(report, /## probe\n\nLoads headless\./);
  const missing = await cli(cwd, 'section', 'probe', '--file', 'nope.md').catch((e) => e);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /nope\.md/);
});

test('urls merges scan.json into the inventory and import adds an operator list', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  const m = path.join(cwd, 'migration');
  await mkdir(path.join(m, 'urls'), { recursive: true });
  const entry = (url) => ({
    url, origin: 'https://example.com', status: 'valid', level1: 'a', level2: '', level3: '',
    filename: '', search: '', lang: '', message: '',
  });
  await writeFile(path.join(m, 'urls/scan.json'), JSON.stringify([
    entry('https://example.com/a/1'), entry('https://example.com/c/2'),
  ]));
  await cli(cwd, 'urls');
  let inv = JSON.parse(await readFile(path.join(m, 'urls/urls.json'), 'utf8'));
  assert.equal(inv.length, 2);
  assert.deepEqual(inv.map((r) => r.group), ['a', 'c']);
  assert.ok(inv.every((r) => r.inLastScan === true && r.firstSeen));
  inv[0].kind = 'page';
  await writeFile(path.join(m, 'urls/urls.json'), JSON.stringify(inv));
  const onlyOne = JSON.stringify([entry('https://example.com/a/1')]);
  await writeFile(path.join(m, 'urls/scan.json'), onlyOne);
  await cli(cwd, 'urls');
  inv = JSON.parse(await readFile(path.join(m, 'urls/urls.json'), 'utf8'));
  assert.equal(inv.find((r) => r.url.endsWith('/1')).kind, 'page', 'enrichment kept');
  assert.equal(inv.find((r) => r.url.endsWith('/2')).inLastScan, false, 'vanished, kept');
  await writeFile(path.join(cwd, 'list.txt'), 'https://example.com/b/1\nhttps://example.com/a/1\n');
  const imported = await cli(cwd, 'urls', 'import', 'list.txt');
  assert.deepEqual(imported, { imported: 2, total: 3 });
  inv = JSON.parse(await readFile(path.join(m, 'urls/urls.json'), 'utf8'));
  assert.equal(inv.find((r) => r.url.endsWith('/b/1')).message, 'operator-provided list');
  const bad = await cli(cwd, 'urls', 'import', 'nope.txt').catch((e) => e);
  assert.match(bad.stderr, /cannot read nope\.txt/);
});

test('status writes migration/status.json for the dashboard on status and check', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://example.com/');
  await cli(cwd);
  const file = path.join(cwd, 'migration/status.json');
  const first = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(first.origin, 'https://example.com/');
  assert.equal(first.steps.find((s) => s.id === 'setup').state, 'ready');
  assert.ok(first.generatedAt);
  await cli(cwd, 'check', 'probe').catch(() => {});
  const second = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(second.generatedAt >= first.generatedAt);
  assert.equal(second.steps.length, first.steps.length);
});

test('init installs the dashboard under tools/migration and excludes migration/ from deploy',
  async () => {
    const cwd = await fresh();
    await writeFile(path.join(cwd, '.hlxignore'), '.*\n*.md\n');
    const out = await cli(cwd, 'init', '--origin', 'https://example.com/');
    assert.deepEqual(out.dashboard, { installed: true, path: 'tools/migration' });
    for (const f of ['index.html', 'dashboard.js', 'dashboard.css']) {
      await access(path.join(cwd, 'tools/migration', f));
    }
    assert.match(await readFile(path.join(cwd, '.hlxignore'), 'utf8'), /\nmigration\/\n/);
    await writeFile(path.join(cwd, 'tools/migration/dashboard.css'), 'body { color: red }');
    const again = await cli(cwd, 'init', '--origin', 'https://example.com/');
    assert.equal(again.dashboard.installed, false, 'an existing dashboard is left alone');
    assert.equal(await readFile(path.join(cwd, 'tools/migration/dashboard.css'), 'utf8'),
      'body { color: red }');
    const ignore = await readFile(path.join(cwd, '.hlxignore'), 'utf8');
    assert.equal(ignore.match(/migration\//g).length, 1, 'the ignore line is added once');
    const noHlx = await fresh();
    const plain = await cli(noHlx, 'init', '--origin', 'https://example.com/');
    assert.equal(plain.dashboard.installed, true);
    const created = await access(path.join(noHlx, '.hlxignore')).then(() => true, () => false);
    assert.equal(created, false, 'no .hlxignore is created where none exists (not an EDS repo)');
  });

test('free-port skips ports held on the IPv4 wildcard or on loopback only', async () => {
  const { createServer } = await import('node:net');
  const { freePort } = await import('../status.mjs');
  for (const host of ['0.0.0.0', '127.0.0.1']) {
    const taken = createServer();
    await new Promise((r) => taken.listen(0, host, r));
    const { port } = taken.address();
    assert.notEqual(await freePort(port), port, `held on ${host}`);
    taken.close();
  }
});

test('a queued or running warm job holds the cache step as running and fails its check',
  async () => {
    const { enqueue, updateJob } = await import('./jobs.mjs');
    const cwd = await fresh();
    await cli(cwd, 'init', '--origin', 'https://example.com/');
    const project = resolveProject(cwd);
    const { job } = await enqueue(project, {
      selection: 'blogs', urls: ['https://example.com/a'],
    });
    await enqueue(project, { selection: 'ja-jp', urls: ['https://example.com/ja'] });
    await updateJob(project, job.id, { state: 'running', pid: process.pid, done: 0 });
    const check = await cli(cwd, 'check', 'cache').catch((e) => e);
    assert.match(check.stdout, /warm job 0\/1 \(blogs\) · queued: ja-jp/);
    assert.equal(check.code, 1);
    const out = await cli(cwd);
    const cache = out.steps.find((s) => s.id === 'cache');
    assert.equal(cache.state, 'running');
    assert.equal(cache.running, '0/1 (blogs) · queued: ja-jp');
    const text = await cli(cwd, '--text');
    assert.match(String(text), /cache\s+running\s+0\/1 \(blogs\) · queued: ja-jp/);
    await updateJob(project, job.id, { state: 'done' });
    const after = await cli(cwd);
    assert.equal(after.steps.find((s) => s.id === 'cache').state, 'running',
      'a queued job with no worker still holds the step');
    assert.equal(after.steps.find((s) => s.id === 'cache').running,
      'worker not started · queued: ja-jp');
    const jobs = await (await import('./jobs.mjs')).readJobs(project);
    await updateJob(project, jobs[1].id, { state: 'stopped', done: 0 });
    const partial = await cli(cwd, 'check', 'cache').catch((e) => e);
    assert.match(partial.stdout, /selection ja-jp is stopped at 0\/1 — approve it again/);
  });

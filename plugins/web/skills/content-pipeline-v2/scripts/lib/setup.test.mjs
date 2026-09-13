import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import {
  commandOnPath, detect, install, missingReasons, writeSetupJson, SKILL_NAMES,
} from './setup.mjs';

const CWD = '/proj';
const HOME = '/home/op';

function fakeExists(paths) {
  const set = new Set(paths);
  return async (file) => set.has(file);
}

const skillMd = (base, name) => path.join(base, '.agents', 'skills', name, 'SKILL.md');
const claudeSkillMd = (base, name) => path.join(base, '.claude', 'skills', name, 'SKILL.md');
const homeSkillMd = (name) => path.join(HOME, '.agents', 'skills', name, 'SKILL.md');
const workBin = path.join(CWD, 'migration', '.work', 'node_modules', '.bin', 'playwright-cli');
const packageJson = path.join(
  CWD, 'migration', '.work', 'node_modules', 'franklin-bulk-shared', 'package.json',
);

function allMissing() {
  return {
    nodeVersion: '22.1.0', env: { PATH: '/usr/bin' },
    cwd: CWD,
    home: HOME,
    exists: fakeExists([]),
  };
}

function allPresent() {
  const paths = [workBin, packageJson, ...SKILL_NAMES.map((n) => skillMd(CWD, n))];
  return {
    nodeVersion: '22.1.0', env: { PATH: '/usr/bin' },
    cwd: CWD,
    home: HOME,
    exists: fakeExists(paths),
  };
}

test('detect reports Node < 22 with the real version string', async () => {
  const result = await detect({
    nodeVersion: '18.19.0', cwd: CWD, home: HOME, exists: fakeExists([]),
  });
  assert.deepEqual(result.node, { ok: false, version: '18.19.0' });
});

test('detect reports Node ok at exactly 22', async () => {
  const result = await detect({
    nodeVersion: '22.0.0', cwd: CWD, home: HOME, exists: fakeExists([]),
  });
  assert.deepEqual(result.node, { ok: true, version: '22.0.0' });
});

test('detect finds playwright-cli on PATH before the project .bin', async () => {
  const onPath = path.join('/opt/bin', 'playwright-cli');
  const result = await detect({
    nodeVersion: '22.0.0', env: { PATH: '/usr/bin:/opt/bin' },
    cwd: CWD,
    home: HOME,
    exists: fakeExists([onPath, workBin]),
  });
  assert.deepEqual(result.playwrightCli, { ok: true, path: onPath });
});

test('detect falls back to the project .bin when PATH has no playwright-cli', async () => {
  const result = await detect({
    nodeVersion: '22.0.0', env: { PATH: '/usr/bin' },
    cwd: CWD,
    home: HOME,
    exists: fakeExists([workBin]),
  });
  assert.deepEqual(result.playwrightCli, { ok: true, path: workBin });
});

test('detect reports playwright-cli missing when it is nowhere', async () => {
  const result = await detect(allMissing());
  assert.deepEqual(result.playwrightCli, { ok: false, path: null });
});

test('detect finds franklin-bulk-shared under the project .work tree', async () => {
  const present = await detect({
    nodeVersion: '22.0.0', env: { PATH: '' },
    cwd: CWD,
    home: HOME,
    exists: fakeExists([packageJson]),
  });
  assert.deepEqual(present.packages, {
    'franklin-bulk-shared': { ok: true, path: packageJson },
  });
  const missing = await detect(allMissing());
  assert.deepEqual(missing.packages, {
    'franklin-bulk-shared': { ok: false, path: null },
  });
});

test('detect prefers project .agents, then .claude, then the home .agents skills dir', async () => {
  const projectFirst = await detect({
    nodeVersion: '22.0.0', env: { PATH: '' },
    cwd: CWD,
    home: HOME,
    exists: fakeExists([
      skillMd(CWD, 'browser-probe'),
      claudeSkillMd(CWD, 'browser-probe'),
      homeSkillMd('browser-probe'),
    ]),
  });
  assert.deepEqual(projectFirst.skills['browser-probe'], {
    ok: true, path: skillMd(CWD, 'browser-probe'),
  });

  const claudeOnly = await detect({
    nodeVersion: '22.0.0', env: { PATH: '' },
    cwd: CWD,
    home: HOME,
    exists: fakeExists([claudeSkillMd(CWD, 'page-prep'), homeSkillMd('page-prep')]),
  });
  assert.deepEqual(claudeOnly.skills['page-prep'], {
    ok: true, path: claudeSkillMd(CWD, 'page-prep'),
  });

  const homeOnly = await detect({
    nodeVersion: '22.0.0', env: { PATH: '' },
    cwd: CWD,
    home: HOME,
    exists: fakeExists([homeSkillMd('site-scan')]),
  });
  assert.deepEqual(homeOnly.skills['site-scan'], { ok: true, path: homeSkillMd('site-scan') });

  const none = await detect(allMissing());
  assert.deepEqual(none.skills['page-cache'], { ok: false, path: null });
});

test('detect: everything present reports every category ok with no missing reasons', async () => {
  const result = await detect(allPresent());
  assert.equal(result.node.ok, true);
  assert.equal(result.playwrightCli.ok, true);
  assert.equal(result.packages['franklin-bulk-shared'].ok, true);
  for (const name of SKILL_NAMES) assert.equal(result.skills[name].ok, true, name);
  assert.deepEqual(missingReasons(result), []);
});

test('missingReasons names Node first, then playwright-cli, the package and each skill', () => {
  const detection = {
    node: { ok: false, version: '18.0.0' },
    playwrightCli: { ok: false, path: null },
    packages: { 'franklin-bulk-shared': { ok: false, path: null } },
    skills: { 'browser-probe': { ok: false, path: null }, 'page-prep': { ok: true, path: 'x' } },
  };
  assert.deepEqual(missingReasons(detection), [
    'install Node >= 22; nothing else can proceed',
    'playwright-cli not found',
    'package franklin-bulk-shared not found',
    'skill browser-probe not found',
  ]);
});

test('commandOnPath finds a name in a PATH directory and null otherwise', async () => {
  const found = await commandOnPath('upskill', {
    env: { PATH: '/usr/bin:/opt/bin' }, exists: fakeExists(['/opt/bin/upskill']),
  });
  assert.equal(found, '/opt/bin/upskill');
  const missing = await commandOnPath('upskill', {
    env: { PATH: '/usr/bin' }, exists: fakeExists([]),
  });
  assert.equal(missing, null);
});

function recordingExec(fail = new Set()) {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (fail.has(file)) throw new Error(`${file} exited 1`);
    return { stdout: '' };
  };
  return { exec, calls };
}

test('install does nothing and never calls exec when everything is already ok', async () => {
  const { exec, calls } = recordingExec();
  const detection = await detect(allPresent());
  const results = await install(detection, { exec, cwd: CWD, hasUpskill: true });
  assert.deepEqual(results, []);
  assert.deepEqual(calls, []);
});

test('install stops at Node and never runs a command when Node is missing', async () => {
  const { exec, calls } = recordingExec();
  const detection = await detect(allMissing());
  detection.node = { ok: false, version: '18.0.0' };
  const results = await install(detection, { exec, cwd: CWD, hasUpskill: true });
  assert.deepEqual(results, [{
    target: 'node', command: [], ok: false, error: 'install Node >= 22; nothing else can proceed',
  }]);
  assert.deepEqual(calls, []);
});

test('install runs project-scope npm installs for playwright-cli and the package', async () => {
  const { exec, calls } = recordingExec();
  const detection = await detect(allMissing());
  const results = await install(detection, { exec, cwd: CWD, hasUpskill: true });
  const work = path.join(CWD, 'migration', '.work');

  const pw = results.find((r) => r.target === 'playwrightCli');
  assert.deepEqual(pw.command, ['npm', 'install', '--prefix', work, '@playwright/cli']);
  const pkg = results.find((r) => r.target === 'franklin-bulk-shared');
  assert.deepEqual(pkg.command, ['npm', 'install', '--prefix', work, 'franklin-bulk-shared']);
  for (const r of results) assert.equal(r.ok, true, r.target);

  for (const call of calls) {
    assert.ok(!call.args.includes('-g'), `no global install: ${call.args.join(' ')}`);
    assert.ok(!call.args.includes('--global'), `no global install: ${call.args.join(' ')}`);
  }
});

test('install calls upskill directly for each missing skill when it is on PATH', async () => {
  const { exec, calls } = recordingExec();
  const detection = await detect(allMissing());
  const results = await install(detection, { exec, cwd: CWD, hasUpskill: true });
  for (const name of SKILL_NAMES) {
    const entry = results.find((r) => r.target === `skill:${name}`);
    assert.deepEqual(entry.command, [
      'upskill', 'adobe/skills', '--path', 'plugins/web/skills', '--skill', name,
    ]);
  }
  const skillCalls = calls.filter((c) => c.file === 'upskill');
  assert.equal(skillCalls.length, SKILL_NAMES.length);
  for (const call of skillCalls) assert.deepEqual(call.options, { cwd: CWD });
});

test('install runs npx -y upskill for a missing skill when upskill is not on PATH', async () => {
  const { exec, calls } = recordingExec();
  const detection = await detect(allMissing());
  const results = await install(detection, { exec, cwd: CWD, hasUpskill: false });
  const entry = results.find((r) => r.target === 'skill:browser-probe');
  assert.deepEqual(entry.command, [
    'npx', '-y', 'upskill', 'adobe/skills', '--path', 'plugins/web/skills', '--skill',
    'browser-probe',
  ]);
  assert.ok(calls.every((c) => c.file !== 'upskill'));
});

test('install records a failed command and keeps installing the rest', async () => {
  const { exec } = recordingExec(new Set(['npm']));
  const detection = await detect(allMissing());
  const results = await install(detection, { exec, cwd: CWD, hasUpskill: true });
  const pw = results.find((r) => r.target === 'playwrightCli');
  assert.equal(pw.ok, false);
  assert.match(pw.error, /npm exited 1/);
  const skillResult = results.find((r) => r.target === 'skill:browser-probe');
  assert.equal(skillResult.ok, true);
});

test('writeSetupJson writes the resolved detection to migration/setup.json', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cpv2-setup-'));
  const project = {
    dir: path.join(cwd, 'migration'),
    setupFile: path.join(cwd, 'migration', 'setup.json'),
  };
  const detection = await detect({
    nodeVersion: '22.0.0', env: { PATH: '' }, cwd, home: HOME, exists: fakeExists([]),
  });
  const written = await writeSetupJson(project, detection);
  assert.equal(written, detection);
  const onDisk = JSON.parse(await readFile(project.setupFile, 'utf8'));
  assert.deepEqual(onDisk, detection);
});

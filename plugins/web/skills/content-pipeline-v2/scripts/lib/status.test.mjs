import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const cliPath = fileURLToPath(new URL('../status.mjs', import.meta.url));

async function cli(cwd, ...args) {
  const { stdout } = await execFileP('node', [cliPath, ...args], { cwd });
  try { return JSON.parse(stdout); } catch { return stdout; }
}

const fresh = () => mkdtemp(path.join(os.tmpdir(), 'cpv2-'));
const byId = (result) => Object.fromEntries(result.steps.map((s) => [s.id, s]));

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
  await writeFile(path.join(m, 'setup.json'), '{}');
  s = byId(await cli(cwd));
  assert.equal(s.probe.state, 'ready');
  assert.equal(s.scan.state, 'ready');
  assert.equal(s.prep.state, 'blocked');
  for (const dir of ['probe', 'prep', 'urls']) await mkdir(path.join(m, dir), { recursive: true });
  for (const f of ['probe/browser-recipe.json', 'probe/probe.md', 'prep/page-prep.json',
    'prep/prep.md', 'urls/urls.json', 'urls/urls.md']) {
    await writeFile(path.join(m, f), 'x');
  }
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

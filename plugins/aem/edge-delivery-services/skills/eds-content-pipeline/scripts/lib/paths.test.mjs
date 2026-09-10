// paths.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths } from './paths.mjs';

async function fakeRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-repo-'));
  await mkdir(path.join(repo, 'migration', 'data'), { recursive: true });
  await writeFile(path.join(repo, 'migration', 'site.config.json'), '{}');
  return repo;
}

test('finds migration/ by walking up from cwd', async () => {
  const repo = await fakeRepo();
  const p = resolvePaths({}, path.join(repo, 'blocks', 'hero'));
  assert.equal(p.repoRoot, repo);
  assert.equal(p.projectDir, path.join(repo, 'migration'));
  assert.equal(p.dataDir, path.join(repo, 'migration', 'data'));
  assert.equal(p.siteDir, p.projectDir);
  assert.equal(p.configPath, path.join(repo, 'migration', 'site.config.json'));
  assert.equal(p.cacheDir, path.join(repo, '.migration-cache'));
  assert.equal(p.stateFile('urls'), path.join(p.dataDir, 'urls.json'));
  assert.equal(p.ledgerFile('runs'), path.join(p.dataDir, 'ledger', 'runs.jsonl'));
});

test('MIGRATION_PROJECT_DIR overrides discovery', async () => {
  const repo = await fakeRepo();
  const p = resolvePaths(
    { MIGRATION_PROJECT_DIR: path.join(repo, 'migration') },
    os.tmpdir()
  );
  assert.equal(p.projectDir, path.join(repo, 'migration'));
  assert.equal(p.repoRoot, repo);
});

test('MIGRATION_DATA_DIR alone works without a project (ported tests)', () => {
  const p = resolvePaths({ MIGRATION_DATA_DIR: '/tmp/x' }, os.tmpdir());
  assert.equal(p.dataDir, '/tmp/x');
  assert.equal(p.stateFile('a'), '/tmp/x/a.json');
});

test('skillRoot is the skill directory', () => {
  const p = resolvePaths({ MIGRATION_DATA_DIR: '/tmp/x' }, os.tmpdir());
  assert.ok(p.skillRoot.endsWith(path.join('skills', 'eds-content-pipeline')));
});

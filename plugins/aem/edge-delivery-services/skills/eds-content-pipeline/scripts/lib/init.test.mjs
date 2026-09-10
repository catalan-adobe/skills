import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkPreconditions, writeProject } from './init.mjs';
import { loadConfig } from './config.mjs';

const execFileP = promisify(execFile);

async function edsRepo() {
  const repo = await mkdtemp(
    path.join(os.tmpdir(), 'ecp-init-'),
  );
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await writeFile(path.join(repo, 'scripts', 'aem.js'), '');
  await writeFile(path.join(repo, 'head.html'), '');
  return repo;
}

test('preconditions name what is missing with an install hint', async () => {
  const repo = await edsRepo();
  const checks = await checkPreconditions(
    repo,
    {
      env: {},
      which: async () => null,
      token: async () => { throw new Error('no'); },
    },
  );
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName['eds-repo'].ok, true);
  assert.equal(byName['page-tree'].ok, false);
  assert.match(
    byName['page-tree'].hint,
    /upskill adobe\/skills.*page-tree/,
  );
  assert.equal(byName['playwright-cli'].ok, false);
  assert.equal(byName['da-token'].ok, false);
});

test(
  'writeProject creates migration/ and appends .hlxignore idempotently',
  async () => {
    const repo = await edsRepo();
    const opts = {
      origin: 'https://www.example.com',
      sitemap: 'https://www.example.com/sitemap.xml',
      daOrg: 'o',
      daSite: 's',
      daRef: 'main',
      include: ['^/de/'],
    };
    const first = await writeProject(repo, opts);
    assert.ok(
      first.created.includes('migration/site.config.json'),
    );
    const config = JSON.parse(
      await readFile(
        path.join(repo, 'migration', 'site.config.json'),
        'utf8',
      ),
    );
    assert.equal(config.origin, 'https://www.example.com');
    assert.deepEqual(config.include, ['^/de/']);
    assert.deepEqual(Object.keys(config.bundles), ['pageTree']);
    await writeProject(repo, opts);
    const ignore = await readFile(
      path.join(repo, '.hlxignore'),
      'utf8',
    );
    assert.equal(
      ignore.split('\n').filter((l) => l === 'migration/').length,
      1,
    );
  },
);

test(
  'generated site.config.json loads with loadConfig and has correct keys',
  async () => {
    const repo = await edsRepo();
    const opts = {
      origin: 'https://www.example.com',
      sitemap: 'https://www.example.com/sitemap.xml',
      daOrg: 'o',
      daSite: 's',
      daRef: 'main',
      include: [],
    };
    await writeProject(repo, opts);
    const config = await loadConfig(
      path.join(repo, 'migration', 'site.config.json'),
    );
    assert.equal(config.thresholds.newTemplateMin, 5);
    assert.deepEqual(
      config.viewports,
      { desktop: [1440, 900] },
      'viewports should have desktop key with [width, height]',
    );
  },
);

test('CLI usage error exits 1', async () => {
  const initScript = fileURLToPath(
    new URL('./init.mjs', import.meta.url)
  );
  try {
    await execFileP('node', [initScript]);
    assert.fail('should have exited non-zero');
  } catch (e) {
    assert.equal(e.code, 1);
    assert.match(e.stderr, /Usage: init\.mjs/);
  }
});

test('CLI with --skip-checks scaffolds temp EDS repo', async () => {
  const repo = await edsRepo();
  const initScript = fileURLToPath(
    new URL('./init.mjs', import.meta.url)
  );
  const result = await execFileP(
    'node',
    [
      initScript,
      '--origin', 'https://www.example.com',
      '--sitemap', 'https://www.example.com/sitemap.xml',
      '--da-org', 'o',
      '--da-site', 's',
      '--skip-checks',
    ],
    { cwd: repo },
  );
  const output = JSON.parse(result.stdout);
  assert.ok(
    output.created.includes('migration/site.config.json'),
  );
  const configPath = path.join(repo, 'migration', 'site.config.json');
  const config = await loadConfig(configPath);
  assert.equal(config.thresholds.newTemplateMin, 5);
});

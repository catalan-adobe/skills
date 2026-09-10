import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths } from './paths.mjs';
import { listRecords, upsertRecords } from './state.mjs';
import { runCluster, slugify, treeBootstrap, treeFromPoll }
  from './cluster.mjs';

function makeConfig(repoRoot = process.cwd()) {
  return {
    origin: 'https://example.com',
    overlaySelectors: ['#cookie'],
    concurrency: { browser: 2 },
    thresholds: {
      clusterSimilarity: 0.8,
      minClusterSize: 2,
      representativesPerTemplate: 2,
    },
    bundles: { pageTree: 'tools/migration/lib/cluster.mjs' },
    templateSeeds: { post: 'blog-post', page: 'page' },
    viewports: { desktop: [1440, 900] },
  };
}
const config = makeConfig();

const tree = (tags) => ({
  data: { tag: 'body', children: tags.map((tag) => ({ tag, bounds: { height: 100 } })) },
  nodeMap: {},
});
const canned = {
  'https://example.com/blog/a': tree(['header', 'article']),
  'https://example.com/blog/b': tree(['header', 'article']),
  'https://example.com/blog/c': tree(['header', 'article', 'footer']),
  'https://example.com/about': tree(['header', 'cards', 'footer']),
};

function fakeBrowserFactory(log) {
  return () => {
    let current = null;
    return {
      async open(url) { current = url; log.push(['open', url]); },
      async resize() { log.push(['resize']); },
      async goto(url) { current = url; log.push(['goto', url]); },
      async pollJson() {
        if (current.endsWith('/broken')) throw new Error('detection failed');
        return canned[current];
      },
      async screenshot(file) { log.push(['shot', file]); await writeFile(file, ''); },
      async close() { log.push(['close']); },
    };
  };
}

async function seed() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-cluster-'));
  const migrationDir = path.join(dir, 'migration');
  await mkdir(migrationDir, { recursive: true });
  await writeFile(
    path.join(migrationDir, 'site.config.json'),
    '{}'
  );
  const bundleDir = path.join(dir, 'tools', 'migration', 'lib');
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, 'cluster.mjs'), '// mock');
  const paths = resolvePaths(
    { MIGRATION_DATA_DIR: path.join(migrationDir, 'data') },
    migrationDir
  );
  const rec = (p, type) => ({
    url: `https://example.com${p}`,
    path: p,
    sitemapType: type,
    template: config.templateSeeds[type],
    status: 'todo',
  });
  await upsertRecords('urls', [
    rec('/blog/a', 'post'), rec('/blog/b', 'post'), rec('/blog/c', 'post'),
    rec('/blog/broken', 'post'),
    rec('/about', 'page'),
    { ...rec('/skip', 'page'), status: 'excluded', excluded: { reason: 'test' } },
  ], paths);
  return { paths, repoRoot: dir };
}

test('bootstrap calls page-tree and parks the result on window', () => {
  const js = treeBootstrap(900);
  assert.match(js, /window\.__visualTree\.captureVisualTree\(900\)/);
  assert.match(js, /window\.__treeResult\s*=/);
  assert.match(js, /window\.__treeError\s*=/);
});

test('treeFromPoll returns the tree or throws the captured error', () => {
  assert.deepEqual(
    treeFromPoll(JSON.stringify({ data: { tag: 'body', children: [] }, nodeMap: {} })).data
      .tag,
    'body'
  );
  assert.throws(() => treeFromPoll(JSON.stringify({ error: 'boom' })), /boom/);
  assert.equal(treeFromPoll('null'), null);
});

test('fingerprints candidates resumably and then finalizes templates', async () => {
  const { paths, repoRoot } = await seed();
  const testConfig = makeConfig(repoRoot);
  const log = [];
  const first = await runCluster({
    config: testConfig, paths, browserFactory: fakeBrowserFactory(log), limit: 2, shots: false,
  });
  assert.equal(first.processed, 2);
  assert.equal(first.remaining, 3);
  assert.equal(first.finalized, false);
  const second = await runCluster({
    config: testConfig, paths, browserFactory: fakeBrowserFactory(log), shots: false,
  });
  assert.equal(second.processed, 3);
  assert.equal(second.errors, 1);
  assert.equal(second.remaining, 0);
  assert.equal(second.finalized, true);
  const templateRows = await listRecords('templates', { paths });
  const templates = Object.fromEntries(templateRows.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(templates).sort(), ['blog-post', 'page']);
  assert.equal(templates['blog-post'].urlCount, 3);
  assert.deepEqual(templates['blog-post'].representatives.sort(), [
    'https://example.com/blog/a', 'https://example.com/blog/b',
  ]);
  const urls = Object.fromEntries((await listRecords('urls', { paths })).map((u) => [u.path, u]));
  assert.equal(urls['/blog/a'].fingerprint, 'header[sm]|article[sm]');
  assert.equal(urls['/blog/a'].template, 'blog-post');
  assert.equal(urls['/blog/a'].status, 'analyzed');
  assert.equal(urls['/blog/b'].representative, true);
  assert.equal(urls['/blog/a'].representative, true);
  assert.match(urls['/blog/broken'].fingerprintError, /detection failed/);
  assert.equal(urls['/skip'].fingerprint, undefined);
  const third = await runCluster({
    config, paths, browserFactory: fakeBrowserFactory(log), shots: false,
  });
  assert.equal(third.processed, 0);
  assert.ok(log.some(([cmd]) => cmd === 'close'));
});

test('a reduce error is stored as fingerprintError and counted in the tally', async () => {
  const { paths, repoRoot } = await seed();
  const testConfig = makeConfig(repoRoot);
  const log = [];
  const failing = (opts) => ({
    ...fakeBrowserFactory(log)(opts),
    pollJson: async () => ({ error: 'boom' }),
  });
  const summary = await runCluster({
    config: testConfig, paths, browserFactory: failing, limit: 1, shots: false,
  });
  assert.equal(summary.processed, 1);
  assert.equal(summary.errors, 1);
  const failed = (await listRecords('urls', { paths })).find((u) => u.fingerprintError);
  assert.match(failed.fingerprintError, /boom/);
});

test('force with a limit keeps stale URLs remaining instead of finalizing', async () => {
  const { paths, repoRoot } = await seed();
  const testConfig = makeConfig(repoRoot);
  const log = [];
  const done = await runCluster({
    config: testConfig, paths, browserFactory: fakeBrowserFactory(log), shots: false,
  });
  assert.equal(done.finalized, true);
  // The remaining count compares stamps against the run start, so let the clock advance.
  await new Promise((r) => { setTimeout(r, 5); });
  const forced = await runCluster({
    config: testConfig,
    paths,
    browserFactory: fakeBrowserFactory(log),
    force: true,
    limit: 1,
    shots: false,
  });
  assert.equal(forced.processed, 1);
  assert.ok(forced.remaining > 0, 'stale fingerprints must still count as remaining');
  assert.equal(forced.finalized, false);
});

test('representative screenshots are captured once and skipped when already on disk', async () => {
  const { paths, repoRoot } = await seed();
  const testConfig = makeConfig(repoRoot);
  const log = [];
  const first = await runCluster({
    config: testConfig, paths, browserFactory: fakeBrowserFactory(log)
  });
  assert.equal(first.finalized, true);
  const shots = log.filter(([cmd]) => cmd === 'shot');
  assert.equal(shots.length, 3, 'one screenshot per representative (2 blog-post + 1 page)');
  assert.ok(shots.every(([, file]) => file.endsWith('.jpg')));
  const before = log.length;
  await runCluster({
    config: testConfig, paths, browserFactory: fakeBrowserFactory(log)
  });
  assert.equal(log.slice(before).filter(([cmd]) => cmd === 'shot').length, 0);
});

test('slugify converts URL pathnames to filesystem-safe slugs', () => {
  assert.equal(slugify('https://x.test/blog/my-post/'), 'blog-my-post');
  assert.equal(slugify('https://x.test/'), 'index');
  assert.equal(slugify('https://x.test/path/to/page'), 'path-to-page');
  assert.equal(slugify('https://x.test/a'), 'a');
  assert.throws(
    () => slugify('not-a-url'),
    /Cannot derive a screenshot name from invalid URL/,
  );
});

test('runCluster throws when page-tree bundle file is missing', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'test-'));
  const paths = resolvePaths({
    MIGRATION_DATA_DIR: temp,
    MIGRATION_REPO_ROOT: temp,
  });
  const missingBundleConfig = {
    ...config,
    bundles: { pageTree: 'missing/path/to/bundle.js' },
  };
  await assert.rejects(
    () => runCluster({
      config: missingBundleConfig,
      paths,
      limit: 1,
      force: false,
      shots: false,
    }),
    /page-tree bundle not found at.*missing\/path\/to\/bundle\.js/,
  );
});

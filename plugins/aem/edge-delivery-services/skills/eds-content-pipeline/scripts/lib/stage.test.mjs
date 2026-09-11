import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, writeFile, cp, readFile, rm, access,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadStage, planStage, validateStages,
} from './stage.mjs';
import { resolvePaths } from './paths.mjs';
import { upsertRecords } from './state.mjs';
import { readRows } from './ledger.mjs';
import { startFixtureServer } from '../fixtures/example-site/serve.mjs';

const execFileP = promisify(execFile);
const skillRoot = fileURLToPath(new URL('../../', import.meta.url));
const lib = fileURLToPath(new URL('./', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/example-site/', import.meta.url));
const exists = (p) => access(p).then(() => true, () => false);

test('the shipped stage specs validate', async () => {
  const result = await validateStages({ skillRoot });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.stages.sort(), ['bulk', 'discover', 'template']);
});

test('planStage resolves placeholders and orders units by dependencies', async () => {
  const spec = await loadStage('template', { skillRoot });
  const plan = planStage(spec, { template: 'product' }, { skillRoot });
  const ids = plan.units.map((u) => u.id);
  assert.ok(ids.indexOf('analyse') < ids.indexOf('scaffold-blocks'));
  assert.ok(ids.indexOf('scaffold-blocks') < ids.indexOf('author-transformer'));
  const scaffold = plan.units.find((u) => u.id === 'scaffold-blocks');
  assert.equal(scaffold.kind, 'run');
  assert.match(scaffold.command, /--template product$/);
  assert.match(scaffold.resolvedCommand, new RegExp(`^node ${skillRoot}scripts/lib/`));
  const analyse = plan.units.find((u) => u.id === 'analyse');
  assert.equal(analyse.kind, 'llm');
  assert.equal(analyse.tier, 'high');
  assert.deepEqual(analyse.inputs, ['data/templates.json', 'data/captures/product/']);
});

test('planStage rejects a missing param and an unknown dependency', async () => {
  const spec = await loadStage('template', { skillRoot });
  assert.throws(() => planStage(spec, {}, { skillRoot }), /param "template" is required/);
  const broken = { ...spec, units: [{ id: 'a', run: 'true', depends_on: ['nope'] }] };
  assert.throws(() => planStage(broken, { template: 'x' }, { skillRoot }), /unknown unit "nope"/);
});

test('validateStages names a bad spec precisely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ecp-stage-'));
  await mkdir(path.join(root, 'stages'), { recursive: true });
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await writeFile(path.join(root, 'stages', 'odd.yaml'), [
    'stage: odd', 'params: []', 'units:',
    '  - id: x', '    role: prompts/missing.md', '    tier: huge', '    colour: blue',
  ].join('\n'));
  const result = await validateStages({ skillRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /odd\.yaml.*prompts\/missing\.md/.test(e)));
  assert.ok(result.errors.some((e) => /tier "huge"/.test(e)));
  assert.ok(result.errors.some((e) => /unknown key "colour"/.test(e)));
});

/**
 * Builds a temp EDS repo seeded exactly like the fixture site, without cluster: `urls.json`
 * assigns the four fixture URLs directly to templates `product`/`page` via `upsertRecords`, and
 * the hand-authored `migration/` artefacts (transformers, templates, blocks.json) are copied in.
 */
async function fixtureRepo() {
  const server = await startFixtureServer();
  const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-stage-'));
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await writeFile(path.join(repo, 'scripts/aem.js'), '');
  await writeFile(path.join(repo, 'head.html'), '');
  await mkdir(path.join(repo, 'migration'), { recursive: true });
  const transformersDir = path.join(repo, 'migration/transformers');
  await cp(path.join(fixture, 'migration/transformers'), transformersDir, { recursive: true });
  await cp(path.join(fixture, 'migration/templates'), path.join(repo, 'migration/templates'), {
    recursive: true,
  });
  await mkdir(path.join(repo, 'migration/data'), { recursive: true });
  const blocksSrc = path.join(fixture, 'migration/data/blocks.json');
  await cp(blocksSrc, path.join(repo, 'migration/data/blocks.json'));
  const cfg = JSON.parse(await readFile(path.join(fixture, 'migration/site.config.json'), 'utf8'));
  cfg.origin = server.origin;
  cfg.sitemapIndex = `${server.origin}/sitemap.xml`;
  await writeFile(path.join(repo, 'migration/site.config.json'), JSON.stringify(cfg, null, 2));
  const paths = resolvePaths({ MIGRATION_PROJECT_DIR: path.join(repo, 'migration') }, repo);
  await upsertRecords('urls', [
    {
      url: `${server.origin}/`, path: '/', sitemapType: 'page', template: 'page', status: 'todo',
    },
    {
      url: `${server.origin}/about.html`,
      path: '/about.html',
      sitemapType: 'page',
      template: 'page',
      status: 'todo',
    },
    {
      url: `${server.origin}/product-a.html`,
      path: '/product-a.html',
      sitemapType: 'page',
      template: 'product',
      status: 'todo',
    },
    {
      url: `${server.origin}/product-b.html`,
      path: '/product-b.html',
      sitemapType: 'page',
      template: 'product',
      status: 'todo',
    },
  ], paths);
  await upsertRecords('templates', [
    { name: 'product', status: 'todo' },
    { name: 'page', status: 'todo' },
  ], paths);
  return { repo, server };
}

/** Runs `stage.mjs`, parsing stdout as JSON; rejects (with `.code/.stdout/.stderr`) on failure. */
async function cli(repo, ...args) {
  const { stdout } = await execFileP('node', [path.join(lib, 'stage.mjs'), ...args], { cwd: repo });
  return JSON.parse(stdout);
}

/** Runs `state.mjs`, parsing stdout as JSON; rejects (with `.code/.stdout/.stderr`) on failure. */
async function stateCli(repo, ...args) {
  const { stdout } = await execFileP('node', [path.join(lib, 'state.mjs'), ...args], { cwd: repo });
  return JSON.parse(stdout);
}

test('stage run bulk --skip-llm executes the run units and stops before the retro', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    const out = await cli(repo, 'run', 'bulk', 'template=product', '--skip-llm');
    assert.deepEqual(out.units.map((u) => [u.id, u.verdict]), [
      ['dry-run', 'done'], ['run', 'skipped-no-da'], ['sample-fidelity', 'skipped-no-da'],
      ['retro', 'skipped'],
    ]);
    assert.ok(await exists(path.join(repo, 'migration/data/bulk/product-dryrun.json')));
  } finally {
    await server.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test('check-transformer passes the fixture transformer and fails a broken one', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    await cli(repo, 'run', 'bulk', 'template=product', '--skip-llm'); // creates captures
    const ok = await cli(repo, 'check-transformer', 'product');
    assert.equal(ok.pass, true, JSON.stringify(ok));
    assert.equal(ok.pages.length, 2);
    const transformerFile = path.join(repo, 'migration/transformers/product.mjs');
    await writeFile(transformerFile, (await readFile(transformerFile, 'utf8'))
      .replace("querySelectorAll('table.specs tr')", "querySelectorAll('table.nope tr')"));
    const bad = await cli(repo, 'check-transformer', 'product').catch((e) => e);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /"pass":\s*false/);
  } finally {
    await server.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test('check-review records a rework row on needs-work and passes on ready', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    const review = path.join(repo, 'migration/templates/product/review.md');
    await writeFile(review, 'verdict: needs-work\n\n1. specs table drops the last row\n');
    const bad = await cli(repo, 'check-review', 'product').catch((e) => e);
    assert.equal(bad.code, 1);
    const rows = await readRows(
      'rework',
      resolvePaths({ MIGRATION_PROJECT_DIR: path.join(repo, 'migration') }, repo),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unit, 'author-transformer');
    await writeFile(review, 'verdict: ready\n');
    assert.equal((await cli(repo, 'check-review', 'product')).ok, true);
  } finally {
    await server.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test('list --count-min and --count-max gate on the count', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    const ok = await stateCli(repo, 'list', 'urls', 'template=product', '--count-min', '2');
    assert.equal(ok.count, 2);
    const low = await stateCli(repo, 'list', 'urls', 'template=product', '--count-min', '3')
      .catch((e) => e);
    assert.equal(low.code, 1);
    assert.match(low.stderr, /expected ≥ 3, got 2/);
  } finally {
    await server.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test('record-run appends a runs ledger row for the given stage and outcome', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    const out = await cli(
      repo, 'record-run', 'bulk', '--run-id', 'bulk-product-1', '--outcome', 'complete',
    );
    assert.equal(out.ok, true);
    const rows = await readRows(
      'runs',
      resolvePaths({ MIGRATION_PROJECT_DIR: path.join(repo, 'migration') }, repo),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, 'bulk-product-1');
    assert.equal(rows[0].stage, 'bulk');
    assert.equal(rows[0].outcome, 'complete');
    assert.ok(rows[0].startedAt);
    const bad = await cli(repo, 'record-run', 'bulk', '--run-id', 'x', '--outcome', 'nope')
      .catch((e) => e);
    assert.equal(bad.code, 1);
  } finally {
    await server.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test('rename-template renames the templates.json record and every URL', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    const out = await stateCli(repo, 'rename-template', 'product', 'gadget');
    assert.equal(out.from, 'product');
    assert.equal(out.to, 'gadget');
    assert.equal(out.urls.length, 2);
    const after = await stateCli(repo, 'list', 'urls', 'template=gadget', '--count');
    assert.equal(after.count, 2);
    const missing = await stateCli(repo, 'rename-template', 'nope', 'other').catch((e) => e);
    assert.equal(missing.code, 1);
    const clash = await stateCli(repo, 'rename-template', 'gadget', 'page').catch((e) => e);
    assert.equal(clash.code, 1);
  } finally {
    await server.close();
    await rm(repo, { recursive: true, force: true });
  }
});

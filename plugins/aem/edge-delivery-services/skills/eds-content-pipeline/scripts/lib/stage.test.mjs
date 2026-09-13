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
  loadStage, parseIgnoreSelectors, planStage, validateStages,
} from './stage.mjs';
import { resolvePaths } from './paths.mjs';
import { upsertRecords } from './state.mjs';
import { readRows } from './ledger.mjs';
import { fixtureRepo } from './testing/fixture-repo.mjs';

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

test('plan via the CLI resolves params and refuses shell metacharacters in values', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    const plan = await cli(repo, 'plan', 'bulk', 'template=product');
    assert.deepEqual(plan.units.map((u) => u.id), ['dry-run', 'run', 'sample-fidelity', 'retro']);
    assert.match(plan.units[0].command, /--template product --dry-run$/);
    const bad = await cli(repo, 'plan', 'bulk', 'template=x;rm -rf /').catch((e) => e);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /param "template" may only contain/);
  } finally { await server.close(); }
});

test('check-coverage fails below the threshold; check-fidelity on a failing page', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    await cli(repo, 'run', 'bulk', 'template=product', '--skip-llm');
    const ok = await cli(repo, 'check-coverage', 'product');
    assert.equal(ok.pass, true);
    const dryRun = path.join(repo, 'migration/data/bulk/product-dryrun.json');
    const report = JSON.parse(await readFile(dryRun, 'utf8'));
    await writeFile(dryRun, JSON.stringify({ ...report, coverage: 0.5 }));
    const low = await cli(repo, 'check-coverage', 'product').catch((e) => e);
    assert.equal(low.code, 1);
    assert.match(low.stdout, /"pass":\s*false/);
    const fidelity = path.join(repo, 'migration/reports/bulk-product-fidelity.json');
    await mkdir(path.dirname(fidelity), { recursive: true });
    await writeFile(fidelity, JSON.stringify({ template: 'product', pages: [
      { url: 'u', recall: 1, precision: 1, pass: true }, { url: 'v', recall: 0.4, pass: false },
    ] }));
    const fail = await cli(repo, 'check-fidelity', 'product').catch((e) => e);
    assert.equal(fail.code, 1);
    assert.match(fail.stdout, /"pages":\s*2/);
    const missing = await cli(repo, 'check-fidelity', 'page').catch((e) => e);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No fidelity report/);
  } finally { await server.close(); }
});

test('sample-fidelity compares produced content with the captures when a token is present',
  async () => {
    const { repo, server } = await fixtureRepo();
    try {
      await cli(repo, 'run', 'bulk', 'template=product', '--skip-llm');
      const paths = resolvePaths({ MIGRATION_PROJECT_DIR: path.join(repo, 'migration') }, repo);
      const { listRecords } = await import('./state.mjs');
      const records = await listRecords('urls', { where: { template: 'product' }, paths });
      await upsertRecords('urls', records.map((u) => ({
        url: u.url,
        status: 'previewed',
        docPath: u.docPath ?? new URL(u.url).pathname.replace(/\.html$/, ''),
      })), paths);
      const { stdout } = await execFileP('node',
        [path.join(lib, 'stage.mjs'), 'sample-fidelity', 'product', '--pages', '1'],
        { cwd: repo, env: { ...process.env, DA_TOKEN: 'test-token' } });
      const report = JSON.parse(stdout);
      assert.equal(report.pages.length, 1);
      assert.equal(report.pages[0].source, 'content');
      assert.equal(report.pages[0].pass, true, JSON.stringify(report));
      const check = await cli(repo, 'check-fidelity', 'product');
      assert.equal(check.pass, true);
    } finally { await server.close(); }
  });

test('check-run gates on the run report: missing, remaining, clean', async () => {
  const { repo, server, paths } = await fixtureRepo();
  try {
    const missing = await cli(repo, 'check-run', 'product').catch((e) => e);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No run report/);
    const file = path.join(paths.dataDir, 'bulk', 'product-run.json');
    await mkdir(path.dirname(file), { recursive: true });
    const base = {
      template: 'product', selected: 2, terminal: 1, remaining: 1, longTail: 0, failed: 0,
      stopped: 'deadline',
    };
    await writeFile(file, JSON.stringify(base));
    const partial = await cli(repo, 'check-run', 'product').catch((e) => e);
    assert.equal(partial.code, 1);
    assert.match(partial.stdout, /"pass":\s*false/);
    await writeFile(file, JSON.stringify({ ...base, stopped: null }));
    const leftover = await cli(repo, 'check-run', 'product').catch((e) => e);
    assert.equal(leftover.code, 1, 'a URL left non-terminal fails even without a deadline');
    await writeFile(file, JSON.stringify({ ...base, terminal: 2, remaining: 0, stopped: null }));
    const clean = await cli(repo, 'check-run', 'product');
    assert.equal(clean.pass, true);
    await writeFile(file, JSON.stringify({
      ...base, terminal: 2, remaining: 0, stopped: null, longTail: 1,
    }));
    const tail = await cli(repo, 'check-run', 'product').catch((e) => e);
    assert.equal(tail.code, 1, 'a long tail fails the run gate');
  } finally { await server.close(); }
});

test('resume is accepted on run units only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ecp-stage-'));
  await mkdir(path.join(root, 'stages'), { recursive: true });
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await writeFile(path.join(root, 'prompts', 'p.md'), '# p');
  await writeFile(path.join(root, 'stages', 'odd.yaml'), [
    'stage: odd', 'params: []', 'units:',
    '  - id: x', '    role: prompts/p.md', '    tier: low', '    done_when: true',
    '    resume: { while: deadline, max_rounds: 2 }',
  ].join('\n'));
  const result = await validateStages({ skillRoot: root });
  assert.ok(result.errors.some((e) => /resume only on run units/.test(e)), result.errors.join());
});

async function resumeStage(maxRounds) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ecp-resume-'));
  await mkdir(path.join(root, 'stages'), { recursive: true });
  await mkdir(path.join(root, 'scripts', 'lib'), { recursive: true });
  const counter = path.join(root, 'count.txt');
  // Prints stopped: deadline twice, then stopped: null — a resumable command that needs 3 runs.
  await writeFile(path.join(root, 'scripts', 'lib', 'flaky.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    `const f = '${counter}';`,
    "let n = 0; try { n = Number(readFileSync(f, 'utf8')); } catch {}",
    'writeFileSync(f, String(n + 1));',
    "console.log(JSON.stringify({ stopped: n < 2 ? 'deadline' : null, run: n + 1 }));",
  ].join('\n'));
  await writeFile(path.join(root, 'stages', 'flaky.yaml'), [
    'stage: flaky', 'params: []', 'units:',
    '  - id: work', '    run: node scripts/lib/flaky.mjs', '    depends_on: []',
    `    resume: { while: deadline, max_rounds: ${maxRounds} }`,
    `    done_when: test "$(cat ${counter})" = "3"`,
  ].join('\n'));
  return root;
}

test('a resumable run unit is re-run while it reports the resume reason, then gated', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    const root = await resumeStage(5);
    const args = [path.join(lib, 'stage.mjs'), 'run', 'flaky', '--skill-root', root];
    const { stdout } = await execFileP('node', args, { cwd: repo });
    const out = JSON.parse(stdout);
    assert.deepEqual(out.units, [{ id: 'work', verdict: 'done', resumed: 2 }]);
    assert.equal(out.stopped, undefined);
  } finally { await server.close(); }
});

test('exhausting resume rounds fails the unit with resume-exhausted', async () => {
  const { repo, server } = await fixtureRepo();
  try {
    const root = await resumeStage(1);
    const args = [path.join(lib, 'stage.mjs'), 'run', 'flaky', '--skill-root', root];
    const failed = await execFileP('node', args, { cwd: repo });
    const out = JSON.parse(failed.stdout);
    assert.deepEqual(out.units, [{ id: 'work', verdict: 'failed', resumed: 1 }]);
    assert.equal(out.stopped, 'work');
    assert.equal(out.reason, 'resume-exhausted');
  } finally { await server.close(); }
});

test('check-prep gates on the overlay recipe: missing, unchecked, no selector, ok', async () => {
  const { repo, server, paths } = await fixtureRepo();
  try {
    const file = path.join(paths.projectDir, 'page-prep.json');
    await rm(file, { force: true });
    const missing = await cli(repo, 'check-prep').catch((e) => e);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No overlay recipe/);
    await writeFile(file, JSON.stringify({ checked: [], overlays: [] }));
    const unchecked = await cli(repo, 'check-prep').catch((e) => e);
    assert.equal(unchecked.code, 1);
    assert.match(unchecked.stdout, /"pass":\s*false/);
    await writeFile(file, JSON.stringify({ checked: ['u'], overlays: [{ id: 'x' }] }));
    const noSelector = await cli(repo, 'check-prep').catch((e) => e);
    assert.equal(noSelector.code, 1);
    await writeFile(file, JSON.stringify({ checked: ['u'], overlays: [] }));
    assert.equal((await cli(repo, 'check-prep')).pass, true, 'a site without overlays is fine');
  } finally { await server.close(); }
});

test('parseIgnoreSelectors reads the documented `- selector: <css> — <why>` lines', () => {
  const text = [
    '## Not Migrated', '',
    'Header and footer are site chrome.', '',
    '- selector: nav.breadcrumbs — navigation, rebuilt from the path',
    '- selector: .share-buttons – social chrome (en dash)',
    '* selector: form.add-to-cart — commerce; operator decision — pending',
    'selector: footer',
    '- .not-a-selector-line — no selector: keyword at the start',
    '- selector:', '',
    '## Open Operator Decisions', '',
    '- selector: .this-one-is-out-of-section',
  ].join('\n');
  assert.deepEqual(parseIgnoreSelectors(text), [
    'nav.breadcrumbs', '.share-buttons', 'form.add-to-cart', 'footer',
  ]);
  assert.deepEqual(parseIgnoreSelectors('no section at all'), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CLASSES, registered, schemaOf } from './lib/schema.mjs';
import { main, parse, usage } from './migration.mjs';

const CLI = fileURLToPath(new URL('./migration.mjs', import.meta.url));
const run = promisify(execFile);
const fresh = () => mkdtemp(path.join(os.tmpdir(), 'mdata-cli-'));
const cli = async (cwd, ...args) => {
  const { stdout } = await run('node', [CLI, ...args], { cwd });
  try { return JSON.parse(stdout); } catch { return stdout; }
};

test('parse: commands, flags with values, booleans, unknown flags refused with the usage', () => {
  assert.deepEqual(parse(['init', '--origin', 'https://a.example/', '--pages', '50']),
    { name: 'init', flags: { '--origin': 'https://a.example/', '--pages': '50' }, positional: [] });
  assert.deepEqual(parse(['approve', 'cache', 'blogs', 'docs']),
    { name: 'approve', flags: {}, positional: ['cache', 'blogs', 'docs'] });
  assert.deepEqual(parse(['state', '--text']),
    { name: 'state', flags: { '--text': true }, positional: [] });
  assert.throws(() => parse(['nope']), /usage:\n {2}migration init --origin/);
  assert.throws(() => parse(['state', '--json']), /state: unknown flag --json\n {2}migration/);
  assert.throws(() => parse(['init', '--origin']), /--origin needs a value/);
  assert.match(usage('runs'), /^ {2}migration runs \[--step <id>\]\n {6}every run, oldest first$/);
});

test('the CLI drives a migration end to end: init, plan, approve, runs, state', async () => {
  const cwd = await fresh();
  const err = await cli(cwd, 'show').catch((e) => e);
  assert.equal(err.code, 1);
  assert.match(err.stderr, /no migration at .*migration\.json; run: migration init --origin/);
  const m = await cli(cwd, 'init', '--origin', 'https://a.example', '--pages', '50',
    '--skills-repo', 'someone/skills', '--skills-ref', 'pinned', '--target-repo', '.');
  assert.equal(m.source.origin, 'https://a.example/');
  assert.deepEqual(m.plan, { pages: 50, selection: null });
  assert.deepEqual(m.settings.skills, { repo: 'someone/skills', ref: 'pinned' });
  const bad = await cli(cwd, 'init', '--origin', 'https://a.example/').catch((e) => e);
  assert.match(bad.stderr, /a migration is created once/);
  const badPages = await cli(cwd, 'plan', '--pages', '0').catch((e) => e);
  assert.match(badPages.stderr, /--pages must be a whole number >= 1/);
  assert.deepEqual((await cli(cwd, 'plan', '--selection', 'migrate')).plan,
    { pages: 50, selection: 'migrate' });
  assert.deepEqual((await cli(cwd, 'approve', 'cache', 'sample')).approvals, { cache: ['sample'] });
  assert.deepEqual((await cli(cwd, 'approve', 'elements')).approvals,
    { cache: ['sample'], elements: true });
  const noStep = await cli(cwd, 'approve').catch((e) => e);
  assert.match(noStep.stderr, /approve needs a step/);
  assert.deepEqual(await cli(cwd, 'runs'), []);
  const state = await cli(cwd, 'state');
  assert.equal(state.schema, 'state/state@1');
  assert.equal(state.steps.find((s) => s.id === 'cache').state, 'blocked');
  const text = await cli(cwd, 'state', '--text');
  assert.match(text, /^step {6}state\n/);
  assert.match(text, /ready: discover, access; blocked: cache, chrome, elements, blocks, report/);
  assert.deepEqual((await readdir(path.join(cwd, 'migration'))).sort(),
    ['migration.json', 'state.json']);
  assert.deepEqual(await main(['show'], cwd), await cli(cwd, 'show'), 'main is the CLI');
});

test('invariant: every registered schema has a known class; files name only registered ones',
  () => {
    for (const ref of registered()) {
      const entry = schemaOf(ref);
      assert.ok(CLASSES.includes(entry.cls), `${ref}: class ${entry.cls}`);
      assert.match(ref, /^[a-z]+\/[a-z-]+@\d+$/, ref);
      assert.ok(entry.schema.required.includes('schema'), `${ref} requires its schema field`);
      assert.equal(entry.schema.additionalProperties, false, `${ref} is closed`);
    }
    const byClass = Object.fromEntries(registered().map((r) => [r, schemaOf(r).cls]));
    assert.equal(byClass['migration/migration@1'], 'decision');
    assert.equal(byClass['runs/run@1'], 'run');
    assert.equal(byClass['state/state@1'], 'derived');
  });

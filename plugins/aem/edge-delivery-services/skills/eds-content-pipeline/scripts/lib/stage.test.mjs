import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStage, planStage, validateStages } from './stage.mjs';

const skillRoot = fileURLToPath(new URL('../../', import.meta.url));

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

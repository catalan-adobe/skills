import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../workflows/pi/', import.meta.url));

for (const file of ['stage.mjs', 'templates.mjs']) {
  test(`${file} is a self-contained pi workflow script`, async () => {
    const src = await readFile(`${root}${file}`, 'utf8');
    assert.match(src, /^export const meta = \{ name: '[a-z_]+', description: '.+' \}/m);
    const bannedPatterns = [
      'import ', 'require(', 'fs.', 'child_process', 'Date.now(', 'Math.random(',
    ];
    for (const banned of bannedPatterns) {
      assert.ok(!src.includes(banned), `${file} uses ${banned}`);
    }
    assert.ok((src.match(/agent\(/g) ?? []).length >= 1 || file === 'templates.mjs');
    for (const tier of src.matchAll(/tier: '([a-z]+)'/g)) {
      assert.ok(['small', 'medium', 'big'].includes(tier[1]), `${file}: tier ${tier[1]}`);
    }
    for (const call of src.matchAll(/agent\([\s\S]*?\{([^}]*)\}\s*\)/g)) {
      assert.match(call[1], /label:/, `${file}: every agent() call needs a label`);
    }
  });
}

test('every agent command carries its own cd into the repo', async () => {
  const src = await readFile(`${root}stage.mjs`, 'utf8');
  assert.match(src, /const inRepo = \(repo, command\) => `cd \$\{repo\} && \$\{command\}`/);
  assert.match(src, /inRepo\(ctx\.repo, unit\.resolvedCommand\)/);
  assert.match(src, /inRepo\(ctx\.repo, unit\.resolvedDoneWhen\)/);
  assert.match(src, /Run exactly: cd \$\{repo\} && node/, 'plan prompt cds too');
  assert.match(src, /Run exactly: cd \$\{ctx\.repo\} && node/, 'record-run prompt cds too');
});

test('model-tiers.json maps low/medium/high to pi tiers', async () => {
  const tiers = JSON.parse(await readFile(`${root}model-tiers.json`, 'utf8'));
  assert.deepEqual(tiers.map, { low: 'small', medium: 'medium', high: 'big' });
  assert.match(tiers.probe, /stage\.mjs validate/);
});

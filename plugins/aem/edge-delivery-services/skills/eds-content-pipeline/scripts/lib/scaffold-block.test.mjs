import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderStub, scaffold, STUB_MARKER } from './scaffold-block.mjs';

const block = {
  name: 'specifications',
  status: 'scaffold',
  templates: { product: 1 },
  evidence: [],
  model: {
    rows: 'repeat',
    columns: [
      { name: 'label', type: 'text' },
      { name: 'value', type: 'text' },
    ],
    header: false,
  },
};

test('renderStub emits structural JS and brand-free CSS with marker', () => {
  const { js, css } = renderStub(block);
  assert.ok(
    js.startsWith(`/* ${STUB_MARKER}`),
    'JS should start with STUB marker',
  );
  assert.ok(
    css.startsWith(`/* ${STUB_MARKER}`),
    'CSS should start with STUB marker',
  );
  assert.match(js, /export default function decorate\(block\)/);
  assert.match(js, /const columns = \["label","value"\]/);
  assert.match(js, /classList\.add\('specifications-row'\)/);
  assert.match(
    css,
    /\.specifications > div \{\s*display: grid;\s*grid-template-columns: repeat\(2, 1fr\)/,
  );
  assert.ok(!/#[0-9a-f]{3,6}|var\(--/i.test(css), 'no brand tokens');
});

test('scaffold writes stubs and refuses to overwrite a real block', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-scaffold-'));
  const first = await scaffold([block], repo);
  assert.deepEqual(first.written, [
    'blocks/specifications/specifications.js',
    'blocks/specifications/specifications.css',
  ]);
  await writeFile(
    path.join(repo, 'blocks/specifications/specifications.js'),
    'export default function decorate() {}',
  );
  const second = await scaffold([block], repo);
  assert.equal(second.written.length, 0);
  assert.match(second.skipped[0].reason, /not a stub/);
  const forced = await scaffold([block], repo, { force: true });
  assert.equal(forced.written.length, 2);
});

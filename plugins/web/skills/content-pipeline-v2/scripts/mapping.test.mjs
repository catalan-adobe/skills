import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventoryFile, main, mappingFile } from './mapping.mjs';
import { runCheck } from './lib/checks.mjs';
import { resolveProject, writeProject } from './lib/project.mjs';

const type = (id, identity, recurring = true) => ({
  id, identity, recurring, pages: 2, instances: 2, medianHeight: 100, variants: [],
  sample: { url: 'https://site.example/a.html', selector: `#${id}` }, screenshots: {},
});
const elements = {
  types: [type('t-hero', 'DIV#.hero'), type('t-text', 'DIV#.text'), type('t-one', 'DIV#.x', false)],
  fragments: [],
  pages: [
    { url: 'https://site.example/a.html', sections: [{ type: 't-hero' }, { type: 't-text' }] },
    { url: 'https://site.example/b.html', sections: [{ type: 't-text' }, { type: 't-one' }] },
  ],
};

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-mapping-'));
  const p = resolveProject(root);
  await writeProject(p, { origin: 'https://site.example/', cacheAllUpTo: 500 });
  await mkdir(p.step('elements'), { recursive: true });
  await writeFile(path.join(p.step('elements'), 'elements.json'), JSON.stringify(elements));
  return p;
}

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('mapping.mjs seeds, refuses a bad decision, derives the inventory and the section',
  async () => {
    const p = await project();
    const first = await main([], p);
    assert.deepEqual(first, {
      blocks: 0, defaultContent: 0, skipped: 0, undecided: 2, orphaned: 0, coverage: 0, pages: 2,
    });
    const seeded = await json(mappingFile(p));
    assert.deepEqual(seeded, { types: { 't-hero': { kind: null }, 't-text': { kind: null } } },
      'recurring types only');
    const md = await readFile(path.join(p.step('mapping'), 'mapping.md'), 'utf8');
    assert.match(md, /## Undecided\n\n- `DIV#\.hero` \(t-hero\)\n- `DIV#\.text` \(t-text\)/);
    await writeFile(mappingFile(p), JSON.stringify({ types: {
      't-hero': { kind: 'block', block: 'Hero' }, 't-text': { kind: null },
    } }));
    await assert.rejects(main([], p), /mapping\/mapping.json:\n- t-hero: a block needs a name/);
    await writeFile(mappingFile(p), JSON.stringify({ types: {
      't-hero': { kind: 'block', block: 'hero', notes: 'image left' },
      't-text': { kind: 'default-content' }, 't-old': { kind: 'skip' },
    } }));
    const done = await main([], p);
    assert.deepEqual(done, {
      blocks: 1, defaultContent: 1, skipped: 0, undecided: 0, orphaned: 1, coverage: 1, pages: 2,
    });
    const inventory = await json(inventoryFile(p));
    assert.deepEqual(inventory.blocks.map((b) => [b.name, b.pages, b.notes]),
      [['hero', 1, ['image left']]]);
    assert.deepEqual(inventory.coverage.uncovered,
      [{ url: 'https://site.example/b.html', types: ['t-one'] }], 'the one-off keeps b open');
    assert.ok(inventory.mappingHash && inventory.elementsHash);
    const report = await readFile(p.report, 'utf8');
    assert.match(report, /## mapping\n\n1 blocks from 1 types; 1 default content types/);
    assert.match(report, /Coverage: 1 of 2 pages .* 1 orphaned decisions\./);
    assert.match(report, /Blocks by pages: hero \(1\)\./);
    const check = await runCheck('mapping', p);
    assert.equal(check.pass, false);
    assert.match(check.reasons[0], /the elements check fails first/, 'the gate before the file');
    await writeFile(path.join(p.step('mapping'), 'mapping.json'), '{');
    await assert.rejects(main([], p), /not valid JSON .* fix it and rerun mapping.mjs/);
  });

test('mapping.mjs without an elements inventory names the step to run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-mapping-'));
  const p = resolveProject(root);
  await writeProject(p, { origin: 'https://site.example/', cacheAllUpTo: 500 });
  await assert.rejects(main([], p), /elements\/elements.json missing; run elements.mjs first/);
  assert.match(await main(['--help'], p), /^mapping.mjs/);
});

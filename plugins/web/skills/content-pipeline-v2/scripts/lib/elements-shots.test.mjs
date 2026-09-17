import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  INSTANCES_PER_TYPE, VARIANTS_PER_TYPE, plannedShots, prepareExpression, screenshotTypes,
  shotsDir,
} from './elements-shots.mjs';
import { resolveProject } from './project.mjs';

const type = (id, variants = 1, recurring = true) => ({
  id, recurring, pages: 6, variants: Array.from({ length: variants }, (_, i) => ({
    instances: 10 - i, pages: 5, sample: { url: `https://s/u${i}`, selector: `var${i}` },
  })),
});
const pages = Array.from({ length: 6 }, (_, i) => ({
  url: `https://s/u${i}`,
  sections: [{ type: 't-a', selector: `s${i}` }, { type: 't-a', selector: `s${i}b` }],
}));

test('prepareExpression pauses animations and hides the chrome members', () => {
  assert.match(prepareExpression(), /animation-play-state: paused/);
  assert.doesNotMatch(prepareExpression(), /display: none/);
  assert.match(prepareExpression(['body > header', '#footer']),
    /body > header, #footer \{ display: none !important; \}/);
});

test('plannedShots: instances on distinct pages by hash, the largest variants, stable', () => {
  const plan = plannedShots(type('t-a', 7), pages);
  const instances = plan.filter((s) => s.kind === 'instance');
  assert.equal(instances.length, INSTANCES_PER_TYPE);
  assert.equal(new Set(instances.map((s) => s.url)).size, INSTANCES_PER_TYPE, 'distinct pages');
  assert.ok(instances.every((s) => /^s\d$/.test(s.selector)), 'the first instance of each page');
  assert.deepEqual(instances.map((s) => s.file),
    ['screenshots/type-t-a-1.png', 'screenshots/type-t-a-2.png', 'screenshots/type-t-a-3.png']);
  assert.deepEqual(plan, plannedShots(type('t-a', 7), pages), 'deterministic');
  const variants = plan.filter((s) => s.kind === 'variant');
  assert.equal(variants.length, VARIANTS_PER_TYPE);
  assert.equal(variants[0].selector, 'var0');
});

function fakeBrowser(files, { failOn = [] } = {}) {
  const calls = { goto: [], shots: [] };
  return {
    calls,
    goto: async (url) => { calls.goto.push(url); },
    eval: async (expr) => { calls.evals = (calls.evals ?? 0) + 1; return expr ? '1' : '0'; },
    screenshot: async (file, selector) => {
      if (failOn.includes(selector)) throw new Error(`no element for ${selector}`);
      calls.shots.push(selector);
      await writeFile(file, '');
      files.push(path.basename(file));
    },
  };
}

test('screenshotTypes: crops per page, only the missing ones, errors on the type', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-shots-'));
  const p = resolveProject(root);
  const result = { types: [type('t-a', 2), type('t-u', 1, false)], pages };
  const files = [];
  const browser = fakeBrowser(files, { failOn: ['var1'] });
  const out = await screenshotTypes(p, result, { browser, origin: 'https://s', port: 1 });
  const a = out.types[0];
  assert.deepEqual(a.screenshots, {
    instances: ['screenshots/type-t-a-1.png', 'screenshots/type-t-a-2.png',
      'screenshots/type-t-a-3.png'],
    variants: [`screenshots/type-t-a-v${1}.png`],
  });
  assert.match(a.screenshotError[0], /^var1 on https:\/\/s\/u1: no element for var1/);
  assert.equal(out.types[1].screenshots, undefined, 'a unique type gets no crop');
  assert.equal(new Set(browser.calls.goto).size, browser.calls.goto.length, 'each page once');
  assert.equal(browser.calls.evals, browser.calls.goto.length, 'animations frozen on each page');
  const again = fakeBrowser(files);
  await mkdir(shotsDir(p), { recursive: true });
  const second = await screenshotTypes(p, result, { browser: again, origin: 'https://s', port: 1 });
  assert.deepEqual(again.calls.shots, ['var1'], 'only the missing crop is retaken');
  assert.equal(second.types[0].screenshotError, undefined);
  assert.equal((await readdir(shotsDir(p))).length, 5);
});

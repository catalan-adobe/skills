import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { variantId } from './elements.mjs';
import {
  INSTANCES_PER_TYPE, VARIANTS_PER_TYPE, plannedShots, prepareExpression, screenshotTypes,
  shotsDir,
} from './elements-shots.mjs';
import { resolveProject } from './project.mjs';

const type = (id, variants = 1, recurring = true) => ({
  id, recurring, pages: 6, variants: Array.from({ length: variants }, (_, i) => ({
    instances: 10 - i, pages: 5, children: [`DIV#.c${i}`],
    sample: { url: `https://s/u${i}`, selector: `var${i}` },
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

test('plannedShots: instances on distinct pages by hash, names carry what they show', () => {
  const plan = plannedShots(type('t-a', 7), pages);
  const instances = plan.filter((s) => s.kind === 'instance');
  assert.equal(instances.length, INSTANCES_PER_TYPE);
  assert.equal(new Set(instances.map((s) => s.url)).size, INSTANCES_PER_TYPE, 'distinct pages');
  assert.ok(instances.every((s) => /^screenshots\/type-t-a-[0-9a-f]{8}\.png$/.test(s.file)));
  assert.deepEqual(plan, plannedShots(type('t-a', 7), pages), 'deterministic');
  const fewer = plannedShots(type('t-a', 7), pages.slice(1));
  const kept = fewer.filter((s) => s.kind === 'instance'
    && instances.some((i) => i.file === s.file));
  assert.ok(kept.every((s) => instances.find((i) => i.file === s.file).url === s.url),
    'a file name still names the same page after the page list changed');
  const variants = plan.filter((s) => s.kind === 'variant');
  assert.equal(variants.length, VARIANTS_PER_TYPE);
  assert.equal(variants[0].file, `screenshots/type-t-a-v${variantId(['DIV#.c0'])}.png`);
  assert.equal(variants[0].selector, 'var0');
});

function fakeBrowser(files, { failOn = [], failPages = [] } = {}) {
  const calls = { goto: [], shots: [], evals: 0 };
  return {
    calls,
    goto: async (url) => {
      calls.goto.push(url);
      if (failPages.includes(url)) throw new Error(`net::ERR_FAILED\nat ${url}`);
    },
    eval: async () => { calls.evals += 1; return '1'; },
    screenshot: async (file, selector) => {
      if (failOn.includes(selector)) throw new Error(`no element for ${selector}`);
      calls.shots.push(selector);
      await writeFile(file, '');
      files.push(path.basename(file));
    },
  };
}

test('screenshotTypes: per page, only the missing, errors per type, stale swept', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-shots-'));
  const p = resolveProject(root);
  const result = { types: [type('t-a', 2), type('t-u', 1, false)], pages };
  const files = [];
  const browser = fakeBrowser(files, { failOn: ['var1'] });
  const progress = [];
  const out = await screenshotTypes(p, result, {
    browser, origin: 'https://s', port: 1, onProgress: async (d, t) => { progress.push([d, t]); },
  });
  const a = out.types[0];
  assert.equal(a.screenshots.instances.length, 3);
  assert.deepEqual(a.screenshots.variants, [`screenshots/type-t-a-v${variantId(['DIV#.c0'])}.png`]);
  assert.match(a.screenshotError[0], /^var1 on https:\/\/s\/u1: no element for var1/);
  assert.equal(out.types[1].screenshots, undefined, 'a unique type gets no crop');
  assert.equal(new Set(browser.calls.goto).size, browser.calls.goto.length, 'each page once');
  assert.equal(browser.calls.evals, browser.calls.goto.length, 'prepared on each page');
  assert.deepEqual(progress.at(-1), [browser.calls.goto.length, browser.calls.goto.length]);
  await writeFile(path.join(shotsDir(p), 'type-t-gone-deadbeef.png'), '');
  const again = fakeBrowser(files);
  const second = await screenshotTypes(p, result, { browser: again, origin: 'https://s', port: 1 });
  assert.deepEqual(again.calls.shots, ['var1'], 'only the missing crop is retaken');
  assert.equal(second.types[0].screenshotError, undefined);
  const onDisk = await readdir(shotsDir(p));
  assert.equal(onDisk.length, 5);
  assert.ok(!onDisk.includes('type-t-gone-deadbeef.png'), 'an unreferenced crop is swept');
});

test('a page that fails to load counts as progress; its crops fail with the reason', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-shots-'));
  const p = resolveProject(root);
  await mkdir(shotsDir(p), { recursive: true });
  const result = { types: [type('t-a', 1)], pages };
  const browser = fakeBrowser([], { failPages: ['https://s/u0'] });
  const progress = [];
  const out = await screenshotTypes(p, result, {
    browser, origin: 'https://s', port: 1, onProgress: async (d) => { progress.push(d); },
  });
  assert.equal(progress.at(-1), browser.calls.goto.length, 'the failed page was counted');
  const errors = out.types[0].screenshotError ?? [];
  assert.ok(errors.every((e) => /^https:\/\/s\/u0: net::ERR_FAILED$/.test(e)), errors.join(';'));
});

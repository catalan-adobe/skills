import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureFile, capturesDir } from './capture.mjs';
import { checkElements, runCheck } from './checks.mjs';
import {
  SATURATION_PAGES, buildElements, elementsJson, groupTable, writeElements,
} from './elements-report.mjs';
import { writeInventory } from './inventory.mjs';
import { resolveProject, writeProject } from './project.mjs';

const ORIGIN = 'https://site.example';
const W = 1200;
const el = (tag, className, selector, y, height, children = []) => ({
  tag, className, selector, bounds: { x: 0, y, width: W, height }, children,
});
const text = (sel, y) => el('DIV', 'text', sel, y, 300,
  [el('H2', '', `${sel} > h2`, y, 50), el('P', '', `${sel} > p`, y + 50, 250)]);
const cards = (sel, y, cls = 'cards') => el('DIV', cls, sel, y, 400,
  [el('DIV', 'card', `${sel} > a`, y, 200), el('DIV', 'card', `${sel} > b`, y + 200, 200)]);
const pageTree = (list) => el('BODY', '', 'body', 0, 1000, list);

async function project(pages) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-elements-'));
  const p = resolveProject(root);
  await writeProject(p, { origin: `${ORIGIN}/`, cacheAllUpTo: 500 });
  await mkdir(p.step('urls'), { recursive: true });
  await mkdir(capturesDir(p), { recursive: true });
  await mkdir(p.step('elements'), { recursive: true });
  await addPages(p, pages);
  return p;
}

async function addPages(p, pages) {
  const existing = await readFile(path.join(p.step('urls'), 'urls.json'), 'utf8')
    .then(JSON.parse, () => []);
  const records = [...existing];
  for (const [name, group, tree] of pages) {
    const url = `${ORIGIN}/${group}/${name}.html`;
    records.push({ url, kind: 'page', group, cache: { path: 'x', verified: true } });
    await writeFile(captureFile(p, url), JSON.stringify({ minWidth: 300, url, tree }));
  }
  await writeInventory(p.step('urls'), records);
}

const three = [
  ['a', 'blog', pageTree([cards('s1', 0), text('s2', 400)])],
  ['b', 'blog', pageTree([cards('s1', 0), text('s2', 400)])],
  ['c', 'docs', pageTree([text('s2', 0), text('s3', 300)])],
];

test('elements.mjs writes the inventory, the operator view and the report section', async () => {
  const p = await project(three);
  const r = await writeElements(p, { now: () => new Date('2026-01-02T03:04:05Z') });
  assert.equal(r.capturedPages, 3);
  assert.deepEqual(r.types.map((t) => [t.identity, t.pages]),
    [['DIV#.text', 3], ['DIV#.cards', 2]]);
  assert.deepEqual(r.runs.map((x) => [x.at, x.newTypes.length, x.newCompositions]),
    [['2026-01-02T03:04:05.000Z', 2, 2]]);
  const md = await readFile(path.join(p.step('elements'), 'elements.md'), 'utf8');
  assert.match(md, /3 pages decomposed .* 2 element types, 2 recurring/);
  assert.match(md, /\| blog \| 2 \| 2 \| 1 \| 100 % \| 2 \| 2 \|  \|/);
  const report = await readFile(p.report, 'utf8');
  assert.match(report, /## elements\n[\s\S]*3 cached pages decomposed into 6 sections/);
  assert.deepEqual(await runCheck('elements', p), { step: 'elements', pass: true, reasons: [] });
});

test('a second run is a delta: ids stable, new types and saturation per group', async () => {
  const p = await project(three);
  const first = await writeElements(p);
  const more = Array.from({ length: SATURATION_PAGES }, (_, i) => (
    [`m${i}`, 'blog', pageTree([cards('s1', 0), text('s2', 400)])]));
  await addPages(p, [...more, ['n', 'docs', pageTree([cards('s1', 0, 'tiles'), text('s2', 400)])]]);
  const second = await buildElements(p);
  assert.equal(second.runs.length, 2);
  const [run1, run2] = second.runs;
  assert.deepEqual([run1.pages, run2.pages], [3, 3 + SATURATION_PAGES + 1]);
  assert.equal(run2.newTypes.length, 1, 'tiles is new; cards and text keep their ids');
  assert.ok(second.types.some((t) => t.id === first.types[0].id));
  const blog = second.groups.find((g) => g.group === 'blog');
  const docs = second.groups.find((g) => g.group === 'docs');
  assert.deepEqual([blog.newPages, blog.newTypes, blog.saturated], [SATURATION_PAGES, 0, true]);
  assert.deepEqual([docs.newPages, docs.newTypes, docs.saturated], [1, 1, false]);
});

test('groupTable without a previous run: everything is new, nothing saturated', () => {
  const pages = [{ group: 'g', composition: 'a b', sections: [{ type: 'a' }, { type: 'b' }] },
    { group: 'g', composition: 'a', sections: [{ type: 'a' }] }];
  assert.deepEqual(groupTable(pages), [{
    group: 'g', pages: 2, types: 2, compositions: 2, dominantShare: 0.5, newPages: 2,
    newTypes: 2, newCompositions: 2, saturated: false,
  }]);
});

test('check elements: a type id edited or a page removed fails by name', async () => {
  const p = await project(three);
  await writeElements(p);
  const file = elementsJson(p);
  const good = JSON.parse(await readFile(file, 'utf8'));
  const edited = JSON.parse(JSON.stringify(good));
  edited.types[0].id = 't-00000000';
  await writeFile(file, JSON.stringify(edited));
  const r1 = await runCheck('elements', p);
  assert.equal(r1.pass, false);
  assert.match(r1.reasons[0], /unknown type\(s\) t-/);
  const shorter = JSON.parse(JSON.stringify(good));
  shorter.pages.pop();
  await writeFile(file, JSON.stringify(shorter));
  const r2 = await runCheck('elements', p);
  assert.match(r2.reasons[0], /1 captured page\(s\) absent/);
  const wrongSample = JSON.parse(JSON.stringify(good));
  wrongSample.types[0].sample.selector = 'body > div.nope';
  await writeFile(file, JSON.stringify(wrongSample));
  assert.match((await runCheck('elements', p)).reasons[0],
    /sample body > div.nope is not in the capture/);
});

test('checkElements: missing or invalid file, count mismatch, page twice, no section', () => {
  assert.deepEqual(checkElements({}),
    { pass: false, reasons: ['missing migration/elements/elements.json'] });
  assert.match(checkElements({ 'elements/elements.json': '{' }).reasons[0], /not valid JSON/);
  const files = {
    'elements/elements.json': JSON.stringify({
      capturedPages: 1, types: [{ id: 't-1', sample: { url: 'u', selector: 's' } }],
      pages: [{ url: 'u', sections: [{ type: 't-1' }] }, { url: 'u', sections: [] }],
    }),
    'elements/elements.md': '#', 'REPORT.md': '## chrome\nx\n',
  };
  const r = checkElements(files, { captured: ['u', 'v'], selectors: { u: new Set(['s']) } });
  assert.deepEqual(r.reasons, [
    'REPORT.md has no ## elements section',
    'elements.json: 1 pages, the store has 2 — run elements.mjs',
    'elements.json: 1 captured page(s) absent',
    'elements.json: page listed twice: u',
  ]);
});

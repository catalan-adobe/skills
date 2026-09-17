import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureFile, capturesDir } from './capture.mjs';
import { checkElements, runCheck } from './checks.mjs';
import { writeEvaluation } from './elements-evaluation.mjs';
import {
  SATURATION_PAGES, buildElements, elementsJson, groupTable, writeElements, writeOutputs,
} from './elements-report.mjs';
import { screenshotTypes } from './elements-shots.mjs';
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
  for (const step of ['urls', 'capture', 'chrome', 'elements']) {
    await mkdir(p.step(step), { recursive: true });
  }
  await writeFile(path.join(p.step('chrome'), 'chrome.json'), JSON.stringify({
    header: [{ members: [{ selectors: ['body > header'] }] }], footer: [],
  }));
  await addPages(p, pages);
  return p;
}

let clock = 0;
async function addPages(p, pages) {
  const existing = await readFile(path.join(p.step('urls'), 'urls.json'), 'utf8')
    .then(JSON.parse, () => []);
  const records = [...existing];
  for (const [name, group, tree] of pages) {
    const url = `${ORIGIN}/${group}/${name}.html`;
    records.push({ url, kind: 'page', group, cache: { path: 'x', verified: true } });
    clock += 1;
    const capturedAt = new Date(Date.UTC(2026, 0, 1, 0, clock)).toISOString();
    await writeFile(captureFile(p, url), JSON.stringify({ minWidth: 300, url, capturedAt, tree }));
  }
  records.push({ url: `${ORIGIN}/empty/x.html`, kind: 'page', group: 'empty', cache: {} });
  await writeInventory(p.step('urls'), records);
}

const header = el('HEADER', 'top', 'body > header', 0, 80);

/** The worker's whole run with a browser that writes empty crops. */
async function fullRun(p) {
  const browser = {
    goto: async () => {}, eval: async () => '1', screenshot: async (file) => writeFile(file, ''),
  };
  const result = await writeElements(p);
  const shot = await screenshotTypes(p, result, { browser, origin: ORIGIN, port: 1 });
  await writeOutputs(p, shot);
  await writeEvaluation(p, shot);
  return shot;
}
const three = [
  ['a', 'blog', pageTree([header, cards('s1', 80), text('s2', 480)])],
  ['b', 'blog', pageTree([header, cards('s1', 80), text('s2', 480)])],
  ['c', 'docs', pageTree([header, text('s2', 80), text('s3', 380)])],
];
const blogPage = (i) => [`m${i}`, 'blog', pageTree([header, cards('s1', 80), text('s2', 480)])];

test('elements.mjs writes the inventory, the operator view and the report section', async () => {
  const p = await project(three);
  const r = await writeElements(p, { now: () => new Date('2026-01-02T03:04:05Z') });
  assert.equal(r.capturedPages, 3);
  assert.deepEqual(r.types.map((t) => [t.identity, t.pages]),
    [['DIV#.text', 3], ['DIV#.cards', 2]], 'the header is chrome, not a type');
  assert.deepEqual(r.runs.map((x) => [x.at, x.newTypes.length, x.removedTypes, x.newCompositions]),
    [['2026-01-02T03:04:05.000Z', 2, [], 2]]);
  assert.equal(r.storeCapturedAt, r.pages.map((x) => x.capturedAt).sort().at(-1));
  assert.deepEqual(r.groupsWithoutPages, ['empty']);
  assert.match(r.rulesHash, /^[0-9a-f]{12}$/);
  const md = await readFile(path.join(p.step('elements'), 'elements.md'), 'utf8');
  assert.match(md, /3 pages decomposed .* 2 element types, 2 recurring/);
  assert.match(md, /\| blog \| 2 \| 2 \| 1 \| 100 % \| 2 \|  \|/);
  assert.match(md, /Groups without a captured page: empty\./);
  const report = await readFile(p.report, 'utf8');
  assert.match(report, /## elements\n[\s\S]*3 cached pages decomposed into 6 sections/);
  const before = await runCheck('elements', p);
  assert.deepEqual(before.reasons.slice(0, 2),
    ['missing migration/elements/evaluation.md', 'type t-4e67f7ee: 0 instances crops of 3'],
    'without the crops and the evaluation the step is not done');
  const shot = await fullRun(p);
  assert.deepEqual(shot.types[0].screenshots.instances.length, 3);
  assert.deepEqual(await runCheck('elements', p), { step: 'elements', pass: true, reasons: [] });
  const evaluation = await readFile(path.join(p.step('elements'), 'evaluation.md'), 'utf8');
  assert.match(evaluation, /### t-.* — `DIV#.text`/);
});

test('without chrome.json the step refuses rather than inventory the header', async () => {
  const p = await project(three);
  await rm(path.join(p.step('chrome'), 'chrome.json'));
  await assert.rejects(buildElements(p), /chrome\/chrome.json missing; run chrome.mjs first/);
});

test('a second run is a delta: ids stable, new and removed types, rule changes labelled',
  async () => {
    const p = await project(three);
    const first = await writeElements(p);
    const tilesPage = pageTree([header, cards('s1', 80, 'tiles'), text('s2', 480)]);
    await addPages(p, [['n', 'docs', tilesPage]]);
    const second = await writeElements(p);
    const [, run2] = second.runs;
    assert.deepEqual([run2.pages, run2.newTypes.length, run2.removedTypes, run2.newCompositions],
      [4, 1, [], 1], 'tiles is new; cards and text keep their ids');
    assert.ok(second.types.some((t) => t.id === first.types[0].id));
    const tiles = second.types.find((t) => t.identity === 'DIV#.tiles');
    const cardsId = first.types.find((t) => t.identity === 'DIV#.cards').id;
    await writeFile(path.join(p.step('elements'), 'rules.json'),
      JSON.stringify({ merge: { [tiles.id]: cardsId } }));
    const third = await writeElements(p);
    const run3 = third.runs[2];
    assert.deepEqual([run3.rulesChanged, run3.newTypes, run3.removedTypes, run3.newCompositions],
      [true, [], [tiles.id], null]);
    assert.notEqual(run3.rulesHash, run2.rulesHash);
    const md = await readFile(path.join(p.step('elements'), 'elements.md'), 'utf8');
    assert.match(md, /\| 0 \| 1 \| rules changed \|/);
  });

test('saturation reads the capture order and survives a rerun with nothing new', async () => {
  const p = await project(three);
  await addPages(p, Array.from({ length: SATURATION_PAGES }, (_, i) => blogPage(i)));
  const r = await writeElements(p);
  const blog = r.groups.find((g) => g.group === 'blog');
  assert.deepEqual([blog.pages, blog.recentNewTypes, blog.saturated],
    [SATURATION_PAGES + 2, 0, true]);
  assert.equal(r.groups.find((g) => g.group === 'docs').saturated, false, 'one page');
  const again = await writeElements(p);
  assert.equal(again.groups.find((g) => g.group === 'blog').saturated, true);
  const late = pageTree([header, cards('s1', 80, 'tiles'), text('s2', 480)]);
  await addPages(p, [['z', 'blog', late]]);
  const after = await writeElements(p);
  const b = after.groups.find((g) => g.group === 'blog');
  assert.deepEqual([b.recentNewTypes, b.saturated], [1, false], 'a late new type unsaturates');
});

test('groupTable on a small group: never saturated, dominant share measured', () => {
  const pages = [
    { group: 'g', composition: 'a b', capturedAt: '1', sections: [{ type: 'a' }, { type: 'b' }] },
    { group: 'g', composition: 'a', capturedAt: '2', sections: [{ type: 'a' }] },
  ];
  assert.deepEqual(groupTable(pages), [{
    group: 'g', pages: 2, types: 2, compositions: 2, dominantShare: 0.5, recentNewTypes: 2,
    saturated: false,
  }]);
});

test('check elements: an edited id, a removed page, a wrong sample, a stale file fail by name',
  async () => {
    const p = await project(three);
    await fullRun(p);
    const file = elementsJson(p);
    const good = JSON.parse(await readFile(file, 'utf8'));
    const mutate = async (f) => {
      const copy = JSON.parse(JSON.stringify(good));
      f(copy);
      await writeFile(file, JSON.stringify(copy));
      return (await runCheck('elements', p)).reasons;
    };
    assert.match((await mutate((c) => { c.types[0].id = 't-00000000'; }))[0],
      /unknown type\(s\) t-/);
    assert.match((await mutate((c) => c.pages.pop()))[0], /1 captured page\(s\) absent/);
    assert.match((await mutate((c) => { c.types[0].sample.selector = 'body > div.nope'; }))[0],
      /sample body > div.nope is not in the capture/);
    assert.match((await mutate((c) => { c.types[0].sample.url = 'https://site.example/gone'; }))[0],
      /sample page https:\/\/site.example\/gone is not in the store/);
    await writeFile(file, JSON.stringify(good));
    const url = `${ORIGIN}/blog/a.html`;
    await writeFile(captureFile(p, url), JSON.stringify({
      minWidth: 300, url, capturedAt: '2027-01-01T00:00:00.000Z', tree: three[0][2],
    }));
    assert.deepEqual((await runCheck('elements', p)).reasons,
      ['elements.json predates the store — run elements.mjs']);
    await fullRun(p);
    await writeFile(path.join(p.step('elements'), 'rules.json'), JSON.stringify({ recurrence: 3 }));
    assert.deepEqual((await runCheck('elements', p)).reasons,
      ['elements.json predates rules.json — run elements.mjs']);
    await writeFile(path.join(p.step('elements'), 'rules.json'), '{ nope');
    assert.match((await runCheck('elements', p)).reasons[0],
      /elements: rules.json: not valid JSON/);
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
    'missing migration/elements/evaluation.md',
    'REPORT.md has no ## elements section',
    'elements.json: 1 pages, the store has 2 — run elements.mjs',
    'elements.json: 1 captured page(s) absent',
    'elements.json: page listed twice: u',
  ]);
});

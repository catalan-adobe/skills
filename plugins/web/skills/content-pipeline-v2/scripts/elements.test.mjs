import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerMain } from './elements.mjs';
import { captureFile, readRun, runFile } from './lib/capture.mjs';
import { writeJson } from './lib/jobs.mjs';
import { writeInventory } from './lib/inventory.mjs';
import { resolveProject, writeProject } from './lib/project.mjs';

const ORIGIN = 'https://site.example';
const el = (tag, className, selector, y, height, children = []) => ({
  tag, className, selector, bounds: { x: 0, y, width: 1200, height }, children,
});
const text = (sel, y) => el('DIV', 'text', sel, y, 300,
  [el('H2', '', `${sel} > h2`, y, 50), el('P', '', `${sel} > p`, y + 50, 250)]);
const cards = (sel, y) => el('DIV', 'cards', sel, y, 400,
  [el('DIV', 'card', `${sel} > a`, y, 200), el('DIV', 'card', `${sel} > b`, y + 200, 200)]);

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-elworker-'));
  const p = resolveProject(root);
  await writeProject(p, { origin: `${ORIGIN}/`, cacheAllUpTo: 500 });
  for (const step of ['urls', 'capture', 'chrome']) await mkdir(p.step(step), { recursive: true });
  await writeFile(path.join(p.step('chrome'), 'chrome.json'),
    JSON.stringify({ header: [], footer: [] }));
  const records = [];
  for (const n of ['a', 'b', 'c']) {
    const url = `${ORIGIN}/${n}.html`;
    records.push({ url, kind: 'page', group: 'g', cache: { path: 'x', verified: true } });
    const tree = el('BODY', '', 'body', 0, 1000, [cards('s1', 0), text('s2', 400)]);
    await writeFile(captureFile(p, url), JSON.stringify({ minWidth: 300, url, tree,
      capturedAt: `2026-01-01T00:0${records.length}:00.000Z` }));
  }
  await writeInventory(p.step('urls'), records);
  await mkdir(p.work, { recursive: true });
  await writeJson(runFile(p, 'elements'), { state: 'running', pid: process.pid });
  return p;
}

const fakeSession = (onGoto = () => {}) => async () => ({
  origin: ORIGIN, port: 1, prepare: null, hide: [],
  browser: {
    goto: async (url) => onGoto(url), eval: async () => '1',
    screenshot: async (file) => writeFile(file, ''), close: async () => {},
  },
});
const io = (signals) => ({ onSignal: (fn) => signals.push(fn), kill() {} });

test('the worker ends done with the crops, the evaluation and the section', async () => {
  const p = await project();
  const out = await workerMain(p, io([]), fakeSession());
  assert.deepEqual([out.state, out.defects], ['done', 0]);
  assert.match(out.summary, /3 cached pages decomposed into 6 sections/);
  const run = await readRun(p, () => true, 'elements');
  assert.deepEqual([run.state, run.done, run.total], ['done', 3, 3]);
  await readFile(path.join(p.step('elements'), 'evaluation.md'), 'utf8');
  const json = JSON.parse(await readFile(path.join(p.step('elements'), 'elements.json'), 'utf8'));
  assert.equal(json.types[0].screenshots.instances.length, 3);
  assert.equal(json.runs.length, 1, 'buildElements ran once');
});

test('a signal during the crops stops after the current page and records stopped', async () => {
  const p = await project();
  const signals = [];
  let pages = 0;
  const session = fakeSession(() => { pages += 1; if (pages === 1) signals.forEach((f) => f()); });
  await assert.rejects(workerMain(p, io(signals), session), /stopped/);
  assert.equal(pages, 1, 'no page after the signal');
  assert.equal((await readRun(p, () => true, 'elements')).state, 'stopped');
});

test('a signal before the crops stops before opening a browser', async () => {
  const p = await project();
  const signals = [];
  const opened = [];
  const ioNow = { onSignal: (fn) => { signals.push(fn); fn(); }, kill() {} };
  await assert.rejects(workerMain(p, ioNow, async () => { opened.push(1); }), /stopped/);
  assert.deepEqual(opened, []);
  assert.equal((await readRun(p, () => true, 'elements')).state, 'stopped');
});

test('a failure before the browser (no chrome.json) records failed with the message', async () => {
  const p = await project();
  await rm(path.join(p.step('chrome'), 'chrome.json'));
  await assert.rejects(workerMain(p, io([]), fakeSession()), /chrome.json missing/);
  const run = await readRun(p, () => true, 'elements');
  assert.deepEqual([run.state, /chrome.json missing/.test(run.error)], ['failed', true]);
});

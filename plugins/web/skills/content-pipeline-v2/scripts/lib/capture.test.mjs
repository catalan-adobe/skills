import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject, writeProject } from './project.mjs';
import { writeInventory } from './inventory.mjs';
import { runCheck } from './checks.mjs';
import { stepStates } from './steps.mjs';
import {
  MAX_CONSECUTIVE_FAILURES, MIN_WIDTH, captureAll, captureFile, capturesDir, pagesToCapture,
  readRun, runFile, startCapture, startWorker, storeStatus, writeCaptureConfig,
  writeCapturesMd,
} from './capture.mjs';

const ORIGIN = 'https://site.example';
const page = (n) => `${ORIGIN}/p${n}.html`;

async function project(n = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-chrome-'));
  const p = resolveProject(root);
  await writeProject(p, { origin: `${ORIGIN}/`, cacheAllUpTo: 500 });
  await mkdir(p.step('urls'), { recursive: true });
  const records = [];
  for (let i = 1; i <= n; i += 1) {
    records.push({ url: page(i), kind: 'page', cache: { path: 'x', verified: true } });
  }
  records.push({ url: `${ORIGIN}/doc.pdf`, kind: 'binary', cache: { path: 'y', verified: true } });
  records.push({ url: `${ORIGIN}/late.html`, kind: 'page', cache: { path: 'z', verified: false } });
  await writeInventory(p.step('urls'), records);
  return p;
}

// The eval result as playwright-cli prints it: JSON of the JSON.stringify'd capture.
const encoded = (data) => JSON.stringify(JSON.stringify({
  data, textFormat: 'r @0,0 10x10', nodeMap: { r: { selector: 'body' } }, rootBackground: null,
}));

function fakeBrowser({ failOn = [] } = {}) {
  const calls = { goto: [], eval: 0 };
  return {
    calls,
    goto: async (url) => {
      calls.goto.push(url);
      if (failOn.some((f) => url.includes(f))) throw new Error(`net::ERR_FAILED at ${url}`);
    },
    eval: async () => {
      calls.eval += 1;
      return encoded({ tag: 'BODY', selector: 'body', bounds: { x: 0, y: 0 }, children: [] });
    },
  };
}

test('pagesToCapture lists verified pages only, minus those already captured', async () => {
  const p = await project();
  assert.deepEqual(await pagesToCapture(p), [page(1), page(2), page(3)],
    'the binary and the unverified page are left out');
  await mkdir(capturesDir(p), { recursive: true });
  await writeFile(captureFile(p, page(2)), JSON.stringify({ url: page(2), minWidth: MIN_WIDTH }));
  assert.deepEqual(await pagesToCapture(p), [page(1), page(3)]);
  assert.deepEqual(await pagesToCapture(p, { force: true }), [page(1), page(2), page(3)]);
});

test('a capture at another min-width is stale: listed by storeStatus, recaptured', async () => {
  const p = await project();
  await mkdir(capturesDir(p), { recursive: true });
  await writeFile(captureFile(p, page(1)), JSON.stringify({ url: page(1), minWidth: 900 }));
  await writeFile(captureFile(p, page(2)), JSON.stringify({ url: page(2), minWidth: 300 }));
  const status = await storeStatus(p, 300);
  assert.deepEqual([status.verified, status.captured, status.missing, status.stale],
    [3, 1, [page(3)], [page(1)]]);
  assert.deepEqual(await pagesToCapture(p, { minWidth: 300 }), [page(3), page(1)]);
  assert.deepEqual(await pagesToCapture(p, { minWidth: 900 }), [page(3), page(2)]);
});

test('captures.md states the store against the cache and the failures', async () => {
  const p = await project(2);
  const run = await captureAll(p, { browser: fakeBrowser({ failOn: ['p2'] }), origin: ORIGIN,
    port: 1 }, { urls: [page(1), page(2)] });
  assert.equal(run.failed.length, 1);
  await writeCapturesMd(p, { now: () => new Date('2026-01-02T03:04:05Z') });
  const md = await readFile(path.join(capturesDir(p), 'captures.md'), 'utf8');
  assert.match(md, /Captured 2026-01-02T03:04Z at min-width 300 px/);
  assert.match(md, /verified cached pages: 2\n- captured at 300 px: 1\n- without a capture: 1/);
  assert.match(md, /failed in the last run: 1\n {2}- https:\/\/site.example\/p2.html — /);
});

test('captureAll stores one capture per page through the proxy and records progress', async () => {
  const p = await project();
  const browser = fakeBrowser();
  const run = await captureAll(p, { browser, origin: ORIGIN, port: 3005 },
    { urls: [page(1), page(2)] });
  assert.deepEqual([run.state, run.done, run.failed], ['done', 2, []]);
  assert.equal(browser.calls.goto[0],
    'http://127.0.0.1:3005/p1.html?_origin=https%3A%2F%2Fsite.example');
  const stored = JSON.parse(await readFile(captureFile(p, page(1)), 'utf8'));
  assert.equal(stored.url, page(1));
  assert.equal(stored.tree.tag, 'BODY');
  assert.equal(stored.text, 'r @0,0 10x10');
  assert.deepEqual(stored.nodeMap, { r: { selector: 'body' } });
  assert.equal((await readdir(capturesDir(p))).length, 2);
  assert.equal(JSON.parse(await readFile(runFile(p), 'utf8')).state, 'done');
});

test('a failed page is recorded and the run goes on; a streak ends it as failed', async () => {
  const p = await project(7);
  const some = fakeBrowser({ failOn: ['p2'] });
  const run = await captureAll(p, { browser: some, origin: ORIGIN, port: 1 },
    { urls: [page(1), page(2), page(3)] });
  assert.deepEqual([run.state, run.done], ['done', 3]);
  assert.equal(run.failed.length, 1);
  assert.match(run.failed[0].error, /ERR_FAILED/);
  assert.equal((await readdir(capturesDir(p))).length, 2);

  const all = fakeBrowser({ failOn: ['p'] });
  const dead = await captureAll(p, { browser: all, origin: ORIGIN, port: 1 },
    { urls: [1, 2, 3, 4, 5, 6, 7].map(page) });
  assert.equal(dead.state, 'failed');
  assert.equal(dead.failed.length, MAX_CONSECUTIVE_FAILURES);
  assert.match(dead.error, /5 pages failed in a row/);
  assert.equal(all.calls.goto.length, MAX_CONSECUTIVE_FAILURES, 'it stopped trying');
});

test('shouldStop ends the run after the current page as stopped', async () => {
  const p = await project();
  let count = 0;
  const run = await captureAll(p, { browser: fakeBrowser(), origin: ORIGIN, port: 1 },
    { urls: [page(1), page(2), page(3)], shouldStop: () => (count += 1) > 2 });
  assert.deepEqual([run.state, run.done, run.current], ['stopped', 2, null]);
  assert.deepEqual(await pagesToCapture(p), [page(3)], 'a rerun does the rest');
});

test('a bundle that returns no tree is a failure, not a stored capture', async () => {
  const p = await project();
  const browser = { goto: async () => {}, eval: async () => JSON.stringify('undefined') };
  const run = await captureAll(p, { browser, origin: ORIGIN, port: 1 }, { urls: [page(1)] });
  assert.match(run.failed[0].error, /returned no tree/);
  assert.deepEqual(await readdir(capturesDir(p)), []);
});

test('startCapture spawns one detached worker, refuses while one runs, and reports a dead one',
  async () => {
    const p = await project();
    const spawned = [];
    const io = {
      spawn: (cmd, args) => { spawned.push(args); return { pid: 4242, unref() {} }; },
      alive: (pid) => pid === 4242,
    };
    const first = await startCapture(p, '/skill/capture.mjs', { force: false }, io);
    assert.deepEqual([first.started, first.pid, first.total], [true, 4242, 3]);
    assert.deepEqual(spawned[0], ['/skill/capture.mjs', '--worker', '--min-width', '300']);
    const second = await startCapture(p, '/skill/capture.mjs', {}, io);
    assert.equal(second.started, false);
    assert.equal(second.run.state, 'running');
    assert.equal(spawned.length, 1);
    const gone = await readRun(p, () => false);
    assert.equal(gone.state, 'interrupted');
    const restarted = await startCapture(p, '/skill/capture.mjs', { force: true },
      { ...io, alive: () => false });
    assert.equal(restarted.started, true);
    assert.deepEqual(spawned[1],
      ['/skill/capture.mjs', '--worker', '--force', '--min-width', '300']);
  });

test('startWorker keeps one run per kind: a chrome run does not block a capture run', async () => {
  const p = await project(1);
  const spawned = [];
  const io = {
    spawn: (cmd, args) => { spawned.push(args); return { pid: 7, unref() {} }; }, alive: () => true,
  };
  const chrome = await startWorker(p, 'chrome', '/skill/chrome.mjs', [], {}, io);
  assert.deepEqual([chrome.started, spawned[0]], [true, ['/skill/chrome.mjs', '--worker']]);
  assert.equal((await readRun(p, io.alive, 'chrome')).state, 'running');
  assert.equal(await readRun(p, io.alive, 'capture'), null);
  const again = await startWorker(p, 'chrome', '/skill/chrome.mjs', [], {}, io);
  assert.equal(again.started, false);
  assert.equal((await startCapture(p, '/skill/capture.mjs', {}, io)).started, true);
});

test('the capture config adds the bundle to the cache browser config', async () => {
  const p = await project();
  await mkdir(p.work, { recursive: true });
  const base = path.join(p.work, 'cache-browser-config.json');
  await writeFile(base, JSON.stringify({
    browser: { browserName: 'chromium' }, network: { allowedOrigins: ['http://127.0.0.1:1'] },
  }));
  const file = await writeCaptureConfig(p, base, '/skills/page-tree/scripts/bundle.js');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    browser: { browserName: 'chromium', initScript: ['/skills/page-tree/scripts/bundle.js'] },
    network: { allowedOrigins: ['http://127.0.0.1:1'] },
  });
});

test('the prep expression runs before the capture and the page is scrolled back up', async () => {
  const p = await project();
  const browser = fakeBrowser();
  const evals = [];
  browser.eval = async (expr) => {
    evals.push(expr);
    return encoded({ tag: 'BODY', selector: 'body', bounds: { x: 0, y: 0 }, children: [] });
  };
  await captureAll(p, { browser, origin: ORIGIN, port: 1, prepare: '(() => "prep")()' },
    { urls: [page(1)] });
  assert.equal(evals.length, 2);
  assert.match(evals[0], /^\(\(\) => "prep"\)\(\), window\.scrollTo\(0, 0\)$/);
});

test('--min-width reaches the worker and the capture; the capture records it', async () => {
  const p = await project(1);
  const spawned = [];
  await startCapture(p, '/s', { minWidth: 600 }, {
    spawn: (cmd, args) => { spawned.push(args); return { pid: 1, unref() {} }; }, alive: () => true,
  });
  assert.deepEqual(spawned[0], ['/s', '--worker', '--min-width', '600']);
  const browser = fakeBrowser();
  const evals = [];
  browser.eval = async (expr) => {
    evals.push(expr);
    return encoded({ tag: 'BODY', selector: 'body', bounds: { x: 0, y: 0 }, children: [] });
  };
  await captureAll(p, { browser, origin: ORIGIN, port: 1, minWidth: 300 }, { urls: [page(1)] });
  assert.match(evals[0], /captureVisualTree\(300\)/);
  assert.equal(JSON.parse(await readFile(captureFile(p, page(1)), 'utf8')).minWidth, 300);
});

test('a store behind the cache: capture notes it, chrome fails on it', async () => {
  const p = await project(3);
  await mkdir(capturesDir(p), { recursive: true });
  await writeFile(captureFile(p, page(1)), JSON.stringify({ url: page(1), minWidth: MIN_WIDTH }));
  await writeFile(path.join(capturesDir(p), 'captures.md'), '# store\n');
  await mkdir(p.step('chrome'), { recursive: true });
  const capture = await runCheck('capture', p);
  assert.equal(capture.pass, false);
  assert.equal(capture.note, '2 pages behind the cache');
  assert.match(capture.reasons[0], /2 verified pages without a capture — the store is behind/);
  const chrome = await runCheck('chrome', p);
  const behind = /store is 2 pages behind the cache — run capture.mjs/;
  assert.ok(chrome.reasons.some((r) => behind.test(r)), chrome.reasons.join('; '));
  const states = stepStates({ capture: false, cache: true }, {}, {}, { capture: capture.note });
  assert.equal(states.find((s) => s.id === 'capture').note, '2 pages behind the cache');
  assert.equal(stepStates({ capture: true }, {}, {}, { capture: 'x' })
    .find((s) => s.id === 'capture').note, undefined, 'a done step carries no note');
});

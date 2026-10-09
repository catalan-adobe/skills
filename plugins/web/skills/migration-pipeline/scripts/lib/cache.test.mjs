import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assetOriginsInCache, assetsInWords, cacheRelativePath, cacheSelection, check, classify,
  fill, pageExpression, pending, pendingSelections, siteUrl, storedFacts,
} from './cache.mjs';
import { cacheDir, proxyStarter } from './browser.mjs';
import { data } from './data.mjs';

const O = 'https://a.example/';
const AT = '2026-09-22T10:00:00.000Z';

/** A fake proxy: "stores" sidecars for the URLs it is told the site answers. */
async function fakeSite(cwd, answers) {
  const dir = cacheDir(cwd);
  for (const [url, { status, type, body, location }] of Object.entries(answers)) {
    const rel = cacheRelativePath(url);
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    const headers = {
      ...(type ? { 'content-type': type } : {}), ...(location ? { location } : {}),
    };
    await writeFile(path.join(dir, `${rel}.json`), JSON.stringify({ status, headers }));
    await writeFile(path.join(dir, rel), body ?? '');
  }
}

const fakeIo = ({ failOn = [], dieOn = [], landings = {} } = {}) => {
  const calls = { opened: [], gone: [], evals: 0, proxies: [], fetched: [] };
  let current = null;
  const visit = (list) => async (url) => {
    list.push(url);
    current = url;
    if (failOn.some((f) => url.includes(f))) throw new Error('net::ERR_FAILED');
    if (dieOn.some((f) => url.includes(f))) throw new Error("The browser 'x' is not open");
  };
  return {
    calls,
    sleep: async () => {},
    fetch: async (url) => {
      calls.fetched.push(url);
      return { ok: true, arrayBuffer: async () => {} };
    },
    startProxy: async ({ offline }) => {
      calls.proxies.push(offline);
      return { port: 4000, stop: async () => {} };
    },
    browser: {
      open: visit(calls.opened),
      goto: visit(calls.gone),
      eval: async () => {
        calls.evals += 1;
        const landed = Object.entries(landings).find(([k]) => current.includes(k))?.[1];
        return JSON.stringify(JSON.stringify(landed ?? current));
      },
      close: async () => {},
    },
  };
};

async function project(urls) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mpipe-cache-'));
  const { migration, pages, website, selections } = await data(cwd);
  await migration.init(cwd, { origin: O });
  await pages.upsert(cwd, urls.map((url) => ({ url, discovered: { from: 'list', at: AT } })));
  await website.writeAccess(cwd, { browser: { engine: 'chromium' },
    overlays: [{ selector: '#cmp', action: 'hide', css: ['#cmp{display:none}'] }],
    verifiedOn: [] });
  const ids = (await pages.read(cwd)).pages.map((p) => p.id);
  await selections.create(cwd, 'all', ids);
  await mkdir(path.join(cwd, 'migration', '.work', 'setup'), { recursive: true });
  return cwd;
}

test('pure pieces: page expression, paths, site URLs, classification, stored facts', async () => {
  const expr = pageExpression({ overlays: [{ action: 'hide', css: ['#a{}'] }, { action: 'click' }],
    scrollFix: 'html{}' });
  assert.match(expr, /"#a\{\}\\nhtml\{\}"/);
  assert.match(expr, /loading="lazy"/);
  assert.match(cacheRelativePath(`${O}`), /^a\.example_[0-9a-f]{8}\/index\.html$/);
  assert.match(cacheRelativePath(`${O}blogs/a?x=1`), /\/blogs\/a\/index~!x=1\.html$/);
  assert.notEqual(cacheRelativePath(`${O}x`), cacheRelativePath(`${O}x/`),
    'a redirect from /x to /x/ must not be stored where /x/ is read');
  assert.equal(siteUrl('http://127.0.0.1:4000/p?x=1&_origin=https%3A%2F%2Fa.example',
    'https://a.example'), 'https://a.example/p?x=1');
  assert.equal(classify({ url: 'u', sidecar: null, finalUrl: null }), 'unreachable');
  const status = (code) => ({ status: code, headers: {} });
  assert.equal(classify({ url: 'u', sidecar: status(301), finalUrl: null }), 'redirect');
  assert.equal(classify({ url: 'u', sidecar: status(404), finalUrl: null }), 'error');
  const ok = (type) => ({ status: 200, headers: { 'content-type': type } });
  assert.equal(classify({ url: 'u', sidecar: ok('application/pdf'), finalUrl: null }), 'binary');
  assert.equal(classify({ url: `${O}a`, sidecar: ok('text/html'), finalUrl: `${O}b` }), 'redirect',
    'a client-side redirect: the browser landed elsewhere');
  assert.equal(classify({ url: `${O}a`, sidecar: ok('text/html'), finalUrl: `${O}a#top` }), 'page');
  assert.equal(classify({ url: `${O}a.html`, sidecar: ok('text/html'),
    finalUrl: `${O}a.html?pagesize=10&pageno=1` }), 'page', 'a script wrote its state: same page');
  assert.equal(classify({ url: `${O}a/`, sidecar: ok('text/html'), finalUrl: `${O}a` }), 'page');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mpipe-sf-'));
  await fakeSite(cwd, {
    [`${O}old`]: { status: 301, location: '/mid' }, [`${O}mid`]: { status: 302, location: '/new' },
    [`${O}new`]: { status: 200, type: 'text/html; charset=utf-8', body: '<html>' },
  });
  const old = await storedFacts(cacheDir(cwd), `${O}old`, 'https://a.example');
  assert.deepEqual(old.redirect, { status: 301, target: `${O}new` }, 'the chain is followed');
  const fresh = await storedFacts(cacheDir(cwd), `${O}new`, 'https://a.example');
  assert.deepEqual(fresh.http, { status: 200, contentType: 'text/html', bytes: 6 });
  assert.deepEqual((await storedFacts(cacheDir(cwd), `${O}none`, 'https://a.example')).http, null);
});

test('a selection is cached in one session, verified offline, recorded with verdicts', async () => {
  const cwd = await project([`${O}`, `${O}a`, `${O}old`, `${O}doc.pdf`, `${O}gone`, `${O}jump`]);
  await fakeSite(cwd, {
    [`${O}`]: { status: 200, type: 'text/html', body: 'x' },
    [`${O}a`]: { status: 200, type: 'text/html', body: 'x' },
    [`${O}old`]: { status: 301, location: '/a' },
    [`${O}doc.pdf`]: { status: 200, type: 'application/pdf', body: '%PDF' },
    [`${O}jump`]: { status: 200, type: 'text/html', body: 'x' },
  });
  const io = fakeIo({ failOn: ['/gone'], landings: { '/jump': `${O}a` } });
  const out = await cacheSelection(cwd, 'all', { io, pace: 0 });
  assert.equal(out.visited, 6);
  assert.deepEqual(out.kinds, { page: 2, redirect: 2, binary: 1 },
    'the page whose navigation failed was never asked: no kind');
  const gone = (await data(cwd)).pages.pageId(`${O}gone`);
  assert.deepEqual(out.failures, [[gone, 'net::ERR_FAILED']]);
  assert.deepEqual(io.calls.proxies, [false, true], 'online, then offline');
  assert.equal(io.calls.opened.length, 1, 'one session');
  assert.equal(io.calls.evals, 4, 'no expression on a binary nor on a failed navigation');
  const { pages, runs, website } = await data(cwd);
  const by = Object.fromEntries((await pages.read(cwd)).pages
    .map((p) => [p.url.replace(O, '/'), p]));
  assert.equal(by['/'].kind, 'page');
  assert.deepEqual(by['/'].cache.selection, 'all');
  assert.equal(by['/old'].kind, 'redirect');
  assert.deepEqual(by['/old'].verdict.reasons.map((r) => [r.code, r.detail]),
    [['redirect', `${O}a`]]);
  assert.equal(by['/doc.pdf'].verdict.status, 'out');
  assert.equal(by['/gone'].kind, 'unknown', 'no fact recorded for a failed navigation');
  assert.equal(by['/gone'].cache, null);
  assert.deepEqual(by['/jump'].verdict.reasons.map((r) => r.code), ['redirect'], 'landed on /a');
  assert.equal(by['/a'].verdict.status, 'in');
  const [run] = await runs.list(cwd, { step: 'cache' });
  assert.equal(run.state, 'done');
  assert.match(run.summary,
    /^6 URLs of all visited \(2 page, 2 redirect, 1 binary\); 1 navigation/);
  assert.equal((await website.readWebsite(cwd)).counts.cached, 5);
  assert.deepEqual(await check(cwd), { pass: false, note: 'no selection approved for the cache' });
});

test('pending selections, the check, resumption without force, failure recorded', async () => {
  const cwd = await project([`${O}a`, `${O}b`]);
  const { migration, pages, selections } = await data(cwd);
  await assert.rejects(cacheSelection(cwd, 'nope', { io: fakeIo() }), /no selection nope/);
  await migration.approve(cwd, 'cache', ['all']);
  assert.deepEqual(await pendingSelections(cwd), ['all']);
  assert.deepEqual(await check(cwd), { pass: false, note: 'not yet cached: all' });
  await fakeSite(cwd, { [`${O}a`]: { status: 200, type: 'text/html' } });
  await cacheSelection(cwd, 'all', { io: fakeIo(), pace: 0 });
  assert.deepEqual(await pendingSelections(cwd), ['all'], 'b is unreachable: still pending');
  await fakeSite(cwd, { [`${O}b`]: { status: 200, type: 'text/html' } });
  const io = fakeIo();
  await cacheSelection(cwd, 'all', { io, pace: 0 });
  assert.equal(io.calls.opened.length + io.calls.gone.length, 1, 'only the uncached page');
  assert.deepEqual(await pendingSelections(cwd), []);
  assert.deepEqual(await check(cwd), { pass: true });
  const ids = (await pages.read(cwd)).pages.map((p) => p.id);
  await selections.create(cwd, 'again', ids);
  await migration.approve(cwd, 'cache', ['again']);
  assert.deepEqual(await pendingSelections(cwd), [], 'already cached pages need no new run');
  const broken = fakeIo({ failOn: ['/a', '/b'] });
  const partial = await cacheSelection(cwd, 'again', { io: broken, pace: 0, force: true });
  assert.equal(partial.failures.length, 2, 'two failures in a row are recorded, not fatal');
  const many = await project(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${O}${n}`));
  const dead = fakeIo({ failOn: ['127.0.0.1'] });
  await assert.rejects(cacheSelection(many, 'all', { io: dead, pace: 0 }),
    /5 navigations failed in a row/);
  const { runs } = await data(many);
  const last = (await runs.list(many, { step: 'cache' })).at(-1);
  assert.equal(last.state, 'failed');
  assert.match(last.summary, /^4 of 6 visited before the failure; recorded/);
});

test('assets from other origins: counted from the cached HTML, named, filled', async () => {
  const cwd = await project([`${O}a`, `${O}b`]);
  const cdn = 'https://images.example';
  const html = `<html><img src="${cdn}/1.jpg"><img srcset="${cdn}/2.jpg 1x, ${O}3.jpg 2x">`
    + `<script src="https://tags.example/t.js"></script><script src="${cdn}/x.js"></script>`
    + `<link href="https://fonts.example/f.css"></html>`;
  await fakeSite(cwd, { [`${O}a`]: { status: 200, type: 'text/html', body: html },
    [`${O}b`]: { status: 200, type: 'text/html', body: `<img src="${cdn}/4.jpg">` } });
  const first = await cacheSelection(cwd, 'all', { io: fakeIo(), pace: 0 });
  assert.deepEqual(first.assets, [
    { origin: cdn, assets: 3, scripts: 1 },
    { origin: 'https://fonts.example', assets: 1, scripts: 0 },
    { origin: 'https://tags.example', assets: 0, scripts: 1 },
  ], 'references per origin, the site itself left out, scripts apart');
  const { notes, migration } = await data(cwd);
  const [note] = await notes.list(cwd, { step: 'cache' });
  assert.match(await notes.body(cwd, note.id), /\| https:\/\/images.example \| 3 \| 1 \| no \|/);
  const words = assetsInWords([{ origin: cdn, assets: 12, scripts: 0 }], { assetOrigins: [] });
  assert.match(words, /Not stored: https:\/\/images.example\. An origin that serves images/);
  assert.doesNotMatch(assetsInWords([{ origin: cdn, assets: 12, scripts: 0 }],
    { assetOrigins: [cdn] }), /Not stored/);
  assert.doesNotMatch(assetsInWords([{ origin: cdn, assets: 3, scripts: 0 }],
    { assetOrigins: [] }), /Not stored/, 'three references are not worth a word');
  // Fill: refused without named origins; with them, every cached page visited once more.
  await assert.rejects(pending(cwd, 'fill'), /no asset origins named/);
  await assert.rejects(pending(cwd, 'bogus'), /knows no mode bogus/);
  await migration.assetOrigins(cwd, [cdn]);
  assert.equal((await pending(cwd, 'fill')).length, 2);
  const io = fakeIo();
  const filled = await fill(cwd, { io, pace: 0 });
  assert.equal(filled.visited, 2);
  assert.equal(io.calls.opened.length + io.calls.gone.length, 2);
  const { runs } = await data(cwd);
  const last = (await runs.list(cwd, { step: 'cache' })).at(-1);
  assert.deepEqual([last.input.fill, last.input.assetOrigins], [true, [cdn]]);
  assert.deepEqual(await assetOriginsInCache(cwd), first.assets, 'the same HTML, the same count');
});

test('the proxy is started with the named origins', async () => {
  const spawned = [];
  const io = {
    freePort: async () => 4321,
    spawn: (_, args) => {
      spawned.push(args);
      return { stderr: { on() {} }, exitCode: null, once() {}, kill() {} };
    },
    fetch: async () => ({ ok: true, json: async () => ({ dir: '/c' }) }),
    sleep: async () => {},
  };
  const start = proxyStarter('/p.js', '/c', io, { also: ['https://images.example'] });
  await start({ offline: true });
  assert.deepEqual(spawned[0], ['/p.js', '--port', '4321', '--cache', '/c', '--offline',
    '--also', 'https://images.example']);
  await proxyStarter('/p.js', '/c', io)({ offline: false });
  assert.deepEqual(spawned[1], ['/p.js', '--port', '4321', '--cache', '/c']);
});

test('a browser that is gone is opened again for the next page', async () => {
  const cwd = await project([`${O}a`, `${O}b`, `${O}c`]);
  await fakeSite(cwd, Object.fromEntries(['a', 'b', 'c'].map((n) => (
    [`${O}${n}`, { status: 200, type: 'text/html' }]))));
  const io = fakeIo({ dieOn: ['/b'] });
  const out = await cacheSelection(cwd, 'all', { io, pace: 0 });
  assert.equal(io.calls.opened.length, 2, 'opened for a, again for c after b killed it');
  assert.equal(io.calls.gone.length, 1);
  assert.equal(out.failures.length, 1);
  assert.deepEqual(out.kinds, { page: 2 });
});

test('freePort sees a port held on the loopback interface', async () => {
  const { createServer } = await import('node:net');
  const { freePort } = await import('./browser.mjs');
  const held = createServer();
  await new Promise((r) => { held.listen(0, '127.0.0.1', r); });
  const { port } = held.address();
  try {
    assert.notEqual(await freePort(port), port, 'held on 127.0.0.1: not free');
  } finally {
    held.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cacheRelativePath, cacheSelection, check, classify, pageExpression, pendingSelections,
  siteUrl, storedFacts,
} from './cache.mjs';
import { cacheDir } from './browser.mjs';
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

const fakeIo = ({ failOn = [], landings = {} } = {}) => {
  const calls = { opened: [], gone: [], evals: 0, proxies: [], fetched: [] };
  const visit = (list) => async (url) => {
    list.push(url);
    if (failOn.some((f) => url.includes(f))) throw new Error('net::ERR_FAILED');
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
        const last = [...calls.opened, ...calls.gone].at(-1);
        const landed = Object.entries(landings).find(([k]) => last.includes(k))?.[1];
        return JSON.stringify(JSON.stringify(landed ?? last));
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
  assert.match(cacheRelativePath(`${O}blogs/a?x=1`), /\/blogs\/a\/index!x=1\.html$/);
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
  assert.deepEqual(out.kinds, { page: 2, redirect: 2, binary: 1, unreachable: 1 });
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
  assert.equal(by['/gone'].kind, 'unreachable');
  assert.equal(by['/gone'].cache, null);
  assert.deepEqual(by['/jump'].verdict.reasons.map((r) => r.code), ['redirect'], 'landed on /a');
  assert.equal(by['/a'].verdict.status, 'in');
  const [run] = await runs.list(cwd, { step: 'cache' });
  assert.equal(run.state, 'done');
  assert.match(run.summary,
    /^6 URLs of all visited \(2 page, 2 redirect, 1 binary, 1 unreachable\); 1 navigation/);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cacheRelativePath } from './checks.mjs';
import { resolveProject, writeProject } from './project.mjs';
import { mergeScan, readInventory, writeInventory } from './inventory.mjs';
import {
  classify, parseEval, pendingUrls, siteUrl, warm,
} from './warm.mjs';

const ORIGIN = 'https://site.example';

/**
 * A stand-in for the page-cache proxy: serves `/__status`, `/__stop`, stores whatever is
 * requested with `?_origin=` in the proxy's file layout, and in offline mode answers only
 * from what it stored. `gone` URLs answer 404 online.
 */
function fakeProxy(cacheDir, { gone = new Set(), moved = new Map() } = {}) {
  const stored = new Map();
  let offline = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__status') {
      res.end(JSON.stringify({ cached: stored.size, offline }));
      return;
    }
    if (url.pathname === '/__stop') { res.end('bye'); return; }
    const origin = url.searchParams.get('_origin') ?? ORIGIN;
    url.searchParams.delete('_origin');
    const target = `${origin}${url.pathname}${url.search}`;
    if (offline) {
      if (!stored.has(target)) { res.statusCode = 404; res.end('miss'); return; }
      res.end(stored.get(target));
      return;
    }
    const store = async (t, status, headers, body) => {
      const file = path.join(cacheDir, cacheRelativePath(t));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
      await writeFile(`${file}.json`, JSON.stringify({ status, headers }));
      stored.set(t, body);
    };
    if (gone.has(target)) {
      await store(target, 404, { 'content-type': 'text/html' }, 'not found');
      res.statusCode = 404; res.end('gone'); return;
    }
    if (moved.has(target)) {
      // Like the real proxy: a same-origin Location is rewritten to route through the proxy.
      const to = new URL(moved.get(target));
      const viaProxy = `http://${req.headers.host}${to.pathname}${to.search}`;
      await store(target, 301, { 'content-type': 'text/html', location: viaProxy }, '');
      res.statusCode = 301; res.setHeader('location', viaProxy); res.end(); return;
    }
    const type = target.endsWith('.css') ? 'text/css'
      : target.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8';
    const body = target.endsWith('.css') ? 'body{}' : `<html>${target}</html>`;
    await store(target, 200, { 'content-type': type }, body);
    res.setHeader('content-type', type);
    res.end(body);
  });
  return {
    server,
    setOffline(value) { offline = value; },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => server.close(r)),
  };
}

async function project() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cpv2-warm-'));
  const p = resolveProject(cwd);
  await writeProject(p, {
    origin: `${ORIGIN}/`, cacheAllUpTo: 500, approved: { cache: true }, cacheSelection: ['s'],
  });
  await mkdir(path.join(p.dir, 'urls/subsets'), { recursive: true });
  await mkdir(path.join(p.dir, 'probe'), { recursive: true });
  await mkdir(path.join(p.dir, 'prep'), { recursive: true });
  await writeFile(path.join(p.dir, 'urls/subsets/s.txt'),
    `${ORIGIN}/\n${ORIGIN}/a.html\n${ORIGIN}/missing.html\n`);
  await writeFile(path.join(p.dir, 'probe/playwright-config.json'), '{"browser":{}}');
  await writeFile(path.join(p.dir, 'probe/browser-recipe.json'), '{"persistent":false}');
  await writeFile(path.join(p.dir, 'prep/page-prep.json'), JSON.stringify({
    checked: [`${ORIGIN}/`],
    overlays: [{ id: 'cmp', selector: '#cmp', hide: { css: ['#cmp { display: none }'] } }],
    scroll_fix: null,
  }));
  return p;
}

/** A browser that, like a real one, fetches the page and one stylesheet through the proxy. */
function fakeBrowser(log, { landsOn = new Map() } = {}) {
  let current = null;
  const visit = async (url) => {
    log.push(['goto', url]);
    const res = await fetch(url, { redirect: 'follow' });
    if (res.ok) await fetch(new URL('/theme.css', url).href);
    const requested = new URL(url);
    const site = `${ORIGIN}${requested.pathname}${requested.search}`
      .replace(/[?&]_origin=[^&]*/, '');
    current = landsOn.get(site) ?? res.url ?? url;
    return res.ok;
  };
  return {
    open: async (url, opts) => { log.push(['open', opts]); return visit(url); },
    goto: visit,
    eval: async (expr) => {
      log.push(['eval', expr]);
      if (expr.includes('location.href')) return JSON.stringify(current);
      if (/fetch\(/.test(expr)) {
        const m = expr.match(/fetch\("([^"]+)"/);
        const res = await fetch(m[1]);
        await res.arrayBuffer();
        return JSON.stringify({ status: res.status, contentType: res.headers.get('content-type') });
      }
      return 'ok';
    },
    close: async () => { log.push(['close']); },
  };
}

test('warm drives the browser through the proxy, verifies offline, writes cache.md', async () => {
  const p = await project();
  const cacheDir = path.join(p.dir, 'cache/.page-cache');
  const proxy = fakeProxy(cacheDir, { gone: new Set([`${ORIGIN}/missing.html`]) });
  const log = [];
  const result = await warm(p, {
    startProxy: async ({ offline }) => {
      proxy.setOffline(offline);
      const port = await proxy.listen();
      return { port, stop: () => proxy.close() };
    },
    browser: fakeBrowser(log),
    pace: 0,
  });
  assert.equal(result.cached, 3, 'a source 404 is a stored response, not a cache failure');
  assert.equal(result.failed, 0);
  assert.deepEqual(result.kinds, { page: 2, error: 1 });
  assert.ok(result.assets >= 1, 'a stylesheet came through the proxy');
  assert.equal(result.pass, true);
  const md = await readFile(path.join(p.dir, 'cache/cache.md'), 'utf8');
  assert.match(md, new RegExp(`\\| ${ORIGIN}/a.html \\| cached \\| page \\|`));
  const errorRow = `\\| ${ORIGIN}/missing.html \\| cached \\| error \\| \\d+ \\| s \\| 404`;
  assert.match(md, new RegExp(errorRow));
  assert.ok(log.some(([k, v]) => k === 'eval' && v.includes('#cmp')), 'hide rules injected');
  assert.ok(log[0][0] === 'open' && log[0][1].config.endsWith('playwright-config.json'));
  assert.ok(log.at(-1)[0] === 'close');
  const report = await readFile(p.report, 'utf8');
  assert.match(report, /## cache\n\n.*3 cached, 0 failed, 0 skipped; 2 page, 1 error/s);
});

test('warm refuses without the recorded approval and when the selection is empty', async () => {
  const p = await project();
  const data = JSON.parse(await readFile(p.projectFile, 'utf8'));
  await writeProject(p, { ...data, approved: {} });
  await assert.rejects(() => warm(p, {}), /not approved; run status\.mjs approve cache/);
  await writeProject(p, { ...data, cacheSelection: ['empty'] });
  await writeFile(path.join(p.dir, 'urls/subsets/empty.txt'), '');
  await assert.rejects(() => warm(p, {}), /cacheSelection resolves to no URLs/);
});

test('the cache path of a stored page is where check cache looks', () => {
  const url = `${ORIGIN}/a.html`;
  const hash = createHash('sha256').update(ORIGIN).digest('hex').slice(0, 8);
  assert.equal(cacheRelativePath(url), `site.example_${hash}/a.html`);
});

test('cache.md carries the time each page took in the browser', async () => {
  const p = await project();
  const proxy = fakeProxy(path.join(p.dir, 'cache/.page-cache'));
  const log = [];
  await warm(p, {
    startProxy: async ({ offline }) => {
      proxy.setOffline(offline);
      const port = await proxy.listen();
      return { port, stop: () => proxy.close() };
    },
    browser: fakeBrowser(log),
    pace: 0,
  });
  const md = await readFile(path.join(p.dir, 'cache/cache.md'), 'utf8');
  assert.match(md, /\| url \| status \| kind \| ms \| selection \| note \|/);
  assert.match(md, new RegExp(`\\| ${ORIGIN}/a.html \\| cached \\| page \\| \\d+ \\|`));
});

test('classify derives kind and migrate from the sidecar, the final URL and the request', () => {
  const html = { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } };
  const url = `${ORIGIN}/a.html`;
  assert.deepEqual(classify({ url, sidecar: html, finalUrl: url }),
    { kind: 'page', migrate: 'yes' });
  const pdf = { status: 200, headers: { 'content-type': 'application/pdf' } };
  assert.deepEqual(classify({ url: `${ORIGIN}/d.pdf`, sidecar: pdf, finalUrl: null }),
    { kind: 'binary', migrate: 'asset' });
  const moved = { status: 301, headers: { location: `${ORIGIN}/b.html` } };
  assert.deepEqual(classify({ url, sidecar: moved, finalUrl: `${ORIGIN}/b.html` }),
    { kind: 'redirect', migrate: 'target' });
  assert.deepEqual(classify({ url, sidecar: html, finalUrl: `${ORIGIN}/c.html` }),
    { kind: 'redirect', migrate: 'target' }, 'a client-side redirect: 200 but landed elsewhere');
  assert.deepEqual(classify({ url, sidecar: html, finalUrl: `${url}#top` }),
    { kind: 'page', migrate: 'yes' }, 'a fragment is not a redirect');
  assert.deepEqual(classify({ url, sidecar: { status: 404, headers: {} }, finalUrl: url }),
    { kind: 'error', migrate: 'no' });
  assert.deepEqual(classify({ url, sidecar: null, finalUrl: null }),
    { kind: 'unreachable', migrate: 'no' });
});

test('siteUrl maps a proxy address back to the site and drops the fragment', () => {
  assert.equal(siteUrl('http://127.0.0.1:3002/a/b.html?x=1&_origin=https%3A%2F%2Fsite.example#f',
    ORIGIN), `${ORIGIN}/a/b.html?x=1`);
  assert.equal(siteUrl('https://other.example/landed', ORIGIN), 'https://other.example/landed');
  assert.equal(siteUrl('not a url', ORIGIN), null);
});

test('warm records http facts, redirects and finalUrl into the inventory', async () => {
  const p = await project();
  const target = `${ORIGIN}/a.html`;
  const cacheDir = path.join(p.dir, 'cache/.page-cache');
  const proxy = fakeProxy(cacheDir, {
    gone: new Set([`${ORIGIN}/missing.html`]),
    moved: new Map([[`${ORIGIN}/old.html`, target]]),
  });
  const paths = ['/', '/a.html', '/missing.html', '/old.html', '/doc.pdf'];
  await writeFile(path.join(p.dir, 'urls/subsets/s.txt'),
    paths.map((rel) => `${ORIGIN}${rel}\n`).join(''));
  await writeInventory(path.join(p.dir, 'urls'), mergeScan([], [
    { url: `${ORIGIN}/` }, { url: target }, { url: `${ORIGIN}/missing.html` },
    { url: `${ORIGIN}/old.html` }, { url: `${ORIGIN}/doc.pdf` },
  ]));
  const log = [];
  const result = await warm(p, {
    startProxy: async ({ offline }) => {
      proxy.setOffline(offline);
      const port = await proxy.listen();
      return { port, stop: () => proxy.close() };
    },
    browser: fakeBrowser(log, { landsOn: new Map([[`${ORIGIN}/old.html`, target]]) }),
    pace: 0,
  });
  const inv = await readInventory(path.join(p.dir, 'urls'));
  const by = Object.fromEntries(inv.map((r) => [r.url, r]));
  assert.equal(by[target].kind, 'page');
  assert.equal(by[target].http.status, 200);
  assert.equal(by[target].http.contentType, 'text/html');
  assert.ok(by[target].http.bytes > 0);
  assert.equal(by[target].cache.selection, 's');
  assert.equal(by[`${ORIGIN}/old.html`].kind, 'redirect');
  assert.equal(by[`${ORIGIN}/old.html`].redirect.target, target);
  assert.equal(by[`${ORIGIN}/old.html`].redirect.status, 301);
  assert.equal(by[`${ORIGIN}/old.html`].redirect.targetInList, true);
  assert.equal(by[`${ORIGIN}/old.html`].migrate, 'target');
  assert.equal(by[`${ORIGIN}/missing.html`].kind, 'error');
  assert.equal(by[`${ORIGIN}/missing.html`].migrate, 'no');
  assert.equal(by[`${ORIGIN}/doc.pdf`].kind, 'binary');
  assert.ok(log.some(([k, v]) => k === 'eval' && /fetch\(/.test(v) && v.includes('doc.pdf')),
    'a binary is fetched from the page, not navigated to');
  assert.ok(log.some(([k, v]) => k === 'eval' && v.includes('location.href')), 'finalUrl read');
  assert.equal(result.kinds.page, 2);
  assert.equal(result.kinds.redirect, 1);
  assert.equal(result.kinds.error, 1);
  assert.equal(result.kinds.binary, 1);
  const md = await readFile(path.join(p.dir, 'cache/cache.md'), 'utf8');
  assert.match(md, /\| url \| status \| kind \| ms \| selection \| note \|/);
  const movedRow = `\\| ${ORIGIN}/old.html \\| cached \\| redirect \\| \\d+ \\| s \\| 301 → `
    + target;
  assert.match(md, new RegExp(movedRow));
  const errorRow = `\\| ${ORIGIN}/missing.html \\| cached \\| error \\| \\d+ \\| s \\| 404`;
  assert.match(md, new RegExp(errorRow));
});

test('parseEval unwraps the CLI encoding and our own JSON.stringify once each', () => {
  assert.equal(parseEval('"\\"https://x.example/a\\""'), 'https://x.example/a');
  assert.equal(parseEval('"https://x.example/a"'), 'https://x.example/a');
  assert.deepEqual(parseEval('"{\\"status\\":200}"'), { status: 200 });
  assert.equal(parseEval('ok'), 'ok');
  assert.equal(parseEval(''), null);
});

test('warm runs a queued job: progress per URL, stop between URLs, phases accumulate', async () => {
  const p = await project();
  const cacheDir = path.join(p.dir, 'cache/.page-cache');
  const proxy = fakeProxy(cacheDir);
  const io = {
    startProxy: async ({ offline }) => {
      proxy.setOffline(offline);
      const port = await proxy.listen();
      return { port, stop: () => proxy.close() };
    },
    browser: fakeBrowser([]),
    pace: 0,
  };
  const progress = [];
  let stop = false;
  const first = await warm(p, io, {
    selection: 'blogs',
    urls: [`${ORIGIN}/`, `${ORIGIN}/a.html`, `${ORIGIN}/b.html`],
    onProgress: (x) => { progress.push(x); if (x.done === 2) stop = true; },
    shouldStop: () => stop,
  });
  assert.deepEqual([first.cached, first.skipped], [2, 1], 'stopped after two of three');
  assert.deepEqual(progress.filter((x) => x.current).map((x) => x.current),
    [`${ORIGIN}/`, `${ORIGIN}/a.html`]);
  assert.deepEqual(progress.at(-1), { failed: 0 });
  const second = await warm(p, io, { selection: 'ja-jp', urls: [`${ORIGIN}/b.html`] });
  assert.deepEqual([second.cached, second.skipped], [1, 0]);
  const md = await readFile(path.join(p.dir, 'cache/cache.md'), 'utf8');
  assert.match(md, /Visited so far: 3 URLs over 2 selection\(s\) \(blogs; ja-jp\)/);
  assert.match(md, new RegExp(`\\| ${ORIGIN}/a.html \\| cached \\| page \\| \\d+ \\| blogs \\|`));
  assert.match(md, new RegExp(`\\| ${ORIGIN}/b.html \\| cached \\| page \\| \\d+ \\| ja-jp \\|`));
  const report = await readFile(p.report, 'utf8');
  assert.match(report, /Selection ja-jp: 1 cached, 0 failed, 0 skipped; 1 page\. In total 3 of 3/);
});

test('pendingUrls leaves out URLs with a stored body, whichever selection stored it', () => {
  const inventory = [
    { url: 'https://x/a', cache: { path: 'x/a', selection: 'blogs' } },
    { url: 'https://x/b', cache: { path: null, selection: 'blogs' } },
    { url: 'https://x/c', cache: { path: 'x/c', selection: 'other' } },
    { url: 'https://x/d' },
  ];
  const urls = ['https://x/a', 'https://x/b', 'https://x/c', 'https://x/d'];
  assert.deepEqual(pendingUrls(inventory, urls), ['https://x/b', 'https://x/d']);
  assert.deepEqual(pendingUrls([], urls), urls);
});

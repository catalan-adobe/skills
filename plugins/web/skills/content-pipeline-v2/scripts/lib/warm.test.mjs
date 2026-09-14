import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cacheRelativePath } from './checks.mjs';
import { resolveProject, writeProject } from './project.mjs';
import { warm } from './warm.mjs';

const ORIGIN = 'https://site.example';

/**
 * A stand-in for the page-cache proxy: serves `/__status`, `/__stop`, stores whatever is
 * requested with `?_origin=` in the proxy's file layout, and in offline mode answers only
 * from what it stored. `gone` URLs answer 404 online.
 */
function fakeProxy(cacheDir, { gone = new Set() } = {}) {
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
    if (gone.has(target)) { res.statusCode = 404; res.end('gone'); return; }
    const body = target.endsWith('.css') ? 'body{}' : `<html>${target}</html>`;
    const file = path.join(cacheDir, cacheRelativePath(target));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.json`, '{"status":200,"headers":{}}');
    stored.set(target, body);
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
function fakeBrowser(log) {
  const visit = async (url) => {
    log.push(['goto', url]);
    const res = await fetch(url);
    if (res.ok) await fetch(new URL('/theme.css', url).href);
    return res.ok;
  };
  return {
    open: async (url, opts) => { log.push(['open', opts]); return visit(url); },
    goto: visit,
    eval: async (expr) => { log.push(['eval', expr]); return 'ok'; },
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
  assert.equal(result.cached, 2);
  assert.equal(result.failed, 1);
  assert.ok(result.assets >= 1, 'a stylesheet came through the proxy');
  assert.equal(result.pass, false, 'one URL failed');
  const md = await readFile(path.join(p.dir, 'cache/cache.md'), 'utf8');
  assert.match(md, new RegExp(`\\| ${ORIGIN}/a.html \\| cached \\|`));
  assert.match(md, new RegExp(`\\| ${ORIGIN}/missing.html \\| failed \\| \\d+ \\| 404`));
  assert.ok(log.some(([k, v]) => k === 'eval' && v.includes('#cmp')), 'hide rules injected');
  assert.ok(log[0][0] === 'open' && log[0][1].config.endsWith('playwright-config.json'));
  assert.ok(log.at(-1)[0] === 'close');
  const report = await readFile(p.report, 'utf8');
  assert.match(report, /## cache\n\n.*2 cached, 1 failed/s);
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
  assert.match(md, /\| url \| status \| ms \| note \|/);
  assert.match(md, new RegExp(`\\| ${ORIGIN}/a.html \\| cached \\| \\d+ \\|`));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./page-cache.js', import.meta.url));

const listen = (handler) => new Promise((resolve) => {
  const s = createServer(handler);
  s.listen(0, '127.0.0.1', () => (
    resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` })));
});

async function proxy(args) {
  const child = spawn(process.execPath, [SCRIPT, '--port', '0', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /proxy on http:\/\/localhost:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (c) => reject(new Error(`proxy exited ${c}: ${out}`)));
  });
  const stop = () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); });
  return { url: `http://127.0.0.1:${port}`, stop };
}

test('--also: another origin\'s assets go through the proxy, cached, served offline', async () => {
  const hits = { site: 0, cdn: 0 };
  const cdn = await listen((req, res) => {
    hits.cdn += 1;
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(`jpeg:${req.url}`);
  });
  const site = await listen((req, res) => {
    hits.site += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body><img src="${cdn.origin}/a.jpg">`
      + `<img srcset="${cdn.origin}/b.jpg?w=1 1x, ${cdn.origin}/b.jpg?w=2 2x">`
      + `<a href="${cdn.origin}">cdn</a><a href="${cdn.origin}.evil/x">not cdn</a>`
      + `<style>.h{background:url(${cdn.origin}/c.png)}</style></body></html>`);
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'page-cache-also-'));
  const enc = encodeURIComponent(cdn.origin);
  try {
    // 1. Cached without --also: the page keeps the CDN's absolute URLs.
    const plain = await proxy(['--cache', dir]);
    const first = await fetch(`${plain.url}/?_origin=${site.origin}`).then((r) => r.text());
    assert.match(first, new RegExp(`src="${cdn.origin}/a.jpg"`));
    await plain.stop();

    // 2. With --also, the same cached page is served rewritten; assets fetched once.
    const also = await proxy(['--cache', dir, '--also', cdn.origin]);
    const status = await fetch(`${also.url}/__status`).then((r) => r.json());
    assert.deepEqual(status.also, [cdn.origin]);
    const res = await fetch(`${also.url}/?_origin=${site.origin}`);
    const html = await res.text();
    assert.equal(res.headers.get('x-page-cache'), 'hit');
    assert.equal(hits.site, 1, 'not fetched again');
    assert.match(html, new RegExp(`src="/a.jpg\\?_origin=${enc}"`));
    assert.match(html,
      new RegExp(`srcset="/b.jpg\\?w=1&_origin=${enc} 1x, /b.jpg\\?w=2&_origin=${enc} 2x"`));
    assert.match(html, new RegExp(`href="/\\?_origin=${enc}"`), 'a bare origin');
    assert.match(html, new RegExp(`href="${cdn.origin}.evil/x"`), 'another host untouched');
    assert.match(html, new RegExp(`url\\(/c.png\\?_origin=${enc}\\)`));
    const img = await fetch(`${also.url}/a.jpg?_origin=${enc}`,
      { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(img.status, 200);
    assert.equal(await img.text(), 'jpeg:/a.jpg');
    assert.equal(img.headers.get('set-cookie'), null, 'an asset origin is never the page origin');
    assert.equal(hits.cdn, 1);
    await fetch(`${also.url}/b.jpg?w=1&_origin=${enc}`).then((r) => r.arrayBuffer());
    assert.equal(hits.cdn, 2);
    await also.stop();

    // 3. Offline: page and assets from the cache, page still rewritten.
    const offline = await proxy(['--cache', dir, '--also', cdn.origin, '--offline']);
    const off = await fetch(`${offline.url}/?_origin=${site.origin}`).then((r) => r.text());
    assert.match(off, new RegExp(`src="/a.jpg\\?_origin=${enc}"`));
    const offImg = await fetch(`${offline.url}/a.jpg?_origin=${enc}`);
    assert.equal(offImg.status, 200);
    assert.equal(await offImg.text(), 'jpeg:/a.jpg');
    assert.equal((await fetch(`${offline.url}/zzz.jpg?_origin=${enc}`)).status, 504);
    assert.equal(hits.cdn, 2, 'nothing fetched offline');
    await offline.stop();
  } finally {
    cdn.server.close();
    site.server.close();
  }
});

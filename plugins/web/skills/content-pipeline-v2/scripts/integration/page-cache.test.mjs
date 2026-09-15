// Contract with the real page-cache proxy: what warm.mjs and check cache assume about it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheRelativePath } from '../lib/checks.mjs';
import { freePort } from '../lib/ports.mjs';
import { proxyStarter } from '../lib/warm-cli.mjs';
import { need, pageCacheScript, startSite } from './helpers.mjs';

const via = (port, origin, p) => (
  `http://127.0.0.1:${port}${p}?_origin=${encodeURIComponent(origin)}`);

test('page-cache proxy: stores bodies and sidecars where cacheRelativePath expects them',
  async (t) => {
    const script = await need(t, 'page-cache (sibling skill)', pageCacheScript);
    const site = await startSite();
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'cpv2-proxy-'));
    const start = proxyStarter(script, cacheDir, {
      freePort, execPath: process.execPath, spawn: (await import('node:child_process')).spawn,
      fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    });
    const proxy = await start({ offline: false });
    try {
      for (const p of ['/a.html', '/old.html', '/missing.html', '/doc.pdf', '/hop.html']) {
        const res = await fetch(via(proxy.port, site.origin, p), { redirect: 'manual' });
        await res.arrayBuffer();
      }
      for (const p of ['/a.html', '/old.html', '/missing.html', '/doc.pdf']) {
        const rel = cacheRelativePath(`${site.origin}${p}`);
        await stat(path.join(cacheDir, rel));
        const sidecar = JSON.parse(await readFile(path.join(cacheDir, `${rel}.json`), 'utf8'));
        assert.equal(typeof sidecar.status, 'number', `${p} sidecar has a status`);
        assert.equal(typeof sidecar.headers, 'object', `${p} sidecar has headers`);
      }
      const moved = JSON.parse(await readFile(
        path.join(cacheDir, `${cacheRelativePath(`${site.origin}/old.html`)}.json`), 'utf8',
      ));
      assert.deepEqual([moved.status, moved.headers.location], [301, '/a.html'],
        'a redirect is stored with its location, not followed');
      const hop = JSON.parse(await readFile(
        path.join(cacheDir, `${cacheRelativePath(`${site.origin}/hop.html`)}.json`), 'utf8',
      ));
      assert.equal(hop.status, 302);
      const gone = JSON.parse(await readFile(
        path.join(cacheDir, `${cacheRelativePath(`${site.origin}/missing.html`)}.json`), 'utf8',
      ));
      assert.equal(gone.status, 404, 'a 404 is a stored response');
      const pdf = JSON.parse(await readFile(
        path.join(cacheDir, `${cacheRelativePath(`${site.origin}/doc.pdf`)}.json`), 'utf8',
      ));
      assert.match(pdf.headers['content-type'], /application\/pdf/);
      const status = await fetch(`http://127.0.0.1:${proxy.port}/__status`).then((r) => r.json());
      assert.equal(status.offline, false);
      assert.ok(status.cached >= 5, `/__status counts stored responses (${status.cached})`);
    } finally {
      await proxy.stop();
    }

    await site.close();
    const offline = await start({ offline: true });
    try {
      const res = await fetch(via(offline.port, site.origin, '/a.html'));
      assert.equal(res.status, 200, 'served from disk with the site gone');
      assert.match(await res.text(), /Page A/);
      const status = await fetch(`http://127.0.0.1:${offline.port}/__status`).then((r) => r.json());
      assert.equal(status.offline, true);
      const miss = await fetch(via(offline.port, site.origin, '/never-fetched.html'));
      assert.notEqual(miss.status, 200, 'offline, an unknown URL is not fetched');
    } finally {
      await offline.stop();
    }
  });

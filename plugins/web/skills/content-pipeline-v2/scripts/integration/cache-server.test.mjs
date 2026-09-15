// Contract with the real page-cache proxy in offline mode: what `status.mjs cache …` assumes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freePort } from '../lib/ports.mjs';
import { proxyStarter } from '../lib/warm-cli.mjs';
import { resolveProject, writeProject } from '../lib/project.mjs';
import {
  cacheDirOf, cacheGet, cacheServerStatus, proxiedUrl, serveCache, stopCacheServer,
} from '../lib/cache-server.mjs';
import { need, pageCacheScript, startSite } from './helpers.mjs';

test('cache serve replays stored pages offline and never contacts the site', async (t) => {
  const script = await need(t, 'page-cache (sibling skill)', pageCacheScript);
  const site = await startSite();
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-cs-int-'));
  const project = resolveProject(root);
  await writeProject(project, { origin: `${site.origin}/`, cacheAllUpTo: 500 });
  const online = await proxyStarter(script, cacheDirOf(project), {
    freePort, execPath: process.execPath, spawn: (await import('node:child_process')).spawn,
    fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
  })({ offline: false });
  try {
    await fetch(proxiedUrl(site.origin, `${site.origin}/a.html`, online.port))
      .then((r) => r.text());
  } finally {
    await online.stop();
  }
  const hitsBefore = site.hits.length;

  const served = await serveCache(project, script, freePort);
  try {
    assert.deepEqual([served.offline, served.reused], [true, false]);
    const again = await serveCache(project, script, freePort);
    assert.deepEqual([again.port, again.reused], [served.port, true]);

    const viaProxy = await fetch(proxiedUrl(site.origin, `${site.origin}/a.html`, served.port));
    assert.equal(viaProxy.status, 200);
    assert.match(await viaProxy.text(), /Page A/);
    assert.match((await cacheGet(project, `${site.origin}/a.html`)).toString(), /Page A/,
      'get reads the same stored body');

    const miss = await fetch(proxiedUrl(site.origin, `${site.origin}/b.html`, served.port));
    assert.equal(miss.status, 504, 'an offline miss is a 504, not a fetch');
    assert.equal(site.hits.length, hitsBefore, 'the site saw no request while offline');

    const status = await cacheServerStatus(project);
    assert.equal(status.misses, 1);
    assert.ok(status.cached >= 1);
  } finally {
    const stopped = await stopCacheServer(project);
    assert.equal(stopped.stopped, true);
    await site.close();
  }
  for (let i = 0; i < 20 && await cacheServerStatus(project); i += 1) {
    await new Promise((r) => { setTimeout(r, 100); });
  }
  assert.equal(await cacheServerStatus(project), null, 'stopped server is gone');
});

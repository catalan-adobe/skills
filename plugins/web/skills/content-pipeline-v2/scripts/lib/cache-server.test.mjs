import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject, writeProject } from './project.mjs';
import { writeInventory } from './inventory.mjs';
import { cacheRelativePath } from './checks.mjs';
import {
  cacheDirOf, cacheGet, cacheHas, cacheLs, cacheServerStatus, proxiedUrl, serveCache,
  stopCacheServer,
} from './cache-server.mjs';

const ORIGIN = 'https://site.example';

async function project({ withCache = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-cs-'));
  const p = resolveProject(root);
  await writeProject(p, { origin: `${ORIGIN}/`, cacheAllUpTo: 500 });
  if (withCache) {
    const rel = cacheRelativePath(`${ORIGIN}/a.html`);
    const file = path.join(cacheDirOf(p), rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '<html>a</html>');
    await writeFile(`${file}.json`, JSON.stringify({ status: 200, headers: { 'x-h': '1' } }));
  }
  return p;
}

// A fake proxy: `answersAfter` polls before /__status is ok; `dir` is what it reports.
const fakeIo = ({ answersAfter = 0, dir, dies = false } = {}) => {
  const calls = { spawned: [], killed: [] };
  const alive = new Set();
  let polls = 0;
  const io = {
    spawn: async (script, port, cacheDir, logFile) => {
      calls.spawned.push({ script, port, cacheDir, logFile });
      if (!dies) alive.add(7);
      return 7;
    },
    status: async () => {
      polls += 1;
      if (polls <= answersAfter || !alive.has(7)) return null;
      return { cached: 3, hits: 1, misses: 0, dir: dir ?? calls.spawned[0]?.cacheDir };
    },
    alive: (pid) => alive.has(pid),
    kill: (pid) => { calls.killed.push(pid); alive.delete(pid); },
    sleep: async () => {},
  };
  return { io, calls, alive };
};

test('serve starts the offline proxy on a free port, records it, reuses it, stops it', async () => {
  const p = await project();
  const { io, calls } = fakeIo({ answersAfter: 2 });
  const first = await serveCache(p, '/skills/page-cache.js', async (from) => from + 1, io);
  assert.deepEqual(
    [first.port, first.pid, first.offline, first.reused, first.cached], [3002, 7, true, false, 3],
  );
  assert.equal(calls.spawned[0].script, '/skills/page-cache.js');
  assert.equal(calls.spawned[0].cacheDir, cacheDirOf(p));
  assert.match(calls.spawned[0].logFile, /cache-server\.log$/);
  const recorded = JSON.parse(await readFile(path.join(p.work, 'cache-server.json'), 'utf8'));
  assert.equal(recorded.port, 3002);
  const config = JSON.parse(await readFile(first.browserConfig, 'utf8'));
  assert.deepEqual(config.network, { allowedOrigins: ['http://127.0.0.1:3002'] },
    'the browser config lets the browser reach the proxy and nothing else');
  const second = await serveCache(p, '/skills/page-cache.js', async () => 9999, io);
  assert.deepEqual([second.port, second.reused], [3002, true], 'the live server is reused');
  assert.equal(second.browserConfig, first.browserConfig);
  assert.equal(calls.spawned.length, 1);
  assert.deepEqual(await cacheServerStatus(p, io), {
    ...recorded, cached: 3, hits: 1, misses: 0,
  });
  assert.deepEqual(await stopCacheServer(p, io), { stopped: true, pid: 7, port: 3002 });
  assert.deepEqual(calls.killed, [7]);
  assert.equal(await cacheServerStatus(p, io), null);
  assert.deepEqual(await stopCacheServer(p, io), {
    stopped: false, reason: 'no cache server is recorded',
  });
});

test('the browser config keeps the probe\'s settings under the network restriction', async () => {
  const p = await project();
  await mkdir(p.step('probe'), { recursive: true });
  await writeFile(path.join(p.step('probe'), 'playwright-config.json'), JSON.stringify({
    browser: { browserName: 'chromium', launchOptions: { args: ['--x'] } },
    network: { blockedOrigins: ['https://ads.example'] },
  }));
  const served = await serveCache(p, '/s.js', async () => 3002, fakeIo().io);
  const config = JSON.parse(await readFile(served.browserConfig, 'utf8'));
  assert.deepEqual(config.browser.launchOptions.args, ['--x']);
  assert.deepEqual(config.network, {
    blockedOrigins: ['https://ads.example'], allowedOrigins: ['http://127.0.0.1:3002'],
  });
});

test('a recorded server that is dead or serves another directory is not reused', async () => {
  const p = await project();
  const dead = fakeIo();
  await serveCache(p, '/s.js', async () => 3002, dead.io);
  dead.alive.delete(7);
  const again = await serveCache(p, '/s.js', async () => 3003, dead.io);
  assert.deepEqual([again.port, again.reused], [3003, false], 'dead pid → a new server');

  const other = fakeIo({ dir: '/somewhere/else' });
  await writeFile(path.join(p.work, 'cache-server.json'), JSON.stringify({
    pid: 7, port: 3002, dir: cacheDirOf(p),
  }));
  other.alive.add(7);
  assert.equal(await cacheServerStatus(p, other.io), null, 'foreign dir → not ours');
});

test('serve fails with the log path when the proxy dies or never answers', async () => {
  const p = await project();
  const { io, calls } = fakeIo({ dies: true });
  await assert.rejects(
    serveCache(p, '/s.js', async () => 3002, io), /did not answer on port 3002; see .*\.log/,
  );
  assert.deepEqual(calls.killed, [7]);
});

test('serve refuses when nothing is cached yet', async () => {
  const p = await project({ withCache: false });
  await assert.rejects(serveCache(p, '/s.js', async () => 1, fakeIo().io), /no cache at .*; the/);
});

test('proxiedUrl keeps path and query, adds _origin, refuses another origin', () => {
  assert.equal(proxiedUrl(`${ORIGIN}/`, `${ORIGIN}/a/b.html?x=1`, 3002),
    'http://127.0.0.1:3002/a/b.html?x=1&_origin=https%3A%2F%2Fsite.example');
  assert.equal(proxiedUrl(ORIGIN, `${ORIGIN}/`, 3002),
    'http://127.0.0.1:3002/?_origin=https%3A%2F%2Fsite.example');
  assert.throws(() => proxiedUrl(ORIGIN, 'https://cdn.example/x', 1), /not on the project origin/);
});

test('ls filters cached inventory records; has and get read the directory', async () => {
  const p = await project();
  await mkdir(p.step('urls'), { recursive: true });
  await writeInventory(p.step('urls'), [
    { url: `${ORIGIN}/a.html`, group: 'a', kind: 'page', cache: { path: 'x' } },
    { url: `${ORIGIN}/b.html`, group: 'b', kind: 'page', cache: { path: 'y' } },
    { url: `${ORIGIN}/c.pdf`, group: 'a', kind: 'binary', cache: { path: 'z' } },
    { url: `${ORIGIN}/d.html`, group: 'a', kind: 'page', cache: { path: null } },
  ]);
  assert.deepEqual(await cacheLs(p), [`${ORIGIN}/a.html`, `${ORIGIN}/b.html`, `${ORIGIN}/c.pdf`]);
  assert.deepEqual(await cacheLs(p, { group: 'a', kind: 'page' }), [`${ORIGIN}/a.html`]);
  assert.equal(await cacheHas(p, `${ORIGIN}/a.html`), true);
  assert.equal(await cacheHas(p, `${ORIGIN}/b.html`), false, 'inventory says yes, disk says no');
  assert.equal((await cacheGet(p, `${ORIGIN}/a.html`)).toString(), '<html>a</html>');
  assert.deepEqual(await cacheGet(p, `${ORIGIN}/a.html`, { headers: true }), {
    status: 200, headers: { 'x-h': '1' }, body: '<html>a</html>',
  });
  await assert.rejects(cacheGet(p, `${ORIGIN}/b.html`), /is not cached \(no migration\/cache/);
});

test('serve moves to another port when a foreign proxy answers on the one it picked', async () => {
  const p = await project();
  const calls = { spawned: [], killed: [] };
  const alive = new Set();
  const io = {
    spawn: async (script, port) => { calls.spawned.push(port); alive.add(port); return port; },
    // 3002 is held by another project's server (its /__status names another directory).
    status: async (port) => (alive.has(port) || port === 3002
      ? {
        cached: 1, hits: 0, misses: 0, dir: port === 3002 ? '/other/project/cache' : cacheDirOf(p),
      }
      : null),
    alive: (pid) => alive.has(pid),
    kill: (pid) => { calls.killed.push(pid); alive.delete(pid); },
    sleep: async () => {},
  };
  const freePort = async (from) => ({ 3001: 3002, 3002: 3003 })[from];
  const served = await serveCache(p, '/s.js', freePort, io);
  assert.equal(served.port, 3003, 'the second attempt asked from 3002 and got 3003');
  assert.deepEqual(calls.spawned, [3002, 3003]);
  assert.deepEqual(calls.killed, [3002], 'our loser on the shared port was killed');
});

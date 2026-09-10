import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from './http.mjs';

let server;
let base;
let cacheDir;
const hits = {};
let flakyCount = 0;

const routes = {
  '/ok': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>ok</h1>');
  },
  '/flaky': (req, res) => {
    flakyCount += 1;
    if (flakyCount <= 2) { res.writeHead(503, { 'retry-after': '0' }); res.end(); return; }
    res.writeHead(200); res.end('recovered');
  },
  '/r1': (req, res) => { res.writeHead(301, { location: '/r2' }); res.end(); },
  '/r2': (req, res) => { res.writeHead(302, { location: '/ok' }); res.end(); },
  '/ext': (req, res) => {
    res.writeHead(302, { location: 'http://external.invalid/x' });
    res.end();
  },
  '/loop': (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
  '/head405': (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
    res.writeHead(200); res.end('via get');
  },
};
const notFound = (req, res) => { res.writeHead(404); res.end(); };

before(async () => {
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    (routes[req.url] ?? notFound)(req, res);
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

test('spaces requests according to requestsPerSecond', async () => {
  const client = createClient({ requestsPerSecond: 20 });
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4].map(() => client.get(`${base}/ok`, { cache: false })));
  assert.ok(Date.now() - t0 >= 140, 'four requests at 20 rps need >= 150ms of spacing');
});

test('retries 5xx with backoff and returns the eventual success', async () => {
  const client = createClient({ requestsPerSecond: 1000, retries: 3, sleep: async () => {} });
  const res = await client.get(`${base}/flaky`, { cache: false });
  assert.equal(res.status, 200);
  assert.equal(res.body, 'recovered');
  assert.equal(hits['/flaky'], 3);
});

test('caches 200 responses on disk and serves them without hitting the server', async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'migration-http-'));
  const client = createClient({ requestsPerSecond: 1000, cacheDir });
  const before1 = hits['/ok'] ?? 0;
  const first = await client.get(`${base}/ok`);
  const second = await client.get(`${base}/ok`);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(second.body, '<h1>ok</h1>');
  assert.equal(hits['/ok'], before1 + 1);
});

test('probe follows redirects, records the chain and flags external targets', async () => {
  const client = createClient({ requestsPerSecond: 1000 });
  const internal = await client.get(`${base}/r1`, { cache: false });
  assert.equal(internal.status, 200);
  assert.deepEqual(internal.redirectChain.map((r) => r.status), [301, 302]);
  assert.equal(internal.finalUrl, `${base}/ok`);
  const ext = await client.probe(`${base}/ext`);
  assert.equal(ext.external, true);
  assert.equal(ext.finalUrl, 'http://external.invalid/x');
  const viaGet = await client.probe(`${base}/head405`);
  assert.equal(viaGet.status, 200);
  const missing = await client.probe(`${base}/nope`);
  assert.equal(missing.status, 404);
});

test('throws the network error after retries are exhausted', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('ECONNRESET');
  };
  const client = createClient({
    requestsPerSecond: 1000, retries: 2, fetchImpl, sleep: async () => {},
  });
  await assert.rejects(client.get(`${base}/ok`, { cache: false }), /ECONNRESET/);
  assert.equal(calls, 3);
});

test('throws when a redirect loop exceeds the hop limit', async () => {
  const client = createClient({ requestsPerSecond: 1000 });
  await assert.rejects(client.get(`${base}/loop`, { cache: false }), /Too many redirects/);
});

test('probe reports both the HEAD and the GET failure when neither succeeds', async () => {
  const fetchImpl = async (url, { method }) => {
    throw new Error(method === 'HEAD' ? 'head-down' : 'get-down');
  };
  const client = createClient({
    requestsPerSecond: 1000, retries: 0, fetchImpl, sleep: async () => {},
  });
  await assert.rejects(
    client.probe(`${base}/ok`),
    /HEAD failed: head-down; GET failed: get-down/,
  );
});

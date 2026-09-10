import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIndexClient } from './index.mjs';

const DA = {
  org: 'org',
  site: 'site',
  ref: 'main',
  adminHost: 'https://admin.hlx.page',
  sourceHost: 'https://admin.da.live',
};

const PREVIEW = 'https://main--site--org.aem.page'
  + '/query-index.json?limit=1';
const LIVE = 'https://main--site--org.aem.live'
  + '/query-index.json?limit=1';

function clientWith(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[url] ?? { status: 404, body: 'not found' };
    return new Response(next.body ?? '', {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
  const client = createIndexClient({ da: DA, token: 'secret-token', io: { fetchImpl } });
  return { client, calls };
}

test('push refuses without --confirm and makes no request', async () => {
  const { client, calls } = clientWith({});
  await assert.rejects(
    () => client.push({ yaml: 'indices:\n' }),
    /Refusing to push:.*--confirm.*Index Admin/s,
  );
  assert.equal(calls.length, 0, 'the gate is checked before the network call');
});

test('push posts the definition as text/yaml with the admin token', async () => {
  const url = 'https://admin.hlx.page/config/org/sites/site/content/query.yaml';
  const { client, calls } = clientWith({ [url]: { status: 200, body: '{"ok":true}' } });
  const result = await client.push({ yaml: 'indices:\n  site: {}\n', confirm: true });
  assert.deepEqual(result, {
    url, status: 200, ok: true, body: { ok: true },
  });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'text/yaml');
  assert.equal(calls[0].init.headers['x-auth-token'], 'secret-token');
  // The IMS token authenticates as a bearer; `x-auth-token` alone answers 401 (measured).
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0].init.body, 'indices:\n  site: {}\n');
});

test('push reports a refusal from the admin API instead of throwing', async () => {
  const url = 'https://admin.hlx.page/config/org/sites/site/content/query.yaml';
  const { client } = clientWith({ [url]: { status: 403, body: 'forbidden' } });
  const result = await client.push({ yaml: 'indices:\n', confirm: true });
  assert.deepEqual(result, {
    url, status: 403, ok: false, body: 'forbidden',
  });
});

test('check calls the per-page index endpoint of the branch', async () => {
  const url = 'https://admin.hlx.page/index/org/site/main/blog/zapier-guide';
  const { client, calls } = clientWith({
    url: { status: 200 },
    [url]: { status: 200, body: '{"results":[{"name":"site"}]}' },
  });
  const result = await client.check({ path: 'blog/zapier-guide' });
  assert.equal(result.url, url, 'a missing leading slash is added');
  assert.deepEqual(result.body, { results: [{ name: 'site' }] });
  assert.equal(calls[0].init.headers['x-auth-token'], 'secret-token');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');
});

test('status reports rows and columns on both hosts', async () => {
  const rows = JSON.stringify({
    total: 1333,
    offset: 0,
    limit: 1,
    data: [{ path: '/blog/x', title: 'X', tags: 'zapier' }],
  });
  const { client } = clientWith({
    [PREVIEW]: { status: 404, body: 'not found' },
    [LIVE]: { status: 200, body: rows },
  });
  const { preview, live } = await client.status();
  assert.deepEqual(preview, {
    channel: 'page', url: PREVIEW, status: 404, exists: false, total: null, columns: [],
  });
  assert.deepEqual(live, {
    channel: 'live',
    url: LIVE,
    status: 200,
    exists: true,
    total: 1333,
    columns: ['path', 'title', 'tags'],
  });
});

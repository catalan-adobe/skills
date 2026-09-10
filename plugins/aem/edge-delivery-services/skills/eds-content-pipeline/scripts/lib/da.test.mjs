import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDaClient, DaTokenError, docPath, livePath, loadToken,
} from './da.mjs';

const execFileP = promisify(execFile);
const daCli = fileURLToPath(new URL('./da.mjs', import.meta.url));
const DA = {
  org: 'org',
  site: 'site',
  ref: 'main',
  adminHost: 'https://admin.hlx.page',
  sourceHost: 'https://admin.da.live',
};

function mockFetch(queue) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected ${init.method} ${url}`);
    return new Response(next.body ?? '', { status: next.status, headers: next.headers ?? {} });
  };
  return { fetchImpl, calls };
}

function clientWith(queue, extra = {}) {
  const { fetchImpl, calls } = mockFetch(queue);
  const delays = [];
  const client = createDaClient({
    da: DA,
    token: 'test-token',
    ...extra,
    io: {
      fetchImpl, sleep: async (ms) => { delays.push(ms); }, ...(extra.io ?? {}),
    },
  });
  return { client, calls, delays };
}

test('docPath and livePath normalize content paths and reject bad ones', () => {
  assert.equal(docPath('/nav'), '/nav');
  assert.equal(docPath('nav.html'), '/nav');
  assert.equal(docPath('/'), '/index');
  assert.equal(docPath('/Blog/My-Post'), '/blog/my-post');
  assert.equal(livePath(docPath('/')), '/');
  assert.equal(livePath(docPath('/footer')), '/footer');
  assert.throws(() => docPath('/blog/my post'), /use lowercase a-z/);
  assert.throws(() => docPath('/../secrets'), /use lowercase a-z/);
});

test('loadToken prefers DA_TOKEN, reads the token file and never leaks the token', async () => {
  const fromEnv = await loadToken({ env: { DA_TOKEN: 'env-token' } });
  assert.equal(fromEnv.token, 'env-token');
  assert.equal(fromEnv.source, 'DA_TOKEN');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-da-'));
  const file = path.join(dir, '.da-token.json');
  await writeFile(file, JSON.stringify({ access_token: 'file-token', expires_at: 1234 }));
  const fromFile = await loadToken({ env: {}, file });
  assert.deepEqual(
    { token: fromFile.token, expiresAt: fromFile.expiresAt },
    { token: 'file-token', expiresAt: 1234 },
  );
  await writeFile(file, JSON.stringify({ access_token: '' }));
  const err = await loadToken({ env: {}, file }).catch((e) => e);
  assert.ok(err instanceof DaTokenError);
  assert.match(err.message, /has no access_token; run `npx -y @adobe\/aem-cli content clone/);
  assert.ok(!err.message.includes('file-token'));
  await assert.rejects(
    () => loadToken({ env: {}, file: path.join(dir, 'missing.json') }),
    /is unreadable; run `npx -y @adobe\/aem-cli content clone/,
  );
});

test('putSource sends one multipart field named data with the html blob', async () => {
  const created = JSON.stringify({ source: { editUrl: 'https://da.live/edit#/x' } });
  const { client, calls } = clientWith([{ status: 201, body: created }]);
  const result = await client.putSource({ path: '/nav', html: '<body><header/></body>' });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://admin.da.live/source/org/site/nav.html',
  );
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
  const blob = calls[0].init.body.get('data');
  assert.deepEqual([...calls[0].init.body.keys()], ['data']);
  assert.equal(blob.name, 'nav.html');
  assert.equal(blob.type, 'text/html');
  assert.equal(await blob.text(), '<body><header/></body>');
  assert.equal(result.status, 201);
  assert.equal(result.path, '/nav');
  assert.equal(result.source.editUrl, 'https://da.live/edit#/x');
});

test('putBinary uploads bytes to a media path, keeping the file extension', async () => {
  const { client, calls } = clientWith([{ status: 201, body: '{}' }]);
  const bytes = Buffer.from('fake-png-bytes');
  const result = await client.putBinary({
    path: '/media/homepage/url-2.png', bytes, contentType: 'image/png',
  });
  assert.equal(
    calls[0].url,
    'https://admin.da.live/source/org/site'
    + '/media/homepage/url-2.png',
  );
  assert.equal(calls[0].init.method, 'PUT');
  const blob = calls[0].init.body.get('data');
  assert.deepEqual([...calls[0].init.body.keys()], ['data']);
  assert.equal(blob.name, 'url-2.png');
  assert.equal(blob.type, 'image/png');
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString('utf8'), 'fake-png-bytes');
  assert.equal(result.status, 201);
  assert.equal(result.path, '/media/homepage/url-2.png');
  const bad = clientWith([]);
  await assert.rejects(
    () => bad.client.putBinary({ path: '/media/x/no-extension', bytes, contentType: 'image/png' }),
    /needs a file extension/,
  );
});

test('a single 401 is retried once; a second one is the expired-token DaTokenError', async () => {
  const once = clientWith([{ status: 401 }, { status: 200, body: '{}' }]);
  await once.client.putSource({ path: '/nav', html: '<body/>' });
  assert.equal(once.calls.length, 2, 'one transient 401 does not stop the run');
  const { client, calls } = clientWith([{ status: 401 }, { status: 401 }, { status: 200 }]);
  const err = await client.putSource({ path: '/nav', html: '<body/>' }).catch((e) => e);
  assert.ok(err instanceof DaTokenError);
  assert.equal(
    err.action,
    'run `npx -y @adobe/aem-cli content clone --path /` to refresh the DA token '
    + '(or export DA_TOKEN)',
  );
  assert.equal(calls.length, 2, 'the second 401 is final');
});

test('429 waits for Retry-After and 5xx backs off exponentially', async () => {
  const throttled = clientWith([
    { status: 429, headers: { 'retry-after': '2' } },
    { status: 200, body: '{}' },
  ]);
  await throttled.client.putSource({ path: '/nav', html: '<body/>' });
  assert.deepEqual(throttled.delays, [2000]);
  assert.equal(throttled.calls.length, 2);
  const flaky = clientWith([
    { status: 503 }, { status: 500 }, { status: 200, body: '{}' },
  ]);
  await flaky.client.putSource({ path: '/nav', html: '<body/>' });
  assert.deepEqual(flaky.delays, [1000, 2000]);
  const down = clientWith([
    { status: 503 }, { status: 503 }, { status: 503 }, { status: 503, body: 'gateway down' },
  ]);
  await assert.rejects(
    () => down.client.putSource({ path: '/nav', html: '<body/>' }),
    /PUT https:\/\/admin\.da\.live\/source\/.* -> 503 gateway down/,
  );
  assert.equal(down.calls.length, 4);
});

test('getSource returns html, reports 404 as missing, deleteSource confirms', async () => {
  const found = clientWith([{ status: 200, body: '<body><main/></body>' }]);
  assert.deepEqual(await found.client.getSource({ path: '/footer' }), {
    path: '/footer', status: 200, exists: true, html: '<body><main/></body>',
  });
  const missing = clientWith([{ status: 404, body: '' }]);
  assert.deepEqual(await missing.client.getSource({ path: '/footer' }), {
    path: '/footer', status: 404, exists: false, html: null,
  });
  const removed = clientWith([{ status: 200, body: '' }]);
  assert.deepEqual(await removed.client.deleteSource({ path: '/footer' }), {
    path: '/footer', status: 200, deleted: true,
  });
  assert.equal(removed.calls[0].init.method, 'DELETE');
});

test('preview and publish post to the admin host with the branch ref', async () => {
  const body = JSON.stringify({ preview: { url: 'https://p/' } });
  const previewed = clientWith([{ status: 200, body }]);
  const result = await previewed.client.preview({ path: '/' });
  assert.equal(
    previewed.calls[0].url,
    'https://admin.hlx.page/preview/org/site/main/',
  );
  assert.equal(previewed.calls[0].init.method, 'POST');
  assert.deepEqual(result, {
    path: '/index', action: 'preview', status: 200, url: 'https://p/',
  });
  const published = clientWith([{ status: 200, body: '{}' }]);
  const live = await published.client.publish({ path: '/nav' });
  assert.equal(
    published.calls[0].url,
    'https://admin.hlx.page/live/org/site/main/nav',
  );
  assert.equal(
    live.url,
    'https://main--site--org.aem.live/nav',
  );
});

test('a non-2xx response surfaces the x-error header in the thrown message', async () => {
  const previewed = clientWith([{
    status: 409,
    body: 'error from content-bus',
    headers: { 'x-error': 'Images 15, 16, 17, 19, 20 and 63 have failed validation' },
  }]);
  const err = await previewed.client.preview({ path: '/' }).catch((e) => e);
  assert.equal(
    err.message,
    'POST https://admin.hlx.page/preview/org/site/main/'
    + ' -> 409 error from content-bus \u2014 x-error: '
    + 'Images 15, 16, 17, 19, 20 and 63 have failed validation',
  );
  const put = clientWith([{ status: 400, body: '', headers: { 'x-error': 'bad path' } }]);
  await assert.rejects(
    () => put.client.putSource({ path: '/nav', html: '<body/>' }),
    /PUT https:\/\/admin\.da\.live\/source\/.* -> 400 \u2014 x-error: bad path/,
  );
  const got = clientWith([{ status: 400, body: 'boom', headers: { 'x-error': 'upstream' } }]);
  await assert.rejects(
    () => got.client.getSource({ path: '/nav' }),
    /GET .* -> 400 boom \u2014 x-error: upstream/,
  );
  const plain = clientWith([{ status: 400, body: 'no header' }]);
  const bare = await plain.client.putSource({ path: '/nav', html: '<body/>' }).catch((e) => e);
  assert.ok(!bare.message.includes('x-error'), 'no header, no suffix');
});

test('preflight throws on an expired token and smoke-tests the site listing', async () => {
  const expired = clientWith([], { expiresAt: Date.now() - 1000 });
  await assert.rejects(
    () => expired.client.preflight(),
    /DA token expired at .*; run `npx -y @adobe\/aem-cli content clone/,
  );
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const ok = clientWith([{ status: 200, body: '[]' }], { expiresAt, tokenSource: 'DA_TOKEN' });
  const report = await ok.client.preflight();
  assert.equal(
    ok.calls[0].url,
    'https://admin.da.live/list/org/site',
  );
  assert.equal(report.ok, true);
  assert.equal(report.ref, 'main');
  assert.equal(report.tokenSource, 'DA_TOKEN');
  assert.ok(report.expiresInMinutes >= 59, 'reports the remaining minutes');
  const broken = clientWith([{ status: 404, body: '' }], { expiresAt });
  await assert.rejects(() => broken.client.preflight(), /check "da" in site.config.json/);
});

test('putAll uploads through the pool and keeps input order', async () => {
  const { client, calls } = clientWith([
    { status: 200, body: '{}' }, { status: 200, body: '{}' }, { status: 200, body: '{}' },
  ]);
  const results = await client.putAll([
    { path: '/nav', html: '<body/>' },
    { path: '/footer', html: '<body/>' },
    { path: '/', html: '<body/>' },
  ]);
  assert.deepEqual(results.map((r) => r.path), ['/nav', '/footer', '/index']);
  assert.equal(calls.length, 3);
});

test('the CLI refuses to publish and rejects unknown commands', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-da-cli-'));
  const configPath = path.join(dir, 'site.config.json');
  await writeFile(configPath, JSON.stringify({
    origin: 'https://www.example.com',
    sitemapIndex: 'https://www.example.com/sitemap.xml',
    exclusions: {},
    viewports: [1440],
    concurrency: { fetch: 2, browser: 2, da: 2 },
    rateLimit: { requestsPerSecond: 2 },
    thresholds: {},
    bundles: { pageTree: 'page-tree-bundle.js' },
    templateSeeds: {},
    da: DA,
    templates: {},
  }));
  const env = { ...process.env, DA_TOKEN: 'test-token', MIGRATION_CONFIG: configPath };
  const refused = await execFileP(process.execPath, [daCli, 'publish', '/nav'], { env })
    .catch((e) => e);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Refusing to publish: publishing is a human gate/);
  const usage = await execFileP(process.execPath, [daCli, 'bogus'], { env }).catch((e) => e);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /Usage: da\.mjs preflight \| get <path>/);
});

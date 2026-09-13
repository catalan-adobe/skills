import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecords, upsertRecords } from './state.mjs';
import { fixtureRepo } from './testing/fixture-repo.mjs';

const execFileP = promisify(execFile);
const captureCli = fileURLToPath(new URL('./capture.mjs', import.meta.url));

async function cli(repo, ...args) {
  const { stdout } = await execFileP('node', [captureCli, ...args], { cwd: repo });
  return JSON.parse(stdout);
}

test('capture fetches the representatives and --check passes only when all exist', async () => {
  const { repo, server, paths } = await fixtureRepo();
  try {
    const before = await cli(repo, 'product', '--check').catch((e) => e);
    assert.equal(before.code, 1);
    assert.equal(JSON.parse(before.stdout).missing.length, 2);
    const out = await cli(repo, 'product');
    assert.deepEqual(out.captured.sort(), [
      `${server.origin}/product-a.html`, `${server.origin}/product-b.html`,
    ]);
    assert.deepEqual(out.failed, []);
    const file = path.join(paths.dataDir, 'captures', 'product', 'product-a.html');
    assert.match(await readFile(file, 'utf8'), /<table class="specs">/);
    assert.deepEqual((await cli(repo, 'product', '--check')).missing, []);
  } finally { await server.close(); }
});

test('flagged representatives win over the first-N fallback and --limit bounds it', async () => {
  const { repo, server, paths } = await fixtureRepo();
  try {
    await upsertRecords('urls', [
      { url: `${server.origin}/product-b.html`, representative: true },
    ], paths);
    const out = await cli(repo, 'product');
    assert.deepEqual(out.captured, [`${server.origin}/product-b.html`]);
    await upsertRecords('urls', [
      { url: `${server.origin}/product-b.html`, representative: false },
    ], paths);
    const limited = await cli(repo, 'product', '--limit', '1');
    assert.deepEqual(limited.captured, [`${server.origin}/product-a.html`]);
  } finally { await server.close(); }
});

test('a representative that fails to fetch is dropped as representative, the unit goes on',
  async () => {
    const { repo, server, paths } = await fixtureRepo();
    try {
      const missing = `${server.origin}/missing.html`;
      await upsertRecords('urls', [{
        url: missing,
        path: '/missing.html',
        sitemapType: 'page',
        template: 'product',
        status: 'todo',
        representative: true,
      }], paths);
      const report = await cli(repo, 'product');
      assert.equal(report.captured.length, 2, 'the others are captured');
      assert.deepEqual(report.failed.map((f) => f.url), [missing]);
      assert.match(report.failed[0].error, /404/);
      const [record] = await listRecords('urls', { where: { url: missing }, paths });
      assert.equal(record.representative, false);
      assert.match(record.note, /capture failed: .*404/);
      const check = await cli(repo, 'product', '--check');
      assert.deepEqual(check.missing, [], 'the remaining representatives are all captured');
      const none = await cli(repo, 'nothing-here').catch((e) => e);
      assert.equal(none.code, 1, 'a template without URLs still fails');
    } finally { await server.close(); }
  });

test('the unit fails when every representative failed to capture', async () => {
  const { repo, server, paths } = await fixtureRepo();
  try {
    const records = await listRecords('urls', { where: { template: 'product' }, paths });
    await upsertRecords('urls', records.map((r) => ({
      ...r, url: r.url.replace('.html', '-gone.html'), representative: true,
    })), paths);
    await upsertRecords('urls', records.map((r) => ({ ...r, template: 'other' })), paths);
    const out = await cli(repo, 'product').catch((e) => e);
    assert.equal(out.code, 1);
    assert.equal(JSON.parse(out.stdout).captured.length, 0);
  } finally { await server.close(); }
});

test('no arguments prints the usage and exits 1', async () => {
  const bad = await execFileP('node', [captureCli]).catch((e) => e);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Usage: capture\.mjs <template>/);
});

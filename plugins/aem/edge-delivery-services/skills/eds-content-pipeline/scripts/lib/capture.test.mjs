import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertRecords } from './state.mjs';
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

test('a representative that fails to fetch is reported and the others are captured', async () => {
  const { repo, server, paths } = await fixtureRepo();
  try {
    await upsertRecords('urls', [{
      url: `${server.origin}/missing.html`,
      path: '/missing.html',
      sitemapType: 'page',
      template: 'product',
      status: 'todo',
    }], paths);
    const out = await cli(repo, 'product').catch((e) => e);
    assert.equal(out.code, 1, 'a failed fetch fails the command');
    const report = JSON.parse(out.stdout);
    assert.equal(report.captured.length, 2);
    assert.deepEqual(report.failed.map((f) => f.url), [`${server.origin}/missing.html`]);
    assert.match(report.failed[0].error, /404/);
  } finally { await server.close(); }
});

test('no arguments prints the usage and exits 1', async () => {
  const bad = await execFileP('node', [captureCli]).catch((e) => e);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Usage: capture\.mjs <template>/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './paths.mjs';
import {
  keyFieldFor, listRecords, updateJson, upsertRecords, withLock,
} from './state.mjs';
import { assertRecord } from './shapes.mjs';

const execFileP = promisify(execFile);
const stateCli = fileURLToPath(new URL('./state.mjs', import.meta.url));

async function tmpPaths() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-state-'));
  return resolvePaths({ MIGRATION_DATA_DIR: dir, MIGRATION_PROJECT_DIR: dir });
}

/** Returns a helper that runs the state CLI against `paths`. */
function runCli(paths) {
  const env = {
    ...process.env,
    MIGRATION_DATA_DIR: paths.dataDir,
    MIGRATION_PROJECT_DIR: paths.projectDir,
  };
  return (...args) => execFileP(process.execPath, [stateCli, ...args], { env });
}

const url = (n) => ({
  url: `https://x.test/p${n}`, path: `/p${n}`, sitemapType: 'page', template: 'page', status: 'todo',
});

test('upsert creates the file, merges by key and stamps updatedAt', async () => {
  const paths = await tmpPaths();
  await upsertRecords('urls', [url(1), url(2)], paths);
  await upsertRecords('urls', [{ url: url(1).url, status: 'analyzed', fingerprint: 'a|b' }], paths);
  const rows = await listRecords('urls', { paths });
  assert.equal(rows.length, 2);
  const first = rows.find((r) => r.url === url(1).url);
  assert.equal(first.status, 'analyzed');
  assert.equal(first.fingerprint, 'a|b');
  assert.equal(first.path, '/p1');
  assert.ok(first.updatedAt);
});

test('rejects invalid enum values and leaves the file untouched', async () => {
  const paths = await tmpPaths();
  await upsertRecords('urls', [url(1)], paths);
  await assert.rejects(
    () => upsertRecords('urls', [{ url: url(1).url, status: 'bogus' }], paths),
    /status "bogus"/,
  );
  const rows = await listRecords('urls', { paths });
  assert.equal(rows[0].status, 'todo');
});

test('concurrent updates serialize through the lock', async () => {
  const paths = await tmpPaths();
  const file = paths.stateFile('counter');
  await Promise.all(Array.from({ length: 20 }, () => updateJson(file, { n: 0 }, (d) => ({
    n: d.n + 1,
  }))));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 20 });
});

test('withLock times out with an actionable message when the lock is held', async () => {
  const paths = await tmpPaths();
  const file = paths.stateFile('held');
  let release;
  const held = new Promise((r) => { release = r; });
  let acquired;
  const acquiredLock = new Promise((r) => { acquired = r; });
  const holder = withLock(file, () => { acquired(); return held; });
  await acquiredLock;
  await assert.rejects(() => withLock(file, async () => {}, { timeoutMs: 200 }), /remove it if no runner is active/);
  release();
  await holder;
});

test('CLI lists, counts and sets records', async () => {
  const paths = await tmpPaths();
  await upsertRecords('urls', [url(1), url(2)], paths);
  const run = runCli(paths);
  await run('set', 'urls', url(2).url, 'status=excluded', 'excluded={"reason":"test"}');
  const { stdout } = await run('list', 'urls', '--count-by', 'status');
  assert.deepEqual(JSON.parse(stdout), { excluded: 1, todo: 1 });
  const listed = await run('list', 'urls', 'status=excluded');
  assert.deepEqual(JSON.parse(listed.stdout)[0].excluded, { reason: 'test' });
});

test('assertRecord names missing fields and refuses unregistered shapes', () => {
  assert.throws(() => assertRecord('urls', { url: 'https://x.test/a' }), /is missing:/);
  assert.throws(() => assertRecord('nope', { any: 1 }), /No shape registered/);
});

test('keyFieldFor rejects an unknown state file', () => {
  assert.throws(() => keyFieldFor('nope'), /Unknown state file/);
});

test('CLI exits 1 when an assignment is not field=value', async () => {
  const paths = await tmpPaths();
  const run = runCli(paths);
  await assert.rejects(() => run('set', 'urls', url(1).url, 'bogus'), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Expected field=value/);
    return true;
  });
});

test('list --count prints a count', async () => {
  const paths = await tmpPaths();
  await upsertRecords('blocks', [
    { name: 'a', status: 'todo', templates: { t1: 1 }, evidence: [] },
    { name: 'b', status: 'todo', templates: { t2: 1 }, evidence: [] },
  ], paths);
  const { stdout } = await runCli(paths)('list', 'blocks', '--count');
  assert.deepEqual(JSON.parse(stdout), { count: 2 });
});

test('check-evidence fails a block whose selector missing on capture',
  async () => {
    const paths = await tmpPaths();
    const { mkdir, writeFile } = await import('fs/promises');
    const capDir = path.join(paths.dataDir, 'captures', 't1');
    await mkdir(capDir, { recursive: true });
    await writeFile(
      path.join(capDir, 'rep1.html'),
      '<main><table class="specs"></table></main>'
    );
    await upsertRecords(
      'templates',
      [{ name: 't1', status: 'todo',
        representatives: ['https://example.com/rep1'] }],
      paths
    );
    await upsertRecords('blocks', [
      {
        name: 'specs',
        status: 'todo',
        templates: { t1: 1 },
        evidence: [
          { url: 'https://example.com/rep1', selector: 'table.specs' },
        ],
      },
      {
        name: 'ghost',
        status: 'todo',
        templates: { t1: 1 },
        evidence: [{ url: 'https://example.com/rep1', selector: '.nope' }],
      },
    ], paths);
    const { stdout } = await runCli(paths)('check-evidence', 't1');
    const out = JSON.parse(stdout);
    assert.equal(out.pass, false);
    assert.deepEqual(out.missing.map((m) => m.name), ['ghost']);
  }
);

test('feedback add/list/set round-trips', async () => {
  const paths = await tmpPaths();
  const cli = runCli(paths);
  await cli('feedback', 'add', 'template:pdp', 'drop reviews tab',
    '--note', 'AJAX only');
  const { stdout: listOut } = await cli('feedback', 'list');
  const list = JSON.parse(listOut);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'received');
  await cli('feedback', 'set', list[0].id, 'status=applied');
  const { stdout: afterOut } = await cli(
    'feedback', 'list', 'status=applied'
  );
  const after = JSON.parse(afterOut);
  assert.equal(after[0].scope, 'template:pdp');
});

test('check-evidence treats a malformed selector as unresolved instead of throwing',
  async () => {
    const paths = await tmpPaths();
    const { mkdir, writeFile } = await import('fs/promises');
    const capDir = path.join(paths.dataDir, 'captures', 't1');
    await mkdir(capDir, { recursive: true });
    await writeFile(
      path.join(capDir, 'rep1.html'),
      '<main><table class="specs"></table></main>'
    );
    await upsertRecords('blocks', [{
      name: 'broken',
      status: 'todo',
      templates: { t1: 1 },
      evidence: [
        { url: 'https://example.com/rep1', selector: '>>>not a selector' },
      ],
    }], paths);
    const { stdout } = await runCli(paths)('check-evidence', 't1');
    const out = JSON.parse(stdout);
    assert.equal(out.pass, false);
    assert.deepEqual(out.missing.map((m) => m.name), ['broken']);
  }
);

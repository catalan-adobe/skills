import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProgress, writeProgress } from './progress.mjs';

const execFileP = promisify(execFile);
const progressCli = fileURLToPath(new URL('./progress.mjs', import.meta.url));

async function tmpPaths() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'migration-progress-'));
  return { dataDir };
}

test('writeProgress creates a run record and readProgress returns it', async () => {
  const paths = await tmpPaths();
  const record = await writeProgress({
    runId: 'run-1', stage: 'template', unit: 'blocks:tabs', status: 'started',
  }, paths);
  assert.equal(record.runId, 'run-1');
  assert.equal(record.stage, 'template');
  assert.equal(record.units.length, 1);
  assert.deepEqual(record.units[0], {
    unit: 'blocks:tabs', status: 'started', detail: null, at: record.units[0].at,
  });
  assert.equal(record.cost, 0);
  const loaded = await readProgress('run-1', paths);
  assert.deepEqual(loaded, record);
});

test('writeProgress updates an existing unit in place and keeps others', async () => {
  const paths = await tmpPaths();
  await writeProgress({
    runId: 'run-2', stage: 'template', unit: 'blocks:tabs', status: 'started',
  }, paths);
  await writeProgress({
    runId: 'run-2', stage: 'template', unit: 'blocks:cards', status: 'started',
  }, paths);
  const record = await writeProgress({
    runId: 'run-2',
    stage: 'template',
    unit: 'blocks:tabs',
    status: 'passed',
    detail: 'ok',
    cost: 1.5,
  }, paths);
  assert.equal(record.units.length, 2);
  const tabs = record.units.find((u) => u.unit === 'blocks:tabs');
  assert.equal(tabs.status, 'passed');
  assert.equal(tabs.detail, 'ok');
  assert.equal(record.cost, 1.5);
});

test('readProgress returns null for a run that has not started', async () => {
  const paths = await tmpPaths();
  assert.equal(await readProgress('never-run', paths), null);
});

test('writeProgress requires runId, stage, unit and status', async () => {
  const paths = await tmpPaths();
  await assert.rejects(
    () => writeProgress({ runId: 'r', stage: 's', unit: '' }, paths),
    /requires runId, stage, unit and status/,
  );
});

test('the CLI writes one JSON object and rejects a bad invocation', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'migration-progress-cli-'));
  const env = { ...process.env, MIGRATION_DATA_DIR: dataDir };
  const { stdout } = await execFileP(process.execPath, [
    progressCli, 'set', 'run-3', 'bulk', 'urls:42', 'uploaded', '--detail', 'ok', '--cost', '0.4',
  ], { env });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.runId, 'run-3');
  assert.equal(parsed.unit, 'urls:42');
  const bad = await execFileP(process.execPath, [progressCli, 'set', 'run-3'], { env })
    .catch((e) => e);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Usage: progress\.mjs set/);
});

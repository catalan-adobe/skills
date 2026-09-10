import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths } from './paths.mjs';
import { upsertRecords, readJson } from './state.mjs';
import {
  appendRow, buildSummary, readRows, writeSummary,
} from './ledger.mjs';

async function tmpPaths() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-ledger-'));
  return resolvePaths({ MIGRATION_DATA_DIR: dir });
}

test('appends validated rows and reads them back in order', async () => {
  const paths = await tmpPaths();
  await appendRow('runs', {
    runId: 'r1', stage: 'discover', startedAt: 't', outcome: 'ok', cost: 1.5,
  }, paths);
  await appendRow('runs', {
    runId: 'r2', stage: 'discover', startedAt: 't', outcome: 'ok', cost: 2,
  }, paths);
  await assert.rejects(
    () => appendRow('runs', { runId: 'r3' }, paths),
    /missing: stage, startedAt, outcome/,
  );
  const rows = await readRows('runs', paths);
  assert.deepEqual(rows.map((r) => r.runId), ['r1', 'r2']);
});

test('summary aggregates state and ledgers and is written to summary.json', async () => {
  const paths = await tmpPaths();
  await upsertRecords('urls', [
    {
      url: 'https://x.test/a',
      path: '/a',
      sitemapType: 'post',
      template: 'blog-post',
      status: 'todo',
    },
    {
      url: 'https://x.test/b',
      path: '/b',
      sitemapType: 'post',
      template: 'blog-post',
      status: 'excluded',
    },
  ], paths);
  await upsertRecords('templates', [{ name: 'blog-post', status: 'todo' }], paths);
  await appendRow('runs', {
    runId: 'r1', stage: 'discover', startedAt: 't', outcome: 'ok', cost: 1.25,
  }, paths);
  await appendRow('units', {
    unitId: 'u1', runId: 'r1', kind: 'record', ref: 'x', verdict: 'pass',
  }, paths);
  await upsertRecords('feedback', [{
    id: 'f1', receivedAt: 't', channel: 'chat', scope: 'global', text: 'hi', status: 'received',
  }], paths);
  const summary = await writeSummary(paths);
  assert.deepEqual(summary.urls.byStatus, { excluded: 1, todo: 1 });
  assert.deepEqual(summary.urls.byTemplate, { 'blog-post': 2 });
  assert.equal(summary.templates.total, 1);
  assert.equal(summary.runs.costTotal, 1.25);
  assert.equal(summary.runs.lastRun.runId, 'r1');
  assert.deepEqual(summary.units.byVerdict, { pass: 1 });
  assert.equal(summary.feedback.open, 1);
  const onDisk = await readJson(paths.stateFile('summary'), null);
  assert.equal(onDisk.urls.total, 2);
  const again = await buildSummary(paths);
  assert.deepEqual(again.urls, summary.urls);
  assert.deepEqual(again.units, summary.units);
});

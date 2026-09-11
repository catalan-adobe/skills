import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatLine, judge, watchRun } from './watch-run.mjs';

const NOW = Date.parse('2026-09-04T12:00:00Z');
const agent = (label, status, startedMinutesAgo) => ({
  label, status, startedAt: new Date(NOW - startedMinutesAgo * 60000).toISOString(),
});

test('judge reports a healthy running run with its active agents', () => {
  const verdict = judge({
    status: 'running',
    currentPhase: 'Chrome',
    agents: [agent('a', 'done', 40), agent('b', 'running', 5)],
    logs: ['remaining units: header'],
    tokenUsage: { cost: 1.5 },
  }, { now: NOW });
  assert.equal(verdict.state, 'running');
  assert.deepEqual(verdict.running, [{ label: 'b', minutes: 5 }]);
  assert.equal(verdict.done, 1);
  assert.equal(verdict.lastLog, 'remaining units: header');
  assert.match(
    formatLine(verdict),
    /running · running · Chrome · agents 1\/2 · \$1\.50 · active: b \(5m\)/,
  );
});

test('judge flags an agent running past the stall threshold', () => {
  const verdict = judge({
    status: 'running', agents: [agent('footer:build-1', 'running', 228)],
  }, { now: NOW, stallMinutes: 30 });
  assert.equal(verdict.state, 'stalled');
  assert.deepEqual(verdict.stalled, ['footer:build-1 running for 228 min']);
});

test('judge treats completed, failed and aborted runs as finished', () => {
  for (const status of ['completed', 'failed', 'aborted']) {
    assert.equal(judge({ status, agents: [] }, { now: NOW }).state, 'finished');
  }
});

test('watchRun returns as soon as the run is finished or stalled', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'watch-run-'));
  await writeFile(path.join(runsDir, 'r1.json'), JSON.stringify({
    runId: 'r1', status: 'failed', agents: [], logs: [{ message: 'boom' }],
  }));
  const lines = [];
  const result = await watchRun({
    runId: 'r1', runsDir, intervalSeconds: 0, log: (l) => lines.push(l),
  });
  assert.equal(result.state, 'finished');
  assert.equal(result.checks, 1);
  assert.equal(result.lastLog, 'boom');
  assert.equal(lines.length, 1);
  await assert.rejects(watchRun({ runId: 'nope', runsDir, log: () => {} }), /not found/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../../../scripts/lib/paths.mjs';
import { readJson } from '../../../scripts/lib/state.mjs';
import {
  collectRuns, relativeLink, renderRetro, summarizeRun, writeReport,
  summarizeSession,
} from './retro.mjs';

const execFileP = promisify(execFile);
const retroCli = fileURLToPath(new URL('./retro.mjs', import.meta.url));

const journal = (runId, overrides = {}) => ({
  runId,
  workflowName: `wf_${runId}`,
  status: 'completed',
  durationMs: 1000,
  startedAt: '2026-09-02T14:46:20.268Z',
  tokenUsage: {
    input: 10, output: 20, total: 100, cost: 0.5,
  },
  agents: [{ id: 1, model: 'haiku' }, { id: 2, model: 'sonnet' }],
  ...overrides,
});

async function tmpDirs() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'migration-retro-data-'));
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'migration-retro-runs-'));
  const paths = resolvePaths({ MIGRATION_DATA_DIR: dataDir, MIGRATION_PROJECT_DIR: dataDir });
  return { paths, runsDir };
}

async function writeJournals(runsDir, journals) {
  await Promise.all(journals.map((j) => writeFile(
    path.join(runsDir, `${j.runId}.json`),
    JSON.stringify(j),
  )));
}

test('summarizeRun reads facts from an array of agents', () => {
  const run = summarizeRun(journal('r1'));
  assert.deepEqual(run, {
    runId: 'r1',
    name: 'wf_r1',
    status: 'completed',
    agents: 2,
    tokens: 100,
    cost: 0.5,
    durationMs: 1000,
    startedAt: '2026-09-02T14:46:20.268Z',
    models: { haiku: 1, sonnet: 1 },
  });
});

test('summarizeRun counts agents given as an object and groups models', () => {
  const run = summarizeRun(journal('r2', {
    agents: { a: { model: 'haiku' }, b: { model: 'haiku' }, c: { model: 'fable' } },
  }));
  assert.equal(run.agents, 3);
  assert.deepEqual(run.models, { fable: 1, haiku: 2 });
});

test('summarizeRun defaults missing tokenUsage, duration and agents to zero', () => {
  const run = summarizeRun({ runId: 'r3' });
  assert.equal(run.tokens, 0);
  assert.equal(run.cost, 0);
  assert.equal(run.durationMs, 0);
  assert.equal(run.agents, 0);
  assert.equal(run.status, 'unknown');
  assert.deepEqual(run.models, {});
});

test('collectRuns creates the retro file, merges by runId and totals the facts', async () => {
  const { paths, runsDir } = await tmpDirs();
  await writeJournals(runsDir, [journal('r1'), journal('r2')]);
  const first = await collectRuns({
    stage: 'discover', runIds: ['r1'], runsDir, paths,
  });
  assert.deepEqual(first, {
    stage: 'discover',
    runs: 1,
    totals: {
      runs: 1, agents: 2, tokens: 100, cost: 0.5, durationMs: 1000,
    },
  });
  const second = await collectRuns({
    stage: 'discover', runIds: ['r2', 'r1'], runsDir, paths,
  });
  assert.equal(second.runs, 2);
  assert.deepEqual(second.totals, {
    runs: 2, agents: 4, tokens: 200, cost: 1, durationMs: 2000,
  });
  const retro = await readJson(path.join(paths.dataDir, 'retros', 'discover.json'), null);
  assert.equal(retro.schemaVersion, 1);
  assert.equal(retro.title, 'discover');
  assert.deepEqual(retro.runs.map((r) => r.runId), ['r1', 'r2']);
});

test('collectRuns replaces an existing run entry in place', async () => {
  const { paths, runsDir } = await tmpDirs();
  await writeJournals(runsDir, [journal('r1'), journal('r2')]);
  await collectRuns({
    stage: 'discover', runIds: ['r1', 'r2'], runsDir, paths,
  });
  const rerun = journal('r1', { status: 'failed', tokenUsage: { total: 7, cost: 0 } });
  await writeJournals(runsDir, [rerun]);
  const out = await collectRuns({
    stage: 'discover', runIds: ['r1'], runsDir, paths,
  });
  assert.equal(out.runs, 2);
  const retro = await readJson(path.join(paths.dataDir, 'retros', 'discover.json'), null);
  assert.deepEqual(retro.runs.map((r) => r.runId), ['r1', 'r2']);
  assert.equal(retro.runs[0].status, 'failed');
  assert.equal(retro.totals.tokens, 107);
});

test('collectRuns fails with the journal path when a run id is unknown', async () => {
  const { paths, runsDir } = await tmpDirs();
  await assert.rejects(() => collectRuns({
    stage: 'discover', runIds: ['nope'], runsDir, paths,
  }), /nope\.json/);
});

test('renderRetro escapes text and renders the header totals', () => {
  const html = renderRetro({
    stage: 'discover',
    title: '<script>alert(1)</script>',
    verdict: 'partial',
    period: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' },
    totals: {
      runs: 2, agents: 4, tokens: 1234, cost: 1.5, durationMs: 65000,
    },
    summary: 'Ran & finished',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Ran &amp; finished/);
  assert.match(html, /2 runs/);
  assert.match(html, /\$1\.50/);
});

test('renderRetro maps verdicts to badge classes', () => {
  const html = renderRetro({
    stage: 's',
    title: 't',
    verdict: 'failed',
    critique: [
      { area: 'A', verdict: 'strong', text: 'good' },
      { area: 'B', verdict: 'adequate', text: 'ok' },
      { area: 'C', verdict: 'weak', text: 'bad' },
    ],
    improvements: [{
      title: 'I', action: 'do', status: 'planned', owner: 'machine',
    }],
  });
  assert.match(html, /class="badge badge-failed"/);
  assert.match(html, /class="badge badge-strong"/);
  assert.match(html, /class="badge badge-adequate"/);
  assert.match(html, /class="badge badge-weak"/);
  assert.match(html, /class="badge badge-planned"/);
});

test('renderRetro skips empty sections', () => {
  const html = renderRetro({ stage: 's', title: 't' });
  assert.doesNotMatch(html, /What went well/);
  assert.doesNotMatch(html, /Struggles/);
  assert.doesNotMatch(html, /Runs<\/h2>/);
  const full = renderRetro({
    stage: 's',
    title: 't',
    wentWell: ['it worked'],
    struggles: [{ title: 'S', impact: 'I', resolution: 'R' }],
    learnings: [{ title: 'L', tag: 'generic', ref: 'docs/migration/LEARNINGS.md' }],
    tools: { harness: ['pi'], skills: [] },
    artifacts: [{ path: 'docs/migration/x.md', description: 'report' }],
  });
  assert.match(full, /What went well/);
  assert.match(full, /Struggles/);
  assert.match(full, /badge-generic/);
  assert.match(full, /<strong>Harness<\/strong>/);
  assert.doesNotMatch(full, /Skills/);
});

test('relativeLink rewrites repo paths and leaves URLs alone', () => {
  assert.equal(relativeLink('docs/migration/x.md'), '../../../../docs/migration/x.md');
  assert.equal(relativeLink('/docs/migration/x.md'), '../../../../docs/migration/x.md');
  assert.equal(relativeLink('https://x.test/a'), 'https://x.test/a');
  assert.equal(relativeLink(''), '');
});

test('writeReport writes the HTML and replaces the stage entry in index.json', async () => {
  const { paths } = await tmpDirs();
  const file = path.join(paths.dataDir, 'retros', 'index.json');
  const retro = {
    stage: 'discover', title: 'Discover', verdict: 'success', summary: 'a'.repeat(250),
  };
  const first = await writeReport({ retro, paths });
  assert.equal(first.html, 'retros/discover.html');
  assert.equal(first.index, 1);
  const other = { stage: 'foundation', title: 'Foundation', verdict: 'partial' };
  await writeReport({ retro: other, paths });
  const again = await writeReport({
    retro: { ...retro, title: 'Discover v2', verdict: 'partial' },
    paths,
  });
  assert.equal(again.index, 2);
  const index = await readJson(file, null);
  const discover = index.filter((e) => e.stage === 'discover');
  assert.equal(discover.length, 1);
  assert.equal(discover[0].title, 'Discover v2');
  assert.equal(discover[0].verdict, 'partial');
  assert.equal(discover[0].summary.length, 200);
  assert.ok(index[0].generatedAt >= index[1].generatedAt);
});

test('CLI exits 1 with an actionable message when no runs dir is configured', async () => {
  const { paths } = await tmpDirs();
  const collectArgs = ['collect', '--stage', 'discover', '--runs', 'r1'];
  const env = { ...process.env, MIGRATION_DATA_DIR: paths.dataDir };
  delete env.MIGRATION_RUNS_DIR;
  await assert.rejects(
    () => execFileP(process.execPath, [retroCli, ...collectArgs], { env }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /MIGRATION_RUNS_DIR/);
      return true;
    },
  );
});

const sessionLine = (timestamp, cost, model = 'claude-fable-5-1') => JSON.stringify({
  type: 'message',
  timestamp,
  message: {
    role: 'assistant',
    provider: 'azure-anthropic',
    model,
    usage: {
      input: 1,
      output: 100,
      cacheRead: 1000,
      cacheWrite: 10,
      cost: { total: cost },
    },
  },
});

test('summarizeSession sums assistant usage, honours the time window and skips junk lines', () => {
  const text = [
    JSON.stringify({ type: 'session', timestamp: '2026-09-02T09:00:00Z' }),
    sessionLine('2026-09-02T10:00:00Z', 0.5),
    sessionLine('2026-09-02T11:00:00Z', 0.25, 'claude-opus-5'),
    JSON.stringify({
      type: 'message', timestamp: '2026-09-02T11:30:00Z', message: { role: 'user' },
    }),
    'not json',
    sessionLine('2026-09-03T00:00:00Z', 9),
  ].join('\n');
  const all = summarizeSession(text);
  assert.equal(all.turns, 3);
  assert.equal(all.cost, 9.75);
  assert.equal(all.cacheRead, 3000);
  assert.deepEqual(all.models, {
    'azure-anthropic/claude-fable-5-1': 2, 'azure-anthropic/claude-opus-5': 1,
  });
  const windowed = summarizeSession(text, {
    since: '2026-09-02T10:30:00Z', until: '2026-09-02T23:59:59Z',
  });
  assert.equal(windowed.turns, 1);
  assert.equal(windowed.cost, 0.25);
});

test('renderRetro shows the orchestrator spend and the grand total when collected', () => {
  const retro = {
    schemaVersion: 1,
    stage: 's',
    title: 'T',
    runs: [{
      runId: 'r',
      name: 'n',
      status: 'completed',
      agents: 1,
      tokens: 1,
      cost: 1.5,
      durationMs: 1000,
      startedAt: '2026-01-01T00:00:00Z',
      models: { m: 1 },
    }],
    orchestrator: {
      turns: 2,
      input: 1,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      cost: 2.5,
      models: { 'azure-anthropic/claude-fable-5-1': 2 },
    },
  };
  const html = renderRetro(retro);
  assert.match(html, /Orchestrator: 2 turns/);
  assert.match(html, /Total stage cost: \$4\.00/);
  const noSpend = renderRetro({ ...retro, orchestrator: undefined });
  assert.match(noSpend, /Orchestrator spend: not collected/);
});

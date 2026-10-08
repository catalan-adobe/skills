import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approve, init } from './migration.mjs';
import { finish, start, update } from './runs.mjs';
import { classOf } from './schema.mjs';
import {
  FILE, SCHEMA, STEPS, STEP_IDS, asText, compute, summarise, write,
} from './state.mjs';
import { openStore } from './store.mjs';

const fresh = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-state-'));
  await init(cwd, { origin: 'https://a.example/' });
  return cwd;
};
const byId = (state) => Object.fromEntries(state.steps.map((s) => [s.id, s]));
const pass = async () => ({ pass: true });

test('the process: dependency order, two gates, no tooling step', () => {
  assert.deepEqual(STEP_IDS,
    ['discover', 'access', 'cache', 'chrome', 'triage', 'elements', 'blocks', 'report']);
  assert.deepEqual(STEPS.filter((s) => s.gate).map((s) => s.id), ['cache', 'elements']);
  for (const s of STEPS) {
    for (const d of s.dependsOn) assert.ok(STEP_IDS.indexOf(d) < STEP_IDS.indexOf(s.id), `${s.id}`);
  }
});

test('states follow the checks, the runs, the dependencies and the approvals', async () => {
  const cwd = await fresh();
  const empty = byId(await compute(cwd));
  assert.deepEqual(Object.values(empty).map((s) => s.state),
    ['ready', 'ready', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked']);
  assert.deepEqual(empty.cache.blockedBy, ['discover', 'access']);
  const checks = { discover: pass, access: pass };
  const collected = byId(await compute(cwd, checks));
  assert.equal(collected.cache.state, 'waiting-operator', 'gated, not approved');
  assert.equal(collected.report.state, 'ready');
  await approve(cwd, 'cache', ['sample']);
  assert.equal(byId(await compute(cwd, checks)).cache.state, 'ready');
  const run = await start(cwd, 'cache', { selection: 'sample' });
  await update(cwd, run.id, { state: 'running', total: 50, done: 12 });
  const running = byId(await compute(cwd, checks));
  assert.deepEqual([running.cache.state, running.cache.run, running.cache.progress],
    ['running', run.id, '12/50']);
  const stale = byId(await compute(cwd, checks, { now: new Date(Date.now() + 11 * 60000) }));
  assert.equal(stale.cache.state, 'ready', 'an interrupted run holds nothing');
  assert.match(stale.cache.note, /was interrupted; start the step again/);
  await finish(cwd, run.id, { state: 'done', summary: 'cached 50' });
  const after = byId(await compute(cwd, { ...checks, cache: pass }));
  assert.equal(after.cache.state, 'done');
  assert.equal(after.chrome.state, 'ready');
  assert.equal(after.elements.state, 'blocked', 'chrome first');
  const chromed = byId(await compute(cwd, { ...checks, cache: pass, chrome: pass }));
  assert.equal(chromed.triage.state, 'ready');
  assert.equal(chromed.elements.state, 'blocked', 'triage first');
  const triaged = byId(await compute(cwd, { ...checks, cache: pass, chrome: pass, triage: pass }));
  assert.equal(triaged.elements.state, 'waiting-operator', 'the second gate');
  const noted = byId(await compute(cwd, { ...checks, cache: pass,
    chrome: async () => ({ pass: false, note: '3 pages behind the cache' }) }));
  assert.deepEqual([noted.chrome.state, noted.chrome.note], ['ready', '3 pages behind the cache']);
});

test('write lands state.json with a summary; asText reads for people', async () => {
  const cwd = await fresh();
  await approve(cwd, 'cache', ['s']);
  const run = await start(cwd, 'cache', {});
  await update(cwd, run.id, { state: 'running', total: 4, done: 1 });
  const state = await write(cwd, { discover: pass, access: pass });
  assert.equal(state.schema, SCHEMA);
  assert.equal(classOf(SCHEMA), 'derived');
  assert.deepEqual(await openStore(cwd).read(FILE, SCHEMA), state);
  assert.equal(state.summary,
    'done: discover, access; cache running (1/4); ready: report; '
    + 'blocked: chrome, triage, elements, blocks.');
  const text = asText(state);
  assert.match(text, /^step {6}state\n/);
  assert.match(text, /\ncache {5}running {10}1\/4\n/);
  assert.match(text, /\nchrome {4}blocked {10}by cache\n/);
  assert.ok(text.endsWith(state.summary));
  assert.equal(summarise([]), 'Nothing yet.');
});

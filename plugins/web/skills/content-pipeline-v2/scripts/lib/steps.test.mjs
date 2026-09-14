import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEP_IDS, stepById, stepStates } from './steps.mjs';

const states = (list) => Object.fromEntries(list.map((s) => [s.id, s.state]));

test('an empty project has setup ready and everything else blocked', () => {
  const s = states(stepStates({}));
  assert.equal(s.setup, 'ready');
  for (const id of STEP_IDS.filter((x) => x !== 'setup')) assert.equal(s[id], 'blocked', id);
  assert.deepEqual(stepStates({}).find((x) => x.id === 'prep').blockedBy, ['probe']);
});

test('prep and scan open together after probe; cache waits for the operator', () => {
  const afterProbe = states(stepStates({ setup: true, probe: true }));
  assert.equal(afterProbe.prep, 'ready');
  assert.equal(afterProbe.scan, 'ready');
  assert.equal(afterProbe['prep-verify'], 'blocked');
  const collected = { setup: true, probe: true, prep: true, scan: true };
  const s = states(stepStates(collected));
  assert.equal(s['prep-verify'], 'ready');
  assert.equal(s.cache, 'waiting-operator');
  assert.equal(s.report, 'ready');
  assert.equal(states(stepStates(collected, { cache: true })).cache, 'ready');
  assert.equal(states(stepStates({ ...collected, cache: true })).cache, 'done');
});

test('scan depends on setup only, so a blocked probe does not block it', () => {
  const s = states(stepStates({ setup: true }));
  assert.equal(s.scan, 'ready');
  assert.equal(s.probe, 'ready');
  assert.equal(s.prep, 'blocked');
});

test('stepById names the known steps on a miss', () => {
  assert.equal(stepById('cache').operatorGate, true);
  assert.throws(() => stepById('nope'), /Unknown step "nope"; steps: setup, probe/);
});

test('a done step lists nothing as blocking it, whatever its dependencies say', () => {
  const probe = stepStates({ probe: true }).find((s) => s.id === 'probe');
  assert.equal(probe.state, 'done');
  assert.deepEqual(probe.blockedBy, []);
});

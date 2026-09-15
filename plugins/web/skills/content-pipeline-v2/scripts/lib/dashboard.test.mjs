import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject } from './project.mjs';
import { dashboard, stopDashboard } from './dashboard.mjs';

const fakeIo = ({ up = new Set(), reachAfter = 0 } = {}) => {
  const calls = { spawned: [], killed: [] };
  let polls = 0;
  const io = {
    spawn: (port, root) => {
      calls.spawned.push({ port, root });
      up.add(4242);
      return 4242;
    },
    reachable: async () => { polls += 1; return polls > reachAfter && up.has(4242); },
    alive: (pid) => up.has(pid),
    kill: (pid) => { calls.killed.push(pid); up.delete(pid); },
    sleep: async () => {},
  };
  return { io, calls, up };
};

test('dashboard starts aem up on a free port, waits for it, records and reuses it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-dash-'));
  const project = resolveProject(root);
  const { io, calls } = fakeIo({ reachAfter: 2 });
  const first = await dashboard(project, async (from) => from + 5, io);
  assert.equal(first.started, true);
  assert.equal(first.url, 'http://localhost:3005/tools/migration/');
  assert.deepEqual(calls.spawned, [{ port: 3005, root }]);
  const state = JSON.parse(await readFile(path.join(root, 'migration/.work/dashboard.json')));
  assert.equal(state.pid, 4242);
  const again = await dashboard(project, async () => { throw new Error('not asked'); }, io);
  assert.equal(again.started, false, 'a live server is reused, no second aem up');
  assert.equal(again.url, first.url);
  const stopped = await stopDashboard(project, io);
  assert.deepEqual(stopped, { stopped: true, pid: 4242, port: 3005 });
  assert.deepEqual(calls.killed, [4242]);
  assert.deepEqual(await stopDashboard(project, io), { stopped: false });
});

test('dashboard fails clearly when aem up dies before answering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-dash-'));
  const project = resolveProject(root);
  const { io, calls, up } = fakeIo();
  io.reachable = async () => { up.delete(4242); return false; };
  await assert.rejects(dashboard(project, async () => 3000, io), /did not answer on port 3000/);
  assert.deepEqual(calls.killed, [4242]);
});

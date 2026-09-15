// free-port against the operating system: listeners bound each way must all count as taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { freePort } from '../lib/ports.mjs';

test('free-port skips ports held on 0.0.0.0, 127.0.0.1 and ::', async () => {
  for (const host of ['0.0.0.0', '127.0.0.1', '::']) {
    const taken = createServer();
    await new Promise((r) => taken.listen(0, host, r));
    const { port } = taken.address();
    assert.notEqual(await freePort(port), port, `held on ${host}`);
    taken.close();
  }
  const free = await freePort(40000);
  const probe = createServer();
  await new Promise((r) => probe.listen(free, r));
  probe.close();
});

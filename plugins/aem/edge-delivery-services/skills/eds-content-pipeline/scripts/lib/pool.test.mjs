import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from './pool.mjs';

test('mapPool preserves order and bounds concurrency', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapPool([30, 10, 20, 5], 2, async (ms, i) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => { setTimeout(r, ms); });
    active -= 1;
    return `${i}:${ms}`;
  });
  assert.deepEqual(results, ['0:30', '1:10', '2:20', '3:5']);
  assert.equal(peak, 2);
});

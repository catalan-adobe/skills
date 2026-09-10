import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flag, positiveIntFlag } from './args.mjs';

test('positiveIntFlag parses the value that follows the flag', () => {
  assert.equal(positiveIntFlag(['--limit', '25'], '--limit', Infinity), 25);
  assert.equal(positiveIntFlag(['--type', 'blog', '--limit', '1'], '--limit', 9), 1);
});

test('positiveIntFlag returns the fallback when the flag is absent', () => {
  assert.equal(positiveIntFlag(['--force'], '--limit', Infinity), Infinity);
  assert.equal(positiveIntFlag([], '--max-minutes', 10), 10);
});

test('positiveIntFlag rejects non-integer values', () => {
  assert.throws(
    () => positiveIntFlag(['--limit', '2.5'], '--limit', Infinity),
    { message: 'Expected --limit <positive integer>, got "2.5"' },
  );
  assert.throws(
    () => positiveIntFlag(['--limit', 'many'], '--limit', Infinity),
    { message: 'Expected --limit <positive integer>, got "many"' },
  );
});

test('positiveIntFlag rejects zero and negative values', () => {
  assert.throws(
    () => positiveIntFlag(['--limit', '0'], '--limit', Infinity),
    { message: 'Expected --limit <positive integer>, got "0"' },
  );
  assert.throws(
    () => positiveIntFlag(['--limit', '-3'], '--limit', Infinity),
    { message: 'Expected --limit <positive integer>, got "-3"' },
  );
});

test('positiveIntFlag rejects a flag with no value at all', () => {
  assert.throws(
    () => positiveIntFlag(['--limit'], '--limit', Infinity),
    { message: 'Expected --limit <positive integer>, got "undefined"' },
  );
});

test('flag reads the raw value and falls back when absent', () => {
  assert.equal(flag(['--type', 'blog'], '--type', null), 'blog');
  assert.equal(flag(['--force'], '--type', null), null);
});

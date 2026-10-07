import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSES, HEAD, classOf, faults, register, registered, schemaOf, validate,
} from './schema.mjs';

const thing = {
  type: 'object',
  required: ['schema', 'name', 'count'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    name: { type: 'string', pattern: '^[a-z-]+$' },
    count: { type: 'integer', minimum: 0, maximum: 10 },
    kind: { enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
    when: { type: 'string', format: 'date-time' },
    ref: { type: ['string', 'null'] },
    shape: { oneOf: [
      { type: 'object', required: ['role'], properties: { role: { const: 'x' } } },
      { type: 'object', required: ['role'], properties: { role: { const: 'y' } } },
    ] },
    extra: { type: 'object', additionalProperties: { type: 'number' } },
  },
};

test('faults: every supported keyword rejects the wrong shape and accepts the right one', () => {
  const good = {
    schema: 'test/thing@1', name: 'ok-name', count: 3, kind: 'a', tags: ['t'],
    when: '2026-09-22T10:00:00.000Z', ref: null, shape: { role: 'y' }, extra: { n: 1 },
  };
  assert.deepEqual(faults(good, thing), []);
  const bad = {
    schema: 7, name: 'Not Ok', count: 11.5, kind: 'c', tags: [], when: 'yesterday', ref: 3,
    shape: { role: 'z' }, extra: { n: 'x' }, surplus: true,
  };
  assert.deepEqual(faults(bad, thing), [
    '$.schema: must be string, is number',
    '$.name: must match ^[a-z-]+$',
    '$.count: must be integer, is number',
    '$.kind: must be one of "a", "b"',
    '$.tags: must have at least 1 items',
    '$.when: must be an ISO 8601 date-time',
    '$.ref: must be string or null, is number',
    '$.shape: must match exactly one shape (matched 0)',
    '$.extra.n: must be number, is string',
    '$.surplus: not allowed',
  ]);
  assert.deepEqual(faults({ schema: 'x' }, thing), ['$.name: required', '$.count: required']);
  assert.deepEqual(faults({ schema: 'x', name: 'a', count: -1 }, thing), ['$.count: must be >= 0']);
  assert.deepEqual(faults('s', { type: 'object' }), ['$: must be object, is string']);
  assert.deepEqual(faults(null, { type: ['object', 'null'] }), []);
});

test('the registry: a file names a registered schema with a class; validate names the file',
  () => {
    assert.throws(() => register('x', 1, 'guess', thing), /unknown class "guess"/);
    register('test/thing', 1, 'derived', thing);
    assert.ok(registered().includes('test/thing@1'));
    assert.equal(classOf('test/thing@1'), 'derived');
    assert.equal(schemaOf('test/thing@1').schema, thing);
    assert.deepEqual(CLASSES, ['decision', 'raw', 'derived', 'run', 'history', 'evidence', 'view']);
    const file = 'migration/x.json';
    assert.throws(() => validate({ name: 'a' }, file), /x\.json: no "schema" field/);
    assert.throws(() => validate({ schema: 'nope@9' }, file), /unknown schema nope@9; registered:/);
    assert.throws(() => validate({ schema: 'test/thing@1' }, file, 'other@1'),
      /schema is test\/thing@1, expected other@1/);
    assert.throws(
      () => validate({ schema: 'test/thing@1', name: 'A', count: 99, kind: 'z' }, file),
      /x\.json: 3 fault\(s\) against test\/thing@1 — \$\.name: must match .*; \$\.count: must/,
    );
    const entry = validate({ schema: 'test/thing@1', name: 'a', count: 1 }, file);
    assert.equal(entry.cls, 'derived');
  });

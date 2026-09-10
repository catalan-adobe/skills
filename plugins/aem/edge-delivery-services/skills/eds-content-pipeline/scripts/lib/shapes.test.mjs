import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRecord, assertBlock } from './shapes.mjs';

const NOW = '2026-09-03T00:00:00.000Z';

test('blocks record with name, status and updatedAt passes', () => {
  assert.doesNotThrow(() => assertRecord('blocks', {
    name: 'header',
    status: 'todo',
    updatedAt: NOW,
  }));
});

test('blocks record missing a required field fails with missing field message', () => {
  assert.throws(
    () => assertRecord('blocks', { status: 'todo', updatedAt: NOW }),
    /is missing: name/,
  );
  assert.throws(
    () => assertRecord('blocks', { name: 'header', status: 'todo' }),
    /is missing: updatedAt/,
  );
});

test('blocks record with invalid status fails with enum error', () => {
  assert.throws(
    () => assertRecord('blocks', { name: 'header', status: 'open', updatedAt: NOW }),
    /invalid status "open"/,
  );
});

test('blocks record with all optional fields passes', () => {
  assert.doesNotThrow(() => assertRecord('blocks', {
    name: 'hero',
    status: 'passed',
    updatedAt: NOW,
    template: 'page',
    variant: 'dark',
    fixture: 'site/fixtures/hero.plain.html',
    checks: { lint: 'pass', render: 'pass' },
    attempts: 1,
    source: 'local',
    sections: ['hero', 'cards'],
  }));
});

test('blocks status enum covers todo building passed failed', () => {
  for (const s of ['todo', 'building', 'passed', 'failed']) {
    assert.doesNotThrow(() => assertRecord('blocks', { name: 'x', status: s, updatedAt: NOW }));
  }
});

test('assertBlock rejects name ../evil with kebab-case error', () => {
  assert.throws(
    () => assertBlock({
      name: '../evil',
      status: 'scaffold',
      model: {
        rows: 'repeat',
        columns: [{ name: 'x', type: 'text' }],
        header: false,
      },
      templates: {},
      evidence: [],
    }),
    /kebab-case/,
  );
});

test('assertBlock rejects status todo', () => {
  assert.throws(
    () => assertBlock({
      name: 'valid',
      status: 'todo',
      model: {
        rows: 'repeat',
        columns: [{ name: 'x', type: 'text' }],
        header: false,
      },
      templates: {},
      evidence: [],
    }),
    /status must be scaffold \| implemented/,
  );
});

test('assertBlock rejects missing model.columns', () => {
  assert.throws(
    () => assertBlock({
      name: 'valid',
      status: 'scaffold',
      model: {
        rows: 'repeat',
        columns: undefined,
        header: false,
      },
      templates: {},
      evidence: [],
    }),
    /model\.columns must be non-empty/,
  );
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SCRIPT = path.resolve(
  __dirname,
  '../../skills/page-prep/scripts/overlay-db.js'
);

function load() {
  delete require.cache[SCRIPT];
  return require(SCRIPT);
}

describe('parseAbpHideRules', () => {
  it('extracts generic CSS selectors from ABP filter syntax', () => {
    const mod = load();
    const input = [
      '! Comment line',
      '##.cookie-banner',
      '##.cookie-consent',
      '##[id*="cookie-notice"]',
      'example.com##.site-specific-banner',
      '||tracking.example.com/cookie^$third-party',
      '',
    ].join('\n');
    const result = mod.parseAbpHideRules(input);
    assert.deepEqual(result, [
      '.cookie-banner',
      '.cookie-consent',
      '[id*="cookie-notice"]',
    ]);
  });

  it('returns empty array for empty input', () => {
    const mod = load();
    assert.deepEqual(mod.parseAbpHideRules(''), []);
  });

  it('deduplicates selectors', () => {
    const mod = load();
    const input = '##.cookie-banner\n##.cookie-banner\n';
    const result = mod.parseAbpHideRules(input);
    assert.deepEqual(result, ['.cookie-banner']);
  });
});

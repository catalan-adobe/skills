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

describe('normalizeCmpRules', () => {
  it('extracts detect selectors from presentMatcher and showingMatcher', () => {
    const mod = load();
    const fixture = require('./fixtures/consent-o-matic-sample.json');
    const result = mod.normalizeCmpRules(fixture);
    assert.deepEqual(result.cmps.onetrust.detect, ['#onetrust-consent-sdk', '#onetrust-banner-sdk']);
  });

  it('sets detect_requires_visible when displayFilter is present', () => {
    const mod = load();
    const fixture = require('./fixtures/consent-o-matic-sample.json');
    const result = mod.normalizeCmpRules(fixture);
    assert.equal(result.cmps.onetrust.detect_requires_visible, true);
  });

  it('extracts hide selectors from HIDE_CMP method', () => {
    const mod = load();
    const fixture = require('./fixtures/consent-o-matic-sample.json');
    const result = mod.normalizeCmpRules(fixture);
    assert.deepEqual(result.cmps.cookiebot.hide, [
      '#CybotCookiebotDialog { display:none!important }',
      '#CybotCookiebotDialogBodyUnderlay { display:none!important }',
    ]);
  });

  it('extracts dismiss actions from DO_CONSENT + SAVE_CONSENT', () => {
    const mod = load();
    const fixture = require('./fixtures/consent-o-matic-sample.json');
    const result = mod.normalizeCmpRules(fixture);
    assert.deepEqual(result.cmps.cookiebot.dismiss, [
      { action: 'click', selector: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll' },
      { action: 'wait', ms: 500 },
    ]);
  });

  it('tracks partial coverage when textFilter is dropped', () => {
    const mod = load();
    const fixture = require('./fixtures/consent-o-matic-sample.json');
    const result = mod.normalizeCmpRules(fixture);
    assert.ok(result.partial_coverage_cmps.includes('text-filter-cmp'));
  });

  it('handles CMP with empty DO_CONSENT', () => {
    const mod = load();
    const fixture = require('./fixtures/consent-o-matic-sample.json');
    const result = mod.normalizeCmpRules(fixture);
    assert.deepEqual(result.cmps['text-filter-cmp'].dismiss, []);
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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

describe('cache management', () => {
  const tmpDir = path.join(os.tmpdir(), `page-prep-test-${Date.now()}`);

  it('isCacheStale returns true when no cache exists', () => {
    const mod = load();
    assert.equal(mod.isCacheStale(path.join(tmpDir, 'nonexistent')), true);
  });

  it('isCacheStale returns false for fresh cache', () => {
    const mod = load();
    fs.mkdirSync(tmpDir, { recursive: true });
    const lastFetch = path.join(tmpDir, 'last-fetch');
    fs.writeFileSync(lastFetch, new Date().toISOString());
    assert.equal(mod.isCacheStale(lastFetch), false);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('isCacheStale returns true for old cache', () => {
    const mod = load();
    fs.mkdirSync(tmpDir, { recursive: true });
    const lastFetch = path.join(tmpDir, 'last-fetch');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.writeFileSync(lastFetch, old.toISOString());
    assert.equal(mod.isCacheStale(lastFetch), true);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('buildPatternsJson', () => {
  it('combines CMP rules and ABP selectors into patterns.json schema', () => {
    const mod = load();
    const cmpResult = {
      cmps: { onetrust: { detect: ['#onetrust-consent-sdk'], detect_requires_visible: true, hide: ['#onetrust-consent-sdk { display:none!important }'], dismiss: [{ action: 'click', selector: '#onetrust-accept-btn-handler' }] } },
      partial_coverage_cmps: [],
    };
    const genericSelectors = ['.cookie-banner', '.cookie-consent'];
    const result = mod.buildPatternsJson(cmpResult, genericSelectors);
    assert.equal(result.version, 1);
    assert.ok(result.fetched_at);
    assert.deepEqual(result.sources, ['consent-o-matic', 'easylist-cookie']);
    assert.equal(result.stats.consent_o_matic_cmps, 1);
    assert.equal(result.stats.easylist_selectors, 2);
    assert.deepEqual(result.cmps, cmpResult.cmps);
    assert.deepEqual(result.generic_selectors, genericSelectors);
  });
});

describe('buildBundle', () => {
  it('embeds patterns JSON into detection script', () => {
    const mod = load();
    const patterns = { version: 1, cmps: {}, generic_selectors: [] };
    const detectScript = 'return PATTERNS.version;';
    const bundle = mod.buildBundle(patterns, detectScript);
    assert.ok(bundle.includes('"version":1'));
  });

  it('produces valid JavaScript that returns a value', () => {
    const mod = load();
    const patterns = { version: 1, cmps: { test: { detect: ['.x'] } }, generic_selectors: ['.a'] };
    const detectScript = 'return PATTERNS.version;';
    const bundle = mod.buildBundle(patterns, detectScript);
    // eslint-disable-next-line no-eval
    const result = eval(bundle);
    assert.equal(result, 1);
  });
});

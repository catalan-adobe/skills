'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SCRIPT = path.resolve(
  __dirname,
  '../../skills/page-prep/scripts/overlay-detect.js'
);

function load() {
  delete require.cache[SCRIPT];
  return require(SCRIPT);
}

describe('matchKnownPatterns', () => {
  it('returns matches when detect selectors exist in document', () => {
    const mod = load();
    const patterns = {
      cmps: {
        onetrust: {
          detect: ['#onetrust-sdk'],
          detect_requires_visible: false,
          hide: ['#onetrust-sdk { display:none!important }'],
          dismiss: [{ action: 'click', selector: '#accept' }],
        },
      },
    };
    const mockDoc = {
      querySelector: (sel) => (sel === '#onetrust-sdk' ? { id: 'onetrust-sdk' } : null),
    };
    const result = mod.matchKnownPatterns(patterns.cmps, mockDoc);
    assert.equal(result.length, 1);
    assert.equal(result[0].cmp, 'onetrust');
    assert.equal(result[0].source, 'cmp-match');
    assert.equal(result[0].confidence, 1.0);
  });

  it('returns empty when no selectors match', () => {
    const mod = load();
    const patterns = {
      cmps: {
        onetrust: {
          detect: ['#onetrust-sdk'],
          detect_requires_visible: false,
          hide: [],
          dismiss: [],
        },
      },
    };
    const mockDoc = { querySelector: () => null };
    const result = mod.matchKnownPatterns(patterns.cmps, mockDoc);
    assert.equal(result.length, 0);
  });
});

describe('scoreElement', () => {
  it('scores high for fixed position + viewport cover + high z-index', () => {
    const mod = load();
    const mockEl = {
      id: 'overlay',
      className: '',
      tagName: 'DIV',
      getAttribute: () => null,
      matches: () => false,
      getBoundingClientRect: () => ({ width: 1024, height: 768, top: 0, left: 0 }),
    };
    const mockStyle = { position: 'fixed', zIndex: '9999' };
    const viewport = { width: 1024, height: 768 };
    const result = mod.scoreElement(mockEl, mockStyle, viewport, []);
    assert.ok(result.confidence >= 0.40);
    assert.ok(result.signals.includes('high-z-index'));
    assert.ok(result.signals.includes('viewport-cover'));
  });

  it('scores keyword-match for cookie-related class names', () => {
    const mod = load();
    const mockEl = {
      id: '',
      className: 'gdpr-consent-banner',
      tagName: 'DIV',
      getAttribute: () => null,
      matches: () => false,
      getBoundingClientRect: () => ({ width: 200, height: 50, top: 0, left: 0 }),
    };
    const mockStyle = { position: 'fixed', zIndex: '100' };
    const viewport = { width: 1024, height: 768 };
    const result = mod.scoreElement(mockEl, mockStyle, viewport, []);
    assert.ok(result.signals.includes('keyword-match'));
  });

  it('boosts confidence when scroll is locked and element has consent keywords', () => {
    const mod = load();
    const mockEl = {
      id: '',
      className: 'gdpr-lmd-wall',
      tagName: 'DIV',
      getAttribute: () => null,
      matches: () => false,
      getBoundingClientRect: () => ({ width: 1024, height: 300, top: 468, left: 0 }),
    };
    const mockStyle = { position: 'fixed', zIndex: '9999' };
    const viewport = { width: 1024, height: 768 };
    // Without scroll lock: high-z-index (0.15) + keyword-match (0.15) = 0.30
    const noBoost = mod.scoreElement(mockEl, mockStyle, viewport, [], false);
    assert.equal(noBoost.confidence, 0.3);
    // With scroll lock: same signals + scroll-lock-boost (0.15) = 0.45
    const boosted = mod.scoreElement(mockEl, mockStyle, viewport, [], true);
    assert.ok(boosted.confidence >= 0.40);
    assert.ok(boosted.signals.includes('scroll-lock-boost'));
  });

  it('does not boost scroll-lock for elements without consent keywords', () => {
    const mod = load();
    const mockEl = {
      id: 'toolbar',
      className: 'floating-toolbar',
      tagName: 'DIV',
      getAttribute: () => null,
      matches: () => false,
      getBoundingClientRect: () => ({ width: 300, height: 50, top: 0, left: 0 }),
    };
    const mockStyle = { position: 'fixed', zIndex: '9999' };
    const viewport = { width: 1024, height: 768 };
    const result = mod.scoreElement(mockEl, mockStyle, viewport, [], true);
    assert.ok(!result.signals.includes('scroll-lock-boost'));
  });

  it('returns confidence below threshold for normal fixed element (e.g. navbar)', () => {
    const mod = load();
    const mockEl = {
      id: 'navbar',
      className: 'nav-main',
      tagName: 'NAV',
      getAttribute: () => null,
      matches: () => false,
      getBoundingClientRect: () => ({ width: 1024, height: 60, top: 0, left: 0 }),
    };
    const mockStyle = { position: 'fixed', zIndex: '100' };
    const viewport = { width: 1024, height: 768 };
    const result = mod.scoreElement(mockEl, mockStyle, viewport, []);
    assert.ok(result.confidence < 0.30, `Expected < 0.30, got ${result.confidence}`);
  });
});

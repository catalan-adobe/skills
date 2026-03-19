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

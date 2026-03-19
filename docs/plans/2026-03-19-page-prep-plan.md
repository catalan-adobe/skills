# page-prep Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a skill that detects and removes disruptive webpage overlays, producing portable recipes any browser tool can execute.

**Architecture:** Two Node.js scripts — `overlay-db.js` (host-side: fetch/cache/normalize Consent-O-Matic + EasyList databases) and `overlay-detect.js` (browser-injectable: DOM scanning with known-pattern + heuristic detection). Orchestrated by SKILL.md prompt. No npm dependencies — Node 22 built-in `fetch` and `node:test`.

**Tech Stack:** Node 22 (built-in fetch, test runner), ABP filter syntax, Consent-O-Matic JSON rules

**Spec:** `docs/plans/2026-03-19-page-prep-design.md`

---

## File Structure

```
skills/page-prep/
  SKILL.md                         # Orchestration prompt
  scripts/
    overlay-db.js                  # Host-side: fetch, cache, normalize, bundle
    overlay-detect.js              # Browser-injectable: scan DOM, return report
  references/
    known-patterns.md              # Agent fallback reference for unknown overlays

tests/page-prep/
  overlay-db.test.js               # Tests for database layer
  overlay-detect.test.js           # Tests for detection script
  fixtures/
    consent-o-matic-sample.json    # Subset of real Consent-O-Matic rules
    easylist-sample.txt            # Subset of real EasyList cookie hide rules
```

**Files to modify when done:**
- `README.md` — add page-prep entry to Available Skills
- `.claude-plugin/plugin.json` — add page-prep to description and keywords
- `.claude-plugin/marketplace.json` — add page-prep to description
- `.claude/CLAUDE.md` — add page-prep to Available Skills table

---

## Task Parallelism

- **Chunk 1** (Tasks 1-4) and **Chunk 2** (Tasks 5-6) are independent — they can run in parallel as separate subagents. `overlay-db.js` and `overlay-detect.js` have no import dependency.
- **Within** each chunk, tasks are sequential (each builds on the previous).
- **Chunk 3** Tasks 7, 8, and 9 are mutually independent and can run in parallel. Task 10 depends on all prior tasks.

---

## Chunk 1: Database Layer

### Task 1: ABP Filter Parsing

Parse EasyList cookie hide rules from ABP filter syntax into plain CSS selectors.

**Files:**
- Create: `tests/page-prep/fixtures/easylist-sample.txt`
- Create: `tests/page-prep/overlay-db.test.js`
- Create: `skills/page-prep/scripts/overlay-db.js`

- [ ] **Step 1: Create test fixture**

Create `tests/page-prep/fixtures/easylist-sample.txt` with representative ABP filter lines:

```
! EasyList Cookie - General element hiding rules
! Last modified: 2026-03-01
##.cookie-banner
##.cookie-consent
##[id*="cookie-notice"]
##[class*="gdpr"]
example.com##.site-specific-banner
##.newsletter-popup
! Comment line
||tracking.example.com/cookie^$third-party
```

This covers: generic hide rules (`##`), domain-specific rules (`example.com##`), comments (`!`), and network rules (`||`).

- [ ] **Step 2: Write failing test for ABP parsing**

In `tests/page-prep/overlay-db.test.js`:

```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/page-prep/overlay-db.test.js`
Expected: FAIL — module not found or `parseAbpHideRules` not exported

- [ ] **Step 4: Implement parseAbpHideRules**

Create `skills/page-prep/scripts/overlay-db.js` with initial structure:

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CACHE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.cache',
  'page-prep'
);
const PATTERNS_FILE = path.join(CACHE_DIR, 'patterns.json');
const LAST_FETCH_FILE = path.join(CACHE_DIR, 'last-fetch');
const STALENESS_DAYS = 7;

// --- ABP Filter Parsing ---

function parseAbpHideRules(text) {
  const seen = new Set();
  const selectors = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('!')) continue;
    // Generic cosmetic rules start with ## (no domain prefix)
    if (!trimmed.startsWith('##')) continue;
    const selector = trimmed.slice(2);
    if (selector && !seen.has(selector)) {
      seen.add(selector);
      selectors.push(selector);
    }
  }
  return selectors;
}

module.exports = { parseAbpHideRules };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/page-prep/overlay-db.test.js`
Expected: 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add tests/page-prep/ skills/page-prep/scripts/overlay-db.js
git commit -m "feat(page-prep): add ABP filter parsing for EasyList cookie rules"
```

---

### Task 2: Consent-O-Matic Normalization

Normalize Consent-O-Matic rule format into the patterns.json schema.

**Files:**
- Create: `tests/page-prep/fixtures/consent-o-matic-sample.json`
- Modify: `tests/page-prep/overlay-db.test.js`
- Modify: `skills/page-prep/scripts/overlay-db.js`

- [ ] **Step 1: Create test fixture**

Create `tests/page-prep/fixtures/consent-o-matic-sample.json` with a realistic CMP rule structure (modeled on OneTrust):

```json
{
  "onetrust": {
    "detectors": [
      {
        "presentMatcher": [
          {
            "type": "css",
            "target": { "selector": "#onetrust-consent-sdk" },
            "displayFilter": true
          }
        ],
        "showingMatcher": [
          {
            "type": "css",
            "target": { "selector": "#onetrust-banner-sdk" },
            "displayFilter": true
          }
        ]
      }
    ],
    "methods": [
      {
        "HIDE_CMP": [
          {
            "type": "hide",
            "target": { "selector": "#onetrust-consent-sdk" }
          },
          {
            "type": "hide",
            "target": { "selector": "#onetrust-banner-sdk" }
          }
        ],
        "DO_CONSENT": [
          {
            "type": "click",
            "target": { "selector": "#onetrust-accept-btn-handler" }
          }
        ],
        "SAVE_CONSENT": []
      }
    ]
  },
  "cookiebot": {
    "detectors": [
      {
        "presentMatcher": [
          {
            "type": "css",
            "target": { "selector": "#CybotCookiebotDialog" }
          }
        ],
        "showingMatcher": [
          {
            "type": "css",
            "target": { "selector": "#CybotCookiebotDialog" },
            "displayFilter": true
          }
        ]
      }
    ],
    "methods": [
      {
        "HIDE_CMP": [
          {
            "type": "hide",
            "target": { "selector": "#CybotCookiebotDialog" }
          },
          {
            "type": "hide",
            "target": { "selector": "#CybotCookiebotDialogBodyUnderlay" }
          }
        ],
        "DO_CONSENT": [
          {
            "type": "click",
            "target": { "selector": "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" }
          }
        ],
        "SAVE_CONSENT": [
          {
            "type": "wait",
            "waitTime": 500
          }
        ]
      }
    ]
  },
  "text-filter-cmp": {
    "detectors": [
      {
        "presentMatcher": [
          {
            "type": "css",
            "target": { "selector": ".consent-dialog" },
            "textFilter": ["Accept cookies", "cookie policy"]
          }
        ],
        "showingMatcher": []
      }
    ],
    "methods": [
      {
        "HIDE_CMP": [
          {
            "type": "hide",
            "target": { "selector": ".consent-dialog" }
          }
        ],
        "DO_CONSENT": [],
        "SAVE_CONSENT": []
      }
    ]
  }
}
```

- [ ] **Step 2: Write failing test for normalization**

Append to `tests/page-prep/overlay-db.test.js`:

```js
describe('normalizeCmpRules', () => {
  it('extracts detect selectors from presentMatcher and showingMatcher', () => {
    const mod = load();
    const fixture = require('./fixtures/consent-o-matic-sample.json');
    const result = mod.normalizeCmpRules(fixture);
    assert.deepEqual(result.cmps.onetrust.detect, [
      '#onetrust-consent-sdk',
      '#onetrust-banner-sdk',
    ]);
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/page-prep/overlay-db.test.js`
Expected: FAIL — `normalizeCmpRules` not defined

- [ ] **Step 4: Implement normalizeCmpRules**

Add to `skills/page-prep/scripts/overlay-db.js`:

```js
// --- Consent-O-Matic Normalization ---

function extractSelectors(matchers) {
  const selectors = [];
  let requiresVisible = false;
  for (const matcher of matchers ?? []) {
    if (matcher.type === 'css' && matcher.target?.selector) {
      selectors.push(matcher.target.selector);
      if (matcher.displayFilter) requiresVisible = true;
    }
  }
  return { selectors, requiresVisible };
}

function extractHideSelectors(hideActions) {
  const rules = [];
  for (const action of hideActions ?? []) {
    if (action.type === 'hide' && action.target?.selector) {
      rules.push(`${action.target.selector} { display:none!important }`);
    }
  }
  return rules;
}

function extractDismissActions(doConsent, saveConsent) {
  const actions = [];
  for (const action of doConsent ?? []) {
    if (action.type === 'click' && action.target?.selector) {
      actions.push({ action: 'click', selector: action.target.selector });
    }
  }
  for (const action of saveConsent ?? []) {
    if (action.type === 'wait' && action.waitTime) {
      actions.push({ action: 'wait', ms: action.waitTime });
    }
    if (action.type === 'click' && action.target?.selector) {
      actions.push({ action: 'click', selector: action.target.selector });
    }
  }
  return actions;
}

function hasDroppedFilters(matchers) {
  return (matchers ?? []).some(
    (m) => (m.textFilter && m.textFilter.length > 0) || m.childFilter
  );
}

function normalizeCmpRules(rawRules) {
  const cmps = {};
  const partialCoverage = [];

  for (const [name, rule] of Object.entries(rawRules)) {
    const detector = rule.detectors?.[0];
    const method = rule.methods?.[0];
    if (!detector) continue;

    const present = extractSelectors(detector.presentMatcher);
    const showing = extractSelectors(detector.showingMatcher);
    const allSelectors = [...new Set([
      ...present.selectors,
      ...showing.selectors,
    ])];

    if (allSelectors.length === 0) continue;

    const hasPartialCoverage =
      hasDroppedFilters(detector.presentMatcher) ||
      hasDroppedFilters(detector.showingMatcher);
    if (hasPartialCoverage) partialCoverage.push(name);

    cmps[name] = {
      detect: allSelectors,
      detect_requires_visible: present.requiresVisible || showing.requiresVisible,
      hide: extractHideSelectors(method?.HIDE_CMP),
      dismiss: extractDismissActions(method?.DO_CONSENT, method?.SAVE_CONSENT),
    };
  }

  return { cmps, partial_coverage_cmps: partialCoverage };
}
```

Update the `module.exports`:

```js
module.exports = { parseAbpHideRules, normalizeCmpRules };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/page-prep/overlay-db.test.js`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add tests/page-prep/ skills/page-prep/scripts/overlay-db.js
git commit -m "feat(page-prep): add Consent-O-Matic rule normalization"
```

---

### Task 3: Cache Management & Fetch

Implement refresh, status, and staleness logic. Uses mocked fetch for tests.

**Files:**
- Modify: `tests/page-prep/overlay-db.test.js`
- Modify: `skills/page-prep/scripts/overlay-db.js`

- [ ] **Step 1: Write failing tests for cache logic**

Append to `tests/page-prep/overlay-db.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');

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
      cmps: {
        onetrust: {
          detect: ['#onetrust-consent-sdk'],
          detect_requires_visible: true,
          hide: ['#onetrust-consent-sdk { display:none!important }'],
          dismiss: [{ action: 'click', selector: '#onetrust-accept-btn-handler' }],
        },
      },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/page-prep/overlay-db.test.js`
Expected: FAIL — `isCacheStale` and `buildPatternsJson` not defined

- [ ] **Step 3: Implement cache management and buildPatternsJson**

Add to `skills/page-prep/scripts/overlay-db.js`:

```js
// --- Cache Management ---

function isCacheStale(lastFetchPath, maxDays = STALENESS_DAYS) {
  try {
    const timestamp = fs.readFileSync(lastFetchPath, 'utf8').trim();
    const age = Date.now() - new Date(timestamp).getTime();
    return age > maxDays * 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

function buildPatternsJson(cmpResult, genericSelectors) {
  return {
    version: 1,
    fetched_at: new Date().toISOString(),
    sources: ['consent-o-matic', 'easylist-cookie'],
    stats: {
      consent_o_matic_cmps: Object.keys(cmpResult.cmps).length,
      easylist_selectors: genericSelectors.length,
      partial_coverage_cmps: cmpResult.partial_coverage_cmps,
    },
    cmps: cmpResult.cmps,
    generic_selectors: genericSelectors,
  };
}
```

Update `module.exports`:

```js
module.exports = {
  parseAbpHideRules,
  normalizeCmpRules,
  isCacheStale,
  buildPatternsJson,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/page-prep/overlay-db.test.js`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add tests/page-prep/ skills/page-prep/scripts/overlay-db.js
git commit -m "feat(page-prep): add cache management and patterns.json builder"
```

---

### Task 4: CLI Subcommands (refresh, status, lookup, bundle)

Wire up the CLI entry point with subcommand dispatch, fetch logic, and the bundle command.

**Files:**
- Modify: `skills/page-prep/scripts/overlay-db.js`
- Modify: `tests/page-prep/overlay-db.test.js`

- [ ] **Step 1: Write failing test for bundle command**

Append to `tests/page-prep/overlay-db.test.js`:

```js
describe('buildBundle', () => {
  it('embeds patterns JSON into detection script', () => {
    const mod = load();
    const patterns = { version: 1, cmps: {}, generic_selectors: [] };
    const detectScript = '(function(PATTERNS) { return PATTERNS; })';
    const bundle = mod.buildBundle(patterns, detectScript);
    assert.ok(bundle.includes('"version":1'));
    assert.ok(bundle.includes('return PATTERNS'));
  });

  it('produces valid JavaScript that returns a value', () => {
    const mod = load();
    const patterns = {
      version: 1,
      cmps: { test: { detect: ['.x'] } },
      generic_selectors: ['.a'],
    };
    // Detection script uses PATTERNS directly (not as a parameter)
    const detectScript = 'return PATTERNS.version;';
    const bundle = mod.buildBundle(patterns, detectScript);
    // Bundle wraps as IIFE: (function(){var PATTERNS=...;return PATTERNS.version;})()
    const result = eval(bundle);
    assert.equal(result, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/page-prep/overlay-db.test.js`
Expected: FAIL — `buildBundle` not defined

- [ ] **Step 3: Implement buildBundle and CLI**

Add to `skills/page-prep/scripts/overlay-db.js`:

```js
// --- Bundle ---

function buildBundle(patterns, detectScriptSource) {
  const patternsJson = JSON.stringify(patterns);
  return `(function(){var PATTERNS=${patternsJson};${detectScriptSource}})()`;
}

// --- Fetch Sources ---

const CONSENT_O_MATIC_RULES =
  'https://raw.githubusercontent.com/AuxGrep/AuxGrep-Consent-O-Matic/refs/heads/master/Rules.json';
const EASYLIST_COOKIE_HIDE =
  'https://raw.githubusercontent.com/AuxGrep/AuxGrep-easylist/refs/heads/master/easylist_cookie/easylist_cookie_general_hide.txt';

async function fetchConsentOMatic() {
  const res = await fetch(CONSENT_O_MATIC_RULES);
  if (!res.ok) throw new Error(`Consent-O-Matic fetch failed: ${res.status}`);
  return res.json();
}

async function fetchEasyList() {
  const res = await fetch(EASYLIST_COOKIE_HIDE);
  if (!res.ok) throw new Error(`EasyList fetch failed: ${res.status}`);
  return res.text();
}

// --- CLI ---

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

async function cmdRefresh(force) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  if (!force && !isCacheStale(LAST_FETCH_FILE)) {
    console.error('Cache is fresh. Use --force to re-fetch.');
    return;
  }

  let cmpResult = { cmps: {}, partial_coverage_cmps: [] };
  let genericSelectors = [];
  let cmpOk = false;
  let easyOk = false;

  try {
    const rawRules = await fetchConsentOMatic();
    cmpResult = normalizeCmpRules(rawRules);
    cmpOk = true;
  } catch (err) {
    console.error(`Warning: Consent-O-Matic fetch failed: ${err.message}`);
  }

  try {
    const rawText = await fetchEasyList();
    genericSelectors = parseAbpHideRules(rawText).slice(0, 1000);
    easyOk = true;
  } catch (err) {
    console.error(`Warning: EasyList fetch failed: ${err.message}`);
  }

  if (!cmpOk && !easyOk) {
    if (fs.existsSync(PATTERNS_FILE)) {
      console.error('Warning: Both sources failed. Using stale cache.');
      return;
    }
    die('No pattern database available. Check network connectivity and retry with --force.');
  }

  // Merge with cached data for the source that failed
  if (fs.existsSync(PATTERNS_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
      if (!cmpOk) cmpResult = { cmps: cached.cmps, partial_coverage_cmps: cached.stats?.partial_coverage_cmps ?? [] };
      if (!easyOk) genericSelectors = cached.generic_selectors ?? [];
    } catch { /* ignore corrupt cache */ }
  }

  const patterns = buildPatternsJson(cmpResult, genericSelectors);
  fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
  fs.writeFileSync(LAST_FETCH_FILE, new Date().toISOString());

  const cmpCount = Object.keys(patterns.cmps).length;
  const selCount = patterns.generic_selectors.length;
  console.log(`Refreshed: ${cmpCount} CMPs, ${selCount} generic selectors.`);
}

function cmdStatus() {
  if (!fs.existsSync(PATTERNS_FILE)) {
    console.log('No cache. Run: node overlay-db.js refresh');
    return;
  }
  const patterns = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
  const stale = isCacheStale(LAST_FETCH_FILE);
  console.log(`Fetched: ${patterns.fetched_at}`);
  console.log(`Status: ${stale ? 'STALE' : 'fresh'}`);
  console.log(`CMPs: ${Object.keys(patterns.cmps).length}`);
  console.log(`Generic selectors: ${patterns.generic_selectors.length}`);
  if (patterns.stats?.partial_coverage_cmps?.length > 0) {
    console.log(`Partial coverage: ${patterns.stats.partial_coverage_cmps.join(', ')}`);
  }
}

function cmdLookup(domain) {
  if (!domain) die('Usage: node overlay-db.js lookup <domain>');
  if (!fs.existsSync(PATTERNS_FILE)) die('No cache. Run: node overlay-db.js refresh');
  const patterns = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
  // Search CMP names for domain-like matches
  const matches = Object.entries(patterns.cmps).filter(
    ([name]) => name.toLowerCase().includes(domain.toLowerCase())
  );
  if (matches.length === 0) {
    console.log(`No known CMP rules for "${domain}".`);
  } else {
    for (const [name, rule] of matches) {
      console.log(`${name}: detect=${rule.detect.join(', ')}`);
    }
  }
}

function cmdBundle() {
  if (!fs.existsSync(PATTERNS_FILE)) die('No cache. Run: node overlay-db.js refresh');
  const patterns = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
  const detectPath = path.join(__dirname, 'overlay-detect.js');
  if (!fs.existsSync(detectPath)) die('overlay-detect.js not found next to overlay-db.js');
  const detectScript = fs.readFileSync(detectPath, 'utf8');
  process.stdout.write(buildBundle(patterns, detectScript));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const force = args.includes('--force');

  switch (command) {
    case 'refresh': await cmdRefresh(force); break;
    case 'status': cmdStatus(); break;
    case 'lookup': cmdLookup(args[1]); break;
    case 'bundle': cmdBundle(); break;
    default:
      console.error([
        'Usage: overlay-db.js <command> [options]',
        '',
        'Commands:',
        '  refresh [--force]   Fetch/update pattern databases',
        '  status              Show cache age and stats',
        '  lookup <domain>     Check if domain has known CMP rules',
        '  bundle              Output injectable script with embedded patterns',
      ].join('\n'));
      process.exit(command ? 1 : 0);
  }
}

// Run CLI when executed directly, export for tests
if (require.main === module) {
  main().catch((err) => die(err.message));
}
```

Update `module.exports`:

```js
module.exports = {
  parseAbpHideRules,
  normalizeCmpRules,
  isCacheStale,
  buildPatternsJson,
  buildBundle,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/page-prep/overlay-db.test.js`
Expected: all tests PASS

- [ ] **Step 5: Smoke test CLI help**

Run: `node skills/page-prep/scripts/overlay-db.js`
Expected: prints usage help, exits 0

- [ ] **Step 6: Commit**

```bash
git add skills/page-prep/scripts/overlay-db.js tests/page-prep/
git commit -m "feat(page-prep): add CLI subcommands (refresh, status, lookup, bundle)"
```

---

## Chunk 2: Detection Script

### Task 5: Known-Pattern Detection (Pass 1)

Browser-injectable script that matches known CMPs from the embedded patterns database.

**Files:**
- Create: `skills/page-prep/scripts/overlay-detect.js`
- Create: `tests/page-prep/overlay-detect.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/page-prep/overlay-detect.test.js`. Since this script runs in browser context, we test the core logic functions by extracting them. The script must be structured as an IIFE that uses `PATTERNS` (injected by bundle) but its internal functions can be tested standalone.

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The detection script is an IIFE for browser injection.
// For testing, we load it as a module that exports internals when
// a global PATTERNS is not defined (Node environment).
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
    // Mock querySelector to simulate element found
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/page-prep/overlay-detect.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement overlay-detect.js with pass 1**

Create `skills/page-prep/scripts/overlay-detect.js`:

```js
// overlay-detect.js — Browser-injectable overlay detection script.
// In browser context: PATTERNS is prepended by overlay-db.js bundle.
// In Node context (tests): exports internal functions.
'use strict';

function matchKnownPatterns(cmps, doc) {
  const results = [];
  for (const [name, rule] of Object.entries(cmps)) {
    for (const selector of rule.detect) {
      let el;
      try { el = doc.querySelector(selector); } catch { continue; }
      if (!el) continue;

      if (rule.detect_requires_visible) {
        const visible = el.offsetParent !== null ||
          (typeof getComputedStyle === 'function' &&
           getComputedStyle(el).display !== 'none');
        if (!visible) continue;
      }

      results.push({
        id: `overlay-${results.length}`,
        type: 'cookie-consent',
        source: 'cmp-match',
        cmp: name,
        selector,
        confidence: 1.0,
        hide: rule.hide,
        dismiss: rule.dismiss.length > 0 ? rule.dismiss : null,
      });
      break; // one match per CMP is enough
    }
  }
  return results;
}

function detectScrollLock(doc) {
  const html = doc.documentElement;
  const body = doc.body;
  if (!html || !body) return { scroll_locked: false, scroll_fix: null };
  const htmlStyle = typeof getComputedStyle === 'function'
    ? getComputedStyle(html) : html.style;
  const bodyStyle = typeof getComputedStyle === 'function'
    ? getComputedStyle(body) : body.style;
  const locked =
    htmlStyle?.overflow === 'hidden' || bodyStyle?.overflow === 'hidden';
  return {
    scroll_locked: locked,
    scroll_fix: locked
      ? 'html,body { overflow:auto!important; height:auto!important }'
      : null,
  };
}

// --- Heuristic scoring (placeholder for Task 6) ---

function heuristicScan(/* doc, genericSelectors, knownSelectors */) {
  return [];
}

// --- Main detection entry point ---

function detect(patterns, doc) {
  const known = matchKnownPatterns(patterns.cmps || {}, doc);
  const knownSelectors = new Set(known.map((o) => o.selector));
  const heuristic = heuristicScan(doc, patterns.generic_selectors || [], knownSelectors);
  const scrollLock = detectScrollLock(doc);

  // Re-number IDs across both arrays
  const all = [...known, ...heuristic];
  all.forEach((o, i) => { o.id = `overlay-${i}`; });

  return {
    overlays: all,
    ...scrollLock,
  };
}

// --- Module boundary ---
// In Node (tests): export internals for unit testing.
// In browser (bundled): PATTERNS is defined by the IIFE wrapper from buildBundle.
// The `return` statement returns from the IIFE, which evaluate() picks up.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matchKnownPatterns, heuristicScan, detectScrollLock, detect };
} else {
  return detect(PATTERNS, document);
}
```

The `buildBundle` in overlay-db.js wraps this as: `(function(){var PATTERNS=...;<detection script>})()`. When the browser executes the bundle, `module` is undefined so the `else` branch runs, calling `detect()` and returning the result to `evaluate()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/page-prep/overlay-detect.test.js`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add skills/page-prep/scripts/overlay-detect.js tests/page-prep/overlay-detect.test.js
git commit -m "feat(page-prep): add browser-injectable detection script with pass 1 (known patterns)"
```

---

### Task 6: Heuristic Detection (Pass 2)

Implement weighted signal scoring for unknown overlays.

**Files:**
- Modify: `tests/page-prep/overlay-detect.test.js`
- Modify: `skills/page-prep/scripts/overlay-detect.js`

- [ ] **Step 1: Write failing tests for heuristic signals**

Append to `tests/page-prep/overlay-detect.test.js`:

```js
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
    const mockStyle = {
      position: 'fixed',
      zIndex: '9999',
    };
    const viewport = { width: 1024, height: 768 };
    const result = mod.scoreElement(mockEl, mockStyle, viewport, []);
    // fixed + viewport-cover + high-z = 0.15 + 0.25 + ...
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

  it('returns confidence 0 for normal fixed element (e.g. navbar)', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/page-prep/overlay-detect.test.js`
Expected: FAIL — `scoreElement` not defined

- [ ] **Step 3: Implement scoreElement and heuristicScan**

Replace the `heuristicScan` placeholder and add `scoreElement` in `overlay-detect.js`:

```js
const SIGNAL_WEIGHTS = {
  'high-z-index': 0.15,
  'viewport-cover': 0.25,
  'aria-modal': 0.20,
  'has-backdrop': 0.15,
  'keyword-match': 0.15,
  'generic-selector-match': 0.10,
};

const OVERLAY_KEYWORDS = /cookie|consent|gdpr|modal|popup|newsletter|subscribe|paywall/i;
const CONFIDENCE_THRESHOLD = 0.30;

function scoreElement(el, computedStyle, viewport, genericSelectors) {
  const signals = [];
  let confidence = 0;

  const zIndex = parseInt(computedStyle.zIndex, 10);
  if (zIndex > 999) {
    signals.push('high-z-index');
    confidence += SIGNAL_WEIGHTS['high-z-index'];
  }

  const rect = el.getBoundingClientRect();
  const coverage = (rect.width * rect.height) / (viewport.width * viewport.height);
  if (coverage > 0.5) {
    signals.push('viewport-cover');
    confidence += SIGNAL_WEIGHTS['viewport-cover'];
  }

  const ariaModal = el.getAttribute('aria-modal');
  const role = el.getAttribute('role');
  if (ariaModal === 'true' || role === 'dialog') {
    signals.push('aria-modal');
    confidence += SIGNAL_WEIGHTS['aria-modal'];
  }

  // Simplified backdrop check — look for a child/sibling covering viewport
  // (Full implementation checks getComputedStyle on siblings; skipped in unit test)

  const text = `${el.id} ${el.className}`;
  if (OVERLAY_KEYWORDS.test(text)) {
    signals.push('keyword-match');
    confidence += SIGNAL_WEIGHTS['keyword-match'];
  }

  // Check generic selectors in batches of 50
  const BATCH = 50;
  for (let i = 0; i < genericSelectors.length; i += BATCH) {
    const group = genericSelectors.slice(i, i + BATCH).join(',');
    try {
      if (el.matches(group)) {
        signals.push('generic-selector-match');
        confidence += SIGNAL_WEIGHTS['generic-selector-match'];
        break;
      }
    } catch { /* invalid selector, skip */ }
  }

  return { confidence: Math.round(confidence * 100) / 100, signals };
}

function buildSelector(el) {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const cls = el.className?.split?.(' ')?.filter(Boolean)?.[0];
  return cls ? `${tag}.${cls}` : tag;
}

function heuristicScan(doc, genericSelectors, knownSelectors) {
  const results = [];
  if (typeof doc.querySelectorAll !== 'function') return results;

  const all = doc.querySelectorAll('*');
  const viewport = {
    width: doc.documentElement?.clientWidth || 1024,
    height: doc.documentElement?.clientHeight || 768,
  };

  for (const el of all) {
    let style;
    try {
      style = typeof getComputedStyle === 'function'
        ? getComputedStyle(el)
        : el.style || {};
    } catch { continue; }

    if (style.position !== 'fixed' && style.position !== 'sticky') continue;

    const sel = buildSelector(el);
    if (knownSelectors.has(sel)) continue;

    const { confidence, signals } = scoreElement(
      el, style, viewport, genericSelectors
    );
    if (confidence < CONFIDENCE_THRESHOLD) continue;

    results.push({
      id: '', // re-numbered by detect()
      type: 'unknown-modal',
      source: 'heuristic',
      selector: sel,
      confidence,
      signals,
      hide: [`${sel} { display:none!important }`],
      dismiss: null,
    });
  }

  return results;
}
```

Update `module.exports`:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    matchKnownPatterns, scoreElement, heuristicScan, detectScrollLock, detect
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/page-prep/overlay-detect.test.js`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add skills/page-prep/scripts/overlay-detect.js tests/page-prep/overlay-detect.test.js
git commit -m "feat(page-prep): add heuristic overlay detection with weighted signal scoring"
```

---

## Chunk 3: SKILL.md, References, and Project Registration

### Task 7: SKILL.md Orchestration Prompt

**Files:**
- Create: `skills/page-prep/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

Create `skills/page-prep/SKILL.md` with:
- YAML frontmatter (name, description with trigger keywords)
- Script location block (CLAUDE_SKILL_DIR with fallback search)
- Step-by-step workflow matching the design spec
- Browser tool agnosticism section (Playwright, CDP, cmux-browser examples)
- Recipe manifest format
- Agent fallback strategy for heuristic-detected overlays
- Watch mode documentation

The description should be "pushy" per skill-creator guidance — lead with what the skill provides that the agent cannot figure out alone:

```yaml
---
name: page-prep
description: >-
  Prepare any webpage for clean interaction by detecting and removing disruptive
  overlays (cookie banners, GDPR consent, modals, popups, newsletter signups,
  paywalls, login walls). Uses a cached database of 300+ known CMPs
  (Consent-O-Matic + EasyList) combined with heuristic DOM scanning. Produces
  portable JS recipes for any browser tool (Playwright, CDP, cmux-browser).
  ALWAYS use this skill before taking screenshots, scraping content, or
  automating interaction on any webpage that might have overlays blocking the
  view or preventing interaction. Triggers on: page prep, clean page, remove
  overlays, dismiss cookie banner, page blocked, overlay cleanup, consent
  banner, prepare page, unblock page, clear popups, cookie popup.
---
```

The SKILL.md body should contain:
1. Script Location block (same pattern as cdp-connect)
2. Prerequisites section (Node 22+)
3. Quick Start (3-step: refresh, bundle+inject, read report)
4. Detailed Workflow (all 9 steps from spec)
5. Browser Tool Examples (Playwright, CDP, cmux-browser)
6. Recipe Manifest Format (abbreviated — reference spec for full schema)
7. Agent Fallback (for heuristic detections with null dismiss)
8. Watch Mode section — include the injectable JS snippet inline in the SKILL.md (MutationObserver with `subtree: true`, debounce at 500ms, `window.__pagePrep.watch/stop/pending` API). The agent copies and injects this snippet when watch mode is needed. No separate script file — the watch code is small enough (~40 lines) to live in the prompt.
9. Tips section

- [ ] **Step 2: Review SKILL.md is under 500 lines**

Run: `wc -l skills/page-prep/SKILL.md`
Expected: < 500 lines

- [ ] **Step 3: Commit**

```bash
git add skills/page-prep/SKILL.md
git commit -m "feat(page-prep): add SKILL.md orchestration prompt"
```

---

### Task 8: Known Patterns Reference

**Files:**
- Create: `skills/page-prep/references/known-patterns.md`

- [ ] **Step 1: Write known-patterns.md**

This file is consulted by the agent when heuristic detection finds overlays but cannot compose a dismiss recipe. Include:

1. **Common close button patterns** — `[aria-label*="close"]`, `.close-btn`, `button.close`, `button:has(svg path[d*="M"])`, `[data-dismiss]`, `[data-close]`
2. **CMP-specific dismiss sequences** — top 10 most common CMPs with their accept-all button selectors (OneTrust, Cookiebot, TrustArc, Quantcast, Didomi, LiveRamp, Axeptio, Osano, CookieYes, Usercentrics)
3. **Shadow DOM CMPs** — known CMPs that render in shadow roots (e.g., Usercentrics v2 uses `#usercentrics-root` with shadow DOM). Manual traversal: `document.querySelector('#usercentrics-root')?.shadowRoot?.querySelector('button[data-testid="uc-accept-all-button"]')`
4. **Scroll-lock patterns** — common CSS properties that block scrolling: `overflow: hidden`, `position: fixed` on body, `touch-action: none`
5. **Exit-intent / delayed overlays** — patterns for overlays that appear after delay or scroll (newsletter modals, exit-intent popups)

Keep under 200 lines. This is a reference, not a database.

- [ ] **Step 2: Commit**

```bash
git add skills/page-prep/references/known-patterns.md
git commit -m "feat(page-prep): add known patterns reference for agent fallback"
```

---

### Task 9: Project Registration

Update README.md, plugin.json, marketplace.json, and CLAUDE.md.

**Files:**
- Modify: `README.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Update README.md**

Add a `### page-prep` section after the last skill entry, following the same format:

```markdown
### page-prep

Prepare webpages for clean interaction by detecting and removing disruptive
overlays (cookie banners, GDPR consent, modals, popups, paywalls). Uses a
cached database of 300+ known CMPs (Consent-O-Matic + EasyList) combined
with heuristic DOM scanning to produce portable JS recipes for any browser
tool (Playwright, CDP, cmux-browser). Supports both CSS hide (for screenshots)
and interactive dismiss (for automation) modes, plus MutationObserver watch
mode for long sessions.

**Dependencies:** Node 22+

See [SKILL.md](skills/page-prep/SKILL.md) for the full workflow.
```

- [ ] **Step 2: Update plugin.json**

Add `page-prep` to the description and keywords array.

- [ ] **Step 3: Update marketplace.json**

Add `page-prep` to the description string.

- [ ] **Step 4: Update CLAUDE.md**

Add `page-prep` row to the Available Skills table:

```markdown
| `page-prep` | Detect and remove webpage overlays for clean interaction |
```

- [ ] **Step 5: Commit**

```bash
git add README.md .claude-plugin/plugin.json .claude-plugin/marketplace.json .claude/CLAUDE.md
git commit -m "docs: register page-prep skill in project manifests"
```

---

### Task 10: Integration Test (Live Smoke Test)

**This task requires a browser tool (Playwright MCP, CDP, or cmux-browser) and network access.**

- [ ] **Step 1: Run refresh to populate cache**

```bash
node skills/page-prep/scripts/overlay-db.js refresh
```

Expected: prints CMP count and selector count, creates `~/.cache/page-prep/patterns.json`

- [ ] **Step 2: Verify status**

```bash
node skills/page-prep/scripts/overlay-db.js status
```

Expected: shows fresh cache with counts

- [ ] **Step 3: Verify bundle produces valid JS**

```bash
node skills/page-prep/scripts/overlay-db.js bundle | head -c 200
```

Expected: starts with `(function(){var PATTERNS={`

- [ ] **Step 4: Test against a real page with overlays**

Navigate to a page known to have cookie consent (e.g., a European news site). Inject the bundled script via the available browser tool. Verify the detection report contains at least one overlay.

- [ ] **Step 5: Verify hide recipe works**

Inject the `hide.js` from the recipe manifest. Verify the overlay is no longer visible (screenshot or accessibility tree).

- [ ] **Step 6: Sync skills**

```bash
./scripts/sync-skills.sh
```

Expected: page-prep is synced to `~/.claude/commands/page-prep.md`

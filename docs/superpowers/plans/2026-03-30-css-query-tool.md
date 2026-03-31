# CSS Query Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CDP-powered on-demand CSS inspection to the header migration pipeline — a standalone query tool plus a light upfront extraction during capture.

**Architecture:** `css-query.js` uses `playwright-cli` sessions for browser persistence and `run-code` for per-query CDP access (`CSS.getMatchedStylesForNode` + `CSS.getComputedStyleForNode`). `css-overview.js` runs during capture via the same pattern. Both follow existing codebase conventions (Node 22 ESM, `execFileSync` for playwright-cli, `parseEvalOutput` for result parsing).

**Tech Stack:** Node 22, playwright-cli, Chrome DevTools Protocol (CSS + DOM domains), vitest

**Spec:** `docs/superpowers/specs/2026-03-30-css-query-tool-design.md`

**Reference implementation:** `/Users/catalan/repos/misc/css-computed-styles-cli/src/index.ts` — contains the CDP call patterns for `CSS.getMatchedStylesForNode`, `CSS.getComputedStyleForNode`, `CSS.forcePseudoState`, rule origin filtering, and inherited property handling.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `scripts/css-query.js` (create) | Standalone query tool — subcommand dispatch, playwright-cli session management, CDP query execution, result formatting |
| `scripts/css-overview.js` (create) | Light CDP extraction during capture — custom properties, font stacks, color palette, key spacing |
| `scripts/cdp-helpers.js` (create) | Shared CDP utilities — `resolveElement` (selector/node: addressing), `getMatchedStyles`, `getComputedStyles`, `parseRuleOrigin`. Used by both css-query.js and css-overview.js |
| `scripts/capture-snapshot.js` (modify) | Add sequential `nodeId` to traverse(), call css-overview.js before closing session |
| `templates/program.md.tmpl` (modify) | Add CSS query tool instructions for polish loop |
| `SKILL.md` (modify) | Document css-query.js in Scripts section, update Stage 7 scaffold prompt to reference css-overview.json |

---

### Task 1: CDP Helpers — Shared Utilities

**Files:**
- Create: `skills/migrate-header/scripts/cdp-helpers.js`
- Test: `tests/migrate-header/cdp-helpers.test.js`

The shared module that both `css-query.js` and `css-overview.js` import. Contains pure functions for parsing CDP responses — no browser interaction (that's the caller's job).

- [ ] **Step 1: Write failing tests for `parseRuleOrigin`**

Create `tests/migrate-header/cdp-helpers.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  parseRuleOrigin,
  extractPropertiesFromMatched,
  categorizeColor,
} from '../../skills/migrate-header/scripts/cdp-helpers.js';

describe('parseRuleOrigin', () => {
  it('maps regular to author', () => {
    expect(parseRuleOrigin('regular')).toBe('author');
  });

  it('maps user-agent to user-agent', () => {
    expect(parseRuleOrigin('user-agent')).toBe('user-agent');
  });

  it('maps injected to extension', () => {
    expect(parseRuleOrigin('injected')).toBe('extension');
  });

  it('defaults unknown origins to unknown', () => {
    expect(parseRuleOrigin('something')).toBe('unknown');
  });
});

describe('extractPropertiesFromMatched', () => {
  it('extracts author properties with rule and file info', () => {
    const matched = {
      inlineStyle: { cssProperties: [] },
      matchedCSSRules: [{
        rule: {
          selectorList: { text: '.nav-link' },
          origin: 'regular',
          style: {
            cssProperties: [
              { name: 'font-size', value: '16px' },
              { name: 'color', value: '#2a2a2a' },
            ],
          },
          styleSheetId: 'sheet1',
        },
        matchingSelectors: [0],
      }],
      inherited: [],
    };
    const sheets = {
      sheet1: { sourceURL: 'https://example.com/styles.css' },
    };

    const result = extractPropertiesFromMatched(matched, sheets);
    expect(result.get('font-size')).toEqual({
      value: '16px',
      source: 'author',
      selector: '.nav-link',
      file: 'styles.css',
      inherited: false,
    });
  });

  it('skips user-agent properties in author-only mode', () => {
    const matched = {
      inlineStyle: { cssProperties: [] },
      matchedCSSRules: [{
        rule: {
          selectorList: { text: 'a' },
          origin: 'user-agent',
          style: {
            cssProperties: [
              { name: 'color', value: '-webkit-link' },
            ],
          },
        },
        matchingSelectors: [0],
      }],
      inherited: [],
    };

    const result = extractPropertiesFromMatched(matched, {}, true);
    expect(result.has('color')).toBe(false);
  });

  it('marks inherited properties', () => {
    const matched = {
      inlineStyle: { cssProperties: [] },
      matchedCSSRules: [],
      inherited: [{
        inlineStyle: { cssProperties: [] },
        matchedCSSRules: [{
          rule: {
            selectorList: { text: 'body' },
            origin: 'regular',
            style: {
              cssProperties: [
                { name: 'font-family', value: 'Helvetica, sans-serif' },
              ],
            },
          },
          matchingSelectors: [0],
        }],
      }],
    };

    const result = extractPropertiesFromMatched(matched, {});
    expect(result.get('font-family')?.inherited).toBe(true);
  });
});

describe('categorizeColor', () => {
  it('categorizes white as background', () => {
    expect(categorizeColor('#ffffff', 'background-color')).toBe('backgrounds');
  });

  it('categorizes dark text color as text', () => {
    expect(categorizeColor('#2a2a2a', 'color')).toBe('text');
  });

  it('categorizes saturated color as accent', () => {
    expect(categorizeColor('#0066cc', 'color')).toBe('accent');
  });

  it('categorizes border colors as borders', () => {
    expect(categorizeColor('#e0e0e0', 'border-color')).toBe('borders');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/migrate-header/cdp-helpers.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement cdp-helpers.js**

Create `skills/migrate-header/scripts/cdp-helpers.js`:

```js
#!/usr/bin/env node

/**
 * Shared CDP utilities for CSS inspection.
 * Pure functions that parse CDP responses — no browser interaction.
 */

// CSS properties that are inherited by default
// (subset — covers the ones relevant to header migration)
const INHERITED_PROPERTIES = new Set([
  'color', 'cursor', 'direction', 'font', 'font-family', 'font-feature-settings',
  'font-kerning', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style',
  'font-variant', 'font-weight', 'letter-spacing', 'line-height', 'list-style',
  'list-style-image', 'list-style-position', 'list-style-type', 'orphans',
  'quotes', 'tab-size', 'text-align', 'text-align-last', 'text-indent',
  'text-justify', 'text-shadow', 'text-transform', 'visibility', 'white-space',
  'widows', 'word-break', 'word-spacing', 'word-wrap',
]);

export function parseRuleOrigin(origin) {
  const map = {
    regular: 'author',
    'user-agent': 'user-agent',
    injected: 'extension',
    inspector: 'inspector',
  };
  return map[origin] || 'unknown';
}

export function extractFileFromURL(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    return path.split('/').pop() || path;
  } catch {
    return url;
  }
}

export function extractPropertiesFromMatched(
  matched, sheets = {}, authorOnly = false
) {
  const result = new Map();

  const addProp = (name, value, origin, selector, sheetId, inherited) => {
    if (authorOnly && origin !== 'regular') return;
    if (inherited && !INHERITED_PROPERTIES.has(name)) return;
    if (result.has(name)) return; // first match wins (highest specificity)

    const file = sheetId && sheets[sheetId]
      ? extractFileFromURL(sheets[sheetId].sourceURL)
      : null;

    result.set(name, {
      value,
      source: parseRuleOrigin(origin),
      selector: selector || null,
      file,
      inherited,
    });
  };

  // Inline styles (highest specificity)
  for (const prop of matched.inlineStyle?.cssProperties || []) {
    if (prop.name && !prop.disabled) {
      addProp(prop.name, prop.value, 'regular', 'element.style', null, false);
    }
  }

  // Matched CSS rules
  for (const match of matched.matchedCSSRules || []) {
    const { rule } = match;
    const selector = rule.selectorList?.text || '';
    for (const prop of rule.style?.cssProperties || []) {
      if (prop.name && !prop.disabled) {
        addProp(
          prop.name, prop.value, rule.origin,
          selector, rule.styleSheetId, false
        );
      }
    }
  }

  // Inherited styles
  for (const entry of matched.inherited || []) {
    for (const prop of entry.inlineStyle?.cssProperties || []) {
      if (prop.name && !prop.disabled) {
        addProp(prop.name, prop.value, 'regular', 'parent.style', null, true);
      }
    }
    for (const match of entry.matchedCSSRules || []) {
      const { rule } = match;
      const selector = rule.selectorList?.text || '';
      for (const prop of rule.style?.cssProperties || []) {
        if (prop.name && !prop.disabled) {
          addProp(
            prop.name, prop.value, rule.origin,
            selector, rule.styleSheetId, true
          );
        }
      }
    }
  }

  return result;
}

export function rgbToHex(rgb) {
  if (!rgb) return null;
  const m = rgb.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const [, r, g, b] = m.map(Number);
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

export function colorSaturation(hex) {
  if (!hex || hex.length !== 7) return 0;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

export function categorizeColor(hex, propertyName) {
  if (!hex) return null;
  if (propertyName.includes('border')) return 'borders';
  if (propertyName.includes('background')) return 'backgrounds';

  const sat = colorSaturation(hex);
  if (sat > 0.3) return 'accent';
  return 'text';
}

export function extractCustomProperties(matchedRules) {
  const vars = {};
  for (const match of matchedRules || []) {
    const { rule } = match;
    if (rule.origin !== 'regular') continue;
    for (const prop of rule.style?.cssProperties || []) {
      if (prop.name?.startsWith('--') && !prop.disabled) {
        vars[prop.name] = prop.value;
      }
    }
  }
  return vars;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/migrate-header/cdp-helpers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/migrate-header/scripts/cdp-helpers.js \
  tests/migrate-header/cdp-helpers.test.js
git commit -m "feat(migrate-header): add CDP helper utilities for CSS inspection"
```

---

### Task 2: css-query.js — Core Tool (open/query/close)

**Files:**
- Create: `skills/migrate-header/scripts/css-query.js`
- Test: `tests/migrate-header/css-query.test.js`

Standalone tool using `playwright-cli` sessions. Each query uses `run-code` to create a fresh CDP session, query, and return.

- [ ] **Step 1: Write failing tests for argument parsing**

Create `tests/migrate-header/css-query.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseArgs, parseTarget } from
  '../../skills/migrate-header/scripts/css-query.js';

describe('parseArgs', () => {
  it('parses open subcommand with URL', () => {
    const result = parseArgs(['', '', 'open', 'https://example.com']);
    expect(result.command).toBe('open');
    expect(result.url).toBe('https://example.com');
  });

  it('parses open with browser-recipe', () => {
    const result = parseArgs([
      '', '', 'open', 'https://example.com',
      '--browser-recipe=/tmp/recipe.json',
    ]);
    expect(result.browserRecipe).toBe('/tmp/recipe.json');
  });

  it('parses query with selector and properties', () => {
    const result = parseArgs([
      '', '', 'query', 'nav > a', 'font-size,color',
    ]);
    expect(result.command).toBe('query');
    expect(result.target).toBe('nav > a');
    expect(result.properties).toEqual(['font-size', 'color']);
  });

  it('parses query with node reference', () => {
    const result = parseArgs([
      '', '', 'query', 'node:42', 'font-size',
    ]);
    expect(result.target).toBe('node:42');
    expect(result.properties).toEqual(['font-size']);
  });

  it('parses cascade subcommand', () => {
    const result = parseArgs(['', '', 'cascade', '.nav-link']);
    expect(result.command).toBe('cascade');
    expect(result.target).toBe('.nav-link');
  });

  it('parses vars subcommand', () => {
    const result = parseArgs(['', '', 'vars']);
    expect(result.command).toBe('vars');
  });

  it('parses close subcommand', () => {
    const result = parseArgs(['', '', 'close']);
    expect(result.command).toBe('close');
  });

  it('parses custom session name', () => {
    const result = parseArgs([
      '', '', 'open', 'https://example.com', '--session=my-session',
    ]);
    expect(result.session).toBe('my-session');
  });
});

describe('parseTarget', () => {
  it('returns selector type for CSS selectors', () => {
    expect(parseTarget('nav > a')).toEqual({
      type: 'selector', value: 'nav > a',
    });
  });

  it('returns node type for node: references', () => {
    expect(parseTarget('node:42')).toEqual({
      type: 'node', value: 42,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/migrate-header/css-query.test.js`
Expected: FAIL

- [ ] **Step 3: Implement css-query.js**

Create `skills/migrate-header/scripts/css-query.js`:

```js
#!/usr/bin/env node

/**
 * css-query — On-demand CSS inspection via CDP.
 *
 * Usage:
 *   node css-query.js open <url> [--browser-recipe=path] [--session=name]
 *   node css-query.js query <selector|node:N> <props>
 *   node css-query.js cascade <selector|node:N>
 *   node css-query.js vars
 *   node css-query.js close
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  extractPropertiesFromMatched,
  extractCustomProperties,
  rgbToHex,
} from './cdp-helpers.js';

const DEFAULT_SESSION = 'css-query';
const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
};

export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const result = { command, session: DEFAULT_SESSION };

  // Extract flags
  for (const arg of args) {
    if (arg.startsWith('--browser-recipe=')) {
      result.browserRecipe = arg.split('=').slice(1).join('=') || null;
    }
    if (arg.startsWith('--session=')) {
      result.session = arg.split('=')[1] || DEFAULT_SESSION;
    }
    if (arg.startsWith('--snapshot=')) {
      result.snapshotPath = arg.split('=').slice(1).join('=');
    }
  }

  // Positional args (after command, excluding flags)
  const positional = args.slice(1).filter(a => !a.startsWith('--'));

  switch (command) {
    case 'open':
      result.url = positional[0];
      break;
    case 'query':
      result.target = positional[0];
      result.properties = positional[1]
        ? positional[1].split(',').map(p => p.trim())
        : [];
      break;
    case 'cascade':
      result.target = positional[0];
      break;
    case 'vars':
    case 'close':
      break;
  }

  return result;
}

export function parseTarget(target) {
  if (target.startsWith('node:')) {
    return { type: 'node', value: parseInt(target.slice(5), 10) };
  }
  return { type: 'selector', value: target };
}

function cli(session, ...args) {
  return execFileSync(
    'playwright-cli', [`-s=${session}`, ...args], EXEC_OPTS
  ).trim();
}

function parseRunCodeOutput(raw) {
  const resultIdx = raw.indexOf('### Result');
  const codeIdx = raw.indexOf('### Ran Playwright code');
  if (resultIdx === -1) return raw;
  const start = resultIdx + '### Result'.length;
  const end = codeIdx !== -1 ? codeIdx : raw.length;
  let value = raw.slice(start, end).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = JSON.parse(value);
  }
  return value;
}

function runCDP(session, code) {
  const raw = cli(session, 'run-code', `async page => { ${code} }`);
  return parseRunCodeOutput(raw);
}

function buildRecipeConfig(browserRecipe) {
  if (!browserRecipe) return [];
  let recipe;
  try {
    recipe = JSON.parse(readFileSync(browserRecipe, 'utf-8'));
  } catch (err) {
    console.error(
      `Failed to load browser recipe from ${browserRecipe}: ${err.message}`
    );
    process.exit(1);
  }

  const tempFiles = [];
  const config = { ...recipe.cliConfig };

  if (recipe.stealthInitScript) {
    const stealthPath = join(tmpdir(), `css-query-stealth-${Date.now()}.js`);
    writeFileSync(stealthPath, recipe.stealthInitScript);
    tempFiles.push(stealthPath);
    if (!config.browser) config.browser = {};
    config.browser.initScript = [stealthPath];
  }

  const configPath = join(tmpdir(), `css-query-config-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  tempFiles.push(configPath);

  return [`--config=${configPath}`];
}

function cmdOpen(args) {
  if (!args.url) {
    console.error('Usage: node css-query.js open <url> [--browser-recipe=path]');
    process.exit(1);
  }
  const extraArgs = buildRecipeConfig(args.browserRecipe);
  cli(args.session, 'open', args.url, ...extraArgs);
  console.error(`CSS query session "${args.session}" opened on ${args.url}`);
}

function cmdQuery(args) {
  const target = parseTarget(args.target);
  const propsFilter = args.properties;

  // Build the CDP query as a run-code string
  const resolveExpr = target.type === 'selector'
    ? `const {nodeId} = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: ${JSON.stringify(target.value)},
      });
      if (!nodeId) return JSON.stringify({error: 'Element not found: ${target.value}'});`
    : `// node:N lookup — walk depth-first to find the Nth element
      function walkDFS(node, counter) {
        if (counter.idx === ${target.value}) return node;
        counter.idx++;
        for (const child of node.children || []) {
          const found = walkDFS(child, counter);
          if (found) return found;
        }
        return null;
      }
      const headerNode = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'header, nav, [role=banner]',
      });
      const fullTree = await cdp.send('DOM.describeNode', {
        nodeId: headerNode.nodeId, depth: -1,
      });
      const target = walkDFS(fullTree.node, {idx: 0});
      if (!target) return JSON.stringify({error: 'Node ${target.value} not found'});
      const nodeId = target.backendNodeId
        ? (await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
            backendNodeIds: [target.backendNodeId]
          })).nodeIds[0]
        : headerNode.nodeId;`;

  const code = `
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const {root} = await cdp.send('DOM.getDocument');
      ${resolveExpr}
      const [computed, matched] = await Promise.all([
        cdp.send('CSS.getComputedStyleForNode', {nodeId}),
        cdp.send('CSS.getMatchedStylesForNode', {nodeId}),
      ]);
      return JSON.stringify({computed, matched});
    } finally {
      await cdp.detach();
    }
  `;

  const raw = runCDP(args.session, code);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Failed to parse CDP response');
    process.exit(1);
  }

  if (parsed.error) {
    console.error(parsed.error);
    process.exit(1);
  }

  // Extract properties using helpers
  const allProps = extractPropertiesFromMatched(parsed.matched, {}, true);

  // Merge with computed values for resolved results
  const computedMap = new Map();
  for (const prop of parsed.computed?.computedStyle || []) {
    computedMap.set(prop.name, prop.value);
  }

  // Build output — filter to requested properties or return all
  const output = { selector: args.target, properties: {} };
  for (const [name, info] of allProps) {
    if (propsFilter.length > 0 && !propsFilter.includes(name)) continue;
    output.properties[name] = {
      ...info,
      value: computedMap.get(name) || info.value,
    };
  }

  // Add requested computed-only properties not in matched rules
  for (const prop of propsFilter) {
    if (!output.properties[prop] && computedMap.has(prop)) {
      output.properties[prop] = {
        value: computedMap.get(prop),
        source: 'computed',
        selector: null,
        file: null,
        inherited: false,
      };
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

function cmdCascade(args) {
  const target = parseTarget(args.target);
  const selectorExpr = target.type === 'selector'
    ? JSON.stringify(target.value)
    : `'header, nav, [role=banner]'`;

  const code = `
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const {root} = await cdp.send('DOM.getDocument');
      const {nodeId} = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: ${selectorExpr},
      });
      if (!nodeId) return JSON.stringify({error: 'Element not found'});
      const matched = await cdp.send('CSS.getMatchedStylesForNode', {nodeId});
      return JSON.stringify(matched);
    } finally {
      await cdp.detach();
    }
  `;

  const raw = runCDP(args.session, code);
  console.log(raw);
}

function cmdVars(args) {
  const code = `
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const {root} = await cdp.send('DOM.getDocument');
      const {nodeId} = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId, selector: ':root',
      });
      const matched = await cdp.send('CSS.getMatchedStylesForNode', {nodeId});
      const vars = {};
      for (const match of matched.matchedCSSRules || []) {
        if (match.rule.origin !== 'regular') continue;
        for (const prop of match.rule.style.cssProperties || []) {
          if (prop.name?.startsWith('--') && !prop.disabled) {
            vars[prop.name] = prop.value;
          }
        }
      }
      return JSON.stringify(vars);
    } finally {
      await cdp.detach();
    }
  `;

  const raw = runCDP(args.session, code);
  console.log(raw);
}

function cmdClose(args) {
  try {
    cli(args.session, 'close');
    console.error(`Session "${args.session}" closed.`);
  } catch {
    console.error(`Session "${args.session}" was not open.`);
  }
}

function main() {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case 'open': cmdOpen(args); break;
    case 'query': cmdQuery(args); break;
    case 'cascade': cmdCascade(args); break;
    case 'vars': cmdVars(args); break;
    case 'close': cmdClose(args); break;
    default:
      console.error(
        'Usage: node css-query.js <open|query|cascade|vars|close> [args]'
      );
      process.exit(1);
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/migrate-header/css-query.test.js`
Expected: PASS (arg parsing tests only — no browser needed)

- [ ] **Step 5: Commit**

```bash
git add skills/migrate-header/scripts/css-query.js \
  tests/migrate-header/css-query.test.js
git commit -m "feat(migrate-header): add css-query.js on-demand CSS inspection tool"
```

---

### Task 3: css-overview.js — Light Extraction

**Files:**
- Create: `skills/migrate-header/scripts/css-overview.js`
- Test: `tests/migrate-header/css-overview.test.js`

Runs during capture via `playwright-cli run-code`. Extracts custom properties, font stacks, color palette, key spacing from CDP data.

- [ ] **Step 1: Write failing tests for overview extraction logic**

Create `tests/migrate-header/css-overview.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  buildOverview,
} from '../../skills/migrate-header/scripts/css-overview.js';

describe('buildOverview', () => {
  it('extracts custom properties from matched rules', () => {
    const elements = [{
      matched: {
        matchedCSSRules: [{
          rule: {
            origin: 'regular',
            selectorList: { text: ':root' },
            style: {
              cssProperties: [
                { name: '--brand-color', value: '#830051' },
                { name: '--nav-height', value: '64px' },
              ],
            },
          },
          matchingSelectors: [0],
        }],
        inherited: [],
        inlineStyle: { cssProperties: [] },
      },
      computed: [
        { name: 'font-family', value: '"Helvetica Neue", Helvetica, sans-serif' },
        { name: 'background-color', value: 'rgb(255, 255, 255)' },
        { name: 'color', value: 'rgb(42, 42, 42)' },
        { name: 'padding-left', value: '24px' },
      ],
      role: 'header',
    }];

    const result = buildOverview(elements);
    expect(result.customProperties['--brand-color']).toBe('#830051');
    expect(result.fontStacks).toContain(
      '"Helvetica Neue", Helvetica, sans-serif'
    );
    expect(result.colorPalette.backgrounds).toContain('#ffffff');
    expect(result.colorPalette.text).toContain('#2a2a2a');
  });

  it('deduplicates font stacks', () => {
    const elements = [
      {
        matched: { matchedCSSRules: [], inherited: [], inlineStyle: { cssProperties: [] } },
        computed: [
          { name: 'font-family', value: 'Arial, sans-serif' },
        ],
        role: 'nav-link',
      },
      {
        matched: { matchedCSSRules: [], inherited: [], inlineStyle: { cssProperties: [] } },
        computed: [
          { name: 'font-family', value: 'Arial, sans-serif' },
        ],
        role: 'nav-link',
      },
    ];

    const result = buildOverview(elements);
    expect(result.fontStacks).toEqual(['Arial, sans-serif']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/migrate-header/css-overview.test.js`
Expected: FAIL

- [ ] **Step 3: Implement css-overview.js**

Create `skills/migrate-header/scripts/css-overview.js`:

```js
#!/usr/bin/env node

/**
 * css-overview — Extract compact CSS summary via CDP during capture.
 *
 * Usage (standalone, for testing):
 *   node css-overview.js <session> <header-selector> <output-dir>
 *
 * The script uses an existing playwright-cli session to run CDP queries.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCustomProperties,
  rgbToHex,
  categorizeColor,
} from './cdp-helpers.js';

const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
};

const KEY_ELEMENTS = [
  { selector: 'header, nav, [role=banner]', role: 'header' },
  { selector: 'header a, nav a', role: 'nav-link' },
  { selector: 'header button, nav button, header [class*=cta], nav [class*=cta]', role: 'cta' },
];

function cli(session, ...args) {
  return execFileSync(
    'playwright-cli', [`-s=${session}`, ...args], EXEC_OPTS
  ).trim();
}

function parseRunCodeOutput(raw) {
  const resultIdx = raw.indexOf('### Result');
  const codeIdx = raw.indexOf('### Ran Playwright code');
  if (resultIdx === -1) return raw;
  const start = resultIdx + '### Result'.length;
  const end = codeIdx !== -1 ? codeIdx : raw.length;
  let value = raw.slice(start, end).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = JSON.parse(value);
  }
  return value;
}

function queryElement(session, selector) {
  const code = `
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const {root} = await cdp.send('DOM.getDocument');
      const {nodeId} = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: ${JSON.stringify(selector)},
      });
      if (!nodeId) return JSON.stringify(null);
      const [computed, matched] = await Promise.all([
        cdp.send('CSS.getComputedStyleForNode', {nodeId}),
        cdp.send('CSS.getMatchedStylesForNode', {nodeId}),
      ]);
      return JSON.stringify({
        computed: computed.computedStyle,
        matched: {
          matchedCSSRules: matched.matchedCSSRules,
          inherited: matched.inherited,
          inlineStyle: matched.inlineStyle,
        },
      });
    } finally {
      await cdp.detach();
    }
  `;

  const raw = cli(session, 'run-code', `async page => { ${code} }`);
  const parsed = parseRunCodeOutput(raw);
  try {
    return JSON.parse(parsed);
  } catch {
    return null;
  }
}

export function buildOverview(elements) {
  const customProperties = {};
  const fontStacks = new Set();
  const colorPalette = {
    backgrounds: new Set(),
    text: new Set(),
    accent: new Set(),
    borders: new Set(),
  };
  const spacing = {};

  for (const el of elements) {
    // Extract custom properties from matched rules
    const vars = extractCustomProperties(el.matched?.matchedCSSRules);
    Object.assign(customProperties, vars);

    // Extract from computed styles
    for (const prop of el.computed || []) {
      // Font stacks
      if (prop.name === 'font-family' && prop.value) {
        fontStacks.add(prop.value);
      }

      // Colors
      if (['color', 'background-color', 'border-color',
           'border-top-color', 'border-bottom-color'].includes(prop.name)) {
        const hex = rgbToHex(prop.value);
        if (hex && hex !== '#000000') {
          const category = categorizeColor(hex, prop.name);
          if (category && colorPalette[category]) {
            colorPalette[category].add(hex);
          }
        }
      }

      // Key spacing (from header element)
      if (el.role === 'header') {
        if (prop.name === 'padding-left' || prop.name === 'padding-right') {
          const px = parseFloat(prop.value);
          if (px > 0) spacing.headerPaddingX = prop.value;
        }
        if (prop.name === 'gap') {
          const px = parseFloat(prop.value);
          if (px > 0) spacing.navGap = prop.value;
        }
        if (prop.name === 'height') {
          const px = parseFloat(prop.value);
          if (px > 0) {
            if (!spacing.rowHeights) spacing.rowHeights = [];
            spacing.rowHeights.push(Math.round(px));
          }
        }
      }
    }
  }

  return {
    customProperties,
    fontStacks: [...fontStacks],
    colorPalette: {
      backgrounds: [...colorPalette.backgrounds],
      text: [...colorPalette.text],
      accent: [...colorPalette.accent],
      borders: [...colorPalette.borders],
    },
    keySpacing: spacing,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(
      'Usage: node css-overview.js <session> <header-selector> <output-dir>'
    );
    process.exit(1);
  }

  const [session, headerSelector, outputDir] = args;

  console.error('Extracting CSS overview via CDP...');

  const elements = [];
  for (const { selector, role } of KEY_ELEMENTS) {
    const result = queryElement(session, selector);
    if (result) {
      elements.push({ ...result, role });
    }
  }

  const overview = buildOverview(elements);
  const outputPath = join(resolve(outputDir), 'css-overview.json');
  writeFileSync(outputPath, JSON.stringify(overview, null, 2));
  console.error(`  Wrote ${outputPath}`);
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/migrate-header/css-overview.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/migrate-header/scripts/css-overview.js \
  tests/migrate-header/css-overview.test.js
git commit -m "feat(migrate-header): add css-overview.js light CDP extraction"
```

---

### Task 4: Add Node IDs to capture-snapshot.js and Call css-overview

**Files:**
- Modify: `skills/migrate-header/scripts/capture-snapshot.js:197` (traverse function), `skills/migrate-header/scripts/capture-snapshot.js:439-457` (main, before session close)

- [ ] **Step 1: Add sequential nodeId to traverse()**

In `capture-snapshot.js`, the `captureHeaderDOM` function contains an inline `traverse()` function (runs in browser context via `cliEval`). Add a counter that assigns sequential IDs.

Find the `traverse` function inside the JS template string (starts around line 197). Add a `nodeId` field using a closure counter:

Before the `function traverse(node, depth)` line, add:
```js
  var nextNodeId = 0;
```

Inside the object construction in `traverse`, add `nodeId: nextNodeId++` as the first field:

```js
    var obj = {
      nodeId: nextNodeId++,
      tag: tag,
      id: node.id || '',
```

- [ ] **Step 2: Call css-overview.js before closing session**

In `main()`, after the snapshot is written (around line 450) and before the `finally` block, add:

```js
    // Extract CSS overview via CDP (same session)
    try {
      const overviewScript = join(__dirname, 'css-overview.js');
      execFileSync('node', [
        overviewScript, SESSION, headerSelector, outputDir,
      ], { ...EXEC_OPTS, stdio: ['pipe', 'pipe', 'inherit'] });
    } catch (err) {
      log(`WARNING: CSS overview extraction failed: ${err.message}`);
    }
```

This calls `css-overview.js` with the same `playwright-cli` session name (`header-capture`) that's still open. The overview script uses `run-code` to access the page via CDP.

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `npx vitest run tests/migrate-header/`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/scripts/capture-snapshot.js
git commit -m "feat(capture-snapshot): add nodeId to DOM tree and call css-overview during capture"
```

---

### Task 5: Update SKILL.md and program.md.tmpl

**Files:**
- Modify: `skills/migrate-header/SKILL.md` (Scripts section, Stage 7 scaffold prompt)
- Modify: `skills/migrate-header/templates/program.md.tmpl` (add CSS query instructions)

- [ ] **Step 1: Add css-query.js to SKILL.md Scripts section**

In the Scripts listing (around line 38-42), add after the existing entries:

```
- `node $SKILL_HOME/scripts/css-query.js open <url> [--browser-recipe=path] [--session=name]`
- `node $SKILL_HOME/scripts/css-query.js query <selector|node:N> <properties>`
- `node $SKILL_HOME/scripts/css-query.js cascade <selector|node:N>`
- `node $SKILL_HOME/scripts/css-query.js vars`
- `node $SKILL_HOME/scripts/css-query.js close`
```

- [ ] **Step 2: Update Stage 7 scaffold subagent prompt**

In the scaffold subagent prompt section (Stage 7), add a new section after "## Input Data":

```markdown
## CSS Data

Read these for accurate styling information:
- CSS Overview: <PROJECT_ROOT>/autoresearch/extraction/css-overview.json
  Contains authored custom properties, font stacks, categorized color
  palette, and key spacing — extracted via Chrome DevTools Protocol.
  Prefer these values over branding.json when they conflict.

For deeper CSS lookups, open a query session:
  node $SKILL_HOME/scripts/css-query.js open "$URL" --browser-recipe="$BROWSER_RECIPE"
  node $SKILL_HOME/scripts/css-query.js query "nav > a:first-child" font-size,color,font-weight
  node $SKILL_HOME/scripts/css-query.js close
```

- [ ] **Step 3: Add CSS query instructions to program.md.tmpl**

In `templates/program.md.tmpl`, add a new section after "## Source Reference":

```markdown
## CSS Query Tool

You have access to an on-demand CSS inspector that queries the source
page's actual stylesheets via Chrome DevTools Protocol. Use it to get
exact property values instead of guessing.

### How to Use

```bash
# Open session on source URL (do this once at start of iteration)
node "$SKILL_HOME/scripts/css-query.js" open "{{URL}}" --session=css-src

# Query specific properties for an element
node "$SKILL_HOME/scripts/css-query.js" query "nav > a:first-child" font-size,color,font-weight --session=css-src

# Get all matched CSS rules for an element (full cascade)
node "$SKILL_HOME/scripts/css-query.js" cascade ".header-brand" --session=css-src

# List CSS custom properties defined in the source
node "$SKILL_HOME/scripts/css-query.js" vars --session=css-src

# Close when done (before committing)
node "$SKILL_HOME/scripts/css-query.js" close --session=css-src
```

### When to Use

- When the diff image shows a color mismatch: query the source element's
  `background-color` or `color` to get the exact hex value
- When font rendering differs: query `font-family`, `font-size`, `font-weight`
  to see the authored font stack, not just the resolved font
- When spacing is off: query `padding`, `margin`, `gap` values
- When you need the source's CSS custom properties to map to EDS properties

### Output

Each query returns JSON with the value, which CSS rule set it, the source
file, and whether it's inherited:

```json
{"font-size": {"value": "14px", "source": "author", "rule": ".nav-link", "inherited": false}}
```
```

- [ ] **Step 4: Update Stage 5 verification to include css-overview.json**

In the Stage 5 file verification block, add `css-overview.json` to the check:

```bash
for f in snapshot.json desktop.png; do
```

Change to:

```bash
for f in snapshot.json desktop.png css-overview.json; do
```

Actually, css-overview extraction is best-effort (warned on failure), so don't require it. Instead, add a note after the verification:

```
If css-overview.json was not generated, log a warning but continue.
The scaffold subagent will fall back to branding.json values.
```

- [ ] **Step 5: Commit**

```bash
git add skills/migrate-header/SKILL.md \
  skills/migrate-header/templates/program.md.tmpl
git commit -m "feat(migrate-header): integrate css-query tool into scaffold and polish prompts"
```

---

### Task 6: Live Test and Verification

**Files:**
- Read: all modified files for final review

- [ ] **Step 1: Run all vitest tests**

Run: `npx vitest run tests/migrate-header/`
Expected: All tests pass.

- [ ] **Step 2: Live test css-query.js against hlx.live**

```bash
node skills/migrate-header/scripts/css-query.js open "https://www.hlx.live/developer/tutorial"
node skills/migrate-header/scripts/css-query.js query "nav > a:first-child" font-size,color,font-family
node skills/migrate-header/scripts/css-query.js vars
node skills/migrate-header/scripts/css-query.js close
```

Expected: JSON output with property values, sources, and rule info.

- [ ] **Step 3: Live test css-overview.js via capture-snapshot**

```bash
mkdir -p /tmp/css-test
node skills/migrate-header/scripts/capture-snapshot.js \
  "https://www.hlx.live/developer/tutorial" /tmp/css-test
cat /tmp/css-test/css-overview.json
```

Expected: `css-overview.json` generated alongside `snapshot.json` with custom properties, font stacks, and color palette.

- [ ] **Step 4: Verify SKILL.md line count**

Run: `wc -l skills/migrate-header/SKILL.md`
Expected: Under 800 lines.

- [ ] **Step 5: Run tessl lint**

Run: `tessl skill lint skills/migrate-header`
Expected: No new warnings.

- [ ] **Step 6: Sync skills**

Run: `./scripts/sync-skills.sh`

- [ ] **Step 7: Final commit if any fixes needed**

Only if previous steps revealed issues.

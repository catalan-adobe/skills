# migrate-header: browser-probe & page-collect Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate browser-probe and page-collect into migrate-header so bot-protected sites are handled automatically and all playwright consumers share a single browser recipe.

**Architecture:** Run browser-probe once at pipeline start (new Stage 2b), save recipe to `autoresearch/browser-recipe.json`, thread the recipe path to three downstream consumers: overlay detection (inline bash), capture-snapshot.js (`--browser-recipe` flag), and page-collect.js (`--browser-recipe` flag).

**Tech Stack:** Node 22, playwright-cli, Playwright Node API, vitest

**Spec:** `docs/superpowers/specs/2026-03-30-migrate-header-probe-integration-design.md`

---

### Task 1: Add `--browser-recipe` to capture-snapshot.js

**Files:**
- Modify: `skills/migrate-header/scripts/capture-snapshot.js:40-69` (parseArgs), `skills/migrate-header/scripts/capture-snapshot.js:108-111` (openPage), `skills/migrate-header/scripts/capture-snapshot.js:353-401` (main)
- Test: `tests/migrate-header/capture-snapshot.test.js` (create)

- [ ] **Step 1: Write failing tests for parseArgs browser-recipe flag**

Create `tests/migrate-header/capture-snapshot.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../skills/migrate-header/scripts/capture-snapshot.js';

describe('parseArgs', () => {
  it('parses --browser-recipe flag', () => {
    const result = parseArgs([
      '', '',
      'https://example.com', '/tmp/out',
      '--browser-recipe=/tmp/recipe.json',
    ]);
    expect(result.browserRecipe).toBe('/tmp/recipe.json');
  });

  it('defaults browserRecipe to null when not provided', () => {
    const result = parseArgs([
      '', '',
      'https://example.com', '/tmp/out',
    ]);
    expect(result.browserRecipe).toBeNull();
  });

  it('ignores empty browser-recipe value', () => {
    const result = parseArgs([
      '', '',
      'https://example.com', '/tmp/out',
      '--browser-recipe=',
    ]);
    expect(result.browserRecipe).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/migrate-header/capture-snapshot.test.js`

Expected: FAIL — `parseArgs` is not exported, and `browserRecipe` field doesn't exist.

- [ ] **Step 3: Export parseArgs and add --browser-recipe flag**

In `skills/migrate-header/scripts/capture-snapshot.js`:

Add `export` to the `parseArgs` function signature (line 40):

```js
export function parseArgs(argv) {
```

Add `browserRecipe` parsing inside the `for` loop (after line 49):

```js
    } else if (arg.startsWith('--browser-recipe=')) {
      const val = arg.split('=')[1];
      browserRecipe = val || null;
```

Add `let browserRecipe = null;` next to line 44 (`let overlayRecipe = null;`).

Update the return object (line 64-69) to include `browserRecipe`:

```js
  return {
    url: positional[0],
    outputDir: resolve(positional[1]),
    headerSelector,
    overlayRecipe,
    browserRecipe,
  };
```

Update the usage string (line 58-59) to include the new flag:

```js
    console.error(
      'Usage: node capture-snapshot.js <url> <output-dir>'
      + ' [--header-selector=header] [--overlay-recipe=path]'
      + ' [--browser-recipe=path]'
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/migrate-header/capture-snapshot.test.js`

Expected: PASS

- [ ] **Step 5: Write failing test for recipe-aware openPage**

Add to `tests/migrate-header/capture-snapshot.test.js`:

```js
import { vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRecipeArgs } from '../../skills/migrate-header/scripts/capture-snapshot.js';

describe('buildRecipeArgs', () => {
  it('returns empty args and null stealth when no recipe', () => {
    const result = buildRecipeArgs(null);
    expect(result).toEqual({ extraArgs: [], stealthScript: null });
  });

  it('returns config path and stealth script from recipe', () => {
    const recipe = {
      cliConfig: {
        browser: {
          browserName: 'chromium',
          launchOptions: { channel: 'chrome' },
        },
      },
      stealthInitScript: '(function(){ /* stealth */ })()',
    };
    const dir = join(tmpdir(), `test-recipe-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recipePath = join(dir, 'browser-recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));

    const result = buildRecipeArgs(recipePath);
    expect(result.extraArgs).toContain(`--config=${result.configPath}`);
    expect(result.stealthScript).toBe('(function(){ /* stealth */ })()');

    // Verify the written config matches cliConfig
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(written.browser.launchOptions.channel).toBe('chrome');
  });

  it('adds --persistent flag when recipe has persistent: true', () => {
    const recipe = {
      cliConfig: { browser: { browserName: 'chromium', launchOptions: {} } },
      stealthInitScript: null,
      persistent: true,
    };
    const dir = join(tmpdir(), `test-recipe-persist-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recipePath = join(dir, 'browser-recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));

    const result = buildRecipeArgs(recipePath);
    expect(result.extraArgs).toContain('--persistent');
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/migrate-header/capture-snapshot.test.js`

Expected: FAIL — `buildRecipeArgs` not exported / doesn't exist.

- [ ] **Step 7: Implement buildRecipeArgs**

Add to `skills/migrate-header/scripts/capture-snapshot.js`, after the `parseArgs` function:

```js
export function buildRecipeArgs(recipePath) {
  if (!recipePath) {
    return { extraArgs: [], stealthScript: null, configPath: null };
  }

  const recipe = JSON.parse(readFileSync(recipePath, 'utf-8'));
  const configPath = join(tmpdir(), `header-capture-config-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify(recipe.cliConfig, null, 2));

  const extraArgs = [`--config=${configPath}`];
  if (recipe.persistent) {
    extraArgs.push('--persistent');
  }

  return {
    extraArgs,
    stealthScript: recipe.stealthInitScript || null,
    configPath,
  };
}
```

Add `tmpdir` to the `node:os` import at the top of the file (new import):

```js
import { tmpdir } from 'node:os';
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/migrate-header/capture-snapshot.test.js`

Expected: PASS

- [ ] **Step 9: Wire recipe into openPage and main**

Update `openPage` (line 108) to accept and use recipe args:

```js
function openPage(url, recipeArgs) {
  log(`Opening ${url}...`);
  cli('open', url, ...recipeArgs.extraArgs);
  if (recipeArgs.stealthScript) {
    log('  Injecting stealth script...');
    cli('eval', recipeArgs.stealthScript);
  }
}
```

Update `main()` (line 353) to build recipe args and pass them, and clean up temp config in finally:

```js
function main() {
  const {
    url, outputDir, headerSelector, overlayRecipe, browserRecipe,
  } = parseArgs(process.argv);

  verifyInstalled();
  mkdirSync(outputDir, { recursive: true });

  const recipeArgs = buildRecipeArgs(browserRecipe);

  try {
    openPage(url, recipeArgs);
    waitForStable();
    // ... rest unchanged ...
  } finally {
    closeSession();
    if (recipeArgs.configPath) {
      try { unlinkSync(recipeArgs.configPath); } catch { /* ignore */ }
    }
  }
}
```

Add `unlinkSync` to the `node:fs` import (line 4):

```js
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
```

- [ ] **Step 10: Run all tests**

Run: `npx vitest run tests/migrate-header/`

Expected: All PASS

- [ ] **Step 11: Commit**

```bash
git add skills/migrate-header/scripts/capture-snapshot.js \
  tests/migrate-header/capture-snapshot.test.js
git commit -m "feat(capture-snapshot): add --browser-recipe flag for bot-protection bypass"
```

---

### Task 2: Add `--browser-recipe` to page-collect.js

**Files:**
- Modify: `skills/page-collect/scripts/page-collect.js:38-69` (parseArgs), `skills/page-collect/scripts/page-collect.js:83-101` (launchBrowser), `skills/page-collect/scripts/page-collect.js:115-116` (main)
- Test: `tests/page-collect/page-collect.test.js` (create)

- [ ] **Step 1: Write failing tests for parseArgs and applyBrowserRecipe**

Create `tests/page-collect/page-collect.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('parseArgs', () => {
  it('parses --browser-recipe flag', async () => {
    const { parseArgs } = await import(
      '../../skills/page-collect/scripts/page-collect.js'
    );
    const result = parseArgs([
      '', '',
      'icons', 'https://example.com',
      '--browser-recipe', '/tmp/recipe.json',
    ]);
    expect(result.browserRecipe).toBe('/tmp/recipe.json');
  });

  it('defaults browserRecipe to null', async () => {
    const { parseArgs } = await import(
      '../../skills/page-collect/scripts/page-collect.js'
    );
    const result = parseArgs([
      '', '',
      'icons', 'https://example.com',
    ]);
    expect(result.browserRecipe).toBeNull();
  });
});

describe('applyBrowserRecipe', () => {
  it('returns default options when no recipe path', async () => {
    const { applyBrowserRecipe } = await import(
      '../../skills/page-collect/scripts/page-collect.js'
    );
    const result = applyBrowserRecipe(null);
    expect(result.launchOptions).toEqual({ headless: true });
    expect(result.userAgent).toBeNull();
    expect(result.stealthScript).toBeNull();
  });

  it('extracts channel from recipe', async () => {
    const { applyBrowserRecipe } = await import(
      '../../skills/page-collect/scripts/page-collect.js'
    );
    const recipe = {
      cliConfig: {
        browser: {
          browserName: 'chromium',
          launchOptions: {
            channel: 'chrome',
            args: [
              '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
            ],
          },
        },
      },
      stealthInitScript: '(function(){ /* stealth */ })()',
    };
    const dir = join(tmpdir(), `test-pc-recipe-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recipePath = join(dir, 'browser-recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));

    const result = applyBrowserRecipe(recipePath);
    expect(result.launchOptions.channel).toBe('chrome');
    expect(result.userAgent).toContain('Chrome/120');
    expect(result.stealthScript).toBe('(function(){ /* stealth */ })()');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/page-collect/page-collect.test.js`

Expected: FAIL — `parseArgs` not exported, `applyBrowserRecipe` doesn't exist, `browserRecipe` field missing.

- [ ] **Step 3: Export parseArgs and add --browser-recipe flag**

In `skills/page-collect/scripts/page-collect.js`:

Export `parseArgs` (line 38):

```js
export function parseArgs(argv) {
```

Add `browserRecipe` parsing after the `--output` handling (after line 49):

```js
  const recipeIdx = args.indexOf('--browser-recipe');
  const browserRecipe = (recipeIdx !== -1 && args[recipeIdx + 1])
    ? args[recipeIdx + 1]
    : null;
```

Update return (line 69):

```js
  return { subcommand, url, output: resolve(output), browserRecipe };
```

- [ ] **Step 4: Implement applyBrowserRecipe**

Add `readFileSync` to the existing imports at the top of `skills/page-collect/scripts/page-collect.js`:

```js
import { readFileSync } from 'node:fs';
```

Add after `parseArgs` in `skills/page-collect/scripts/page-collect.js`:

```js
export function applyBrowserRecipe(recipePath) {
  if (!recipePath) {
    return { launchOptions: { headless: true }, userAgent: null, stealthScript: null };
  }

  const recipe = JSON.parse(readFileSync(recipePath, 'utf-8'));
  const launchOpts = recipe.cliConfig?.browser?.launchOptions || {};

  const launchOptions = { headless: true };
  if (launchOpts.channel) {
    launchOptions.channel = launchOpts.channel;
  }

  let userAgent = null;
  const uaArg = (launchOpts.args || []).find((a) => a.startsWith('--user-agent='));
  if (uaArg) {
    userAgent = uaArg.split('=').slice(1).join('=');
  }

  return {
    launchOptions,
    userAgent,
    stealthScript: recipe.stealthInitScript || null,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/page-collect/page-collect.test.js`

Expected: PASS

- [ ] **Step 6: Wire recipe into launchBrowser and main**

Update `launchBrowser` signature and body (line 83):

```js
async function launchBrowser(url, recipeOpts) {
  detectPlaywright();

  const { chromium } = await import('playwright');
  const browser = await chromium.launch(recipeOpts.launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: recipeOpts.userAgent
      || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  if (recipeOpts.stealthScript) {
    await page.addInitScript(recipeOpts.stealthScript);
  }

  console.error(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  return { browser, page };
}
```

Update `main()` (line 115-116):

```js
  const { subcommand, url, output, browserRecipe } = parseArgs(process.argv);
  await mkdir(output, { recursive: true });

  const recipeOpts = applyBrowserRecipe(browserRecipe);
  const { browser, page } = await launchBrowser(url, recipeOpts);
```

- [ ] **Step 7: Run all page-collect tests**

Run: `npx vitest run tests/page-collect/` and `bash tests/page-collect/test-icons.sh`

Expected: All PASS. The shell tests don't pass `--browser-recipe` so they exercise the null-recipe default path.

- [ ] **Step 8: Commit**

```bash
git add skills/page-collect/scripts/page-collect.js \
  tests/page-collect/page-collect.test.js
git commit -m "feat(page-collect): add --browser-recipe flag for bot-protection bypass"
```

---

### Task 3: Update SKILL.md — Stage 2b (Browser Probe) and State Variables

**Files:**
- Modify: `skills/migrate-header/SKILL.md:24-26` (pipeline diagram), `skills/migrate-header/SKILL.md:53-57` (state variables), `skills/migrate-header/SKILL.md:109-111` (insert new stage after Stage 2)

- [ ] **Step 1: Update pipeline diagram**

Replace line 25 in SKILL.md:

```
URL --> PARSE --> VALIDATE --> PROBE --> PREPARE --> OVERLAY --> SNAPSHOT --> EXTRACT --> SCAFFOLD --> SETUP --> DEV+POLISH --> REPORT --> RETRO
        (args)    (EDS?)      (CDN)    (mkdir)      (LLM)     (pw-cli)   (scripts)    (LLM)      (files)   (aem+loop)    (score)   (learnings)
```

- [ ] **Step 2: Add BROWSER_RECIPE state variable**

After `AEM_PID=""` (line 57), add:

```
BROWSER_RECIPE=""
```

- [ ] **Step 3: Insert Stage 2b after Stage 2 (Validate)**

After Stage 2's closing code block and `echo "EDS repository validated."` (after line 111), insert:

````markdown
### Stage 2b: Browser Probe

Detect CDN bot protection before any browser interaction. If the site
blocks headless Chrome, all downstream captures will fail. Probe once,
share the recipe with all consumers.

**Locate browser-probe scripts** (sibling skill):

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  BROWSER_PROBE_DIR="$(dirname "$CLAUDE_SKILL_DIR")/browser-probe/scripts"
else
  BROWSER_PROBE_DIR="$(dirname "$(find ~/.claude \
    -path "*/browser-probe/scripts/browser-probe.js" \
    -type f 2>/dev/null | head -1)" 2>/dev/null)"
fi
```

If browser-probe scripts are not found, skip probing:

```bash
if [[ -z "$BROWSER_PROBE_DIR" || ! -f "$BROWSER_PROBE_DIR/browser-probe.js" ]]; then
  echo "Warning: browser-probe skill not found. Skipping CDN probe."
  echo "Install: sync browser-probe skill to ~/.claude/skills/"
fi
```

**Run the probe:**

```bash
node "$BROWSER_PROBE_DIR/browser-probe.js" "$URL" "$PROJECT_ROOT/autoresearch"
```

**Read `probe-report.json` and generate recipe:**

Read `$PROJECT_ROOT/autoresearch/probe-report.json`. Check `firstSuccess`:

- If `firstSuccess` is `"default"`: no bot protection detected. Set
  `BROWSER_RECIPE=""` and continue. Log: "No bot protection detected."
- If `firstSuccess` is non-null and not `"default"`: bot protection
  detected. Follow browser-probe Steps 3-4 to interpret
  `detectedSignals` and generate `browser-recipe.json`. Read
  [stealth-config.md](references/stealth-config.md) from the
  browser-probe skill for the stealth init script and provider
  signature table. Save to
  `$PROJECT_ROOT/autoresearch/browser-recipe.json` and set
  `BROWSER_RECIPE="$PROJECT_ROOT/autoresearch/browser-recipe.json"`.
  Log: "Bot protection detected (<signals>). Recipe saved."
- If `firstSuccess` is null: all configurations failed. Report error
  and stop the pipeline:

```
ERROR: All browser configurations failed for $URL.
  The site may require authentication, VPN, or manual interaction.
  Detected signals: <detectedSignals from report>

  Options:
  1. Provide a --browser-recipe manually
  2. Use a VPN or check URL accessibility
  3. Provide pre-captured snapshots in autoresearch/source/
```
````

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): add Stage 2b browser probe"
```

---

### Task 4: Update SKILL.md — Stage 4 (Overlay Detection) Recipe Threading

**Files:**
- Modify: `skills/migrate-header/SKILL.md:158-194` (Stage 4 overlay detection bash)

- [ ] **Step 1: Replace the inline playwright-cli block**

Replace the Stage 4 playwright-cli invocation block (lines 164-167):

```bash
playwright-cli -s=overlay-detect open "$URL"
REPORT_RAW=$(playwright-cli -s=overlay-detect eval "$BUNDLE")
playwright-cli -s=overlay-detect close
```

With recipe-aware version:

```bash
if [[ -n "$BROWSER_RECIPE" && -f "$BROWSER_RECIPE" ]]; then
  # Write cliConfig to temp file for playwright-cli --config
  PROBE_CONFIG="/tmp/overlay-probe-config.json"
  node -e "
    const fs = require('fs');
    const r = JSON.parse(fs.readFileSync('$BROWSER_RECIPE','utf-8'));
    fs.writeFileSync('$PROBE_CONFIG', JSON.stringify(r.cliConfig, null, 2));
  "
  STEALTH=$(node -e "
    const fs = require('fs');
    const r = JSON.parse(fs.readFileSync('$BROWSER_RECIPE','utf-8'));
    console.log(r.stealthInitScript || '');
  ")

  # Open blank page, inject stealth, then navigate
  playwright-cli -s=overlay-detect open --config="$PROBE_CONFIG"
  if [[ -n "$STEALTH" ]]; then
    playwright-cli -s=overlay-detect eval "$STEALTH"
  fi
  playwright-cli -s=overlay-detect goto "$URL"
else
  playwright-cli -s=overlay-detect open "$URL"
fi

REPORT_RAW=$(playwright-cli -s=overlay-detect eval "$BUNDLE")
playwright-cli -s=overlay-detect close
```

Note: `eval "$BUNDLE"` and `close` are shared — they run regardless of
whether a recipe was used. Only the open/navigate sequence changes.

- [ ] **Step 2: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): thread browser recipe into Stage 4 overlay detection"
```

---

### Task 5: Update SKILL.md — Stage 5 (Snapshot) and Stage 6b (Icons)

**Files:**
- Modify: `skills/migrate-header/SKILL.md:209-215` (Stage 5 capture command), `skills/migrate-header/SKILL.md:257-279` (Stage 6b icon collection)

- [ ] **Step 1: Update Stage 5 capture-snapshot invocation**

Replace the capture-snapshot command block (lines 210-215):

```bash
node "$SKILL_HOME/scripts/capture-snapshot.js" \
  "$URL" \
  "$PROJECT_ROOT/autoresearch/source" \
  "--header-selector=$HEADER_SELECTOR" \
  "--overlay-recipe=$PROJECT_ROOT/autoresearch/overlay-recipe.json"
```

With:

```bash
RECIPE_FLAG=""
if [[ -n "$BROWSER_RECIPE" ]]; then
  RECIPE_FLAG="--browser-recipe=$BROWSER_RECIPE"
fi

node "$SKILL_HOME/scripts/capture-snapshot.js" \
  "$URL" \
  "$PROJECT_ROOT/autoresearch/source" \
  "--header-selector=$HEADER_SELECTOR" \
  "--overlay-recipe=$PROJECT_ROOT/autoresearch/overlay-recipe.json" \
  $RECIPE_FLAG
```

- [ ] **Step 2: Fix Stage 6b path resolution and add recipe flag**

Replace the page-collect script location block (lines 260-263):

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  PAGE_COLLECT="$(dirname "$CLAUDE_SKILL_DIR")/../page-collect/scripts/page-collect.js"
else
  PAGE_COLLECT="$(find ~/.claude -path "*/page-collect/scripts/page-collect.js" -type f 2>/dev/null | head -1)"
fi
```

With:

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  PAGE_COLLECT="$(dirname "$CLAUDE_SKILL_DIR")/page-collect/scripts/page-collect.js"
else
  PAGE_COLLECT="$(find ~/.claude -path "*/page-collect/scripts/page-collect.js" -type f 2>/dev/null | head -1)"
fi
```

Replace the page-collect invocation (line 271):

```bash
  node "$PAGE_COLLECT" icons "$SOURCE_URL" --output "$ICON_OUTPUT"
```

With:

```bash
  RECIPE_ARGS=""
  if [[ -n "$BROWSER_RECIPE" ]]; then
    RECIPE_ARGS="--browser-recipe $BROWSER_RECIPE"
  fi
  node "$PAGE_COLLECT" icons "$SOURCE_URL" --output "$ICON_OUTPUT" $RECIPE_ARGS
```

- [ ] **Step 3: Update the Scripts section at the top**

Update the script listing (line 39) to document the new flag:

```
- `node $SKILL_HOME/scripts/capture-snapshot.js <url> <output-dir> [--header-selector=header] [--overlay-recipe=path] [--browser-recipe=path]`
```

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): thread browser recipe into Stages 5 and 6b, fix path resolution"
```

---

### Task 6: Update SKILL.md — Error Handling and Retrospective

**Files:**
- Modify: `skills/migrate-header/SKILL.md:540-563` (Stage 11 retrospective dimensions), `skills/migrate-header/SKILL.md:629-658` (error handling failure report)

- [ ] **Step 1: Add probe stage to retrospective analysis**

In the Stage 11 retrospective analysis table (around line 563), add a new row:

```
| Bot protection | probe-report.json vs firstSuccess config | Whether probe correctly identified protection and recipe worked |
```

- [ ] **Step 2: Add probe stage to error handling failure report**

In the example failure report (around line 649), add Stage 2b to the completed stages list:

```
- [x] Stage 2b: Browser probe (no bot protection / stealth config)
```

- [ ] **Step 3: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): add browser probe to retrospective and error handling"
```

---

### Task 7: Run Full Test Suite and Verify

**Files:**
- Read: all modified files for final review

- [ ] **Step 1: Run all vitest tests**

Run: `npx vitest run tests/`

Expected: All tests pass.

- [ ] **Step 2: Run page-collect shell tests**

Run: `bash tests/page-collect/test-icons.sh`

Expected: All pass (exercises null-recipe default path).

- [ ] **Step 3: Verify SKILL.md line count**

Run: `wc -l skills/migrate-header/SKILL.md`

Expected: Under 750 lines (was 660, adding ~60 lines for Stage 2b and recipe threading). If over, check whether reference material should be extracted.

- [ ] **Step 4: Verify no broken references**

Run: `tessl skill lint skills/migrate-header` (if tessl is installed)

Expected: Zero warnings.

- [ ] **Step 5: Final commit (if any fixes needed)**

Only if previous steps revealed issues that needed fixing.

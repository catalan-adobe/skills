# browser-probe Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a `browser-probe` skill that detects CDN bot protection blocking headless Chrome and produces a `browser-recipe.json` for downstream `playwright-cli` consumers.

**Architecture:** A `browser-probe.js` Node script runs an escalation ladder of browser configurations (default → stealth → system Chrome → persistent profile), checking page health at each step. SKILL.md teaches agents to invoke the script, interpret the probe report using a provider signature knowledge base, and generate a recipe. No npm dependencies — uses `playwright-cli` via `execFileSync` and Node 22 built-ins.

**Tech Stack:** Node 22 ESM, `playwright-cli` (CLI, not API), pure prompt SKILL.md

**Spec:** `docs/2026-03-30-browser-probe-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `skills/browser-probe/scripts/browser-probe.js` | Create | Escalation ladder probe script — runs 4 browser configs, outputs `probe-report.json` |
| `skills/browser-probe/references/stealth-config.md` | Create | Stealth init script, HTTP headers, provider signature table |
| `skills/browser-probe/SKILL.md` | Create | Orchestration prompt — when/how to probe, interpret report, generate recipe |
| `tests/browser-probe/browser-probe.test.js` | Create | Unit tests for health-check logic, signal detection, report structure |

---

### Task 1: Create stealth-config.md reference

This is the knowledge base. Writing it first because the probe script references the stealth init script from here, and the SKILL.md references the provider table.

**Files:**
- Create: `skills/browser-probe/references/stealth-config.md`

- [ ] **Step 1: Create the reference file**

```markdown
# Stealth Configuration Reference

## Stealth Init Script

Inject via `playwright-cli eval` after `open` (no URL) and before `goto <url>`.
This patches browser fingerprints that headless detection relies on.

```js
(function() {
  // Hide webdriver property (primary headless signal)
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Add realistic plugins (headless Chrome has empty plugins array)
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
  });

  // Set realistic languages (headless may report empty)
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // Add chrome runtime object (missing in headless)
  window.chrome = { runtime: {} };
})()
```

## Stealth HTTP Headers

These headers mimic a real Chrome session. Currently not injectable via
`playwright-cli` (no `extraHTTPHeaders` support). Documented for future use
or for scripts using Playwright API directly.

| Header | Value |
|--------|-------|
| `Accept` | `text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8` |
| `Accept-Language` | `en-US,en;q=0.9` |
| `Accept-Encoding` | `gzip, deflate, br` |
| `Cache-Control` | `no-cache` |
| `Sec-Ch-Ua` | `"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"` |
| `Sec-Ch-Ua-Mobile` | `?0` |
| `Sec-Ch-Ua-Platform` | `"macOS"` |
| `Sec-Fetch-Dest` | `document` |
| `Sec-Fetch-Mode` | `navigate` |
| `Sec-Fetch-Site` | `none` |
| `Sec-Fetch-User` | `?1` |
| `Upgrade-Insecure-Requests` | `1` |

## Provider Signature Table

Maps observable signals (from `playwright-cli network` response headers and
page content) to CDN bot detection providers and typical remedies.

| Signal | Provider | Confidence | Typical fix |
|--------|----------|------------|-------------|
| `server: AkamaiGHost` or `server: AkamaiNetStorage` | Akamai | medium | System Chrome (`--browser=chrome`) — TLS fingerprint |
| `bm_sz` cookie in `set-cookie` | Akamai Bot Manager | high | System Chrome — TLS fingerprint |
| `_abck` cookie in `set-cookie` | Akamai Bot Manager | high | System Chrome — TLS fingerprint |
| `cf-ray` header present | Cloudflare | medium | Stealth script often sufficient |
| Page title contains "Just a moment" or "Checking your browser" | Cloudflare Challenge | high | System Chrome + stealth |
| `x-datadome` header present | DataDome | high | System Chrome + stealth |
| `x-amzn-waf-action` header present | AWS WAF | medium | Stealth script (UA-based detection) |
| `x-cdn: Imperva` or `x-iinfo` header | Incapsula/Imperva | medium | System Chrome + stealth |
| Page title contains "Access Denied" + `server: AkamaiGHost` | Akamai hard block | high | System Chrome — TLS fingerprint |
| Page title matches `/error\|denied\|blocked\|403\|captcha/i` + no known provider | Unknown WAF | low | Escalate to persistent profile |
| `status: 403` + `bodyLength < 500` | Generic block | low | Escalate through all steps |
```

- [ ] **Step 2: Verify the file exists and markdown renders**

Run: `head -5 skills/browser-probe/references/stealth-config.md`

- [ ] **Step 3: Commit**

```bash
git add skills/browser-probe/references/stealth-config.md
git commit -m "feat(browser-probe): add stealth-config reference"
```

---

### Task 2: Create browser-probe.js script — scaffolding and helpers

The probe script in two tasks: scaffolding + helpers first (this task), then the main escalation logic (next task). This split keeps each task focused and testable.

**Files:**
- Create: `skills/browser-probe/scripts/browser-probe.js`

- [ ] **Step 1: Write the failing test for parseEvalOutput and health check**

Create `tests/browser-probe/browser-probe.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  parseEvalOutput,
  checkHealth,
  detectSignals,
} from '../../skills/browser-probe/scripts/browser-probe.js';

describe('parseEvalOutput', () => {
  it('extracts JSON from playwright-cli eval result block', () => {
    const raw = `### Result\n{"title":"Test"}\n### Ran Playwright code`;
    expect(parseEvalOutput(raw)).toBe('{"title":"Test"}');
  });

  it('extracts quoted string from result block', () => {
    const raw = `### Result\n"hello world"\n### Ran Playwright code`;
    expect(parseEvalOutput(raw)).toBe('hello world');
  });

  it('returns raw input when no result block found', () => {
    expect(parseEvalOutput('plain text')).toBe('plain text');
  });
});

describe('checkHealth', () => {
  it('returns success for a normal page', () => {
    const health = {
      title: 'AstraZeneca | Home',
      url: 'https://www.astrazeneca.com/',
      bodyLength: 12000,
      status: 200,
      hasMainContent: true,
    };
    expect(checkHealth(health)).toBe('success');
  });

  it('returns blocked for error page title', () => {
    const health = {
      title: 'ERROR: The request could not be satisfied',
      url: 'https://www.astrazeneca.com/',
      bodyLength: 42,
      status: 403,
      hasMainContent: false,
    };
    expect(checkHealth(health)).toBe('blocked');
  });

  it('returns blocked for captcha challenge', () => {
    const health = {
      title: 'Just a moment...',
      url: 'https://example.com/',
      bodyLength: 800,
      status: 200,
      hasMainContent: false,
    };
    expect(checkHealth(health)).toBe('blocked');
  });

  it('returns blocked for very short body with no main content', () => {
    const health = {
      title: 'Example',
      url: 'https://example.com/',
      bodyLength: 30,
      status: 200,
      hasMainContent: false,
    };
    expect(checkHealth(health)).toBe('blocked');
  });

  it('returns success for short body if main content exists', () => {
    const health = {
      title: 'Minimal Site',
      url: 'https://example.com/',
      bodyLength: 30,
      status: 200,
      hasMainContent: true,
    };
    expect(checkHealth(health)).toBe('success');
  });
});

describe('detectSignals', () => {
  it('detects Akamai from server header', () => {
    const networkLines = [
      'GET https://www.example.com/ 403 server: AkamaiGHost',
    ];
    const signals = detectSignals(networkLines, {
      title: 'Access Denied', status: 403,
    });
    expect(signals).toContain('akamai-server');
  });

  it('detects Cloudflare from cf-ray header', () => {
    const networkLines = [
      'GET https://www.example.com/ 200 cf-ray: abc123',
    ];
    const signals = detectSignals(networkLines, {
      title: 'Example', status: 200,
    });
    expect(signals).toContain('cloudflare-ray');
  });

  it('detects Cloudflare challenge from page title', () => {
    const signals = detectSignals([], {
      title: 'Just a moment...', status: 200,
    });
    expect(signals).toContain('cloudflare-challenge');
  });

  it('returns empty array for clean site', () => {
    const signals = detectSignals([], {
      title: 'Adobe', status: 200,
    });
    expect(signals).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/browser-probe/browser-probe.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create browser-probe.js with exported helpers**

Create `skills/browser-probe/scripts/browser-probe.js`:

```js
#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 30_000,
};

const ERROR_TITLE_PATTERN =
  /error|denied|blocked|not satisfied|403|captcha|challenge|attention required|just a moment/i;

const MIN_BODY_LENGTH = 100;

// --- Exported helpers (used by tests and main) ---

export function parseEvalOutput(raw) {
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

export function checkHealth(health) {
  if (health.status >= 400) return 'blocked';
  if (ERROR_TITLE_PATTERN.test(health.title)) return 'blocked';
  if (health.bodyLength < MIN_BODY_LENGTH && !health.hasMainContent) {
    return 'blocked';
  }
  return 'success';
}

export function detectSignals(networkLines, health) {
  const signals = [];
  const joined = networkLines.join('\n').toLowerCase();

  if (joined.includes('server: akamaighost')
      || joined.includes('server: akamainetstorage')) {
    signals.push('akamai-server');
  }
  if (joined.includes('bm_sz') || joined.includes('_abck')) {
    signals.push('akamai-bot-manager');
  }
  if (joined.includes('cf-ray')) {
    signals.push('cloudflare-ray');
  }
  if (joined.includes('x-datadome')) {
    signals.push('datadome');
  }
  if (joined.includes('x-amzn-waf-action')) {
    signals.push('aws-waf');
  }
  if (joined.includes('x-cdn: imperva') || joined.includes('x-iinfo')) {
    signals.push('incapsula');
  }

  const title = (health.title || '').toLowerCase();
  if (title.includes('just a moment')
      || title.includes('checking your browser')) {
    signals.push('cloudflare-challenge');
  }

  return signals;
}

// --- CLI plumbing ---

function cli(session, ...args) {
  return execFileSync(
    'playwright-cli', [`-s=${session}`, ...args], EXEC_OPTS,
  ).trim();
}

function cliEval(session, js) {
  const raw = cli(session, 'eval', js);
  return parseEvalOutput(raw);
}

function closeSession(session) {
  try {
    execFileSync(
      'playwright-cli', [`-s=${session}`, 'close'], EXEC_OPTS,
    );
  } catch {
    // Session may already be closed
  }
}
```

- [ ] **Step 4: Run tests to verify helpers pass**

Run: `npx vitest run tests/browser-probe/browser-probe.test.js`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add skills/browser-probe/scripts/browser-probe.js \
  tests/browser-probe/browser-probe.test.js
git commit -m "feat(browser-probe): add probe script scaffolding and helpers"
```

---

### Task 3: Implement escalation ladder and main function

Add the health check JS, the escalation steps, and the `main()` function that runs the ladder and writes `probe-report.json`.

**Files:**
- Modify: `skills/browser-probe/scripts/browser-probe.js`

- [ ] **Step 1: Write integration test for report structure**

Append to `tests/browser-probe/browser-probe.test.js`:

```js
describe('buildStepResult', () => {
  it('builds a well-formed step result', async () => {
    // Dynamic import — buildStepResult not in the static import yet
    const { buildStepResult } = await import(
      '../../skills/browser-probe/scripts/browser-probe.js'
    );
    const result = buildStepResult('default', {
      browser: 'chromium', stealth: false, persistent: false,
    }, 'blocked', {
      title: 'ERROR', url: 'https://x.com/', bodyLength: 10,
      status: 403, hasMainContent: false,
    }, 1234);
    expect(result).toEqual({
      name: 'default',
      config: { browser: 'chromium', stealth: false, persistent: false },
      result: 'blocked',
      health: {
        title: 'ERROR', url: 'https://x.com/', bodyLength: 10,
        status: 403, hasMainContent: false,
      },
      durationMs: 1234,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/browser-probe/browser-probe.test.js`
Expected: FAIL — `buildStepResult` not exported

- [ ] **Step 3: Add escalation ladder and main to browser-probe.js**

Append to the end of `skills/browser-probe/scripts/browser-probe.js` (after `closeSession`):

```js
// --- Step execution ---

export function buildStepResult(name, config, result, health, durationMs) {
  return { name, config, result, health, durationMs };
}

const HEALTH_CHECK_JS = `(function() {
  var perf = performance.getEntriesByType('navigation');
  var status = perf.length > 0 ? perf[0].responseStatus : 0;
  return JSON.stringify({
    title: document.title || '',
    url: location.href,
    bodyLength: (document.body ? document.body.innerText.length : 0),
    status: status,
    hasMainContent: !!document.querySelector(
      'main, [role="main"], article, #content'
    )
  });
})()`;

const STEALTH_INIT_SCRIPT = `(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  window.chrome = { runtime: {} };
})()`;

function waitForStable(session) {
  for (let i = 0; i < 10; ++i) {
    const state = cliEval(session, 'document.readyState');
    if (state === 'complete') return;
  }
}

function getNetworkLines(session) {
  try {
    const raw = cli(session, 'network');
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function runStep(url, stepDef) {
  const session = `probe-${stepDef.name}`;
  const start = Date.now();

  try {
    if (stepDef.stealth) {
      // Open browser without URL, inject stealth, then navigate
      const openArgs = ['open'];
      if (stepDef.browser !== 'chromium') {
        openArgs.push(`--browser=${stepDef.browser}`);
      }
      if (stepDef.persistent) openArgs.push('--persistent');
      cli(session, ...openArgs);
      cliEval(session, STEALTH_INIT_SCRIPT);
      cli(session, 'goto', url);
    } else {
      // Open directly with URL
      const openArgs = ['open', url];
      if (stepDef.browser !== 'chromium') {
        openArgs.push(`--browser=${stepDef.browser}`);
      }
      if (stepDef.persistent) openArgs.push('--persistent');
      cli(session, ...openArgs);
    }

    waitForStable(session);
    const healthRaw = cliEval(session, HEALTH_CHECK_JS);
    const health = JSON.parse(healthRaw);
    const networkLines = getNetworkLines(session);
    const result = checkHealth(health);
    const durationMs = Date.now() - start;

    return {
      step: buildStepResult(
        stepDef.name, stepDef.config, result, health, durationMs,
      ),
      networkLines,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      step: buildStepResult(stepDef.name, stepDef.config, 'error', {
        title: '', url: '', bodyLength: 0,
        status: 0, hasMainContent: false,
        error: err.message,
      }, durationMs),
      networkLines: [],
    };
  } finally {
    closeSession(session);
  }
}

const STEPS = [
  {
    name: 'default',
    browser: 'chromium', stealth: false, persistent: false,
    config: { browser: 'chromium', stealth: false, persistent: false },
  },
  {
    name: 'stealth',
    browser: 'chromium', stealth: true, persistent: false,
    config: { browser: 'chromium', stealth: true, persistent: false },
  },
  {
    name: 'chrome',
    browser: 'chrome', stealth: true, persistent: false,
    config: { browser: 'chrome', stealth: true, persistent: false },
  },
  {
    name: 'persistent',
    browser: 'chrome', stealth: true, persistent: true,
    config: { browser: 'chrome', stealth: true, persistent: true },
  },
];

function log(msg) {
  console.error(msg);
}

function parseArgs(argv) {
  const positional = argv.slice(2).filter(a => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error(
      'Usage: node browser-probe.js <url> <output-dir>',
    );
    process.exit(1);
  }
  return { url: positional[0], outputDir: resolve(positional[1]) };
}

function main() {
  const { url, outputDir } = parseArgs(process.argv);

  try {
    execFileSync('playwright-cli', ['--version'], EXEC_OPTS);
  } catch {
    console.error(
      'playwright-cli not found.'
      + ' Install with: npm install -g @playwright/cli@latest',
    );
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  const steps = [];
  const allNetworkLines = [];
  let firstSuccess = null;

  for (const stepDef of STEPS) {
    log(`Probing with ${stepDef.name} config...`);
    const { step, networkLines } = runStep(url, stepDef);
    steps.push(step);
    allNetworkLines.push(...networkLines);

    log(
      `  ${stepDef.name}: ${step.result}`
      + ` (${step.health.title || 'no title'}, ${step.durationMs}ms)`,
    );

    if (step.result === 'success') {
      firstSuccess = stepDef.name;
      break;
    }
  }

  const lastHealth = steps[steps.length - 1].health;
  const detectedSignals = detectSignals(allNetworkLines, lastHealth);

  const report = {
    url,
    timestamp: new Date().toISOString(),
    steps,
    firstSuccess,
    detectedSignals,
  };

  const reportPath = `${outputDir}/probe-report.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`Wrote ${reportPath}`);
}

// Only run main when executed directly (not imported by tests)
const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(
    new URL(import.meta.url).pathname,
  );
if (isMain) main();
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/browser-probe/browser-probe.test.js`
Expected: All tests PASS (11 total)

- [ ] **Step 5: Commit**

```bash
git add skills/browser-probe/scripts/browser-probe.js \
  tests/browser-probe/browser-probe.test.js
git commit -m "feat(browser-probe): implement escalation ladder and main"
```

---

### Task 4: Create SKILL.md

**Files:**
- Create: `skills/browser-probe/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: browser-probe
description: >-
  Probe a URL with escalating headless browser configurations to detect CDN bot
  protection (Akamai, Cloudflare, DataDome, AWS WAF) and produce a
  browser-recipe.json that downstream playwright-cli consumers use to bypass
  blocking. Runs an automated escalation ladder: default headless → stealth
  script injection → system Chrome (TLS fingerprint fix) → persistent profile.
  Use BEFORE any playwright-cli interaction with an untrusted domain. Triggers
  on: browser probe, site blocked, headless blocked, CDN blocking, bot
  detection, browser recipe, can't load page, 403 error page, access denied.
---

# Browser Probe

Detect CDN bot protection blocking headless Chrome and produce a browser recipe
for downstream `playwright-cli` consumers. Node 22+ required. No npm
dependencies.

## When to Use

Run this skill **before** any `playwright-cli` interaction with a domain you
haven't tested, or when a downstream script reports a blocked page. Common
triggers:

- First interaction with a new domain
- `capture-snapshot.js` produces empty/error snapshots
- Page title contains "error", "denied", "blocked", "captcha"
- HTTP 403 responses from headless browser

## Script Location

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  PROBE_DIR="${CLAUDE_SKILL_DIR}/scripts"
else
  PROBE_DIR="$(dirname "$(command -v browser-probe.js 2>/dev/null || \
    find ~/.claude -path "*/browser-probe/scripts/browser-probe.js" \
    -type f 2>/dev/null | head -1)")"
fi
```

## Workflow

### Step 1 — Run the probe

```bash
node "$PROBE_DIR/browser-probe.js" "$URL" "$OUTPUT_DIR"
```

The script tries up to 4 browser configurations, stopping at the first success:

1. **default** — headless Chromium (baseline)
2. **stealth** — headless Chromium + stealth init script (patches `navigator.webdriver`, plugins, languages)
3. **chrome** — system Chrome (`--browser=chrome`) + stealth (fixes TLS fingerprint detection)
4. **persistent** — system Chrome + stealth + persistent profile (cookie/session challenges)

Output: `$OUTPUT_DIR/probe-report.json`

### Step 2 — Read the report

Load `probe-report.json`. Check `firstSuccess`:
- If non-null: a configuration worked. Proceed to Step 3.
- If null: all configurations failed. Skip to Step 5.

### Step 3 — Interpret results

Load [stealth-config.md](references/stealth-config.md) and match the
`detectedSignals` array against the Provider Signature Table.

Key interpretation rules:
- `akamai-server` or `akamai-bot-manager` → TLS fingerprint blocking.
  System Chrome is the fix. Stealth script alone is insufficient.
- `cloudflare-ray` without `cloudflare-challenge` → Cloudflare present
  but not actively blocking. Default config may work.
- `cloudflare-challenge` → Active JS challenge. System Chrome + stealth
  usually resolves it.
- `datadome` → Aggressive detection. System Chrome + stealth required.
- `aws-waf` → Usually UA-based. Stealth script often sufficient.
- No signals + blocked → Unknown protection. Persistent profile is last
  resort.

### Step 4 — Generate recipe

Write `browser-recipe.json` to `$OUTPUT_DIR`:

```json
{
  "url": "<probed URL>",
  "generated": "<ISO timestamp>",
  "cliConfig": {
    "browser": {
      "browserName": "chromium",
      "launchOptions": { "channel": "<from firstSuccess step>" }
    }
  },
  "stealthInitScript": "<full script from stealth-config.md if stealth was needed>",
  "notes": "<1-2 sentence explanation of what was detected and why this config>"
}
```

**Config mapping from `firstSuccess`:**

| firstSuccess | cliConfig.launchOptions | stealthInitScript |
|---|---|---|
| `default` | `{}` (no channel) | `null` (not needed) |
| `stealth` | `{}` (no channel) | Full stealth script from reference |
| `chrome` | `{ "channel": "chrome" }` | Full stealth script from reference |
| `persistent` | `{ "channel": "chrome" }` | Full stealth script from reference |

If `firstSuccess` is `persistent`, add a `"persistent": true` field to the
recipe so consumers know to use `--persistent`.

### Step 5 — Report results

**If a configuration worked:**
```
Browser probe complete for <url>.
  Working config: <firstSuccess>
  Detected: <detectedSignals or "no bot protection detected">
  Recipe: <path to browser-recipe.json>
```

**If all configurations failed:**
```
Browser probe failed for <url>. No headless configuration could load the page.
  Tried: default, stealth, chrome, persistent
  Detected signals: <detectedSignals>

  Options:
  1. Use --headed flag for manual browser interaction
  2. Provide pre-captured data (DOM snapshot, screenshots) manually
  3. Check if the URL requires authentication or VPN access
```

Do NOT produce a recipe when all steps fail. Do NOT silently continue
with a broken configuration.

## How Consumers Use the Recipe

Any script using `playwright-cli` can consume `browser-recipe.json`:

1. Write `cliConfig` to a temp file (e.g., `/tmp/probe-cli-config.json`)
2. Pass `--config=/tmp/probe-cli-config.json` to `playwright-cli open`
3. After `open` (before `goto`), inject `stealthInitScript` via
   `playwright-cli eval "<script>"`
4. Proceed with normal `goto <url>` and workflow

If recipe has `"persistent": true`, also pass `--persistent` to `open`.
```

- [ ] **Step 2: Verify SKILL.md is under 500 lines**

Run: `wc -l skills/browser-probe/SKILL.md`
Expected: under 500 lines

- [ ] **Step 3: Commit**

```bash
git add skills/browser-probe/SKILL.md
git commit -m "feat(browser-probe): add SKILL.md orchestration prompt"
```

---

### Task 5: Register skill in manifests and docs

Follow the standard skill registration checklist from `.claude/rules/adding-skills.md`.

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Import into tessl**

```bash
tessl skill import --workspace catalan-adobe --public skills/browser-probe
```

- [ ] **Step 2: Lint**

```bash
tessl skill lint skills/browser-probe
```

Expected: zero warnings. If orphaned file warnings appear, fix markdown link syntax in SKILL.md.

- [ ] **Step 3: Update plugin.json**

Add `browser-probe` to the description string and keywords array. Read the current file first to find the exact insertion points.

- [ ] **Step 4: Update marketplace.json**

Add `browser-probe` to both description fields. Read the current file first.

- [ ] **Step 5: Update CLAUDE.md skills table**

Add row:
```markdown
| `browser-probe` | Detect CDN bot protection and produce browser recipes for playwright-cli |
```

- [ ] **Step 6: Update README.md**

Add a `### browser-probe` section under "Available Skills" with description and link to SKILL.md.

- [ ] **Step 7: Sync locally**

```bash
./scripts/sync-skills.sh
```

- [ ] **Step 8: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json \
  .claude/CLAUDE.md README.md
git commit -m "feat(browser-probe): register in manifests and docs"
```

---

### Task 6: Live test against real sites

Test the probe against a known-blocking site and a known-clean site.

**Files:**
- No file changes — this is a validation task

- [ ] **Step 1: Test against adobe.com (should pass at step 1)**

```bash
mkdir -p /tmp/probe-test-adobe
node skills/browser-probe/scripts/browser-probe.js \
  https://www.adobe.com /tmp/probe-test-adobe
```

Verify: `firstSuccess` is `"default"`, only 1 step in `steps` array.

- [ ] **Step 2: Read and verify report structure**

Read `/tmp/probe-test-adobe/probe-report.json` and confirm all fields match the spec: `url`, `timestamp`, `steps[]` with `name/config/result/health/durationMs`, `firstSuccess`, `detectedSignals`.

- [ ] **Step 3: Test against astrazeneca.com (should escalate)**

```bash
mkdir -p /tmp/probe-test-az
node skills/browser-probe/scripts/browser-probe.js \
  https://www.astrazeneca.com /tmp/probe-test-az
```

Verify: `firstSuccess` is `"chrome"` or `"persistent"` (not `"default"`). Multiple steps in `steps` array. `detectedSignals` contains Akamai-related signals.

- [ ] **Step 4: Verify session cleanup**

```bash
playwright-cli list
```

Verify: no `probe-*` sessions remain.

- [ ] **Step 5: Fix any issues found during live testing**

If tests reveal problems (wrong health check thresholds, session cleanup failures, `playwright-cli` output parsing issues), fix them and re-run. Commit fixes separately:

```bash
git commit -m "fix(browser-probe): <describe fix>"
```

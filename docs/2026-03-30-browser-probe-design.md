# browser-probe Skill Design

**Date:** 2026-03-30
**Issue:** catalan-adobe/skills#37 (companion skill)
**Status:** Draft

## Problem

Scripts that use `playwright-cli` to load web pages in headless mode fail silently on sites with CDN-level bot protection (Akamai, Cloudflare, DataDome, etc.). Headless Chrome is fingerprinted via `navigator.webdriver`, TLS signatures (JA3/JA4), missing browser plugins, and other signals. There is no standard way to detect this failure or recover from it.

During the AstraZeneca header migration, headless `playwright-cli` returned an error page from Akamai's CDN. The downstream `capture-snapshot.js` produced a `snapshot.json` with null DOM data and screenshots of an error page — with no indication anything went wrong.

## Prior Art

- **domain-probe-worker** (Cloudflare Worker, aemcoder repo) — HTTP probe with 4 UA variants, browser probe, 10 CDN provider fingerprints, severity scoring. Deployed on Cloudflare with Puppeteer.
- **domain-probe skill** (vibemigration repo) — Port of the worker to a Claude Code skill with `http-probe.js`, `robots-probe.js`, `detect.js`. Merged via PR #74.
- **Stealth configuration** (vectorize/scraper project) — Tested against business.adobe.com (Akamai). Found that Akamai uses TLS fingerprinting; Playwright's bundled Chromium is blocklisted. Fix: `channel: 'chrome'` (system Chrome) + stealth headers + navigator.webdriver patching.

## Approach

**Script for detection, SKILL.md for interpretation.** A `browser-probe.js` script handles the mechanical work — runs an escalation ladder of browser configurations and outputs a structured diagnostic report. The SKILL.md teaches agents how to invoke the script, interpret the report using a knowledge base of CDN provider signatures, and generate a browser recipe.

## Skill Structure

```
skills/browser-probe/
  SKILL.md                        Orchestration prompt
  scripts/browser-probe.js        Escalation ladder + diagnostic report
  references/stealth-config.md    Stealth scripts, headers, provider signatures
```

## The Probe Script

### Input

```bash
node browser-probe.js <url> <output-dir>
```

### Escalation Ladder

Four steps, each in its own `playwright-cli` session, stopping at the first success:

| Step | Session name | Config | What it tests |
|------|-------------|--------|---------------|
| 1 | `probe-default` | Default headless Chromium | Baseline — does the site work at all? |
| 2 | `probe-stealth` | Default headless + stealth init script | JS-level detection (webdriver, plugins) |
| 3 | `probe-chrome` | System Chrome (`--browser=chrome`) + stealth | TLS fingerprint detection (Akamai, CloudFront) |
| 4 | `probe-persistent` | System Chrome + stealth + `--persistent` | Cookie/session-based challenges |

### Navigation Sequence

For steps without stealth (step 1):
```
playwright-cli -s=<session> open <url>
```

For steps with stealth (steps 2-4):
```
playwright-cli -s=<session> open                    # launch browser, no navigation
playwright-cli -s=<session> eval "<stealth-script>"  # inject before any page load
playwright-cli -s=<session> goto <url>               # navigate with stealth active
```

`playwright-cli open <url>` navigates immediately, so stealth must be injected between `open` (no URL) and `goto`.

### Health Check

Run after page load at each step via `eval`:

```js
{
  title: document.title,
  url: location.href,
  bodyLength: document.body.innerText.length,
  status: performance.getEntriesByType('navigation')[0]?.responseStatus,
  hasMainContent: !!document.querySelector('main, [role="main"], article, #content')
}
```

Plus title/body pattern matching for known error signatures:

```
/error|denied|blocked|not satisfied|403|captcha|challenge|attention required/i
```

### Output: `probe-report.json`

```json
{
  "url": "https://www.astrazeneca.com",
  "timestamp": "2026-03-30T...",
  "steps": [
    {
      "name": "default",
      "config": { "browser": "chromium", "stealth": false, "persistent": false },
      "result": "blocked",
      "health": {
        "title": "ERROR: The request could not be satisfied",
        "bodyLength": 42,
        "status": 403,
        "hasMainContent": false
      },
      "durationMs": 2340
    },
    {
      "name": "stealth",
      "config": { "browser": "chromium", "stealth": true, "persistent": false },
      "result": "blocked",
      "health": { "...": "..." },
      "durationMs": 2100
    },
    {
      "name": "chrome",
      "config": { "browser": "chrome", "stealth": true, "persistent": false },
      "result": "success",
      "health": {
        "title": "AstraZeneca | Pushing the boundaries...",
        "bodyLength": 12840,
        "status": 200,
        "hasMainContent": true
      },
      "durationMs": 3200
    }
  ],
  "firstSuccess": "chrome",
  "detectedSignals": ["akamai-header", "tls-fingerprint-block"]
}
```

The script reports symptoms, not remedies. `detectedSignals` are gathered from two sources:
- **Response headers** — captured via `playwright-cli network` after page load (looks for `server`, `cf-ray`, `x-datadome`, `x-amzn-waf-action`, `set-cookie` with known bot-manager cookie names like `bm_sz`)
- **Page content patterns** — from the health check (error page titles, challenge page markers in body text)

These clues help the SKILL.md reason about which provider is blocking.

**Early termination:** Once a step succeeds, remaining steps are skipped. Sessions are always cleaned up (`close`) even on failure.

## SKILL.md Orchestration

### Workflow

1. **Run the probe** — `node $SKILL_HOME/scripts/browser-probe.js <url> <output-dir>`
2. **Read the report** — load `probe-report.json`, check `firstSuccess`
3. **Interpret results** — load `references/stealth-config.md`, match `detectedSignals` to known provider patterns
4. **Generate recipe** — write `browser-recipe.json` with `cliConfig`, `stealthInitScript`, and human-readable `notes`
5. **Report to caller** — summarize findings and recipe location

### When All Steps Fail

The SKILL.md instructs the agent to report clearly that the site cannot be loaded in headless mode with available configurations, listing what was tried. No silent failure, no garbage output. It may suggest the user try `--headed` as a manual escape hatch or provide pre-captured data.

## Recipe Output Format: `browser-recipe.json`

```json
{
  "url": "https://www.astrazeneca.com",
  "generated": "2026-03-30T...",
  "cliConfig": {
    "browser": {
      "browserName": "chromium",
      "launchOptions": { "channel": "chrome" }
    }
  },
  "stealthInitScript": "Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); ...",
  "notes": "Akamai TLS fingerprinting detected. System Chrome required."
}
```

- `cliConfig` — valid `playwright-cli` config. Consumers write it to a temp file and pass `--config=<temp>`.
- `stealthInitScript` — JS to inject via `eval` after `open` but before navigating to the target URL.
- `notes` — human-readable explanation for logs and agent context.

## Reference: `stealth-config.md`

Contains three sections:

### Stealth Init Script

The JS payload that patches `navigator.webdriver`, `navigator.plugins`, `navigator.languages`, and adds `window.chrome.runtime`. Ported from the vectorize/scraper project's tested implementation.

### Stealth HTTP Headers

`Sec-Ch-Ua`, `Sec-Fetch-*`, and other headers that mimic a real Chrome session. Currently not injectable via `playwright-cli` (no `extraHTTPHeaders` support), documented for future use.

### Provider Signature Table

Maps observable signals to CDN providers and typical fixes:

| Signal | Provider | Typical fix |
|--------|----------|-------------|
| `server: AkamaiGHost`, `bm_sz` cookie | Akamai | System Chrome (TLS fingerprint) |
| `cf-ray` header, "Just a moment" title | Cloudflare | Stealth script often sufficient |
| `x-datadome` header | DataDome | System Chrome + stealth |
| `x-amzn-waf-action` header | AWS WAF | Usually UA-based, stealth sufficient |
| Generic 403 + empty body | Unknown | Escalate to persistent profile |

## Integration with Downstream Consumers

The browser recipe is a generic contract. Any script using `playwright-cli` can consume it:

1. Read `browser-recipe.json`
2. Write `cliConfig` to a temp file, pass `--config=<temp>` to `playwright-cli` commands
3. After `open` (before `goto`), inject `stealthInitScript` via `eval`
4. Proceed with normal workflow

### Orchestration Flow (migrate-header example)

```
1. Run browser-probe on URL        → produces browser-recipe.json
2. Run page-prep overlay detection  → uses browser-recipe.json
                                    → produces overlay-recipe.json
3. Run capture-snapshot.js          → uses browser-recipe.json + overlay-recipe.json
```

The browser recipe is the foundation — produced first, passed to every subsequent `playwright-cli` interaction with that domain. Both recipes are optional; sites that work in default headless with no overlays skip both steps.

### Changes Required (issue #37, separate work)

- `capture-snapshot.js` — add `--browser-recipe` flag, failure detection, clear error reporting
- `migrate-header/SKILL.md` — update Stage 5 to run browser-probe before capture
- `page-prep` — accept browser recipe for overlay detection sessions

## Testing

- Test against a site that blocks headless (e.g., astrazeneca.com) — probe should escalate and find a working config
- Test against a site that works in default headless (e.g., adobe.com) — should succeed at step 1, skip remaining steps
- Test with system Chrome not installed — step 3 should fail gracefully and report the issue
- Verify recipe consumption: write recipe, pass to `playwright-cli --config=...`, confirm page loads
- Verify clean session cleanup on failure at every step

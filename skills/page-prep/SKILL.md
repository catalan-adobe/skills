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

# Page Prep

Detect and remove overlays (cookie banners, GDPR consent, modals, paywalls,
login walls) before screenshots, scraping, or browser automation.
Node 22+ required. No npm dependencies.

## Script Location

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  PAGE_PREP_DIR="${CLAUDE_SKILL_DIR}/scripts"
else
  PAGE_PREP_DIR="$(dirname "$(command -v overlay-db.js 2>/dev/null || \
    find ~/.claude -path "*/page-prep/scripts/overlay-db.js" -type f 2>/dev/null | head -1)")"
fi
```

Store in `PAGE_PREP_DIR` and prefix all commands below with
`node "$PAGE_PREP_DIR/overlay-db.js"`.

## Quick Start

```bash
# 1. Refresh the CMP database (skips if cache is fresh)
node "$PAGE_PREP_DIR/overlay-db.js" refresh

# 2. Bundle + inject the detection script into the active page
BUNDLE="$(node "$PAGE_PREP_DIR/overlay-db.js" bundle)"
# Inject via your browser tool (see Browser Tool Examples below)

# 3. Read the detection report, produce and execute recipes

# 4. Take a snapshot — if anything still blocks the page, remove it manually
#    (the script handles known patterns; the agent handles the rest)
```

## Detailed Workflow

### Step 1 — Locate scripts

Resolve `PAGE_PREP_DIR` using the block above. Verify the path is non-empty
before continuing.

### Step 2 — Refresh the database

```bash
node "$PAGE_PREP_DIR/overlay-db.js" refresh
```

Downloads and merges Consent-O-Matic rules + EasyList cookie filters into a
local cache (`~/.cache/page-prep/`). Skips network fetch if cache is less than
7 days old. Run with `--force` to bypass the age check.

### Step 3 — Bundle the injectable script

```bash
BUNDLE="$(node "$PAGE_PREP_DIR/overlay-db.js" bundle)"
```

Captures a self-contained JS string (no imports, no external deps) to stdout.
The bundled script embeds the full CMP database and heuristic scanner.

### Step 4 — Inject via browser tool

Evaluate `$BUNDLE` in the active page using whichever browser tool is in use
(see Browser Tool Examples). The script runs synchronously and returns a
detection report.

### Step 5 — Read the detection report

The injection return value is a JSON detection report. Parse it to enumerate
detected overlays. Each overlay has a `source` field: `"cmp-match"` (database
match) or `"heuristic"` (DOM scan).

### Step 6 — Resolve dismiss strategy per overlay

- **cmp-match** (`source: "cmp-match"`): the report includes a complete `dismiss`
  recipe with ordered steps. Use it directly.
- **heuristic** (`source: "heuristic"`, `dismiss: null`): compose a dismiss
  sequence yourself — try Escape key, then close buttons, then element removal
  (see Agent Fallback).

### Step 7 — Produce a recipe manifest

Combine hide and dismiss recipes for all detected overlays into a single
manifest (see Recipe Manifest Format). Include the global `scroll_fix` if
`scroll_locked` is true.

### Step 8 — Execute the recipe

- **Visual cleanup** (fast): batch-evaluate the `hide.js` block in one
  `browser_evaluate` call. Hides all overlays and restores scroll.
- **Interactive dismiss** (thorough): execute each `dismiss.steps` entry
  sequentially using the browser tool's click/key primitives. Use this when
  the site requires a real consent signal (analytics, A/B tests).

### Step 9 — Verify the page is clean

Take a snapshot (accessibility tree or screenshot) and inspect the result.
The detection script catches known CMPs and common heuristic patterns, but
it will miss overlays that don't fit those signals — third-party login
prompts (Google One Tap, Apple Sign In), custom-built modals, iframes with
their own UI, or elements injected after the initial scan.

If the page still has something blocking content or interaction:

1. Identify the element from the snapshot (look for `position: fixed`,
   high `z-index`, iframes, or modal-like structure).
2. Compose a removal recipe: `document.querySelector('<selector>')?.remove()`
   or click a dismiss button if one exists.
3. Apply and re-verify.

Repeat until the page is clean. This verification loop is the agent's value
over the heuristic script alone — the script handles the 80% of known
patterns fast, the agent handles the 20% that requires judgment.

### Step 10 — Optionally inject watch mode

For multi-step sessions where new overlays may appear (SPAs, lazy-loaded
banners), inject the watch mode snippet after cleanup (see Watch Mode).

## Browser Tool Examples

### Playwright MCP

```js
// Inject and capture report
const report = await browser_evaluate({
  expression: BUNDLE  // the string captured from `bundle`
});
```

### CDP connect

```bash
node "$CDP_JS" eval "$(node "$PAGE_PREP_DIR/overlay-db.js" bundle)"
```

### cmux-browser

```bash
cmux browser --surface <ref> eval "$(node "$PAGE_PREP_DIR/overlay-db.js" bundle)"
```

## Detection Report Format

```jsonc
{
  "overlays": [
    {
      "id": "overlay-0",
      "type": "cookie-consent",
      "source": "cmp-match",       // "cmp-match" | "heuristic"
      "cmp": "cookiebot",          // CMP name (only for cmp-match)
      "selector": "#CybotCookiebotDialog",
      "confidence": 1.0,
      "hide": ["#CybotCookiebotDialog { display:none!important }"],
      "dismiss": [{ "action": "click", "selector": "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" }]
    },
    {
      "id": "overlay-1",
      "type": "unknown-modal",
      "source": "heuristic",
      "selector": "div.gdpr-wall",
      "confidence": 0.45,
      "signals": ["high-z-index", "keyword-match", "scroll-lock-boost"],
      "hide": ["div.gdpr-wall { display:none!important }"],
      "dismiss": null               // agent composes dismiss (see Agent Fallback)
    }
  ],
  "scroll_locked": true,
  "scroll_fix": "html,body { overflow:auto!important; height:auto!important }"
}
```

## Recipe Manifest Format

```jsonc
{
  "overlays": [
    {
      "id": "cookiebot",
      "hide": {
        "css": ["#CybotCookiebotDialog { display: none !important; }"],
        "js": "document.querySelector('#CybotCookiebotDialog')?.remove()"
      },
      "dismiss": {
        "steps": [
          { "action": "click", "selector": "#CybotCookiebotDialogBodyButtonAccept" }
        ],
        "js": "/* composed from steps */"
      }
    }
  ],
  "scroll_fix": "document.body.style.overflow=''"
}
```

## Agent Fallback (heuristic detections with null dismiss)

When `dismiss` is null, attempt in order:

1. **Escape key** — press Escape; check if overlay is gone.
2. **Close buttons** — click the first matching:
   `[aria-label*="close" i]`, `[aria-label*="dismiss" i]`, `.close`,
   `button:has(svg)`, `button[class*="close"]`.
3. **Element removal** — evaluate `document.querySelector('<selector>')?.remove()`.

Consult `references/known-patterns.md` for CMP-specific dismiss patterns when
the above three steps fail.

## Watch Mode

Inject after cleanup for pages that load overlays dynamically.

```js
window.__pagePrep = (() => {
  let timer = null;
  let pending = [];
  const MODE = 'hide'; // 'hide' | 'dismiss'

  function scan() {
    // Re-run heuristic scanner on current DOM
    const found = window.__pagePrepScan?.() ?? [];
    if (found.length === 0) return;

    if (MODE === 'hide') {
      found.forEach(o => {
        const el = document.querySelector(o.selector);
        if (el) el.style.display = 'none';
      });
    } else {
      // 'dismiss' mode — queue for agent
      found.forEach(o => {
        if (!pending.find(p => p.id === o.id)) pending.push(o);
      });
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 500);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  return {
    watch: () => observer.observe(document.body, { childList: true, subtree: true }),
    stop:  () => { observer.disconnect(); clearTimeout(timer); },
    pending: () => [...pending],
  };
})();
```

- **hide mode** (default): auto-removes newly detected overlays.
- **dismiss mode**: queues detected overlays in `window.__pagePrep.pending()`
  for the agent to process interactively.
- Call `window.__pagePrep.stop()` when the session is done.

## Tips

- Run `refresh --force` if detection misses a known CMP — the database may be stale.
- Run `node "$PAGE_PREP_DIR/overlay-db.js" status` to check cache age and entry count.
- Run `node "$PAGE_PREP_DIR/overlay-db.js" lookup <cmp-name>` to check if a CMP is in
  the database before injecting.
- Visual cleanup (hide) is faster — one evaluate call, no sequencing needed.
- Interactive dismiss is more thorough — use it when a real consent signal matters.
- Watch mode is only needed for multi-step sessions on SPAs or pages with lazy banners.

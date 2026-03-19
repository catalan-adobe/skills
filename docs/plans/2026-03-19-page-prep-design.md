# page-prep: Webpage Overlay Detection & Removal Skill

## Purpose

Detect and remove disruptive webpage overlays (cookie banners, modals, popups, paywalls, newsletter signups, GDPR consent, login walls) to get pages into a clean, interactive state. Produces portable recipes that any browser interaction layer can execute.

## Architecture

Two Node.js scripts with an orchestrating SKILL.md prompt.

```
SKILL.md (orchestration)
  |
  +-- overlay-db.js    (host-side: fetch/cache/normalize pattern databases)
  +-- overlay-detect.js (browser-injectable: scan DOM, return detection report)
```

### Data Flow

1. `node overlay-db.js refresh` downloads Consent-O-Matic rules + EasyList Cookie selectors, normalizes into `~/.cache/page-prep/patterns.json`
2. `node overlay-db.js bundle` reads `patterns.json` and `overlay-detect.js`, outputs a self-contained JS string with patterns embedded -- ready for browser injection
3. Agent injects the bundled script via whatever browser tool is available
4. `overlay-detect.js` runs in browser context, returns a detection report JSON
5. SKILL.md instructs the agent to generate a recipe manifest from the report
6. Agent executes recipes via whatever browser tool is available, or returns the manifest to the user

The agent never reads `patterns.json` directly. The `bundle` command handles composition so the full database (potentially hundreds of KB) stays out of the agent's context window.

### File Structure

```
skills/page-prep/
  SKILL.md
  scripts/
    overlay-db.js
    overlay-detect.js
  references/
    known-patterns.md
```

## Database Layer (`overlay-db.js`)

Host-side Node.js script. Zero dependencies beyond Node 22 built-in `fetch`.

### Subcommands

```bash
node overlay-db.js refresh [--force]   # Fetch/update, skip if fresh (unless --force)
node overlay-db.js status              # Cache age, pattern count, sources
node overlay-db.js lookup <cmp-name>   # Check if a CMP is in the database
node overlay-db.js bundle              # Compose injectable script with embedded patterns
```

### Sources

1. **Consent-O-Matic** (github.com/cavi-au/Consent-O-Matic) -- fetches the monolithic `Rules.json` from the repository root (44+ CMPs). Each rule has `detectors` (with `presentMatcher`/`showingMatcher` as single objects or arrays) and `methods` (HIDE_CMP, DO_CONSENT, SAVE_CONSENT).
2. **EasyList Cookie** (github.com/easylist/easylist) -- `easylist_cookie/easylist_cookie_general_hide.txt` only (cosmetic/element-hiding rules). The `_block.txt` file contains network-level rules and is not used.

### Consent-O-Matic Normalization

The raw Consent-O-Matic format uses nested matcher objects:

```json
{
  "presentMatcher": {
    "type": "css",
    "target": { "selector": "#onetrust-consent-sdk" },
    "displayFilter": true
  }
}
```

Normalization rules:
- Iterate the `presentMatcher` array; for each entry with `type: "css"`, extract `.target.selector` into `detect` array. Same for `showingMatcher`.
- `displayFilter: true` -- record as metadata; at detection time, verify element is visible (`offsetParent !== null` or `getComputedStyle` check)
- `childFilter` -- convert to `:has(<child-selector>)` where supported; drop where not (accept coverage loss)
- `textFilter` -- drop (cannot express in CSS selectors; accept coverage loss on ~5% of CMPs that rely on text matching)
- Document dropped matchers in `patterns.json` metadata so the agent knows which CMPs have partial coverage

### Normalized Schema (`patterns.json`)

```json
{
  "version": 1,
  "fetched_at": "2026-03-19T...",
  "sources": ["consent-o-matic", "easylist-cookie"],
  "stats": {
    "consent_o_matic_cmps": 313,
    "easylist_selectors": 1200,
    "partial_coverage_cmps": ["cmp-x", "cmp-y"]
  },
  "cmps": {
    "onetrust": {
      "detect": ["#onetrust-consent-sdk"],
      "detect_requires_visible": true,
      "hide": [
        "#onetrust-consent-sdk { display:none!important }",
        "#onetrust-banner-sdk { display:none!important }"
      ],
      "dismiss": [
        { "action": "click", "selector": "#onetrust-accept-btn-handler" },
        { "action": "wait", "ms": 300 }
      ]
    }
  },
  "generic_selectors": [
    "#cookie-banner",
    ".cookie-consent",
    "[class*='gdpr']"
  ]
}
```

Note: `hide` is always an array (CMPs often have multiple elements to hide). `generic_selectors` are capped at ~1000 entries -- the most commonly referenced selectors from EasyList. Site-specific EasyList rules are dropped (they target individual domains, not generic patterns).

### Cache

- Location: `~/.cache/page-prep/`
- Files: `patterns.json`, `last-fetch` (timestamp)
- Staleness: refresh if >7 days old
- `--force` bypasses staleness check

### Error Handling

Partial success is acceptable:
- If one source fails, use cached data for that source and warn on stderr
- If both fail and cache exists (even stale), use stale cache with a warning
- If both fail and no cache exists, exit with error code 1 and message: "No pattern database available. Check network connectivity and retry with --force."

### ABP Filter Parsing

Extract cosmetic filter rules (`##` syntax) from `easylist_cookie_general_hide.txt` into plain CSS selectors. Domain-specific rules (e.g., `example.com##.banner`) are dropped -- only generic rules (no domain prefix) are kept. This caps the selector count to ~1000 generic patterns.

## Detection Script (`overlay-detect.js`)

Browser-injectable script. Receives patterns embedded at bundle time (not passed by the agent). Scans the live DOM, returns a structured detection report.

### Input

Patterns are embedded by `overlay-db.js bundle` which prepends `const PATTERNS = <patterns.json content>;` to the detection script. The agent injects the bundled output, not the raw script.

### Output (Detection Report)

```json
{
  "overlays": [
    {
      "id": "overlay-0",
      "type": "cookie-consent",
      "source": "cmp-match",
      "cmp": "onetrust",
      "selector": "#onetrust-consent-sdk",
      "confidence": 1.0,
      "hide": [
        "#onetrust-consent-sdk { display:none!important }",
        "#onetrust-banner-sdk { display:none!important }"
      ],
      "dismiss": [
        { "action": "click", "selector": "#onetrust-accept-btn-handler" },
        { "action": "wait", "ms": 300 }
      ]
    },
    {
      "id": "overlay-1",
      "type": "unknown-modal",
      "source": "heuristic",
      "selector": "div.modal-backdrop",
      "confidence": 0.75,
      "signals": ["fixed-position", "viewport-cover", "high-z-index", "has-backdrop"],
      "hide": ["div.modal-backdrop { display:none!important }"],
      "dismiss": null
    }
  ],
  "scroll_locked": true,
  "scroll_fix": "html,body { overflow:auto!important; height:auto!important }"
}
```

Note: `hide` is always an array.

### Detection Passes

**Pass 1 -- Known-pattern matching:** Iterate `cmps` entries, test each `detect` selector against the DOM. If `detect_requires_visible` is true, also verify the matched element is visible (`el.offsetParent !== null || getComputedStyle(el).display !== 'none'`). If matched, the overlay gets full recipes from the database. `confidence: 1.0`.

**Pass 2 -- Heuristic scan:** For elements not caught by pass 1, scan all elements with `position: fixed` or `position: sticky` (via `querySelectorAll('*')` filtered by computed style), then score each against these signals:

| Signal | Weight | Check |
|--------|--------|-------|
| `high-z-index` | 0.15 | `z-index > 999` |
| `viewport-cover` | 0.25 | covers >50% of viewport area |
| `aria-modal` | 0.20 | `aria-modal="true"` or `role="dialog"` |
| `has-backdrop` | 0.15 | sibling/child with semi-transparent background covering viewport |
| `keyword-match` | 0.15 | id/class contains: `cookie`, `consent`, `gdpr`, `modal`, `popup`, `newsletter`, `subscribe`, `paywall` |
| `generic-selector-match` | 0.10 | matches one of the `generic_selectors` from EasyList |

`confidence = sum of matched signal weights`. Threshold: report overlay if confidence >= 0.30.

Generic selectors are tested efficiently: join into comma-separated groups of 50 and use `el.matches(selectorGroup)` rather than running `querySelectorAll` per selector.

**Pass 3 -- Scroll-lock detection:** Checks `overflow: hidden` on `html`/`body`, reports a CSS fix.

Heuristic-detected overlays get a `hide` recipe but `dismiss` is `null` -- the agent composes dismiss sequences for these.

### Shadow DOM Limitation

`document.querySelector()` cannot pierce shadow DOM boundaries. CMPs that render inside shadow roots are invisible to both detection passes. This is a known v1 limitation. The `references/known-patterns.md` file documents known shadow-DOM CMPs and manual traversal patterns (`element.shadowRoot.querySelector()`) for the agent to try as a fallback when no overlays are detected but the page is visibly blocked.

## Recipe Manifest

The final deliverable. Each overlay gets both a hide and dismiss recipe, each in both human-readable (CSS/steps) and injectable JS forms.

```json
{
  "url": "https://example.com",
  "generated_at": "2026-03-19T...",
  "recipes": [
    {
      "overlay_id": "overlay-0",
      "type": "cookie-consent",
      "cmp": "onetrust",
      "hide": {
        "css": [
          "#onetrust-consent-sdk { display:none!important }",
          "#onetrust-banner-sdk { display:none!important }"
        ],
        "js": "document.querySelectorAll('#onetrust-consent-sdk,#onetrust-banner-sdk').forEach(e=>e.remove());"
      },
      "dismiss": {
        "steps": [
          { "action": "click", "selector": "#onetrust-accept-btn-handler" },
          { "action": "wait", "ms": 300 },
          { "action": "verify", "selector": "#onetrust-consent-sdk", "absent": true }
        ],
        "js": "document.querySelector('#onetrust-accept-btn-handler')?.click();"
      }
    }
  ],
  "global": {
    "scroll_fix": {
      "css": "html,body { overflow:auto!important; height:auto!important }",
      "js": "document.documentElement.style.overflow='auto'; document.body.style.overflow='auto';"
    }
  }
}
```

### Recipe Formats

- `hide.css` / `hide.js` -- CSS rules (array) or element removal. Non-destructive for visual cleanup.
- `dismiss.steps` -- Interaction sequence (click, wait, press key, verify). Human-readable, tool-agnostic. Full sequence with verification.
- `dismiss.js` -- Best-effort one-shot snippet (click only, no wait/verify). For quick visual cleanup where full interaction isn't needed.
- `global.scroll_fix` -- Always applied alongside any recipe.

### Agent Compose Strategy (for heuristic detections)

When `dismiss` is `null`, the SKILL.md instructs the agent to:

1. Try Escape key first
2. Look for close buttons: `[aria-label*="close"]`, `.close`, `button:has(svg)` near the overlay
3. Fall back to element removal

### Execution Model

- **Visual cleanup** (screenshots): batch-inject all `hide.js` snippets + `scroll_fix.js` in one `evaluate()` call.
- **Interactive cleanup** (automation): execute `dismiss.steps` sequentially via browser tool, verify each, fall back to `hide.js` if dismiss fails.

## Watch Mode

For long-running automation sessions where overlays appear after initial cleanup.

### Mechanism

A separate injectable snippet that installs a `MutationObserver` on `document.body` with `{ childList: true, subtree: true }`. The observer is debounced at 500ms. When mutations settle, it filters new/changed elements for `position: fixed/sticky` (via `getComputedStyle`) and runs the two-pass detection against those elements only.

Using `subtree: true` is necessary because many overlays are injected by third-party scripts into nested DOM positions, not as direct children of body. The debounce and fixed/sticky pre-filter keep performance acceptable -- the observer fires on all mutations but only runs detection logic on the small subset of elements with overlay-like positioning.

### Behavior

- `mode: "hide"` -- auto-apply CSS hide immediately (no agent involvement)
- `mode: "dismiss"` -- apply hide as stopgap, mark elements with `data-overlay-cleanup-pending` for agent to poll and dismiss

### API (injected into page)

```js
window.__pagePrep.watch({ mode: 'hide' })   // start (patterns already embedded)
window.__pagePrep.stop()                     // stop
window.__pagePrep.pending()                  // check for new detections needing dismiss
```

### Scope Limits

- Debounced at 500ms to avoid firing on SPA/React render churn
- Only processes elements with `position: fixed` or `sticky` computed style
- No persistence across page navigations -- agent re-injects after navigation

### When to Use

SKILL.md defaults to scan mode. Watch mode only when the agent is doing multi-step automation on the same page or when the user explicitly asks.

## SKILL.md Orchestration

### Workflow

1. Locate scripts (`CLAUDE_SKILL_DIR` or fallback search)
2. Run `node overlay-db.js refresh` (fetches if stale, no-ops if fresh)
3. Run `node overlay-db.js bundle` to get the self-contained injectable script
4. Inject the bundled script into the page via available browser tool
5. Read detection report from return value
6. For each overlay:
   - `source=cmp-match` -- recipes complete from database
   - `source=heuristic` -- agent composes dismiss recipe
7. Produce recipe manifest
8. Execute based on goal (visual or interactive cleanup)
9. Optionally inject watch mode for multi-step sessions

### Browser Tool Agnosticism

The SKILL.md documents how to inject the detection script for each browser tool:
- Playwright MCP: `browser_evaluate` with the bundled script as expression
- CDP connect: `node cdp.js eval "$(node overlay-db.js bundle)" --id <target-id>` (command substitution keeps bundled content out of agent context; bundle output goes to stdout)
- cmux-browser: `cmux browser --surface <ref> eval "<bundled script>"` (discover surface via `cmux list-surfaces` first)

### Agent Fallback

For unknown overlays where heuristics fail, the agent consults `references/known-patterns.md` for common close button patterns, CMP-specific quirks, and shadow DOM traversal strategies.

## Dependencies

- Node 22+ (built-in `fetch`, native JSON)
- No npm packages
- Browser tool provided by the user's environment (Playwright, CDP, cmux-browser)

## Non-Goals

- Paywall content extraction (the skill removes the overlay, not the paywall enforcement)
- Ad blocking (different domain, handled by filter lists in ad blockers)
- Cookie preference management (the skill dismisses banners, it does not configure cookie preferences)
- Shadow DOM piercing in v1 (documented limitation with manual fallback guidance)

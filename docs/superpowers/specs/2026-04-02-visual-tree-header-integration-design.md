# Visual Tree Integration into Migrate Header

**Date:** 2026-04-02
**Status:** Approved
**Approach:** B (focused + polish loop enrichment)

## Summary

Integrate the `visual-tree` skill as a foundational early stage in the
`migrate-header` pipeline. Visual-tree captures a spatial hierarchy of
the source page, which then drives two capabilities that currently
require separate tools or user-provided flags: overlay detection and
header element identification. The visual-tree text format is also
passed to the polish loop for richer spatial context.

## Pipeline Change

```
Before: probe → overlay-detect → snapshot → extraction → scaffold → polish
After:  probe → VISUAL-TREE → OVERLAY-DISMISS → HEADER-DETECT → snapshot → extraction → scaffold → polish
```

Stages after visual-tree shift down. The visual-tree session stays open
through overlay dismissal and header detection to avoid redundant page
loads.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| When to run visual-tree | After domain probe, before everything else | Probe provides browser recipe; visual-tree provides spatial map for all downstream stages |
| minWidth parameter | 1024 | Captures full-width and near-full-width elements. Filters sidebars and partial-width content. Safe for sites using common max-width containers (1200px+). `position: fixed` elements bypass the filter regardless |
| Overlay detection method | Visual-tree structural detection (nodeMap overlay metadata) | Algorithmic — no CMP database needed. Catches custom overlays that page-prep's 300+ known patterns miss |
| Overlay dismissal method | LLM-guided | LLM receives visual-tree data (geometry, text hints, selectors), inspects each overlay, finds dismiss mechanism, executes it. More flexible than pattern matching |
| Header detection method | LLM-guided from visual-tree data | LLM reads spatial map and identifies the header node. Handles edge cases (announcement bars, brand bars, unusual layouts) better than deterministic heuristics |
| Header selector override | `--header-selector` flag skips LLM detection | Backward compatible escape hatch when inference gets it wrong |
| Extract-layout integration | None | Visual-tree lacks the DOM detail extract-layout needs (tag names, CSS classes, HTML attributes, SVG children, full text content). Different levels of abstraction — spatial summary vs semantic classification |
| Polish loop enrichment | Visual-tree text format injected into program.md | Low-effort, gives polish subagent a spatial vocabulary for reasoning about CSS adjustments |

## Stage 3: Visual Tree Capture

**Trigger:** Runs after domain probe (Stage 2b). New Stage 3.

**Flow:**

1. Build a playwright-cli config with `initScript` pointing to the
   visual-tree bundle file (and browser recipe if present)
2. Open a playwright-cli session (`-s=visual-tree`) with the config —
   the bundle is injected before navigation, creating
   `window.__visualTree`
3. Navigate to the source URL, wait for page load
4. Capture via pure expression eval:
   `JSON.stringify(window.__visualTree.captureVisualTree(1024))`
5. Parse the returned JSON
6. Save artifacts to `autoresearch/source/`:
   - `visual-tree.json` — full output (textFormat, data, nodeMap,
     rootBackground, rootBackgroundInfo)
   - `visual-tree.txt` — text format alone (LLM-readable reference)
   - `overlays.json` — overlay entries extracted from nodeMap (selector,
     occluding list, bounds, text)
7. Keep session open for overlay dismissal and header detection

**Parameters:**

| Parameter | Value | Notes |
|-----------|-------|-------|
| minWidth | 1024 | Filters elements narrower than 1024px. `position: fixed` elements bypass this filter and their descendants are walked with minWidth=0 |
| viewport | 1440x900 | Matches existing capture-snapshot.js viewport |

**Failure mode:** If the page fails to load or the eval returns empty,
log a warning and fall through. Downstream stages still work:
- Overlay detection falls back to page-prep if available
- Header detection falls back to `--header-selector` or `header` tag
  default

## Stage 4: Overlay Detection and Dismissal

**Replaces:** page-prep overlay detection (Stage 4 in current pipeline).
Page-prep is no longer a required dependency for overlay handling. It
remains a fallback if visual-tree capture fails.

### Detection (deterministic)

1. Read `overlays.json` from visual-tree capture
2. Overlay entries come from nodeMap — any node with `overlay.occluding`
   metadata was promoted to root by `promoteEscapedNodes` because it
   renders outside its DOM parent's bounds
3. If no overlay entries, skip to header detection

### Dismissal (LLM-guided)

4. Present the full visual-tree text format + overlay entries (selectors,
   text hints, geometry, occluding lists) to the LLM
5. For each overlay, the LLM:
   - Has the parent element's CSS selector from nodeMap
   - Can inspect the overlay's internals (query child buttons/links,
     take targeted screenshots, read ax-tree) to find the dismiss
     mechanism
   - Decides the action: click a specific button, or remove the element
6. LLM executes dismissals in the live playwright-cli session
7. Record every action as `overlay-recipe.json`:
   ```json
   [
     {"action": "click", "selector": "#onetrust-accept-btn"},
     {"action": "remove", "selector": ".promo-modal-backdrop"}
   ]
   ```

### Downstream replay

Existing `--overlay-recipe` consumption is unchanged. Every downstream
stage that opens a new session replays the recipe to clear overlays
before its work.

### Fallbacks

- `--overlay-recipe` flag provided → skip detection + dismissal entirely,
  use user's recipe
- Visual-tree capture failed → fall back to page-prep if available, or
  proceed with no overlay handling
- LLM cannot determine dismissal strategy → record
  `{"action": "remove", "selector": "..."}` as brute-force fallback

### Session management

The playwright-cli session from visual-tree capture stays open. After
overlays are dismissed, the page is clean for header detection. No extra
page load needed.

## Stage 5: Header Element Detection

**Replaces:** The need for `--header-selector` to be provided or guessed.
The flag becomes an optional override.

### Flow

1. Present the visual-tree text format to the LLM (overlays already
   identified in the previous step)
2. LLM identifies the header node using geometry, ARIA roles, text
   hints, grid layouts, and contextual reasoning
3. Extract the CSS selector from nodeMap for the identified node
4. Save to `autoresearch/source/header-detection.json`:
   ```json
   {
     "selector": "header.site-header",
     "nodeId": "rc2",
     "bounds": {"x": 0, "y": 40, "width": 1440, "height": 80}
   }
   ```
5. This selector feeds into `capture-snapshot.js` as the
   `--header-selector` value
6. Close the playwright-cli session (visual-tree session has served
   its purpose)

### Override

If `--header-selector` was passed by the user, skip LLM detection
entirely. Use the user's value. Log a note of what visual-tree detected
for reference.

### Failure fallback

If the LLM cannot confidently identify the header, fall back to
`header` tag default and log a warning.

## Polish Loop Enrichment

**Scope:** Small template change in `setup-polish-loop.js` and
`program.md.tmpl`.

### Flow

1. `setup-polish-loop.js` reads `autoresearch/source/visual-tree.txt`
2. Injects contents as a `{{VISUAL_TREE}}` template replacement into
   `program.md.tmpl`
3. The polish loop subagent receives the spatial outline alongside
   `desktop.png`, `layout.json`, and `nav-structure.json`

### Value

The text format gives the subagent compact spatial context:

```
rc1 [bg:color] @0,0 1440x40 "Free shipping on orders..."
rc2 [3x1] @0,40 1440x80 "Products Solutions Resourc..."
  rc2c1 @120,40 120x80
  rc2c2 [5x1] @300,40 800x80
  rc2c3 @1350,40 90x80
```

This helps the subagent reason about target dimensions and spatial
layout when adjusting CSS ("rc2 is 80px tall — my header should match
that height").

## What Does NOT Change

- `capture-snapshot.js` — still captures DOM tree, nav items, and
  screenshots. Receives header selector as input (now from visual-tree
  detection instead of user flag)
- `extract-layout.js` — still classifies elements semantically (logo,
  nav-links, search, icons, CTA). Visual-tree data is too coarse for
  this (lacks tag names, CSS classes, HTML attributes, SVG children)
- `extract-styles.js` — still queries computed CSS via CDP session
- `css-query.js` — unchanged
- `overlay-recipe.json` format — unchanged, downstream replay is
  compatible
- `--overlay-recipe` flag — still accepted, bypasses detection
- `--header-selector` flag — still accepted, bypasses detection
- Scaffold generation — unchanged
- Polish loop evaluator (`evaluate.js`) — unchanged

## Artifacts Summary

| File | Stage | Producer | Consumer |
|------|-------|----------|----------|
| `autoresearch/source/visual-tree.json` | 3 | visual-tree capture | Reference artifact |
| `autoresearch/source/visual-tree.txt` | 3 | visual-tree capture | LLM (stages 4, 5), setup-polish-loop.js |
| `autoresearch/source/overlays.json` | 3 | visual-tree capture | LLM (stage 4) |
| `autoresearch/source/header-detection.json` | 5 | LLM header detection | capture-snapshot.js |
| `overlay-recipe.json` | 4 | LLM overlay dismissal | All downstream sessions |

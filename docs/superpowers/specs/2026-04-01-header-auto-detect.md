# Header Element Auto-Detection

## Problem

The migrate-header pipeline requires a CSS selector to identify the
header element (default: `header`). If the site uses a non-standard
element (`<div class="site-header">`, `<div id="masthead">`, etc.),
the capture fails silently — `snapshot.json` has a null header tree,
the screenshot crops nothing useful, and the entire pipeline produces
garbage.

Users must know the right selector upfront or iterate manually with
`--header-selector`. This is the single biggest point of failure in
the pipeline and the most common reason for failed migrations.

## Proposed Fix

Add a new **Stage 4b: Header Auto-Detection** between Overlay
Detection (Stage 4) and Snapshot Capture (Stage 5). This stage probes
the page and scores candidate elements to find the header.

### Detection Heuristics

Score candidate elements on these signals (highest combined score wins):

| Signal | Weight | How to check |
|--------|--------|-------------|
| Semantic tag | High | `<header>`, `<nav>` |
| ARIA role | High | `[role="banner"]`, `[role="navigation"]` |
| Class/ID naming | Medium | Contains `header`, `nav-bar`, `site-header`, `masthead`, `top-bar`, `main-nav` |
| Position | Medium | `position: fixed` or `sticky` at top of viewport |
| Layout | Medium | Spans full viewport width, height < 200px |
| Contains logo | Medium | Has `<img>` or element with class containing `logo` in left portion |
| Contains nav links | High | Has `<ul>` or `<nav>` with 3+ `<a>` children |
| Vertical position | Low | `boundingRect.y < 150` (near top of page) |

### Fallback Chain

1. Score all candidates, pick highest
2. If no candidate scores above threshold, try `header` tag
3. If `header` tag not found, try `[role="banner"]`
4. If nothing found, ask the user to provide `--header-selector`

### Output

The detected selector replaces the default `header` value in
`$HEADER_SELECTOR`. If `--header-selector` was explicitly provided
by the user, skip auto-detection entirely (user override).

### Implementation Options

**Option A: Browser IIFE** — Run a `page.evaluate()` IIFE that scores
all top-level elements and returns the best candidate's selector. Fast,
no extra dependencies. Similar pattern to `font-detect.js`.

**Option B: Accessibility tree** — Use `playwright-cli` snapshot (ax
tree) to find `banner` and `navigation` landmarks. More semantic but
depends on the site having proper ARIA markup.

**Option C: Visual analysis** — Take a full-page screenshot, use the
DOM tree + bounding rects to find the topmost full-width element with
nav links. Most robust but more complex.

Recommend Option A with Option B as a supplementary signal.

## Files to Create/Modify

| File | Action |
|------|--------|
| `skills/migrate-header/scripts/detect-header.js` | Create — browser IIFE for header auto-detection |
| `skills/migrate-header/SKILL.md` | Add Stage 4b between overlay detection and snapshot capture |

## Impact

- Eliminates the most common failure mode (wrong selector)
- Makes the skill work out-of-the-box on non-standard sites
- `--header-selector` becomes an optional override, not required knowledge

## Discovered

2026-04-01, during brand-setup skill implementation and migrate-header
flow review. The default `header` selector assumption is fragile — many
enterprise sites (AEM, Sitecore, etc.) use `<div>` wrappers instead of
semantic `<header>` tags.

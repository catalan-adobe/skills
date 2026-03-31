# CDP-Powered CSS Query Tool for Header Migration

Replace guesswork-from-resolved-values with precise, on-demand CSS
inspection using Chrome DevTools Protocol. A hybrid approach: light
upfront extraction (CSS overview) plus an interactive query tool the
LLM can call during scaffold and polish phases.

## Problem

The current extraction pipeline (`extract-branding.js`) works from a
static snapshot of `getComputedStyle()` values. This produces resolved
final values with no provenance:

- Can't distinguish author CSS from browser defaults
- CSS custom properties (`--brand-color`) are resolved away
- Font stacks are collapsed to the single rendered font
- No information about which CSS rule set a property or why
- Colors are guessed by heuristics (saturation, luminance) rather
  than read from the actual stylesheet

This forces the scaffold subagent to guess, and the polish loop to
trial-and-error its way to correct values — wasting iterations on
information that's available in the source page's stylesheets.

## Approach

Two new components, integrated into the existing pipeline:

1. **CSS overview** — a compact extraction of authored CSS data
   (custom properties, font stacks, categorized color palette) run
   once during capture via CDP. Gives the scaffold subagent accurate
   starting values.

2. **CSS query tool** — a standalone script that opens a persistent
   browser session on the source URL and serves on-demand CSS queries
   via CDP. The scaffold subagent and polish loop agent can ask for
   exact property values, their source rules, and whether they're
   inherited or explicit.

## Component 1: `css-query.js`

Standalone Node script. Opens a persistent `playwright-cli` session
on the source URL. Serves CDP-powered CSS queries.

### Subcommands

```
open <url> [--browser-recipe=path] [--session=css-query]
query <selector-or-node> <properties>
cascade <selector-or-node>
vars
close
```

- `open` — launch browser, navigate to URL, enable CDP CSS domain
- `query` — return specific properties with source/rule/inherited info
- `cascade` — return all matched CSS rules for an element (full cascade)
- `vars` — list CSS custom properties defined in page stylesheets
- `close` — close session

### Element Addressing

Two modes, both supported:

**CSS selector:** `query "nav > a:first-child" font-size,color`
- Uses `DOM.querySelector` to resolve
- If multiple matches, returns all with a count note

**Snapshot node ID:** `query node:42 font-size,color`
- Maps to the depth-first sequential ID in `snapshot.json`
- Uses `DOM.getDocument({depth:-1})` + depth-first walk to find
  the matching CDP `backendNodeId`
- Verifies tag/class match against snapshot; errors if mismatch

### Output Format

JSON to stdout:

```json
{
  "selector": "nav > a:first-child",
  "matches": 1,
  "properties": {
    "font-size": {
      "value": "16px",
      "source": "author",
      "rule": ".nav-link { font-size: 16px; }",
      "file": "styles.css:42",
      "inherited": false
    },
    "color": {
      "value": "#2a2a2a",
      "source": "author",
      "rule": ".nav-link { color: #2a2a2a; }",
      "file": "styles.css:43",
      "inherited": false
    }
  }
}
```

### Implementation

Uses `playwright-cli run-code` to get a `page` object, then:

1. `page.context().newCDPSession()` for CDP access
2. `CSS.enable()` to activate the CSS domain
3. `DOM.querySelector({nodeId, selector})` for selector-based lookups
4. `CSS.getMatchedStylesForNode({nodeId})` for rule provenance
5. `CSS.getComputedStyleForNode({nodeId})` for resolved values
6. Combine: matched rules provide source/file/inherited; computed
   provides the final resolved value

Session stays open across queries. Closed explicitly via `close`.

### Node Reference Mapping

When `node:N` is used:

1. `DOM.getDocument({depth: -1})` returns full CDP DOM tree
2. Walk depth-first matching `capture-snapshot.js`'s `traverse()` order
3. Map snapshot `nodeId: N` to CDP `backendNodeId`
4. Cache the mapping for the session (~200ms first query)
5. Verify tag + classes match snapshot entry; error on mismatch

### Browser Recipe Support

`open` accepts `--browser-recipe` to handle bot-protected sites:

- Reads the recipe JSON
- Writes stealth script to temp file, adds as `initScript` in config
- Passes `--config` to `playwright-cli` (same pattern as
  `capture-snapshot.js` `buildRecipeArgs`)

## Component 2: `css-overview.js`

Extracts a compact CSS summary during the capture phase via CDP.
Called by `capture-snapshot.js` after the DOM snapshot is written,
using the still-open browser session.

### Output: `css-overview.json`

```json
{
  "customProperties": {
    "--brand-color": "#830051",
    "--nav-height": "64px"
  },
  "fontStacks": [
    "\"Helvetica Neue\", Helvetica, Arial, sans-serif",
    "Georgia, \"Times New Roman\", serif"
  ],
  "colorPalette": {
    "backgrounds": ["#ffffff", "#1a1a2e", "#f5f5f5"],
    "text": ["#2a2a2a", "#666666", "#ffffff"],
    "accent": ["#830051", "#0066cc"],
    "borders": ["#e0e0e0", "#cccccc"]
  },
  "keySpacing": {
    "headerPaddingX": "24px",
    "navGap": "32px",
    "rowHeights": [36, 58]
  }
}
```

### How It Differs From `extract-branding.js`

| Property | Current (getComputedStyle) | New (CDP) |
|----------|---------------------------|-----------|
| Custom properties | Resolved away | Preserved as authored |
| Font stacks | First rendered font only | Full authored `font-family` |
| Colors | Guessed by heuristics | Categorized from matched rules (author only, no defaults) |
| Source info | None | Which rule, which file |

### Implementation

Runs as a separate step within the same `playwright-cli` session that
capture-snapshot opened. Uses `playwright-cli run-code` to access the
`page` object and establish a CDP session. Calls:

1. `CSS.getMatchedStylesForNode` on key elements (header, rows,
   nav links, CTA) to extract authored property values
2. `CSS.getComputedStyleForNode` on the same elements for resolved
   values where matched rules use custom properties
3. Scans matched rules for `var(--*)` usage to build the custom
   properties map
4. Deduplicates font stacks and colors across all inspected elements

Adds ~500ms to the capture phase.

## Pipeline Integration

### Stage 5 (Capture)

After `capture-snapshot.js` writes snapshot.json and screenshots:

1. Call `css-overview.js` using the still-open browser session
2. Write `css-overview.json` to the output directory
3. Close session

### Snapshot Node IDs

`capture-snapshot.js`'s `traverse()` function assigns sequential
`nodeId` to each node in the snapshot as it walks depth-first.
These IDs appear in `snapshot.json` and are used by `css-query.js`
for `node:N` addressing.

### Stage 6 (Extraction)

No changes to `extract-layout.js` or `extract-branding.js`.
`branding.json` continues to be produced for backward compatibility.

### Stage 7 (Scaffold)

The scaffold subagent prompt gains:

1. Read `css-overview.json` for custom properties, font stacks,
   and exact color palette
2. Ability to open a `css-query.js` session on the source URL for
   deeper lookups during scaffold generation
3. Close the query session when done

### Stage 9 (Polish Loop)

`program.md.tmpl` gains CSS query instructions:

1. Open `css-query.js` session on source URL at start of iteration
2. When diff image shows a mismatch in a specific area, query the
   source element's styles to find the exact target value
3. Compare against current EDS header CSS to identify the delta
4. Make targeted changes based on the actual difference
5. Close session before committing

The query session (source URL) is separate from the evaluation
session (localhost:3000).

## New Files

| File | Purpose | Est. lines |
|------|---------|-----------|
| `scripts/css-query.js` | Standalone query tool | ~150 |
| `scripts/css-overview.js` | Overview extraction during capture | ~100 |

## Changes to Existing Files

| File | Change |
|------|--------|
| `scripts/capture-snapshot.js` | Add nodeId to traverse(), call css-overview.js before closing session |
| `templates/program.md.tmpl` | Add CSS query tool instructions and usage examples |
| `SKILL.md` | Document css-query.js in Scripts section, update Stage 7 scaffold prompt |

## What Stays Unchanged

- `extract-branding.js` — still produces `branding.json`
- `extract-layout.js` — still produces `layout.json`
- `evaluate.js.tmpl` — still scores via pixelmatch
- `loop.sh.tmpl` — still runs the outer loop
- `block-files/header.{js,css}` — scaffold base files

## Expected Impact

- Scaffold starts with authored CSS values — fewer iterations to baseline
- Polish loop makes targeted fixes based on exact property deltas
- CSS custom properties visible — enables direct mapping to EDS custom properties
- Reduces late-stage plateau (C+D problem) by replacing guesswork with precise queries

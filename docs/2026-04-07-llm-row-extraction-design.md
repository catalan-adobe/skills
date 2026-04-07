# LLM-Driven Per-Row Content Extraction

Replace script-based content extraction with LLM subagents that extract
content and styles per visual header row. Produces 1 EDS section per
row instead of the current fixed 3-section split.

## Problem

The current pipeline uses four scripts (~1200 lines) to extract header
content and styles:

1. `capture-snapshot.js` + `capture-helpers.js` — open page, walk DOM
   tree, extract nav items by visibility heuristics
2. `extract-layout.js` — classify rows by CSS class heuristics, detect
   elements, deduplicate nav items, build hierarchy
3. `extract-styles.js` — open css-query session, query CSS values for
   a fixed set of element types

These scripts produce `layout.json` and `styles.json`, which a scaffold
subagent consumes to generate `nav.plain.html` (3 sections: brand,
main-nav, utility) and `header.css`.

### Observed failures (AstraZeneca migration)

- **Row classification missed utility links.** `extract-layout.js`
  tagged row 1 as `nav-bar` with `elements: ["logo"]`, missing the
  "AstraZeneca Websites" and "Global site" utility links entirely.
- **Style extraction queried wrong elements.** `extract-styles.js`
  returned `font-size: 10px` from utility links (`.navigation__region-link`)
  instead of the ~15px main nav links. The polish loop judge then
  flagged a font-size mismatch, causing a wasted iteration.
- **3 sections for 2 visual rows.** Brand (logo) and utility (site
  links) are on the same visual row but were split into separate EDS
  sections. The CSS had to re-compose them, adding complexity the
  polish loop had to solve.

### Root cause

Scripts use spatial and class-name heuristics to infer semantics. An
LLM reading the visual tree text ("2x1 grid, 44px, AstraZeneca
Websites Global si...") immediately understands the row's purpose
without heuristics.

## Design

### Approach: Row agents replace Phase 3, scaffold stays

- Phase 2 gains row identification + screenshot capture
- Phase 3 becomes parallel LLM row agents (one per visual row)
- Phase 4 scaffold receives `row-*.json` instead of `layout.json` +
  `styles.json`
- Phases 1, 5, 6 unchanged

### Scripts deleted

| Script | Lines | Replaced by |
|--------|-------|-------------|
| `extract-layout.js` | 496 | Pipeline agent (row identification from visual tree) |
| `extract-styles.js` | ~200 | Row agents (css-query per row) |
| `capture-snapshot.js` | 358 | Pipeline agent (screenshot) + row agents (DOM reads) |
| `capture-helpers.js` | 153 | Row agents (direct DOM queries) |

### Scripts kept

- `capture-visual-tree.js` — initial page capture
- `css-query.js` — browser interaction tool for row agents
- `detect-overlays-fallback.js` — overlay detection when visual tree
  fails
- `setup-polish-loop.js` — polish loop infrastructure
- `cdp-helpers.js` — shared playwright-cli output parsing

### No changes to block files

`block-files/header.js` already uses section-metadata-driven
classification (iterates `navDoc.querySelectorAll('body > div')`,
reads each section's `Style` metadata). It handles any number of
sections. No changes needed.

`block-files/header.css` is customized by the scaffold subagent as
before.

## Phase 2 Changes

Current Phase 2: visual tree → overlay detection → header element
detection → close session.

### New steps added before session close

**Step 2.4 — Row identification:**

The pipeline agent reads the header subtree from `visual-tree.txt`
and `visual-tree.json`. It identifies direct child rows within the
header node based on vertical stacking and spatial annotations.

Output: `autoresearch/source/rows.json`

```json
{
  "headerSelector": "#navigation",
  "headerHeight": 94,
  "rows": [
    {
      "index": 0,
      "nodeId": "rc1c1c1",
      "selector": "<CSS selector from visual-tree.json nodeMap>",
      "bounds": { "y": 0, "height": 44 },
      "vtSubtree": "<visual tree text for this node and children>",
      "description": "<LLM-written description of row content>"
    }
  ]
}
```

The `description` field is a short natural-language summary (e.g.,
"Top bar: logo left, utility links right") that gives the downstream
row agent a head start.

The `vtSubtree` field is the visual-tree text lines for this node
and its children, extracted from `visual-tree.txt`.

**Step 2.5 — Screenshot capture:**

Before closing the visual-tree session, capture the header screenshot:

```bash
playwright-cli -s=visual-tree resize 1440 900
sleep 1
playwright-cli -s=visual-tree screenshot \
  --filename=autoresearch/source/desktop-full.png
```

Then crop the header region using the bounds from header detection
(step 2.3). Use a small inline node script with pngjs (already a
dependency in the skill's scripts/node_modules).

Save cropped header to `autoresearch/source/desktop.png` (same path
the evaluator expects).

**Step 2.6 — Close visual-tree session.**

## Phase 3 Changes

Current Phase 3: run `capture-snapshot.js` → classify nav items →
run `extract-layout.js` → run `extract-styles.js` → icons → fonts.

### New Phase 3: Row agents (parallel)

The pipeline agent reads `rows.json` and dispatches one subagent per
row in parallel.

**Row agent inputs** (all passed inline in the prompt):

- Row's visual-tree subtree text
- Row's CSS selector
- Row description (from step 2.4)
- Row index and total row count
- Source URL
- Browser recipe path (for bot protection bypass)
- css-query.js script path
- Project root path

**Row agent execution:**

1. Open a css-query session on the source URL:
   ```bash
   node <css-query-path> open <url> \
     --session=row-<N> --browser-recipe=<path>
   ```

2. Query the row's DOM content:
   ```bash
   playwright-cli -s=row-<N> eval \
     "document.querySelector('<selector>').innerHTML"
   ```

3. Analyze the DOM to classify elements: logo, nav-link (with
   children from nested `<ul>`s including hidden submenus),
   utility-link, promotional-card, search, icon, CTA, plain text.
   Annotate each with a `role` field — this is descriptive only,
   nothing is filtered. All items flow to the scaffold.

4. Query CSS values for each element type via css-query:
   ```bash
   node <css-query-path> query "<selector>" \
     "background-color, height, padding, font-family"
   node <css-query-path> query "<selector> a" \
     "font-size, color, font-weight, letter-spacing"
   ```

5. Close the session:
   ```bash
   node <css-query-path> close --session=row-<N>
   ```

6. Write output to
   `<project-root>/autoresearch/extraction/row-<N>.json`

**Row agent output schema:**

```json
{
  "index": 0,
  "description": "Top bar with logo and utility links",
  "bounds": { "y": 0, "height": 44 },
  "suggestedSectionStyle": "brand",
  "elements": [
    {
      "role": "logo",
      "position": "left",
      "content": {
        "tag": "a",
        "href": "/",
        "children": [
          {
            "tag": "img",
            "src": "/etc/designs/az/img/logo-az.png",
            "alt": "AstraZeneca logo"
          }
        ]
      },
      "styles": {
        "width": "108px",
        "padding": "0 0 0 1.25rem"
      }
    },
    {
      "role": "utility-link",
      "position": "right",
      "content": {
        "text": "AstraZeneca Websites",
        "href": "/global/en/AstraZeneca-Websites.html"
      },
      "styles": {
        "font-size": "10px",
        "color": "rgb(60, 66, 66)",
        "letter-spacing": "0.8px"
      }
    }
  ],
  "rowStyles": {
    "background-color": "rgba(0, 0, 0, 0)",
    "height": "44px",
    "border-bottom": "1px solid #e0e0e0",
    "font-family": "\"Helvetica Neue\", Helvetica, Arial, sans-serif"
  }
}
```

For nav rows, elements include children from hidden submenus:

```json
{
  "role": "nav-link",
  "position": "left",
  "content": {
    "text": "R&D",
    "href": "/r-d.html",
    "children": [
      {
        "text": "Precision medicine",
        "href": "/r-d/precision-medicine.html"
      },
      {
        "text": "Featured website — Clinical Trials",
        "href": "https://www.astrazenecaclinicaltrials.com"
      }
    ]
  },
  "styles": {
    "font-size": "15px",
    "font-weight": "400",
    "color": "rgb(60, 66, 66)"
  }
}
```

Schema field reference:

| Field | Type | Description |
|-------|------|-------------|
| `index` | number | Row position (0-based, top to bottom) |
| `description` | string | Natural-language summary of row content |
| `bounds` | object | `{ y, height }` from visual tree |
| `suggestedSectionStyle` | string | Proposed section-metadata Style value |
| `elements` | array | Classified elements in the row |
| `elements[].role` | string | Descriptive annotation: logo, nav-link, utility-link, promotional-card, search, icon, cta, text |
| `elements[].position` | string | Spatial hint: left, right, center |
| `elements[].content` | object | Element content (text, href, children, tag, src, alt) |
| `elements[].styles` | object | CSS property-value pairs from css-query |
| `rowStyles` | object | Row-level CSS (background, height, borders, font-family) |

### Icons and fonts

Icon collection (page-collect) and font detection (brand-setup) remain
as separate steps after row agents complete — they operate on the full
page, not per-row. No changes.

## Phase 4 Changes

The scaffold subagent receives `row-*.json` files instead of
`layout.json` + `styles.json`.

### Updated scaffold prompt

Replace the input data section:

```
Read these files:
- Row extractions: <PROJECT_ROOT>/autoresearch/extraction/row-*.json
- Fonts (if exists): <PROJECT_ROOT>/autoresearch/extraction/fonts-detected.json
```

Key instruction changes:

- "Each row-N.json represents one visual row of the header. Generate
  exactly one nav.plain.html `<div>` section per row file."
- "Use `suggestedSectionStyle` from each row file for the
  section-metadata Style property."
- "Element styles in each row file are per-element — use the font-size
  from nav-link elements for nav styling, utility-link elements for
  utility styling. Do not mix them."
- "All elements are included regardless of role — promotional cards,
  featured links, etc. should appear in nav.plain.html."

### Updated scaffold output

Same files as before:
- `blocks/header/header.css` — customized CSS properties
- `nav.plain.html` — 1 section per row
- `images/logo.png` — downloaded logo

## Migration Example: AstraZeneca

### Before (current pipeline)

3 sections from mixed extraction:

```
Section 1 (brand):    [Logo]
Section 2 (main-nav): [9 nav items]
Section 3 (utility):  [AstraZeneca Websites, Global site]
```

### After (proposed)

2 sections matching visual rows:

```
Section 1 (brand):    [Logo] + [AstraZeneca Websites, Global site]
Section 2 (main-nav): [9 nav items with all submenu items]
```

The top row section contains both the logo and utility links because
they share the same visual row. The scaffold uses CSS (flexbox with
`justify-content: space-between`) to position logo left and utility
right — matching the source layout without needing to re-compose
separate sections.

## Testing

Validate the design by re-running the AstraZeneca migration with the
new pipeline and comparing:

1. **Row agent output** — do row-0.json and row-1.json capture all
   content with correct styles?
2. **nav.plain.html** — does it have 2 sections matching 2 visual rows?
3. **Scaffold score** — does the first evaluation score improve vs the
   current pipeline's first-iteration score?
4. **Polish convergence** — does the polish loop need fewer iterations
   to reach the same or better composite score?

## Risks

- **Lazy-loaded menus:** Some sites load submenu content on hover via
  AJAX. The row agent's DOM read would miss these. Mitigation: for now,
  accept this limitation. A future iteration can add hover interaction
  as a fallback when the DOM has nav links with `aria-haspopup` but
  empty nested lists.
- **Menu panels outside header DOM:** Some sites render mega menu panels
  as siblings of the header or in portal containers. The row agent
  queries only its row's DOM slice. Mitigation: the row agent can follow
  `aria-controls` references to external panels if detected.
- **LLM output consistency:** Row agents may produce slightly different
  JSON structures across runs. Mitigation: the scaffold prompt should
  validate row JSON structure and handle missing fields gracefully.

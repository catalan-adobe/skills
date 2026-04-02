---
name: visual-tree
description: >-
  Capture a spatial hierarchy of rendered DOM elements from any webpage.
  Injects a pre-built script via playwright-cli that walks the DOM, detects
  layout grids, extracts backgrounds, prunes invisible nodes, promotes
  elements rendered outside their DOM parent (overlays, fixed navs, modals),
  and tags overlay nodes with occlusion metadata. Returns three outputs:
  LLM-friendly indented text, structured JSON tree, and a nodeMap mapping
  positional IDs to CSS selectors with background and overlay data. Use
  before page decomposition, overlay detection, brand extraction, or any
  workflow that needs structured page analysis. Triggers on: visual tree,
  capture tree, page structure, page hierarchy, DOM tree, capture visual,
  page analysis, extract tree.
---

# Visual Tree

Capture a spatial hierarchy of rendered DOM elements from any webpage via
`playwright-cli`. Returns three outputs for downstream consumption.

## Prerequisites

- `playwright-cli` available (run `playwright-cli help` to verify)
- A page already open in the browser session

## Script Location

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  VT_BUNDLE="${CLAUDE_SKILL_DIR}/scripts/visual-tree-bundle.js"
else
  VT_BUNDLE="$(find ~/.claude \
    -path "*/visual-tree/scripts/visual-tree-bundle.js" \
    -type f 2>/dev/null | head -1)"
fi
```

Verify the path is non-empty before continuing.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minWidth` | 900 | Minimum element width in px. Elements narrower than this are excluded. `position: fixed` elements always pass regardless. Lower for more detail (e.g., 300 for mobile). |

## Workflow

### Step 1 — Resolve the bundle

Run the script location block above and store the path in `VT_BUNDLE`.
If the path is empty, report an error and stop.

### Step 2 — Inject and capture

Run a single `playwright-cli eval` that injects the bundle and captures the
visual tree. The bundle defines a `__visualTree` global; the wrapper IIFE
calls `captureVisualTree` and returns the result as JSON.

```bash
MINWIDTH=900  # or caller-specified value
playwright-cli eval "(() => {
  $(cat "$VT_BUNDLE")
  globalThis.__visualTree = __visualTree;
  var r = __visualTree.captureVisualTree($MINWIDTH);
  return JSON.stringify({
    textFormat: r.textFormat,
    data: r.data,
    nodeMap: r.nodeMap,
    rootBackground: r.rootBackground,
    rootBackgroundInfo: r.rootBackgroundInfo,
  });
})()"
```

Parse the returned JSON string.

### Step 3 — Present outputs

Present three sections to the caller:

**1. Visual Tree (text format)**

The primary output for LLM consumers. Show in a code block:

```
r @0,0 1440x5667
  rc1 [3x1] @0,0 1440x83 "Header text..."
  rc2 @0,83 1440x5216
    rc2c1 [bg:image] @0,83 1440x410 "Hero text..."
    ...
```

Format: `ID [role] [CxR] [bg:type] @x,y wxh "text..."`
- **ID**: positional address in the tree (r = root, rc1 = first child, etc.)
- **[role]**: ARIA role if present
- **[CxR]**: grid layout (e.g., 4x2 = 4 columns, 2 rows) — only when multi-column
- **[bg:type]**: background (color, gradient, or image) — only when visually distinct
- **@x,y**: position from page top-left in pixels
- **wxh**: width x height in pixels
- **"text..."**: first 30 characters of text content

**2. Node Map**

Positional ID to metadata lookup. Show as JSON. Each entry contains:
- `selector`: CSS selector for the DOM element
- `background` (optional): `{ type, value, raw, source }`
- `overlay` (optional): `{ occluding: [sibling IDs this node covers] }`

Overlay entries indicate the node was promoted from a deeper DOM position
to root level because it rendered outside its parent's bounds (e.g., cookie
banners, fixed navs, modals).

**3. JSON Tree**

Full structured tree. Show as JSON only if the caller requests it, otherwise
mention it is available. Each node contains: tag, selector, bounds, text,
role, layout, background, children.

## Pipeline

The bundle runs 6 passes on the DOM:

1. **buildVisualNode** — walks `document.body`, captures bounding boxes,
   backgrounds, text, roles, layout detection. Filters by minWidth.
   `position: fixed` elements bypass the width filter.
2. **collapseSingleChildren** — flattens wrapper chains (div > div > div
   becomes a single node with promoted properties).
3. **pruneZeroHeightLeaves** — removes invisible zero-dimension nodes
   bottom-up (e.g., accessibility skip-links).
4. **promoteEscapedNodes** — re-parents elements rendered outside their
   DOM parent's bounds to the nearest containing ancestor. Uses 2px
   tolerance for subpixel rounding.
5. **assignPositionalIds** — assigns compact tree addresses (r, rc1,
   rc1c2, ...) and builds the nodeMap.
6. **enrichOverlayMetadata** — tags promoted root-level nodes with
   `overlay.occluding` listing which siblings they visually cover.

## Tips

- Run on pages after they finish loading (`playwright-cli goto <url>` then
  wait for network idle) for best results.
- For pages with lazy-loaded content, scroll to bottom and back before
  capturing.
- Overlay nodes in the nodeMap have CSS selectors usable for dismissal
  (e.g., click accept buttons, remove elements).
- The text format is designed for LLM consumption — thin, spatial, and
  inferrable. The nodeMap carries richer metadata for programmatic use.

---
name: migrate-header
description: >
  Migrate any website header to AEM Edge Delivery Services with pixel-accurate
  fidelity using an automated extraction + scaffold + visual polish pipeline.
  Takes a URL, captures a visual tree for spatial analysis, detects and
  dismisses overlays via LLM, identifies the header element from the spatial
  map, identifies visual rows, dispatches parallel LLM agents to extract content
  and styles per row, generates scaffold
  code, then launches an autonomous visual polish loop. Requires being in an
  EDS git repository. Works in the current directory — the caller is
  responsible for worktree/branch setup if isolation is needed. Triggers on:
  "migrate header", "header migration", "migrate-header", "/migrate-header",
  "convert header to EDS", "EDS header from URL".
---

# Migrate Header

Migrate any website header to AEM Edge Delivery Services. The pipeline
captures the source header, extracts layout and branding data, generates
an EDS-compatible scaffold, then runs an autonomous visual polish loop
to converge on pixel-accurate fidelity.

## Pipeline Overview

```
Phase 1: Setup & Validation     │ Parse args → Validate EDS → Probe CDN → Prepare dirs
Phase 2: Page Analysis          │ Visual tree → Overlay detection → Header identification
Phase 3: Source Extraction      │ Row agents (parallel) → Icons → Fonts
Phase 4: Scaffold Generation    │ Copy base block → Customize CSS → Generate nav
Phase 5: Visual Polish          │ Setup loop infra → Run autonomous polish loop
Phase 6: Wrap-up                │ Report results → Generate retrospective
```

## Scripts

All deterministic work goes through Node scripts bundled with this skill.
Resolve the skill directory once, then use it for all asset paths:

```bash
SKILL_HOME="${CLAUDE_SKILL_DIR:-$HOME/.claude/skills/migrate-header}"
```

Scripts:
- `node $SKILL_HOME/scripts/capture-visual-tree.js <url> <output-dir> [--browser-recipe=path] [--session=visual-tree]`
- `node $SKILL_HOME/scripts/detect-overlays-fallback.js <url> <output-dir> [--browser-recipe=path]`
- `node $SKILL_HOME/scripts/setup-polish-loop.js --rows-dir=... --url=... --source-dir=... --target-dir=... --port=3000 --max-iterations=N`
- `node $SKILL_HOME/scripts/css-query.js open <url> [--browser-recipe=path] [--session=name]`
- `node $SKILL_HOME/scripts/css-query.js query <selector|node:N> <properties>`
- `node $SKILL_HOME/scripts/css-query.js cascade <selector|node:N>`
- `node $SKILL_HOME/scripts/css-query.js vars`
- `node $SKILL_HOME/scripts/css-query.js close`

Block-files: `$SKILL_HOME/block-files/header.{js,css}`
Reference docs: `$SKILL_HOME/references/*.md`

See [EDS header conventions](references/eds-header-conventions.md) for block patterns used in scaffold generation.

## Execution

### Pipeline Tracking

After parsing arguments (step 1.1), create a task list to track
progress through all 6 phases:

1. **Phase 1: Setup & Validation** — Parse args, validate EDS repo, probe CDN, prepare dirs
2. **Phase 2: Page Analysis** — Visual tree, overlay detection, header identification
3. **Phase 3: Source Extraction** — Row agents (parallel), icons, fonts
4. **Phase 4: Scaffold Generation** — Copy base block, customize CSS, generate nav
5. **Phase 5: Visual Polish** — Setup loop infrastructure, run autonomous polish
6. **Phase 6: Wrap-up** — Report results, generate retrospective

Use TaskCreate for each phase. Mark each phase `in_progress` when you
start it and `completed` when all its steps finish. On failure, leave
the phase in_progress and report which step failed.

### State Variables

Track state across phases with these variables. Set each one as its
phase completes. Use them in error handling to know what to clean up.

```
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
AEM_PID=""
BROWSER_RECIPE=""
```

### Phase 1: Setup & Validation

Mark Phase 1 as in_progress.

#### 1.1 Parse Arguments

Extract arguments from the user's message:

| Argument | Required | Default | How to extract |
|----------|----------|---------|----------------|
| `URL` | Yes | -- | First `https?://...` string in the user message |
| `--header-selector` | No | `header` | Literal flag value if present |
| `--overlay-recipe` | No | Auto-detect | Path to a JSON file if present |
| `--max-iterations` | No | `30` | Integer value if present |

If no URL is found, ask the user: "Please provide the URL of the website
whose header you want to migrate."

Store these in shell variables for use in subsequent stages:

```bash
URL="<extracted>"
HEADER_SELECTOR="${header_selector:-header}"
HEADER_SELECTOR_EXPLICIT="false"
OVERLAY_RECIPE="${overlay_recipe:-}"
MAX_ITERATIONS="${max_iterations:-30}"
```

When `--header-selector` is found in the user's message, also set
`HEADER_SELECTOR_EXPLICIT="true"`. Step 2.3 uses this to skip
LLM-based header detection.

#### 1.2 Validate EDS Repository

Run via Bash. Every check must pass or the pipeline stops.

```bash
# Check 1: git repo
git rev-parse --git-dir > /dev/null 2>&1 || { echo "ERROR: Not a git repository. Run this from an EDS project root."; exit 1; }

# Check 2: EDS markers
if [[ ! -f fstab.yaml && ! -f scripts/aem.js && ! -f head.html ]]; then
  echo "ERROR: No EDS markers found (fstab.yaml, scripts/aem.js, or head.html)."
  echo "This skill requires an AEM Edge Delivery Services repository."
  exit 1
fi

# Check 3: blocks directory
if [[ ! -d blocks ]]; then
  echo "ERROR: No blocks/ directory found. Expected EDS project structure."
  exit 1
fi

# Check 4: clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree has uncommitted changes. Commit or stash before running."
  echo "$(git status --short)"
  exit 1
fi

echo "EDS repository validated."
```

#### 1.3 Browser Probe

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
  `stealth-config.md` from the browser-probe skill's
  `references/` directory for the stealth init script and provider
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

#### 1.4 Prepare Working Directory

All file operations happen in the current project root. Create the
autoresearch directory structure:

```bash
mkdir -p "$PROJECT_ROOT/autoresearch/source"
mkdir -p "$PROJECT_ROOT/autoresearch/extraction"
mkdir -p "$PROJECT_ROOT/autoresearch/results"
```

Mark Phase 1 as completed.

### Phase 2: Page Analysis

Mark Phase 2 as in_progress.

#### 2.1 Visual Tree Capture

Capture a spatial hierarchy of the source page using the visual-tree
skill's bundle. Produces a spatial map consumed by overlay detection
(step 2.2) and header identification (step 2.3).

```bash
RECIPE_FLAG=""
if [[ -n "$BROWSER_RECIPE" ]]; then
  RECIPE_FLAG="--browser-recipe=$BROWSER_RECIPE"
fi

node "$SKILL_HOME/scripts/capture-visual-tree.js" \
  "$URL" \
  "$PROJECT_ROOT/autoresearch/source" \
  $RECIPE_FLAG
```

The script locates the visual-tree bundle, injects it via `initScript`,
captures the spatial hierarchy, and saves `visual-tree.json`,
`visual-tree.txt`, and `overlays.json` to the output directory.

If the visual-tree bundle is not found (exit code 1) or capture fails
(exit code 2), log a warning and skip to step 3.1. Overlay detection
falls back to page-prep; header detection falls back to
`--header-selector` or `header` tag default.

**The script leaves the playwright-cli session open** (`-s=visual-tree`)
— it will be used for overlay dismissal and header detection. Do NOT
close it here.

#### 2.2 Overlay Detection & Dismissal

If `--overlay-recipe` was provided, copy it into the project and skip
to step 2.3:

```bash
cp "$OVERLAY_RECIPE" "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
```

Otherwise, use visual-tree data to detect and dismiss overlays.

**If visual-tree capture succeeded** (step 2.1 produced
`autoresearch/source/overlays.json`):

Read `overlays.json`. If the array is empty, write an empty recipe and
skip to step 2.3:

```bash
OVERLAY_COUNT=$(node --input-type=module -e "
  import { readFileSync } from 'fs';
  const overlays = JSON.parse(readFileSync(
    '$PROJECT_ROOT/autoresearch/source/overlays.json', 'utf-8'));
  console.log(overlays.length);
")

if [[ "$OVERLAY_COUNT" -eq 0 ]]; then
  echo '{ "selectors": [], "action": "remove" }' > "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
  echo "No overlays detected."
fi
```

If overlays were detected, present the visual-tree data to the LLM
for dismissal. Read and present these files:

1. `autoresearch/source/visual-tree.txt` — full spatial map
2. `autoresearch/source/overlays.json` — detected overlay entries with
   selectors, occluding lists, bounds, and text hints

For each overlay entry, the LLM:

1. Reviews the overlay's geometry, text, and which page sections it
   occludes from the visual-tree data
2. Uses the overlay's CSS selector from nodeMap to inspect its internals
   in the live playwright-cli session (`-s=visual-tree`):
   ```bash
   playwright-cli -s=visual-tree eval "[...document.querySelector('${OVERLAY_SELECTOR}').querySelectorAll('button, a, [role=button]')].map(b => ({text: b.textContent.trim().slice(0, 50), tag: b.tagName}))"
   ```
3. Decides the dismissal action:
   - If an accept/close button is found → `{"action": "click", "selector": "<button>"}`
   - If no interactive dismiss is possible → `{"action": "remove", "selector": "<overlay>"}`
4. Executes the action in the live session:
   ```bash
   # For click actions:
   playwright-cli -s=visual-tree eval "document.querySelector('${BTN_SELECTOR}').click()"
   # For remove actions:
   playwright-cli -s=visual-tree eval "document.querySelector('${OVERLAY_SELECTOR}').remove()"
   ```
5. Records the action

After all overlays are handled, write the overlay recipe — an object with a `selectors` array
containing CSS selectors for elements to remove:

```bash
# Collect all overlay selectors that were dismissed (clicked or removed)
# Format: { selectors: [...], action: "remove" }
node --input-type=module -e "
  import { writeFileSync } from 'fs';
  const selectors = [/* all overlay CSS selectors that were dismissed */];
  writeFileSync('$PROJECT_ROOT/autoresearch/overlay-recipe.json',
    JSON.stringify({ selectors, action: 'remove' }, null, 2));
"
```

**If visual-tree capture failed** (no `overlays.json` from step 2.1):

Fall back to page-prep's CMP database for overlay detection:

```bash
RECIPE_FLAG=""
if [[ -n "$BROWSER_RECIPE" ]]; then
  RECIPE_FLAG="--browser-recipe=$BROWSER_RECIPE"
fi

node "$SKILL_HOME/scripts/detect-overlays-fallback.js" \
  "$URL" \
  "$PROJECT_ROOT/autoresearch" \
  $RECIPE_FLAG
```

The script locates page-prep, refreshes the CMP database, injects the
detection bundle via `initScript`, extracts the report, and writes
`overlay-recipe.json`. If page-prep is not found or detection fails,
it writes an empty recipe as fallback.

#### 2.3 Header Element Detection

If `--header-selector` was explicitly provided, use it directly and skip
detection:

```bash
if [[ "$HEADER_SELECTOR_EXPLICIT" == "true" ]]; then
  echo "Using explicit header selector: $HEADER_SELECTOR"
fi
```

Otherwise, use visual-tree data to identify the header element.

**If visual-tree capture succeeded** (step 2.1 produced
`autoresearch/source/visual-tree.txt`):

Present the visual-tree text format to the LLM. The LLM identifies the
header node based on:
- Position (near top of page, after any announcement bars)
- Width (spans full or near-full viewport)
- Height (relatively short — under ~200px vs hero/content sections)
- Content (navigation text, grid layouts suggesting nav link rows)
- ARIA roles (`[navigation]` role annotation)

The LLM should exclude nodes already identified as overlays in step 2.2.

After identifying the header node, extract its CSS selector from the
nodeMap in `visual-tree.json`:

```bash
DETECTED_SELECTOR=$(node --input-type=module -e "
  import { readFileSync } from 'fs';
  const vt = JSON.parse(readFileSync(
    '$PROJECT_ROOT/autoresearch/source/visual-tree.json', 'utf-8'));
  const nodeId = '<LLM-identified node ID, e.g. rc2>';
  console.log(vt.nodeMap[nodeId]?.selector || '');
")
```

Save the detection result:

```bash
node --input-type=module -e "
  import { writeFileSync } from 'fs';
  writeFileSync('$PROJECT_ROOT/autoresearch/source/header-detection.json',
    JSON.stringify({
      selector: '$DETECTED_SELECTOR',
      nodeId: '<identified node ID>',
      bounds: { /* from visual-tree data */ }
    }, null, 2));
"
```

Update the header selector variable for downstream stages:

```bash
HEADER_SELECTOR="$DETECTED_SELECTOR"
echo "Detected header element: $HEADER_SELECTOR"
```

**If visual-tree capture failed** (no `visual-tree.txt`):

Fall back to the default `header` selector (or `--header-selector` if
it was provided). Log a warning:

```bash
echo "Warning: Visual tree not available. Using default selector: $HEADER_SELECTOR"
```

#### 2.4 Row Identification

Read the header subtree from `visual-tree.txt` and `visual-tree.json`
(produced in step 2.1). Identify direct child rows within the header
node identified in step 2.3.

**How to identify rows:**

Using the header's node ID from `header-detection.json`, find that
node in `visual-tree.txt`. Its direct children that are vertically
stacked (non-overlapping Y ranges) and have meaningful height (>15px)
are the visual rows.

For each row, extract from `visual-tree.json`'s nodeMap:
- `nodeId` — the row node's ID in the visual tree
- `selector` — CSS selector from `nodeMap[nodeId].selector`
- `bounds` — `{ y, height }` from the visual tree spatial data

Write a short description of each row's content based on what you see
in the visual tree text (e.g., "Top bar: logo left, utility links right").

Also extract the visual-tree text lines for each row node and its
children — this is the `vtSubtree` field that gives downstream row
agents context.

**Save to** `$PROJECT_ROOT/autoresearch/source/rows.json`:

```json
{
  "headerSelector": "<from header-detection.json>",
  "headerHeight": 94,
  "rows": [
    {
      "index": 0,
      "nodeId": "<visual tree node ID>",
      "selector": "<CSS selector from nodeMap>",
      "bounds": { "y": 0, "height": 44 },
      "vtSubtree": "<visual tree text for this node>",
      "description": "Top bar: logo left, utility links right"
    }
  ]
}
```

#### 2.5 Screenshot Capture

Before closing the visual-tree session, capture the header screenshot
for the evaluator and polish loop.

**Full viewport screenshot:**

```bash
playwright-cli -s=visual-tree resize 1440 900
sleep 1
playwright-cli -s=visual-tree screenshot \
  --filename=$PROJECT_ROOT/autoresearch/source/desktop-full.png
```

**Extract header height** from the rows.json produced in step 2.4:

```bash
HEADER_HEIGHT=$(node --input-type=module -e "
  import { readFileSync } from 'fs';
  const rows = JSON.parse(readFileSync(
    '$PROJECT_ROOT/autoresearch/source/rows.json', 'utf-8'));
  console.log(rows.headerHeight);
")
```

**Crop to header region** using pngjs from the skill's scripts/node_modules:

```bash
node --input-type=module -e "
  import { readFileSync, writeFileSync } from 'fs';
  import { createRequire } from 'module';
  const require = createRequire('$SKILL_HOME/scripts/package.json');
  const { PNG } = require('pngjs');

  const full = PNG.sync.read(readFileSync(
    '$PROJECT_ROOT/autoresearch/source/desktop-full.png'));
  const y = 0;
  const h = Math.min(${HEADER_HEIGHT}, full.height);
  const w = full.width;
  const cropped = new PNG({ width: w, height: h });
  PNG.bitblt(full, cropped, 0, y, w, h, 0, 0);
  writeFileSync(
    '$PROJECT_ROOT/autoresearch/source/desktop.png',
    PNG.sync.write(cropped));
  console.log('Cropped header: ' + w + 'x' + h);
"
```

#### 2.6 Close Visual-Tree Session

```bash
playwright-cli -s=visual-tree close 2>/dev/null || true
```

Mark Phase 2 as completed.

### Phase 3: Source Extraction

Mark Phase 3 as in_progress.

#### 3.1 Row Agent Dispatch

Read `$PROJECT_ROOT/autoresearch/source/rows.json` (produced in step 2.4).
Dispatch one subagent per row **in parallel** using the Agent tool.

**Placeholder resolution** for the row agent prompt:

| Placeholder | Value |
|-------------|-------|
| `[INDEX]` | Row index from `rows.json` (0, 1, ...) |
| `[TOTAL_ROWS]` | Length of `rows.json` rows array |
| `[DESCRIPTION]` | Row description from `rows.json` |
| `[SELECTOR]` | Row CSS selector from `rows.json` |
| `[VT_SUBTREE]` | Row vtSubtree text from `rows.json` |
| `[CSS_QUERY_PATH]` | `$SKILL_HOME/scripts/css-query.js` |
| `[URL]` | `$URL` (from step 1.1) |
| `[BROWSER_RECIPE_FLAG]` | `--browser-recipe=$BROWSER_RECIPE` if set, empty otherwise |
| `[PROJECT_ROOT]` | `$PROJECT_ROOT` |
| `[Y]`, `[HEIGHT]` | Row bounds from `rows.json` |

**Row agent prompt** (customize per row — replace bracketed values):

```
You are extracting content and styles from one row of a website header.

## Your Row

- **Row [INDEX]** of [TOTAL_ROWS]: [DESCRIPTION]
- **CSS selector:** [SELECTOR]
- **Visual tree context:**
[VT_SUBTREE]

## Tools

css-query.js for browser CSS queries:
```bash
node [CSS_QUERY_PATH] open [URL] --session=row-[INDEX] [BROWSER_RECIPE_FLAG]
node [CSS_QUERY_PATH] query "<selector>" "<properties>"
node [CSS_QUERY_PATH] close --session=row-[INDEX]
```

playwright-cli for DOM reads:
```bash
playwright-cli -s=row-[INDEX] eval "<expression>"
```

## Steps

1. Open a css-query session:
   ```bash
   node [CSS_QUERY_PATH] open [URL] --session=row-[INDEX] [BROWSER_RECIPE_FLAG]
   ```

2. Read the row's DOM content:
   ```bash
   playwright-cli -s=row-[INDEX] eval "document.querySelector('[SELECTOR]').innerHTML"
   ```

3. Analyze the DOM to classify elements. Assign each a role:
   logo, nav-link, utility-link, promotional-card, search, icon, cta, text.
   For nav-link elements, also extract children from nested <ul>s —
   including items in hidden submenus (display:none panels). These are
   real navigation links that belong in the output.

3b. For each element, capture its cleaned innerHTML:
    ```bash
    playwright-cli -s=row-[INDEX] eval "
      const el = document.querySelector('<element-selector>').cloneNode(true);
      el.querySelectorAll('script,style,noscript').forEach(n => n.remove());
      el.innerHTML.trim()
    "
    ```
    Store the output as the element's `contentHtml` field.

    For nav-link elements with dropdown/submenu panels, capture the
    panel's innerHTML instead of just the link — this includes nested
    lists, promotional cards, and images.

4. Query CSS values for each element type via css-query:
   ```bash
   node [CSS_QUERY_PATH] query "[SELECTOR]" "background-color, height, padding, font-family"
   node [CSS_QUERY_PATH] query "[SELECTOR] a" "font-size, color, font-weight, letter-spacing"
   ```
   Query each distinct element type separately to avoid mixing styles.

5. Close the session:
   ```bash
   node [CSS_QUERY_PATH] close --session=row-[INDEX]
   ```

6. Write output to [PROJECT_ROOT]/autoresearch/extraction/row-[INDEX].json

## Output Schema

```json
{
  "index": [INDEX],
  "description": "[DESCRIPTION]",
  "bounds": { "y": [Y], "height": [HEIGHT] },
  "suggestedSectionStyle": "<brand|main-nav|utility|top-bar>",
  "elements": [
    {
      "role": "<logo|nav-link|utility-link|cta|search|icon|text>",
      "position": "<left|right|center>",
      "content": { "text": "...", "href": "...", "children": [...] },
      "contentHtml": "<a href=\"...\">...</a><ul>...</ul>",
      "styles": { "font-size": "15px", "color": "rgb(60, 66, 66)" }
    }
  ],
  "rowStyles": {
    "background-color": "...",
    "height": "...",
    "font-family": "..."
  }
}
```

All elements are included regardless of role — nothing is filtered.
The `suggestedSectionStyle` is your best guess for the section-metadata
Style value based on the row's content.

**URL hygiene:** Verify that `href` values don't have doubled extensions
(e.g., `.html.html`). If the source DOM has this, fix it in the output.
```

After all row agents complete, verify the output files:

```bash
for f in $PROJECT_ROOT/autoresearch/extraction/row-*.json; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: Row agent failed — missing $f"
    exit 1
  fi
done
ROW_COUNT=$(ls -1 $PROJECT_ROOT/autoresearch/extraction/row-*.json | wc -l)
echo "Row extraction complete: $ROW_COUNT rows"
```

#### 3.2 Icon Collection

Extract and classify icons from the source header using page-collect:

```bash
# Find the page-collect script
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  PAGE_COLLECT="$(dirname "$CLAUDE_SKILL_DIR")/page-collect/scripts/page-collect.js"
else
  PAGE_COLLECT="$(find ~/.claude -path "*/page-collect/scripts/page-collect.js" -type f 2>/dev/null | head -1)"
fi

if [[ -z "$PAGE_COLLECT" || ! -f "$PAGE_COLLECT" ]]; then
  echo "WARNING: page-collect skill not found. Skipping icon extraction."
  echo "Install: sync page-collect skill to ~/.claude/skills/"
else
  ICON_OUTPUT="$PROJECT_ROOT/autoresearch/extraction/icons"
  RECIPE_ARGS=""
  if [[ -n "$BROWSER_RECIPE" ]]; then
    RECIPE_ARGS="--browser-recipe $BROWSER_RECIPE"
  fi
  # Ensure page-collect dependencies are installed
  PAGE_COLLECT_DIR="$(dirname "$PAGE_COLLECT")"
  if [[ ! -d "$PAGE_COLLECT_DIR/node_modules" ]]; then
    echo "Installing page-collect dependencies..."
    (cd "$PAGE_COLLECT_DIR" && npm install --no-audit --no-fund 2>/dev/null && npx playwright install chromium 2>/dev/null) || true
  fi

  node "$PAGE_COLLECT" icons "$URL" --output "$ICON_OUTPUT" $RECIPE_ARGS 2>/dev/null

  if [[ -f "$ICON_OUTPUT/icons.json" ]]; then
    ICON_COUNT=$(node --input-type=module -e "import {readFileSync} from 'fs'; const d=JSON.parse(readFileSync('$ICON_OUTPUT/icons.json','utf-8')); console.log(d.icons.length)")
    echo "Extracted $ICON_COUNT icons to $ICON_OUTPUT/"
  else
    echo "WARNING: Icon extraction produced no output."
  fi
fi
```

If icon extraction succeeds, Phase 4 (Scaffold) will use the output.
If it fails or page-collect is not installed, the migration continues
without pre-extracted icons (the polish loop handles icons manually).

#### 3.3 Font Detection & Installation

Detect fonts used on the source page and install them in the EDS
project so the AEM dev server renders correct fonts from iteration 1.

**ALWAYS run this step.** Do not skip it based on fonts detected in
earlier steps. Brand-setup uses 4 browser API layers (document.fonts,
CSS import rules, Performance API, computed style voting) which detect
web fonts that CSS extraction alone misses — including fonts loaded via
JavaScript, lazy-loaded fonts, and fonts served from third-party CDNs.
Even when earlier analysis shows only system fonts, brand-setup may
discover web fonts that override them at render time.

**Invoke the brand-setup skill** with `--only=fonts` to detect and
install fonts without running the full brand extraction:

```
/brand-setup $URL --only=fonts --session=brand-fonts \
  --browser-recipe=$BROWSER_RECIPE
```

The brand-setup skill will:
1. Open a browser session on the source URL
2. Detect fonts via 4 browser API layers (document.fonts, CSS import
   rules, Performance API, computed style voting)
3. Resolve each font through the cascade (system → Typekit kit →
   Adobe Fonts add-to-kit → Google Fonts → not-found)
4. Update `head.html` with font `<link>` tags
5. Close the session

After brand-setup completes, copy `fonts-detected.json` to the
extraction directory for the scaffold subagent:

```bash
if [[ -f "$PROJECT_ROOT/fonts-detected.json" ]]; then
  cp "$PROJECT_ROOT/fonts-detected.json" \
    "$PROJECT_ROOT/autoresearch/extraction/fonts-detected.json"
fi
```

**Commit font installation** so font links survive polish loop reverts:

```bash
cd "$PROJECT_ROOT"
git add head.html
git diff --cached --quiet head.html 2>/dev/null || \
  git commit -m "scaffold: install brand fonts in head.html"
```

After this step:
- `head.html` has Typekit or Google Fonts `<link>` tags (committed)
- `fonts-detected.json` available for the scaffold subagent
- The AEM dev server renders pages with correct fonts
- The polish loop's pixelmatch comparison is font-accurate from
  iteration 1 — and reverts can't drop the font links

If brand-setup is not installed or fails, the migration continues
without installed fonts — the polish loop can still converge, just
with more iterations spent on font-related differences.

Mark Phase 3 as completed.

### Phase 4: Scaffold Generation

Mark Phase 4 as in_progress.

This phase copies a battle-tested base header block and then dispatches
a subagent to customize the CSS and generate nav.plain.html from the
extraction data.

**Step 1 — Copy base block files:**

```bash
mkdir -p "$PROJECT_ROOT/blocks/header"
cp "$SKILL_HOME/block-files/header.js" "$PROJECT_ROOT/blocks/header/header.js"
cp "$SKILL_HOME/block-files/header.css" "$PROJECT_ROOT/blocks/header/header.css"
```

The base block (420-line JS, 574-line CSS) handles: multi-section layout
via section-metadata, mega menu auto-detection, 3 mobile dropdown modes
(accordion/slide-in/fullscreen), keyboard navigation, hover gap bridges,
accessibility (aria-haspopup, aria-expanded, aria-label), and DA-wrapped
content selectors. The JS stays as-is. The subagent customizes the CSS
and generates nav.plain.html.

**Step 2 — Dispatch scaffold subagent:**

Read the [scaffold subagent prompt](references/scaffold-prompt.md) and
send it to a subagent. Replace `<PROJECT_ROOT>` and `$SKILL_HOME` with
actual paths before dispatching.

After the subagent completes, verify the files exist:

```bash
for f in blocks/header/header.js blocks/header/header.css nav.plain.html; do
  if [[ ! -f "$PROJECT_ROOT/$f" ]]; then
    echo "ERROR: Scaffold generation failed -- missing $f"
    exit 1
  fi
done
echo "Scaffold committed."
```

Mark Phase 4 as completed.

### Phase 5: Visual Polish

Mark Phase 5 as in_progress.

#### 5.1 Polish Loop Setup

Run the setup script to generate the polish loop infrastructure:

```bash
node "$SKILL_HOME/scripts/setup-polish-loop.js" \
  "--rows-dir=$PROJECT_ROOT/autoresearch/extraction" \
  "--url=$URL" \
  "--source-dir=$PROJECT_ROOT/autoresearch/source" \
  "--target-dir=$PROJECT_ROOT" \
  "--port=3000" \
  "--max-iterations=$MAX_ITERATIONS" \
  "--skill-home=$SKILL_HOME"
```

Verify the generated files exist:

```bash
for f in autoresearch/evaluate.js program.md loop.sh; do
  if [[ ! -f "$PROJECT_ROOT/$f" ]]; then
    echo "ERROR: Polish loop setup failed -- missing $f"
    exit 1
  fi
done
chmod +x "$PROJECT_ROOT/loop.sh"
echo "Polish loop infrastructure ready."
```

#### 5.2 Dev Server + Polish Loop

Start the AEM dev server in the background, then launch the polish loop.

**Start dev server:**

```bash
cd "$PROJECT_ROOT" && aem up --html-folder . &
AEM_PID=$!
echo "AEM dev server starting (PID: $AEM_PID)..."
```

**Wait for server readiness** (poll until 200 response, max 30 seconds):

```bash
TRIES=0
until curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ | grep -q "200"; do
  TRIES=$((TRIES + 1))
  if [[ $TRIES -ge 30 ]]; then
    echo "ERROR: AEM dev server did not start within 30 seconds."
    kill $AEM_PID 2>/dev/null
    exit 1
  fi
  sleep 1
done
echo "AEM dev server ready on http://localhost:3000/"
```

**Launch the polish loop** (this blocks until completion):

```bash
cd "$PROJECT_ROOT" && ./loop.sh 2>&1 | tee autoresearch/results/loop.log
echo "Loop finished. Full log at autoresearch/results/loop.log"
```

The loop runs autonomously. It terminates on:
- 5 consecutive reverted iterations (plateau)
- Reaching `--max-iterations`

Do NOT attempt to control individual iterations. The loop handles
scoring, commit/revert decisions, and termination.

Do NOT wrap the loop with `timeout` or any time limit. Each iteration
takes 8-12 minutes, so 10 iterations needs ~90+ minutes. This is
expected — let it run to completion.

Mark Phase 5 as completed. Then proceed to Phase 6 — do NOT stop here.

### Phase 6: Wrap-up

Mark Phase 6 as in_progress.

#### 6.1 Report

After the loop finishes, clean up and report results.

**Kill dev server:**

```bash
if [[ -n "$AEM_PID" ]]; then
  kill "$AEM_PID" 2>/dev/null
  wait "$AEM_PID" 2>/dev/null
  echo "AEM dev server stopped."
fi
```

**Read results** from `$PROJECT_ROOT/results.tsv`
and `$PROJECT_ROOT/autoresearch/results/latest-evaluation.json`.
Extract: composite score, desktop score, nav completeness,
iteration count (kept vs reverted).

**Report to user** with this format:

```
## Header Migration Complete

**Source:** <URL>
**Branch:** $(git branch --show-current)
**Directory:** <PROJECT_ROOT>

### Final Score
- Composite: <score>%
- Desktop:   <desktop>%
- Nav completeness: <nav>%

### Iterations
- Total: <N> (<kept> kept, <reverted> reverted)

### Next Steps
1. Review the header at <PROJECT_ROOT>/blocks/header/
2. Preview locally: cd <PROJECT_ROOT> && aem up --html-folder .
3. When satisfied, commit and open a PR
```

#### 6.2 Retrospective (required — do not skip)

Read the [retrospective template](references/retrospective-template.md)
and follow its data sources, analysis dimensions, output format, and
user report appendix. Save the retrospective to
`$PROJECT_ROOT/autoresearch/results/retrospective.md` and append
the summary to the user report.

Mark Phase 6 as completed.

## Error Handling

If any step fails, follow this cleanup procedure:

1. Report which phase and step failed, with the error message
2. Report which phases completed successfully before the failure
3. Kill the AEM dev server if it was started:
   ```bash
   if [[ -n "${AEM_PID:-}" ]]; then
     kill "$AEM_PID" 2>/dev/null
   fi
   ```
4. Do NOT delete the autoresearch directory -- it contains partial
   results the user may want to inspect or resume from
5. Tell the user the project path so they can inspect

Example failure report:

```
## Header Migration Failed at Step 3.1 (Row Agent Dispatch)

**Error:** Row agent for row-0 failed — css-query session timed out.

**Phase status:**
- [x] Phase 1: Setup & Validation — completed
- [x] Phase 2: Page Analysis — completed (N nodes, M overlays, header detected)
- [ ] Phase 3: Source Extraction — FAILED at step 3.1 (Row Agent Dispatch)
- [ ] Phase 4: Scaffold Generation — not started
- [ ] Phase 5: Visual Polish — not started
- [ ] Phase 6: Wrap-up — not started

**Suggestion:** Try a different header selector:
  /migrate-header https://example.com --header-selector="nav.main-nav"

**Partial results at:** <PROJECT_ROOT>/autoresearch/
```

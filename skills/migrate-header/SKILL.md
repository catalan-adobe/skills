---
name: migrate-header
description: >
  Migrate any website header to AEM Edge Delivery Services with pixel-accurate
  fidelity using an automated extraction + scaffold + visual polish pipeline.
  Takes a URL, captures a visual tree for spatial analysis, detects and
  dismisses overlays via LLM, identifies the header element from the spatial
  map, captures DOM snapshots, extracts layout and branding, generates scaffold
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
URL --> PARSE --> VALIDATE --> PROBE --> PREPARE --> VIS-TREE --> OVERLAY --> HEADER --> SNAPSHOT --> EXTRACT --> ICONS --> FONTS --> SCAFFOLD --> SETUP --> DEV+POLISH --> REPORT --> RETRO
        (args)    (EDS?)      (CDN)    (mkdir)     (spatial)    (LLM)     (LLM)      (pw-cli)   (scripts)   (collect) (brand)    (LLM)      (files)   (aem+loop)    (score)   (learnings)
```

## Scripts

All deterministic work goes through Node scripts bundled with this skill.
Resolve the skill directory once, then use it for all asset paths:

```bash
SKILL_HOME="${CLAUDE_SKILL_DIR:-$HOME/.claude/skills/migrate-header}"
```

Scripts:
- `node $SKILL_HOME/scripts/capture-snapshot.js <url> <output-dir> [--header-selector=header] [--overlay-recipe=path] [--browser-recipe=path]`
- `node $SKILL_HOME/scripts/extract-layout.js <snapshot.json>` (stdout JSON)
- `node $SKILL_HOME/scripts/extract-styles.js <snapshot.json> <url> [--browser-recipe=path]` (stdout JSON)
- `node $SKILL_HOME/scripts/setup-polish-loop.js --layout=... --styles=... --source-dir=... --target-dir=... --port=3000 --max-iterations=N`
- `node $SKILL_HOME/scripts/css-query.js open <url> [--browser-recipe=path] [--session=name]`
- `node $SKILL_HOME/scripts/css-query.js query <selector|node:N> <properties>`
- `node $SKILL_HOME/scripts/css-query.js cascade <selector|node:N>`
- `node $SKILL_HOME/scripts/css-query.js vars`
- `node $SKILL_HOME/scripts/css-query.js close`

Block-files: `$SKILL_HOME/block-files/header.{js,css}`
Reference docs: `$SKILL_HOME/references/*.md`

See [EDS header conventions](references/eds-header-conventions.md) for block patterns used in scaffold generation.

## Execution

Track state across stages with these variables. Set each one as its
stage completes. Use them in error handling to know what to clean up.

```
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
AEM_PID=""
BROWSER_RECIPE=""
```

### Stage 1: Parse Arguments

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
`HEADER_SELECTOR_EXPLICIT="true"`. Stage 6 uses this to skip
LLM-based header detection.

### Stage 2: Validate EDS Repository

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

### Stage 2b: Browser Probe

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

### Stage 3: Prepare Working Directory

All file operations happen in the current project root. Create the
autoresearch directory structure:

```bash
mkdir -p "$PROJECT_ROOT/autoresearch/source"
mkdir -p "$PROJECT_ROOT/autoresearch/extraction"
mkdir -p "$PROJECT_ROOT/autoresearch/results"
```

### Stage 4: Visual Tree Capture

Capture a spatial hierarchy of the source page using the visual-tree
skill's pre-built bundle. This produces a spatial map consumed by
overlay detection (Stage 5) and header identification (Stage 6).

**Locate the visual-tree bundle:**

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  VT_BUNDLE="$(dirname "$CLAUDE_SKILL_DIR")/visual-tree/scripts/visual-tree-bundle.js"
else
  VT_BUNDLE="$(find ~/.claude \
    -path "*/visual-tree/scripts/visual-tree-bundle.js" \
    -type f 2>/dev/null | head -1)"
fi
```

If the bundle is not found, log a warning and skip to Stage 7 (Snapshot
Capture). Overlay detection falls back to page-prep if available; header
detection falls back to `--header-selector` or `header` tag default.

**Open a session, navigate, and capture:**

```bash
# Build config with browser recipe if available
VT_CONFIG="/tmp/vt-config-$$.json"
if [[ -n "$BROWSER_RECIPE" && -f "$BROWSER_RECIPE" ]]; then
  cp "$BROWSER_RECIPE" "$VT_CONFIG"
else
  echo '{}' > "$VT_CONFIG"
fi

playwright-cli -s=visual-tree --config="$VT_CONFIG" open "$URL"

# Wait for page load
playwright-cli -s=visual-tree eval "await new Promise(r => {
  if (document.readyState === 'complete') return r();
  window.addEventListener('load', r);
})"

# Inject bundle and capture with minWidth=1024
VT_RESULT=$(playwright-cli -s=visual-tree eval "(() => {
  $(cat "$VT_BUNDLE")
  globalThis.__visualTree = __visualTree;
  var r = __visualTree.captureVisualTree(1024);
  return JSON.stringify({
    textFormat: r.textFormat,
    data: r.data,
    nodeMap: r.nodeMap,
    rootBackground: r.rootBackground,
    rootBackgroundInfo: r.rootBackgroundInfo,
  });
})()")

rm -f "$VT_CONFIG"
```

**Parse and save artifacts:**

Parse `VT_RESULT` (strip playwright-cli output markers if present)
and save three files:

```bash
echo "$VT_RESULT" | node --input-type=module -e "
  import { readFileSync, writeFileSync } from 'fs';
  const raw = readFileSync('/dev/stdin', 'utf-8');
  const idx = raw.indexOf('{');
  const json = raw.slice(idx);
  const result = JSON.parse(json);

  const outDir = '$PROJECT_ROOT/autoresearch/source';

  // Full visual-tree output
  writeFileSync(outDir + '/visual-tree.json',
    JSON.stringify(result, null, 2));

  // Text format for LLM consumption
  writeFileSync(outDir + '/visual-tree.txt', result.textFormat);

  // Extract overlay entries from nodeMap
  const overlays = [];
  for (const [id, info] of Object.entries(result.nodeMap)) {
    if (info.overlay) {
      // Find matching node in tree for bounds and text
      const node = findNode(result.data, id);
      overlays.push({
        nodeId: id,
        selector: info.selector,
        occluding: info.overlay.occluding,
        bounds: node?.bounds || null,
        text: node?.text || null,
      });
    }
  }
  writeFileSync(outDir + '/overlays.json',
    JSON.stringify(overlays, null, 2));

  function findNode(tree, targetId, currentId = 'r') {
    if (currentId === targetId) return tree;
    for (let i = 0; i < (tree.children || []).length; i++) {
      const found = findNode(
        tree.children[i], targetId, currentId + 'c' + (i + 1)
      );
      if (found) return found;
    }
    return null;
  }

  console.error('Visual tree captured:');
  console.error('  ' + result.textFormat.split('\\n').length + ' nodes');
  console.error('  ' + overlays.length + ' overlays detected');
"
```

Verify the output exists:

```bash
if [[ ! -f "$PROJECT_ROOT/autoresearch/source/visual-tree.json" ]]; then
  echo "WARNING: Visual tree capture failed. Falling back to legacy pipeline."
  playwright-cli -s=visual-tree close 2>/dev/null
fi
```

**Keep the session open** — it will be used for overlay dismissal and
header detection. Do NOT close it here.

### Stage 5: Overlay Detection and Dismissal

If `--overlay-recipe` was provided, copy it into the project and skip
to Stage 6:

```bash
cp "$OVERLAY_RECIPE" "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
```

Otherwise, use visual-tree data to detect and dismiss overlays.

**If visual-tree capture succeeded** (Stage 4 produced
`autoresearch/source/overlays.json`):

Read `overlays.json`. If the array is empty, write an empty recipe and
skip to Stage 6:

```bash
OVERLAY_COUNT=$(node --input-type=module -e "
  import { readFileSync } from 'fs';
  const overlays = JSON.parse(readFileSync(
    '$PROJECT_ROOT/autoresearch/source/overlays.json', 'utf-8'));
  console.log(overlays.length);
")

if [[ "$OVERLAY_COUNT" -eq 0 ]]; then
  echo '[]' > "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
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
   playwright-cli -s=visual-tree eval "
     const el = document.querySelector('${OVERLAY_SELECTOR}');
     const buttons = [...el.querySelectorAll('button, a, [role=button]')];
     JSON.stringify(buttons.map(b => ({
       text: b.textContent.trim().slice(0, 50),
       tag: b.tagName,
     })));
   "
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

After all overlays are handled, write the recipe:

```bash
# Write overlay-recipe.json with all recorded actions
echo '<JSON array of {action, selector} objects>' \
  > "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
```

**If visual-tree capture failed** (no `overlays.json`):

Fall back to page-prep if available. Locate page-prep scripts:

```bash
PAGE_PREP_DIR="$(dirname "$SKILL_HOME")/page-prep/scripts"
```

If page-prep scripts are not found, write an empty recipe:

```bash
if [[ -z "$PAGE_PREP_DIR" || ! -f "$PAGE_PREP_DIR/overlay-db.js" ]]; then
  echo '[]' > "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
  echo "Warning: No overlay detection available. Using empty recipe."
fi
```

If page-prep is available, run the legacy overlay detection flow.

**Refresh database and generate bundle:**

```bash
node "$PAGE_PREP_DIR/overlay-db.js" refresh
BUNDLE_FILE="/tmp/overlay-bundle-$$.js"
# Wrap the bundle IIFE so initScript stores the result in a global
node -e "
  const fs = require('fs');
  const { execSync } = require('child_process');
  const bundle = execSync('node $PAGE_PREP_DIR/overlay-db.js bundle', { encoding: 'utf-8' });
  fs.writeFileSync('$BUNDLE_FILE', 'window.__overlayReport = ' + bundle + ';');
"
```

**Inject via headless playwright-cli:**

Open the URL with the overlay bundle as an `initScript` so it runs
before any page JS. Build a playwright-cli config file that includes
the bundle path and any browser-recipe settings.

```bash
# Build playwright-cli config with initScript for the bundle
OVERLAY_CONFIG="/tmp/overlay-detect-config-$$.json"
node -e "
  const fs = require('fs');
  const config = { browser: { initScript: ['$BUNDLE_FILE'] } };
  const recipePath = '$BROWSER_RECIPE';
  if (recipePath && fs.existsSync(recipePath)) {
    const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf-8'));
    const cli = recipe.cliConfig || {};
    Object.assign(config.browser, cli.browser || {});
    if (recipe.stealthInitScript) {
      const stealthFile = '/tmp/overlay-stealth-$$.js';
      fs.writeFileSync(stealthFile, recipe.stealthInitScript);
      config.browser.initScript.unshift(stealthFile);
    }
  }
  fs.writeFileSync('$OVERLAY_CONFIG', JSON.stringify(config, null, 2));
"

playwright-cli -s=overlay-detect --config="$OVERLAY_CONFIG" open "$URL"

# The bundle ran via initScript on page load. Now extract the report
# by reading the global result the bundle sets.
REPORT_RAW=$(playwright-cli -s=overlay-detect eval "JSON.stringify(window.__overlayReport || {})")
playwright-cli -s=overlay-detect close
rm -f "$OVERLAY_CONFIG" "/tmp/overlay-stealth-$$.js" "$BUNDLE_FILE"
```

**Convert detection report to overlay recipe:**

The detection report contains an `overlays` array with selectors for
each detected overlay. Extract all selectors and write the recipe in
the format `capture-snapshot.js` expects:

```bash
echo "$REPORT_RAW" | node -e "
  const raw = require('fs').readFileSync('/dev/stdin', 'utf-8');
  const idx = raw.indexOf('### Result');
  const end = raw.indexOf('### Ran Playwright code');
  const json = idx === -1
    ? raw.trim()
    : raw.slice(idx + 10, end === -1 ? undefined : end).trim();
  try {
    const parsed = json.startsWith('\"') ? JSON.parse(json) : json;
    const report = JSON.parse(parsed);
    const selectors = (report.overlays || [])
      .map(o => o.selector).filter(Boolean);
    console.log(JSON.stringify({ selectors, action: 'remove' }, null, 2));
  } catch {
    console.log(JSON.stringify({ selectors: [], action: 'remove' }, null, 2));
  }
" > "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
```

Verify the recipe file exists:

```bash
if [[ ! -f "$PROJECT_ROOT/autoresearch/overlay-recipe.json" ]]; then
  echo '{ "selectors": [], "action": "remove" }' > "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
  echo "Warning: Overlay detection produced no recipe. Using empty recipe."
fi
```

### Stage 6: Header Element Detection

If `--header-selector` was explicitly provided, use it directly and skip
detection:

```bash
if [[ "$HEADER_SELECTOR_EXPLICIT" == "true" ]]; then
  echo "Using explicit header selector: $HEADER_SELECTOR"
fi
```

Otherwise, use visual-tree data to identify the header element.

**If visual-tree capture succeeded** (Stage 4 produced
`autoresearch/source/visual-tree.txt`):

Present the visual-tree text format to the LLM. The LLM identifies the
header node based on:
- Position (near top of page, after any announcement bars)
- Width (spans full or near-full viewport)
- Height (relatively short — under ~200px vs hero/content sections)
- Content (navigation text, grid layouts suggesting nav link rows)
- ARIA roles (`[navigation]` role annotation)

The LLM should exclude nodes already identified as overlays in Stage 5.

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

**Close the visual-tree session** (no longer needed):

```bash
playwright-cli -s=visual-tree close
```

**If visual-tree capture failed** (no `visual-tree.txt`):

Fall back to the default `header` selector (or `--header-selector` if
it was provided). Log a warning:

```bash
echo "Warning: Visual tree not available. Using default selector: $HEADER_SELECTOR"
```

### Stage 7: Snapshot Capture

Run the capture script via Bash:

```bash
RECIPE_FLAG=""
if [[ -n "$BROWSER_RECIPE" ]]; then
  RECIPE_FLAG="--browser-recipe=$BROWSER_RECIPE"
fi

node "$SKILL_HOME/scripts/capture-snapshot.js" \
  "$URL" \
  "$PROJECT_ROOT/autoresearch/source" \
  "--header-selector=$HEADER_SELECTOR" \
  "--overlay-recipe=$PROJECT_ROOT/autoresearch/overlay-recipe.json" \
  $RECIPE_FLAG
```

Verify output files exist:

```bash
for f in snapshot.json desktop.png; do
  if [[ ! -f "$PROJECT_ROOT/autoresearch/source/$f" ]]; then
    echo "ERROR: Snapshot capture failed -- missing $f"
    exit 1
  fi
done
echo "Snapshot capture complete."
```

If capture fails, suggest: different `--header-selector`, manual `--overlay-recipe`, or retry.

### Stage 8: Extraction

Run layout extraction (from snapshot, no browser needed):

```bash
node "$SKILL_HOME/scripts/extract-layout.js" \
  "$PROJECT_ROOT/autoresearch/source/snapshot.json" \
  > "$PROJECT_ROOT/autoresearch/extraction/layout.json"
```

Run style extraction (opens a css-query session on the source URL):

```bash
RECIPE_FLAG=""
if [[ -n "$BROWSER_RECIPE" ]]; then
  RECIPE_FLAG="--browser-recipe=$BROWSER_RECIPE"
fi

node "$SKILL_HOME/scripts/extract-styles.js" \
  "$PROJECT_ROOT/autoresearch/source/snapshot.json" \
  "$URL" \
  $RECIPE_FLAG \
  > "$PROJECT_ROOT/autoresearch/extraction/styles.json"
```

After extraction, read both JSON files and log a summary:

```
Extracted layout: <N> rows, <height>px total header height, <N> nav items
Extracted styles: font-family: <family>, nav color: <color>, <N> custom properties
```

If either script fails, report the error and stop.

### Stage 8b: Icon Collection

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
  node "$PAGE_COLLECT" icons "$URL" --output "$ICON_OUTPUT" $RECIPE_ARGS

  if [[ -f "$ICON_OUTPUT/icons.json" ]]; then
    ICON_COUNT=$(node --input-type=module -e "import {readFileSync} from 'fs'; const d=JSON.parse(readFileSync('$ICON_OUTPUT/icons.json','utf-8')); console.log(d.icons.length)")
    echo "Extracted $ICON_COUNT icons to $ICON_OUTPUT/"
  else
    echo "WARNING: Icon extraction produced no output."
  fi
fi
```

If icon extraction succeeds, the scaffold stage will use the output.
If it fails or page-collect is not installed, the migration continues
without pre-extracted icons (the polish loop handles icons manually).

### Stage 8c: Brand Font Detection & Installation

Detect fonts used on the source page and install them in the EDS
project so the AEM dev server renders correct fonts from iteration 1.

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

After this stage:
- `head.html` has Typekit or Google Fonts `<link>` tags (committed)
- `fonts-detected.json` available for the scaffold subagent
- The AEM dev server renders pages with correct fonts
- The polish loop's pixelmatch comparison is font-accurate from
  iteration 1 — and reverts can't drop the font links

If brand-setup is not installed or fails, the migration continues
without installed fonts — the polish loop can still converge, just
with more iterations spent on font-related differences.

### Stage 9: Scaffold Generation

This stage copies a battle-tested base header block and then dispatches
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

The subagent receives this prompt:

```
You are customizing an EDS header block for a specific website. The
header.js is already in place and must NOT be modified. You will:
1. Customize the CSS custom properties in header.css
2. Generate nav.plain.html from extraction data

## Input Data

Read these files:
- Layout: <PROJECT_ROOT>/autoresearch/extraction/layout.json
- Styles: <PROJECT_ROOT>/autoresearch/extraction/styles.json
- Fonts (if exists): <PROJECT_ROOT>/autoresearch/extraction/fonts-detected.json

styles.json contains CDP-queried CSS values with provenance (which
rule, which file, whether inherited). Use these directly — they are
the source of truth for all styling decisions.

If fonts-detected.json exists, use its `fonts.heading.stack` and
`fonts.body.stack` values for `font-family` in header.css. These
are the actual rendered fonts detected from the source page, and
the corresponding font files are already installed in head.html.

## Reference Docs

Read ALL of these for patterns and mapping guidance:
- $SKILL_HOME/references/eds-header-conventions.md
- $SKILL_HOME/references/content-mapping.md
- $SKILL_HOME/references/styling-guide.md
- $SKILL_HOME/references/header-block-guide.md

## Task 1: Customize header.css

Open <PROJECT_ROOT>/blocks/header/header.css and update ONLY the CSS
custom properties block at the top (.header.block { ... }) to match the
source site's styles from styles.json.

**Properties to set (all from styles.json):**
- --header-background: from styles.header["background-color"].value
- --header-nav-gap: from styles.navSpacing.value (spatially measured)
- --header-nav-font-size: from styles.navLinks["font-size"].value
- --header-nav-font-weight: from styles.navLinks["font-weight"].value
- font-family: from styles.navLinks["font-family"].value
- --header-text-color: from styles.navLinks.color.value
- --header-section-padding: from styles.header.padding.value
- For multi-row headers: styles.rows[N]["background-color"].value
- For CTA buttons: styles.cta (background-color, color, border-radius)
- Accent/hover color: styles.navLinksHover.color.value

Do NOT modify the structural CSS (layout, dropdowns, etc.).

## Task 2: Generate nav.plain.html

Create <PROJECT_ROOT>/nav.plain.html following the content-mapping
guide patterns. Use the extraction data:

- layout.rows tells you the section structure (brand, main-nav, etc.)
- layout.navItems.primary are the main nav links
- layout.navItems.secondary are secondary/utility links
- layout.rows[].elements tells you what each section contains
- layout.logo has the logo image data (src, alt, width, height, href)
- branding.logo also has the logo image data (src, alt, width, height)

### Logo Handling

If layout.logo or branding.logo has a src URL:

Use `layout.logo` as the primary source (it includes `href`).
Fall back to `branding.logo` only if `layout.logo` is null;
use `href="/"` in that case since `branding.logo` has no link.

1. Download the logo image to <PROJECT_ROOT>/images/logo.png (or
   matching extension). Use curl or fetch.
2. In nav.plain.html, use the local path:
   `<p><a href="<logo.href>"><img src="./images/logo.png" alt="<logo.alt>"></a></p>`

If no logo URL is available, use text: `<p><a href="/">Company Name</a></p>`

Each section needs a section-metadata block with Style property.
See content-mapping.md for exact HTML patterns per section type.

For single-row headers (1 row): use a single main-nav section with
inline brand and tools.

For multi-row headers: use separate sections (brand, main-nav, utility)
each with their own section-metadata.

## Task 3: Wire extracted icons into EDS

If `<PROJECT_ROOT>/autoresearch/extraction/icons/icons.json` exists:

1. Read the icon manifest
2. Copy all SVG files from `<PROJECT_ROOT>/autoresearch/extraction/icons/icons/`
   to `<PROJECT_ROOT>/icons/`
3. In nav.plain.html, use `:iconname:` notation for icons that appear
   in the tools/utility section. For example, if the manifest has a
   "search" icon, use `:search:` where a search button appears.
4. For the logo, if the manifest has a "logo" class icon, use `:logo:`
   in the brand section instead of an `<img>` tag.

The EDS `decorateIcons()` function in `aem.js` automatically converts
`:iconname:` to `<span class="icon icon-{name}"><img src="/icons/{name}.svg">`
at runtime. Do NOT create inline SVGs for icons in the manifest.

If the icon manifest does not exist, skip this task — icons will be
handled by the polish loop instead.

## After Generating

Stage and commit:
  cd <PROJECT_ROOT>
  git add blocks/header/header.css nav.plain.html images/ icons/
  git commit -m "scaffold: customize header CSS and generate nav content"
```

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

### Stage 10: Polish Loop Setup

Run the setup script to generate the polish loop infrastructure:

```bash
node "$SKILL_HOME/scripts/setup-polish-loop.js" \
  "--layout=$PROJECT_ROOT/autoresearch/extraction/layout.json" \
  "--styles=$PROJECT_ROOT/autoresearch/extraction/styles.json" \
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

### Stage 11: Dev Server + Polish Loop

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
cd "$PROJECT_ROOT" && ./loop.sh
```

The loop runs autonomously. It terminates on:
- 5 consecutive reverted iterations (plateau)
- Reaching `--max-iterations`

Do NOT attempt to control individual iterations. The loop handles
scoring, commit/revert decisions, and termination.

### Stage 12: Report

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

### Stage 13: Retrospective

After reporting results, analyze the full migration run to extract
learnings that could improve the skill for future header migrations.

**Read all data sources:**

1. `$PROJECT_ROOT/results.tsv` — iteration scores and keep/revert decisions
2. `$PROJECT_ROOT/autoresearch/results/latest-evaluation.json` — detailed score breakdown
3. `$PROJECT_ROOT/autoresearch/extraction/layout.json` — extracted layout structure
4. `$PROJECT_ROOT/autoresearch/extraction/styles.json` — CDP-extracted CSS values
5. `$PROJECT_ROOT/autoresearch/overlay-recipe.json` — overlays detected
6. Source screenshots in `$PROJECT_ROOT/autoresearch/source/` — visual reference
7. `git log --oneline` — changes made during polish

**Analyze these dimensions:**

| Dimension | Evidence | What it reveals |
|-----------|----------|-----------------|
| Extraction accuracy | Compare styles.json values against final CSS custom properties in header.css | Whether extraction scripts need calibration |
| Scaffold quality | First iteration score in results.tsv | How good the initial code generation was |
| Convergence pattern | Score trajectory and revert rate across iterations | Whether the polish loop guidance is effective |
| Desktop fidelity | Desktop visual score in evaluation | Whether scaffold and polish loop guidance are effective |
| Nav completeness | Nav score in evaluation vs layout.json navItems count | Whether content mapping missed items |
| Overlay handling | Overlay recipe contents vs capture quality | Whether overlay detection was sufficient |
| Bot protection | probe-report.json vs firstSuccess config | Whether probe correctly identified protection and recipe worked |

**Generate the retrospective:**

Save to `$PROJECT_ROOT/autoresearch/results/retrospective.md` using
this structure:

```markdown
# Migration Retrospective: <domain>

## Summary
- Source: <URL>
- Final composite: <score>% | Desktop: <d>%
- Iterations: <kept>/<total> kept (<revert_rate>% revert rate)
- Header type: <single-row|multi-row|mega-menu|etc.>

## What Worked (Reinforcements)
<!-- Concrete patterns the pipeline handled well. Include evidence:
     "Brand color extraction (#1a2b3c) matched source exactly — zero
     iterations spent fixing colors." -->

- <finding with evidence>

## What Struggled (Improvement Opportunities)
<!-- Areas where the pipeline underperformed. Include evidence:
     "Mobile hamburger menu took 8 iterations to converge, 4 reverted
     — the scaffold default for slide-in mode didn't match the source
     fullscreen overlay pattern." -->

- <finding with evidence>

## Pattern Notes
<!-- Header-type observations useful for future migrations of similar
     headers. E.g., "Mega menu with icon grid: extraction captured
     grid dimensions but not icon placement — needed manual column
     template in polish loop." -->

- <observation>

## Recommendations for Skill Improvement
<!-- Actionable suggestions: script changes, new reference patterns,
     CSS defaults, extraction improvements. Be specific enough that
     someone could file an issue or write a patch. -->

- <suggestion>
```

**Report to user** after the Stage 12 results, appending:

```
### Retrospective

Learnings from this migration saved to:
<PROJECT_ROOT>/autoresearch/results/retrospective.md

**Reinforcements:** <1-2 sentence summary of what worked>
**Improvements:** <1-2 sentence summary of what struggled>

Review the full retrospective for detailed findings and skill
improvement recommendations.
```

## Error Handling

If any stage fails, follow this cleanup procedure:

1. Report which stage failed and the error message
2. Report what completed successfully before the failure
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
## Header Migration Failed at Stage 7 (Snapshot Capture)

**Error:** Header selector '.site-header' not found in page DOM.

**Completed stages:**
- [x] Stage 1: Arguments parsed (URL: https://example.com)
- [x] Stage 2: EDS repository validated
- [x] Stage 2b: Browser probe (no bot protection / stealth config)
- [x] Stage 3: Working directory prepared
- [x] Stage 4: Visual tree captured (N nodes, M overlays)
- [x] Stage 5: Overlay detection (2 overlays dismissed)
- [x] Stage 6: Header detected (selector: header.site-header)
- [ ] Stage 7: Snapshot capture -- FAILED

**Suggestion:** Try a different header selector:
  /migrate-header https://example.com --header-selector="nav.main-nav"

**Partial results at:** <PROJECT_ROOT>/autoresearch/
```

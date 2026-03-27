---
name: migrate-header
description: >
  Migrate any website header to AEM Edge Delivery Services with pixel-accurate
  fidelity using an automated extraction + scaffold + visual polish pipeline.
  Takes a URL, runs overlay detection, captures DOM snapshots, extracts layout
  and branding, generates scaffold code, then launches an autonomous visual
  polish loop. Requires being in an EDS git repository. Works in the current
  directory — the caller is responsible for worktree/branch setup if isolation
  is needed. Triggers on: "migrate header", "header migration",
  "migrate-header", "/migrate-header", "convert header to EDS",
  "EDS header from URL".
---

# Migrate Header

Migrate any website header to AEM Edge Delivery Services. The pipeline
captures the source header, extracts layout and branding data, generates
an EDS-compatible scaffold, then runs an autonomous visual polish loop
to converge on pixel-accurate fidelity.

## Pipeline Overview

```
URL --> PARSE --> VALIDATE --> OVERLAY --> SNAPSHOT --> EXTRACT --> SCAFFOLD --> SETUP --> DEV+POLISH --> REPORT --> RETRO
        (args)    (EDS?)      (LLM)     (pw-cli)   (scripts)    (LLM)      (files)   (aem+loop)    (score)   (learnings)
```

## Scripts

All deterministic work goes through Node scripts bundled with this skill.
Resolve the skill directory once, then use it for all asset paths:

```bash
SKILL_HOME="${CLAUDE_SKILL_DIR:-$HOME/.claude/skills/migrate-header}"
```

Scripts:
- `node $SKILL_HOME/scripts/capture-snapshot.js <url> <output-dir> [--header-selector=header] [--overlay-recipe=path]`
- `node $SKILL_HOME/scripts/extract-layout.js <snapshot.json>` (stdout JSON)
- `node $SKILL_HOME/scripts/extract-branding.js <snapshot.json>` (stdout JSON)
- `node $SKILL_HOME/scripts/setup-polish-loop.js --layout=... --branding=... --source-dir=... --target-dir=... --port=3000 --max-iterations=N`

Block-files: `$SKILL_HOME/block-files/header.{js,css}`
Reference docs: `$SKILL_HOME/references/*.md`

See [EDS header conventions](references/eds-header-conventions.md) for block patterns used in scaffold generation.

## Execution

Track state across stages with these variables. Set each one as its
stage completes. Use them in error handling to know what to clean up.

```
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
AEM_PID=""
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
OVERLAY_RECIPE="${overlay_recipe:-}"
MAX_ITERATIONS="${max_iterations:-30}"
```

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

### Stage 3: Prepare Working Directory

All file operations happen in the current project root. Create the
autoresearch directory structure:

```bash
mkdir -p "$PROJECT_ROOT/autoresearch/source"
mkdir -p "$PROJECT_ROOT/autoresearch/extraction"
mkdir -p "$PROJECT_ROOT/autoresearch/results"
```

### Stage 4: Overlay Detection

If `--overlay-recipe` was provided, copy it into the project and skip
to Stage 5:

```bash
cp "$OVERLAY_RECIPE" "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
```

Otherwise, detect overlays using the page-prep skill's CMP database
(300+ known consent managers) via headless playwright-cli.

**Locate page-prep scripts** (sibling skill):

```bash
PAGE_PREP_DIR="$(dirname "$SKILL_HOME")/page-prep/scripts"
```

If page-prep scripts are not found, write an empty recipe and skip to
Stage 5:

```bash
if [[ -z "$PAGE_PREP_DIR" || ! -f "$PAGE_PREP_DIR/overlay-db.js" ]]; then
  echo '{ "selectors": [], "action": "remove" }' > "$PROJECT_ROOT/autoresearch/overlay-recipe.json"
  echo "Warning: page-prep scripts not found. Skipping overlay detection."
fi
```

**Refresh database and generate bundle:**

```bash
node "$PAGE_PREP_DIR/overlay-db.js" refresh
BUNDLE="$(node "$PAGE_PREP_DIR/overlay-db.js" bundle)"
```

**Inject via headless playwright-cli:**

Open the URL, inject the page-prep detection bundle, and capture the
detection report. playwright-cli runs headless by default.

```bash
playwright-cli -s=overlay-detect open "$URL"
REPORT_RAW=$(playwright-cli -s=overlay-detect eval "$BUNDLE")
playwright-cli -s=overlay-detect close
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

### Stage 5: Snapshot Capture

Run the capture script via Bash:

```bash
node "$SKILL_HOME/scripts/capture-snapshot.js" \
  "$URL" \
  "$PROJECT_ROOT/autoresearch/source" \
  "--header-selector=$HEADER_SELECTOR" \
  "--overlay-recipe=$PROJECT_ROOT/autoresearch/overlay-recipe.json"
```

Verify output files exist:

```bash
for f in snapshot.json desktop.png tablet.png mobile.png; do
  if [[ ! -f "$PROJECT_ROOT/autoresearch/source/$f" ]]; then
    echo "ERROR: Snapshot capture failed -- missing $f"
    exit 1
  fi
done
echo "Snapshot capture complete."
```

If capture fails, suggest: different `--header-selector`, manual `--overlay-recipe`, or retry.

### Stage 6: Extraction

Run both extraction scripts via Bash:

```bash
node "$SKILL_HOME/scripts/extract-layout.js" \
  "$PROJECT_ROOT/autoresearch/source/snapshot.json" \
  > "$PROJECT_ROOT/autoresearch/extraction/layout.json"

node "$SKILL_HOME/scripts/extract-branding.js" \
  "$PROJECT_ROOT/autoresearch/source/snapshot.json" \
  > "$PROJECT_ROOT/autoresearch/extraction/branding.json"
```

After extraction, read both JSON files and log a summary:

```
Extracted layout: <N> rows, <height>px total header height, <N> nav items
Extracted branding: font-family: <family>, primary-bg: <color>, primary-text: <color>
```

If either script fails, report the error and stop.

### Stage 7: Scaffold Generation

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
- Branding: <PROJECT_ROOT>/autoresearch/extraction/branding.json

## Reference Docs

Read ALL of these for patterns and mapping guidance:
- $SKILL_HOME/references/eds-header-conventions.md
- $SKILL_HOME/references/content-mapping.md
- $SKILL_HOME/references/styling-guide.md
- $SKILL_HOME/references/header-block-guide.md

## Task 1: Customize header.css

Open <PROJECT_ROOT>/blocks/header/header.css and update ONLY the CSS
custom properties block at the top (.header.block { ... }) to match the
extracted branding:

- --header-background: use branding.colors.main-bar-bg
- --header-nav-gap: use branding.spacing.nav-gap
- --header-nav-font-size: use branding.fonts.nav-size
- --header-nav-font-weight: use branding.fonts.nav-weight
- --header-section-padding: use branding.spacing.header-padding-x
- Add font-family from branding.fonts.family
- Add --header-text-color from branding.colors.text-primary
- For multi-row headers: add section-specific background colors
  (e.g., .header-brand { background: <brand-bar-bg> })
- For CTA buttons: add .header-tools-inline a:last-child styles with
  branding.colors.cta-bg, cta-text, and decorations.cta-border-radius

Do NOT modify the structural CSS (layout, mobile, dropdowns, etc.).

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

## After Generating

Stage and commit:
  cd <PROJECT_ROOT>
  git add blocks/header/header.css nav.plain.html images/
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

### Stage 8: Polish Loop Setup

Run the setup script to generate the polish loop infrastructure:

```bash
node "$SKILL_HOME/scripts/setup-polish-loop.js" \
  "--layout=$PROJECT_ROOT/autoresearch/extraction/layout.json" \
  "--branding=$PROJECT_ROOT/autoresearch/extraction/branding.json" \
  "--source-dir=$PROJECT_ROOT/autoresearch/source" \
  "--target-dir=$PROJECT_ROOT" \
  "--port=3000" \
  "--max-iterations=$MAX_ITERATIONS"
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

### Stage 9: Dev Server + Polish Loop

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

### Stage 10: Report

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
Extract: composite score, desktop/tablet/mobile scores, nav completeness,
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
- Tablet:    <tablet>%
- Mobile:    <mobile>%
- Nav completeness: <nav>%

### Iterations
- Total: <N> (<kept> kept, <reverted> reverted)

### Next Steps
1. Review the header at <PROJECT_ROOT>/blocks/header/
2. Preview locally: cd <PROJECT_ROOT> && aem up --html-folder .
3. When satisfied, commit and open a PR
```

### Stage 11: Retrospective

After reporting results, analyze the full migration run to extract
learnings that could improve the skill for future header migrations.

**Read all data sources:**

1. `$PROJECT_ROOT/results.tsv` — iteration scores and keep/revert decisions
2. `$PROJECT_ROOT/autoresearch/results/latest-evaluation.json` — detailed score breakdown
3. `$PROJECT_ROOT/autoresearch/extraction/layout.json` — extracted layout structure
4. `$PROJECT_ROOT/autoresearch/extraction/branding.json` — extracted branding values
5. `$PROJECT_ROOT/autoresearch/overlay-recipe.json` — overlays detected
6. Source screenshots in `$PROJECT_ROOT/autoresearch/source/` — visual reference
7. `git log --oneline` — changes made during polish

**Analyze these dimensions:**

| Dimension | Evidence | What it reveals |
|-----------|----------|-----------------|
| Extraction accuracy | Compare branding.json values against final CSS custom properties in header.css | Whether extraction scripts need calibration |
| Scaffold quality | First iteration score in results.tsv | How good the initial code generation was |
| Convergence pattern | Score trajectory and revert rate across iterations | Whether the polish loop guidance is effective |
| Breakpoint fidelity | Desktop vs tablet vs mobile scores in evaluation | Which viewport needs better scaffold defaults |
| Nav completeness | Nav score in evaluation vs layout.json navItems count | Whether content mapping missed items |
| Overlay handling | Overlay recipe contents vs capture quality | Whether overlay detection was sufficient |

**Generate the retrospective:**

Save to `$PROJECT_ROOT/autoresearch/results/retrospective.md` using
this structure:

```markdown
# Migration Retrospective: <domain>

## Summary
- Source: <URL>
- Final composite: <score>% | Desktop: <d>% | Tablet: <t>% | Mobile: <m>%
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

**Report to user** after the Stage 10 results, appending:

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
## Header Migration Failed at Stage 5 (Snapshot Capture)

**Error:** Header selector '.site-header' not found in page DOM.

**Completed stages:**
- [x] Stage 1: Arguments parsed (URL: https://example.com)
- [x] Stage 2: EDS repository validated
- [x] Stage 3: Working directory prepared
- [x] Stage 4: Overlay detection (2 overlays found)
- [ ] Stage 5: Snapshot capture -- FAILED

**Suggestion:** Try a different header selector:
  /migrate-header https://example.com --header-selector="nav.main-nav"

**Partial results at:** <PROJECT_ROOT>/autoresearch/
```

---
name: migrate-header
description: >
  Migrate any website header to AEM Edge Delivery Services with pixel-accurate
  fidelity using an automated extraction + scaffold + visual polish pipeline.
  Takes a URL, creates a worktree, runs overlay detection, captures DOM snapshots,
  extracts layout and branding, generates scaffold code, then launches an
  autonomous visual polish loop. Requires being in an EDS git repository.
  Triggers on: "migrate header", "header migration", "migrate-header",
  "/migrate-header", "convert header to EDS", "EDS header from URL".
---

# Migrate Header

Migrate any website header to AEM Edge Delivery Services. The pipeline
captures the source header, extracts layout and branding data, generates
an EDS-compatible scaffold, then runs an autonomous visual polish loop
to converge on pixel-accurate fidelity.

## Pipeline Overview

```
URL --> PARSE --> VALIDATE --> WORKTREE --> OVERLAY --> SNAPSHOT --> EXTRACT --> SCAFFOLD --> SETUP --> DEV+POLISH --> REPORT
        (args)    (EDS?)    (git branch)   (LLM)     (pw-cli)   (scripts)    (LLM)      (files)   (aem+loop)    (score)
```

## Scripts

All deterministic work goes through Node scripts bundled with this skill.

**Locating scripts:** Use `${CLAUDE_SKILL_DIR}` to resolve paths:

```bash
SKILL_SCRIPTS="${CLAUDE_SKILL_DIR}/scripts"
```

If `CLAUDE_SKILL_DIR` is not set, fall back:
`SKILL_SCRIPTS="$(find ~/.claude -path "*/migrate-header/scripts" -type d 2>/dev/null | head -1)"`

Available scripts:
- `capture-snapshot.js` -- `node $SKILL_SCRIPTS/capture-snapshot.js <url> <output-dir> [--header-selector=header] [--overlay-recipe=path]`
- `extract-layout.js` -- `node $SKILL_SCRIPTS/extract-layout.js <snapshot.json>` (stdout JSON)
- `extract-branding.js` -- `node $SKILL_SCRIPTS/extract-branding.js <snapshot.json>` (stdout JSON)
- `setup-polish-loop.js` -- `node $SKILL_SCRIPTS/setup-polish-loop.js --layout=... --branding=... --source-dir=... --target-dir=... --port=3000 --max-iterations=N`

See [EDS header conventions](references/eds-header-conventions.md) for block patterns used in scaffold generation.

## Execution

Track state across stages with these variables. Set each one as its
stage completes. Use them in error handling to know what to clean up.

```
WORKTREE_PATH=""
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

### Stage 3: Create Worktree

Sanitize the domain from the URL, create a git worktree for all pipeline work.

```bash
# Extract domain and sanitize for branch name
DOMAIN=$(echo "$URL" | sed -E 's|https?://||; s|/.*||; s|[^a-zA-Z0-9]|-|g')
BRANCH="header-migration-${DOMAIN}"
WORKTREE_PATH="$(git rev-parse --show-toplevel)/.claude/worktrees/${BRANCH}"

# Create worktree
git worktree add "$WORKTREE_PATH" -b "$BRANCH"
echo "Worktree created at: $WORKTREE_PATH (branch: $BRANCH)"
```

If the branch already exists, tell the user:
"Branch `<name>` already exists. A previous migration may be in progress.
Delete it with `git worktree remove <path> && git branch -D <name>` to
start fresh, or provide a different URL."

From this point forward, **all file operations happen inside `$WORKTREE_PATH`**.
Create the autoresearch directory structure:

```bash
mkdir -p "$WORKTREE_PATH/autoresearch/source"
mkdir -p "$WORKTREE_PATH/autoresearch/extraction"
mkdir -p "$WORKTREE_PATH/autoresearch/results"
```

### Stage 4: Overlay Detection

If `--overlay-recipe` was provided, copy it into the worktree and skip
to Stage 5:

```bash
cp "$OVERLAY_RECIPE" "$WORKTREE_PATH/autoresearch/overlay-recipe.json"
```

Otherwise, dispatch an Agent subagent to detect overlays.

The subagent receives this prompt:

```
You are detecting overlays that block a website header. This is a
RESEARCH-ONLY task -- do not modify any project files.

## Task

1. Use playwright to navigate to: <URL>
2. Wait for the page to fully load (wait for networkidle)
3. Take a full-viewport screenshot and save it to:
   <WORKTREE_PATH>/autoresearch/source/overlay-check.png
4. Take a DOM snapshot of the page
5. Analyze the screenshot and DOM to identify elements that overlay
   or block the header area:
   - Cookie consent banners (OneTrust, CookieBot, custom)
   - GDPR/privacy dialogs
   - Newsletter signup modals
   - Splash screens or interstitials
   - Any element with position:fixed or position:absolute and high
     z-index that covers the top portion of the viewport

6. For each overlay found, record its CSS selector (prefer #id, then
   [data-*] attributes, then .class combinations)

7. Write the recipe JSON to:
   <WORKTREE_PATH>/autoresearch/overlay-recipe.json

   Format:
   {
     "selectors": ["#onetrust-banner-sdk", ".modal-overlay"],
     "action": "remove"
   }

   If no overlays are detected, write:
   { "selectors": [], "action": "remove" }
```

After the subagent completes, verify the recipe file exists:

```bash
if [[ ! -f "$WORKTREE_PATH/autoresearch/overlay-recipe.json" ]]; then
  echo '{ "selectors": [], "action": "remove" }' > "$WORKTREE_PATH/autoresearch/overlay-recipe.json"
  echo "Warning: Overlay detection produced no recipe. Using empty recipe."
fi
```

### Stage 5: Snapshot Capture

Run the capture script via Bash:

```bash
node "$SKILL_SCRIPTS/capture-snapshot.js" \
  "$URL" \
  "$WORKTREE_PATH/autoresearch/source" \
  "--header-selector=$HEADER_SELECTOR" \
  "--overlay-recipe=$WORKTREE_PATH/autoresearch/overlay-recipe.json"
```

Verify output files exist:

```bash
for f in snapshot.json desktop.png tablet.png mobile.png; do
  if [[ ! -f "$WORKTREE_PATH/autoresearch/source/$f" ]]; then
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
node "$SKILL_SCRIPTS/extract-layout.js" \
  "$WORKTREE_PATH/autoresearch/source/snapshot.json" \
  > "$WORKTREE_PATH/autoresearch/extraction/layout.json"

node "$SKILL_SCRIPTS/extract-branding.js" \
  "$WORKTREE_PATH/autoresearch/source/snapshot.json" \
  > "$WORKTREE_PATH/autoresearch/extraction/branding.json"
```

After extraction, read both JSON files and log a summary:

```
Extracted layout: <N> rows, <height>px total header height, <N> nav items
Extracted branding: font-family: <family>, primary-bg: <color>, primary-text: <color>
```

If either script fails, report the error and stop.

### Stage 7: Scaffold Generation

Dispatch an Agent subagent to generate initial EDS header code.
The subagent receives this prompt:

```
You are generating an AEM Edge Delivery Services header block from
structured extraction data. You will create three files in a git
worktree and commit them.

## Input Data

Read these files:
- Layout: <WORKTREE_PATH>/autoresearch/extraction/layout.json
- Branding: <WORKTREE_PATH>/autoresearch/extraction/branding.json

## EDS Conventions

Read the EDS header conventions reference:
${CLAUDE_SKILL_DIR}/references/eds-header-conventions.md

This document defines all required patterns: decorate(block) contract,
nav document structure, CSS scoping, responsive breakpoints, hamburger
toggle, vanilla-only constraints.

## Output Files

Generate these three files:

### 1. <WORKTREE_PATH>/blocks/header/header.js

EDS header block JavaScript. Must follow these rules:
- Export default async function decorate(block)
- Import { getMetadata } from '../../scripts/aem.js'
- Fetch nav content from /nav.plain.html (use getMetadata('nav') for override)
- Build DOM structure matching the extracted layout rows
- Classify nav sections: brand, nav-links, actions
- Create hamburger toggle for mobile (breakpoint at 900px)
- Use aria-expanded for menu state
- Lock body scroll when mobile menu is open
- No frameworks, no npm packages, no build tools

### 2. <WORKTREE_PATH>/blocks/header/header.css

Header styling with CSS custom properties derived from branding data:
- Define --header-bg, --header-text, --header-font, --header-height,
  --header-max-width, --header-padding from branding extraction
- Override header { height: auto !important; } (EDS sets 64px default)
- Scope styles under header nav or .header.block
- Reset margins/padding on nav p, ul, li, div
- Responsive layout: desktop flex-row, mobile flex-column
- Hamburger icon via CSS pseudo-elements
- @media (width >= 900px) and @media (width < 900px) breakpoints
- Use extracted colors, fonts, spacing, border-radius values

### 3. <WORKTREE_PATH>/nav.plain.html

Nav document content matching the extracted nav structure:
- First <div>: brand/logo section with <a> containing <img> or text
- Second <div>: navigation links as <ul> with <li><a> items
- Third <div>: utility/action links (CTAs, search, account)
- Match the hierarchy from layout.json nav items
- Use placeholder image paths for logos (e.g., /media/logo.png)

## After Generating

1. Ensure the blocks/header/ directory exists (mkdir -p)
2. Write all three files
3. Stage and commit in the worktree:
   cd <WORKTREE_PATH>
   git add blocks/header/header.js blocks/header/header.css nav.plain.html
   git commit -m "scaffold: initial header from extraction data"
```

After the subagent completes, verify the three files exist:

```bash
for f in blocks/header/header.js blocks/header/header.css nav.plain.html; do
  if [[ ! -f "$WORKTREE_PATH/$f" ]]; then
    echo "ERROR: Scaffold generation failed -- missing $f"
    exit 1
  fi
done
echo "Scaffold committed."
```

### Stage 8: Polish Loop Setup

Run the setup script to generate the polish loop infrastructure:

```bash
node "$SKILL_SCRIPTS/setup-polish-loop.js" \
  "--layout=$WORKTREE_PATH/autoresearch/extraction/layout.json" \
  "--branding=$WORKTREE_PATH/autoresearch/extraction/branding.json" \
  "--source-dir=$WORKTREE_PATH/autoresearch/source" \
  "--target-dir=$WORKTREE_PATH" \
  "--port=3000" \
  "--max-iterations=$MAX_ITERATIONS"
```

Verify the generated files exist:

```bash
for f in autoresearch/evaluate.js program.md loop.sh; do
  if [[ ! -f "$WORKTREE_PATH/$f" ]]; then
    echo "ERROR: Polish loop setup failed -- missing $f"
    exit 1
  fi
done
chmod +x "$WORKTREE_PATH/loop.sh"
echo "Polish loop infrastructure ready."
```

### Stage 9: Dev Server + Polish Loop

Start the AEM dev server in the background, then launch the polish loop.

**Start dev server:**

```bash
cd "$WORKTREE_PATH" && aem up --html-folder . &
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
cd "$WORKTREE_PATH" && ./loop.sh
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

**Read results** from `$WORKTREE_PATH/results.tsv`
and `$WORKTREE_PATH/autoresearch/results/latest-evaluation.json`.
Extract: composite score, desktop/tablet/mobile scores, nav completeness,
iteration count (kept vs reverted).

**Report to user** with this format:

```
## Header Migration Complete

**Source:** <URL>
**Branch:** <BRANCH>
**Worktree:** <WORKTREE_PATH>

### Final Score
- Composite: <score>%
- Desktop:   <desktop>%
- Tablet:    <tablet>%
- Mobile:    <mobile>%
- Nav completeness: <nav>%

### Iterations
- Total: <N> (<kept> kept, <reverted> reverted)

### Next Steps
1. Review the header at <WORKTREE_PATH>/blocks/header/
2. Preview locally: cd <WORKTREE_PATH> && aem up --html-folder .
3. When satisfied, merge the branch:
   git checkout main
   cp -r <WORKTREE_PATH>/blocks/header/ blocks/header/
   cp <WORKTREE_PATH>/nav.plain.html nav.plain.html
   git add blocks/header/ nav.plain.html
   git commit -m "feat: add migrated header from <domain>"
4. Clean up the worktree:
   git worktree remove <WORKTREE_PATH>
   git branch -D <BRANCH>
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
4. Do NOT delete the worktree -- it contains partial results the user
   may want to inspect or resume from
5. Tell the user the worktree path and branch name so they can inspect
   or clean up manually

Example failure report:

```
## Header Migration Failed at Stage 5 (Snapshot Capture)

**Error:** Header selector '.site-header' not found in page DOM.

**Completed stages:**
- [x] Stage 1: Arguments parsed (URL: https://example.com)
- [x] Stage 2: EDS repository validated
- [x] Stage 3: Worktree created at <path> (branch: <name>)
- [x] Stage 4: Overlay detection (2 overlays found)
- [ ] Stage 5: Snapshot capture -- FAILED

**Suggestion:** Try a different header selector:
  /migrate-header https://example.com --header-selector="nav.main-nav"

**Worktree preserved at:** <path>
```

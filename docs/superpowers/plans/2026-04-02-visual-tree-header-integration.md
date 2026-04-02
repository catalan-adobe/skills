# Visual Tree Integration into Migrate Header — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the visual-tree skill as a foundational early stage in the migrate-header pipeline for overlay detection, header identification, and polish loop enrichment.

**Architecture:** Visual-tree runs after domain probe, producing a spatial map consumed by three downstream stages: LLM-guided overlay dismissal (replaces page-prep dependency), LLM-guided header element detection (replaces `--header-selector` guessing), and polish loop context injection (text format in program.md).

**Tech Stack:** Node.js (ESM), playwright-cli, visual-tree bundle (pre-built IIFE)

**Spec:** `docs/superpowers/specs/2026-04-02-visual-tree-header-integration-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `skills/migrate-header/SKILL.md` | Modify | Add visual-tree capture stage, replace overlay detection stage, add header detection stage, update stage numbering |
| `skills/migrate-header/scripts/setup-polish-loop.js` | Modify | Read visual-tree.txt and inject into program.md template |
| `skills/migrate-header/templates/program.md.tmpl` | Modify | Add `{{VISUAL_TREE}}` section for polish loop subagent |

No new scripts. No changes to capture-snapshot.js, extract-layout.js, extract-styles.js, css-query.js, or cdp-helpers.js.

---

### Task 1: Add Visual Tree Capture Stage to SKILL.md

**Files:**
- Modify: `skills/migrate-header/SKILL.md` (after Stage 2b: Browser Probe, before current Stage 3: Prepare Working Directory)

This task adds the new Stage 3 (visual-tree capture) and renumbers subsequent stages.

- [ ] **Step 1: Read the current SKILL.md**

Read `skills/migrate-header/SKILL.md` in full. Locate:
- Stage 2b: Browser Probe (ends around line 179)
- Stage 3: Prepare Working Directory (starts around line 181)

- [ ] **Step 2: Insert Stage 3 — Visual Tree Capture**

After Stage 2b (Browser Probe) and before the current Stage 3 (Prepare Working Directory), insert a new stage. The current "Stage 3: Prepare Working Directory" moves up to run before visual-tree capture since the `autoresearch/source/` directory must exist for saving artifacts.

Edit `skills/migrate-header/SKILL.md` — replace the current `### Stage 3: Prepare Working Directory` heading and its content with a reordered version that runs prepare first, then visual tree:

```markdown
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
```

- [ ] **Step 3: Verify the insertion reads correctly**

Read the modified SKILL.md around the insertion point. Confirm:
- Stage numbering flows: 1, 2, 2b, 3, 4, ...
- No duplicate stage numbers
- The prepare-dir stage runs before visual-tree (it needs `autoresearch/source/` to exist)

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): add visual-tree capture stage"
```

---

### Task 2: Replace Overlay Detection Stage in SKILL.md

**Files:**
- Modify: `skills/migrate-header/SKILL.md` (replace current Stage 4: Overlay Detection)

This task replaces the page-prep CMP database approach with visual-tree-based detection + LLM-guided dismissal.

- [ ] **Step 1: Read the current overlay detection stage**

Read `skills/migrate-header/SKILL.md` and locate Stage 4: Overlay Detection (currently starting around line 193). Read through the end of the stage to understand all the code being replaced.

- [ ] **Step 2: Replace the overlay detection stage**

Replace the entire current Stage 4 (Overlay Detection) content with the new visual-tree-based approach. The new stage number is 5:

```markdown
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
       selector: /* build unique selector */
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
Copy the entire existing Stage 4 overlay detection code from the
current SKILL.md (the `overlay-db.js refresh`, bundle generation,
playwright-cli config, injection, report parsing, and recipe
conversion blocks) verbatim into this fallback branch. This
preserves the page-prep CMP database approach as a working fallback
when visual-tree is unavailable.
```

- [ ] **Step 3: Verify stage transitions**

Read the modified SKILL.md around the overlay detection stage. Confirm:
- References to the next stage point to Stage 6 (Header Detection)
- The `--overlay-recipe` bypass skips to Stage 6
- The fallback to page-prep still works

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): replace overlay detection with visual-tree + LLM dismissal"
```

---

### Task 3: Add Header Detection Stage to SKILL.md

**Files:**
- Modify: `skills/migrate-header/SKILL.md` (insert new Stage 6 before current Snapshot Capture)

This task adds LLM-guided header detection from visual-tree data, making `--header-selector` an optional override instead of the primary mechanism.

- [ ] **Step 1: Read context around current Snapshot Capture stage**

Read `skills/migrate-header/SKILL.md` and locate the Snapshot Capture stage. Note how `HEADER_SELECTOR` is currently used in the capture command.

- [ ] **Step 2: Insert Stage 6 — Header Element Detection**

Insert before the Snapshot Capture stage (which becomes Stage 7):

```markdown
### Stage 6: Header Element Detection

If `--header-selector` was provided, use it directly and skip detection:

```bash
if [[ "$HEADER_SELECTOR" != "header" || "$HEADER_SELECTOR_EXPLICIT" == "true" ]]; then
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
```

- [ ] **Step 3: Update Stage 1 argument parsing**

In Stage 1 (Parse Arguments), add tracking for whether `--header-selector`
was explicitly provided vs using the default. This lets Stage 6 know
whether to skip detection:

Edit the argument parsing section to add:

```bash
HEADER_SELECTOR_EXPLICIT="false"
```

And in the argument extraction, when `--header-selector` is found:

```bash
HEADER_SELECTOR_EXPLICIT="true"
```

- [ ] **Step 4: Renumber Snapshot Capture and all subsequent stages**

Renumber the current stages:
- Snapshot Capture → Stage 7
- Extraction → Stage 8
- Icon Collection → Stage 8b
- Brand Font Detection → Stage 8c
- Scaffold Generation → Stage 9
- Polish Loop Setup → Stage 10
- Dev Server + Polish Loop → Stage 11
- Report → Stage 12
- Retrospective → Stage 13

Update all cross-references within SKILL.md (e.g., "skip to Stage 5"
becomes "skip to Stage 7", etc.).

- [ ] **Step 5: Update the pipeline overview diagram**

Replace the pipeline overview at the top of SKILL.md:

```markdown
## Pipeline Overview

```
URL --> PARSE --> VALIDATE --> PROBE --> PREPARE --> VIS-TREE --> OVERLAY --> HEADER --> SNAPSHOT --> EXTRACT --> ICONS --> FONTS --> SCAFFOLD --> SETUP --> DEV+POLISH --> REPORT --> RETRO
        (args)    (EDS?)      (CDN)    (mkdir)     (spatial)    (LLM)     (LLM)      (pw-cli)   (scripts)   (collect) (brand)    (LLM)      (files)   (aem+loop)    (score)   (learnings)
```
```

- [ ] **Step 6: Update error handling template**

Update the error handling section's example failure report to include
the new stages in the completed stages checklist.

- [ ] **Step 7: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): add LLM-guided header detection from visual-tree"
```

---

### Task 4: Add Visual Tree to Polish Loop Context

**Files:**
- Modify: `skills/migrate-header/templates/program.md.tmpl`
- Modify: `skills/migrate-header/scripts/setup-polish-loop.js`

This task injects the visual-tree text format into the polish loop's
program.md so the subagent has spatial context.

- [ ] **Step 1: Add `{{VISUAL_TREE}}` section to program.md.tmpl**

Edit `skills/migrate-header/templates/program.md.tmpl`. After the
"Source Reference" section (around line 58) and before the "CSS Query
Tool" section, insert:

```markdown
## Source Visual Tree

Spatial hierarchy of the source page captured at 1440px viewport.
Each line shows: `ID [role] [CxR grid] [bg:type] @x,y wxh "text..."`.
Use this to understand the source header's spatial structure — row
heights, column counts, and element positions.

```
{{VISUAL_TREE}}
```

The header node identified during migration is marked in the tree. Match
your rendered header's dimensions (position, width, height) to the
corresponding node in this tree.
```

- [ ] **Step 2: Add visual-tree reading to setup-polish-loop.js**

Edit `skills/migrate-header/scripts/setup-polish-loop.js`.

In the `main()` function, after the `replacements` object is built
(around line 230), add reading of the visual-tree text file:

```javascript
  // Read visual-tree text format if available
  const vtPath = join(args.sourceDir, 'visual-tree.txt');
  let visualTreeText = 'Visual tree not available for this migration.';
  if (existsSync(vtPath)) {
    visualTreeText = readFileSync(vtPath, 'utf-8');
    log(`  Loaded visual-tree.txt (${visualTreeText.split('\n').length} lines)`);
  }
```

Add the replacement to the `replacements` object:

```javascript
    '{{VISUAL_TREE}}': visualTreeText,
```

- [ ] **Step 3: Verify template rendering**

Read the modified `program.md.tmpl` and confirm `{{VISUAL_TREE}}` is
in a markdown code block so indentation is preserved. Read `setup-polish-loop.js`
and confirm the replacement is added to the `replacements` object alongside
existing entries.

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/templates/program.md.tmpl \
  skills/migrate-header/scripts/setup-polish-loop.js
git commit -m "feat(migrate-header): inject visual-tree context into polish loop"
```

---

### Task 5: Update SKILL.md Description and Test Full Pipeline

**Files:**
- Modify: `skills/migrate-header/SKILL.md` (frontmatter description)

- [ ] **Step 1: Update SKILL.md frontmatter description**

Edit the `description` field in the SKILL.md frontmatter to mention
visual-tree integration. The description must stay under 1024 characters
(tessl constraint).

Replace the current description with:

```yaml
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
```

- [ ] **Step 2: Verify description length**

```bash
node -e "
  const desc = 'Migrate any website header to AEM Edge Delivery Services with pixel-accurate fidelity using an automated extraction + scaffold + visual polish pipeline. Takes a URL, captures a visual tree for spatial analysis, detects and dismisses overlays via LLM, identifies the header element from the spatial map, captures DOM snapshots, extracts layout and branding, generates scaffold code, then launches an autonomous visual polish loop. Requires being in an EDS git repository. Works in the current directory — the caller is responsible for worktree/branch setup if isolation is needed. Triggers on: migrate header, header migration, migrate-header, /migrate-header, convert header to EDS, EDS header from URL.';
  console.log(desc.length + ' chars (max 1024)');
"
```

Expected: under 700 characters.

- [ ] **Step 3: Read through full SKILL.md for consistency**

Read the complete modified SKILL.md end to end. Check:
- Stage numbering is sequential (1, 2, 2b, 3, 4, 5, 6, 7, 8, 8b, 8c, 9, 10, 11, 12, 13)
- All "skip to Stage N" references point to correct stages
- Pipeline overview diagram matches actual stages
- Error handling example includes new stages
- No orphaned references to removed page-prep-only flow

- [ ] **Step 4: Lint the skill**

```bash
tessl skill lint skills/migrate-header
```

Expected: zero warnings.

- [ ] **Step 5: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): update description and verify pipeline consistency"
```

---

### Task 6: Sync and Final Verification

**Files:**
- No file changes — verification only

- [ ] **Step 1: Sync skills locally**

```bash
./scripts/sync-skills.sh
```

This copies the updated migrate-header skill to `~/.claude/skills/migrate-header/`.

- [ ] **Step 2: Verify visual-tree bundle is accessible**

```bash
ls -la ~/.claude/skills/visual-tree/scripts/visual-tree-bundle.js
```

Expected: file exists (synced earlier when visual-tree was added).

- [ ] **Step 3: Verify migrate-header skill loads**

In a new terminal, run:

```bash
cat ~/.claude/skills/migrate-header/SKILL.md | head -20
```

Expected: updated frontmatter with visual-tree mention.

- [ ] **Step 4: Commit all remaining changes (if any)**

```bash
git status
# If any unstaged changes remain:
git add -A && git commit -m "chore(migrate-header): sync and verify"
```

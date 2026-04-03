# LLM Judge Evaluator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an LLM judge agent to the header migration polish loop that compares screenshots, produces a binary improved/not-improved judgment for the composite score, and writes actionable diagnosis for the next iteration's polish agent.

**Architecture:** The judge is a second `claude -p` call in `loop.sh`, invoked after the pixelmatch evaluator. It reads three screenshots (source, before, after), outputs structured JSON with improved + diagnosis. Loop.sh recomputes the composite score with the judge's 20% weight and writes the diagnosis to a file the polish agent reads.

**Tech Stack:** Bash (loop.sh), Node.js (evaluate.js), Claude CLI (`claude -p`)

**Spec:** `docs/superpowers/specs/2026-04-02-llm-judge-evaluator-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `skills/migrate-header/templates/evaluate.js.tmpl` | Modify | Accept iteration number, save per-iteration screenshots |
| `skills/migrate-header/templates/judge.md.tmpl` | Create | Judge agent prompt template (3-image comparison) |
| `skills/migrate-header/templates/loop.sh.tmpl` | Modify | Invoke judge, recompute composite, track best-kept iteration |
| `skills/migrate-header/templates/program.md.tmpl` | Modify | Add judge feedback section, update scoring description |

---

### Task 1: Save per-iteration screenshots in evaluate.js.tmpl

**Files:**
- Modify: `skills/migrate-header/templates/evaluate.js.tmpl`

- [ ] **Step 1: Read the current evaluator template**

Read `skills/migrate-header/templates/evaluate.js.tmpl` in full. Note:
- Line 21: `const PORT = process.argv[2] || '{{PORT}}';` — port is argv[2]
- Line 193: `const renderedPath = join(RESULTS_DIR, \`${vp.name}-rendered.png\`);` — current save path

- [ ] **Step 2: Add iteration number argument**

After line 22 (`const PAGE_PATH = '{{PAGE_PATH}}';`), add:

```javascript
const ITERATION = process.argv[3] || 'latest';
```

- [ ] **Step 3: Save per-iteration screenshot copy**

Find the line inside the viewport loop where `cropHeaderFromScreenshot` is called (around line 212). After the crop succeeds, add a copy to the per-iteration path. The block currently looks like:

```javascript
    if (rect && rect.width > 0 && rect.height > 0) {
      cropHeaderFromScreenshot(fullPath, renderedPath, rect);
```

After the `cropHeaderFromScreenshot` call and before the `if (vp.name === 'desktop')` check, insert:

```javascript
      // Save per-iteration copy for judge comparison and debugging
      const iterPath = join(RESULTS_DIR, `${vp.name}-rendered-${ITERATION}.png`);
      if (existsSync(renderedPath)) {
        writeFileSync(iterPath, readFileSync(renderedPath));
      }
```

- [ ] **Step 4: Verify the change**

Read the modified file around the insertion point. Confirm:
- `ITERATION` is read from `process.argv[3]`
- The per-iteration copy is saved right after the crop
- The original `renderedPath` (overwritten each time) is untouched

- [ ] **Step 5: Commit**

```bash
git add skills/migrate-header/templates/evaluate.js.tmpl
git commit -m "feat(migrate-header): save per-iteration screenshots in evaluator"
```

---

### Task 2: Create judge prompt template

**Files:**
- Create: `skills/migrate-header/templates/judge.md.tmpl`

- [ ] **Step 1: Create the judge prompt template**

Write the file `skills/migrate-header/templates/judge.md.tmpl` with this content:

```markdown
You are evaluating a header migration iteration by comparing screenshots.

## Source Header (the target to match)

Read this image: {{SOURCE_IMG}}

This is the original website header we are trying to replicate in AEM Edge Delivery Services.

## Before (iteration {{BEFORE_ITERATION}})

Read this image: {{BEFORE_IMG}}

This is how the migrated header looked after the last successful iteration.

## After (iteration {{AFTER_ITERATION}})

Read this image: {{AFTER_IMG}}

This is how the migrated header looks after the current iteration's changes.

## Your Task

Compare Before and After against the Source. Did the After iteration move closer to matching the Source header?

Consider these dimensions:
- **Layout structure** — row arrangement, column alignment, element positioning
- **Colors** — background colors, text colors, accent colors
- **Typography** — font family feel, sizes, weights
- **Spacing** — padding, gaps between elements, margins
- **Logo** — placement, size, proportions
- **Nav items** — arrangement, visibility, hover indicators

Ignore minor subpixel differences, antialiasing, and font rendering variations between browsers.

**Respond with ONLY this JSON (no markdown fences, no other text):**

{"improved": true, "confidence": "high", "diagnosis": ["first item to fix", "second item to fix"]}

Rules for the JSON:
- "improved": true if After is closer to Source than Before, false otherwise
- "confidence": "high", "medium", or "low"
- "diagnosis": 3-5 specific actionable items describing what After still gets wrong compared to Source. Be precise — reference positions (left/center/right), approximate colors, sizes, and spacing.
```

- [ ] **Step 2: Create the first-iteration variant template**

Write the file `skills/migrate-header/templates/judge-first.md.tmpl` with this content:

```markdown
You are evaluating the first iteration of a header migration by comparing screenshots.

## Source Header (the target to match)

Read this image: {{SOURCE_IMG}}

This is the original website header we are trying to replicate in AEM Edge Delivery Services.

## Current Render (iteration {{AFTER_ITERATION}})

Read this image: {{AFTER_IMG}}

This is the first attempt at rendering the migrated header.

## Your Task

Assess how closely this first render matches the Source header. Does it show structural resemblance — correct layout, element placement, and content?

Consider these dimensions:
- **Layout structure** — row arrangement, column alignment, element positioning
- **Colors** — background colors, text colors, accent colors
- **Typography** — font family feel, sizes, weights
- **Spacing** — padding, gaps between elements, margins
- **Logo** — placement, size, proportions
- **Nav items** — arrangement, visibility, hover indicators

**Respond with ONLY this JSON (no markdown fences, no other text):**

{"improved": true, "confidence": "high", "diagnosis": ["first item to fix", "second item to fix"]}

Rules for the JSON:
- "improved": true if the header renders with recognizable structure, false if it is broken or empty
- "confidence": "high", "medium", or "low"
- "diagnosis": 3-5 specific actionable items describing what needs to change to match the Source. Be precise — reference positions (left/center/right), approximate colors, sizes, and spacing.
```

- [ ] **Step 3: Commit**

```bash
git add skills/migrate-header/templates/judge.md.tmpl \
  skills/migrate-header/templates/judge-first.md.tmpl
git commit -m "feat(migrate-header): add judge agent prompt templates"
```

---

### Task 3: Integrate judge into loop.sh.tmpl

**Files:**
- Modify: `skills/migrate-header/templates/loop.sh.tmpl`

This is the largest task — it adds the judge invocation, recomputes composite, and tracks the best-kept iteration.

- [ ] **Step 1: Read the current loop template**

Read `skills/migrate-header/templates/loop.sh.tmpl` in full.

- [ ] **Step 2: Add new variables at the top**

After line 18 (`CONSECUTIVE_REVERTS=0`), add:

```bash
BEST_KEPT_ITERATION=0
JUDGE_TMPL_DIR="$(dirname "$(dirname "$0")")/skills/migrate-header/templates"
# Fallback: find templates via SKILL_HOME or ~/.claude
if [[ ! -d "${JUDGE_TMPL_DIR}" ]]; then
  JUDGE_TMPL_DIR="{{SKILL_HOME}}/templates"
fi
```

- [ ] **Step 3: Add the judge function**

After the `run_evaluation()` function (after line 92), add:

```bash
# Run LLM judge: compare source + before + after screenshots
run_judge() {
  local iteration=$1
  local source_img="${PROJECT_DIR}/autoresearch/source/desktop.png"
  local after_img="${PROJECT_DIR}/autoresearch/results/desktop-rendered-${iteration}.png"
  local judge_prompt_file="/tmp/judge-prompt-$$.md"

  if [[ ! -f "${after_img}" ]]; then
    warn "Judge: after screenshot not found, skipping"
    echo '50|[]'
    return
  fi

  # Build judge prompt from template
  if [[ ${BEST_KEPT_ITERATION} -eq 0 ]]; then
    # First iteration: use 2-image template
    local tmpl="${JUDGE_TMPL_DIR}/judge-first.md.tmpl"
    if [[ ! -f "${tmpl}" ]]; then
      warn "Judge: first-iteration template not found, skipping"
      echo '50|[]'
      return
    fi
    sed -e "s|{{SOURCE_IMG}}|${source_img}|g" \
        -e "s|{{AFTER_IMG}}|${after_img}|g" \
        -e "s|{{AFTER_ITERATION}}|${iteration}|g" \
        "${tmpl}" > "${judge_prompt_file}"
  else
    # Subsequent iterations: use 3-image template
    local before_img="${PROJECT_DIR}/autoresearch/results/desktop-rendered-${BEST_KEPT_ITERATION}.png"
    local tmpl="${JUDGE_TMPL_DIR}/judge.md.tmpl"
    if [[ ! -f "${tmpl}" ]]; then
      warn "Judge: template not found, skipping"
      echo '50|[]'
      return
    fi
    if [[ ! -f "${before_img}" ]]; then
      warn "Judge: before screenshot not found, using first-iteration template"
      tmpl="${JUDGE_TMPL_DIR}/judge-first.md.tmpl"
      sed -e "s|{{SOURCE_IMG}}|${source_img}|g" \
          -e "s|{{AFTER_IMG}}|${after_img}|g" \
          -e "s|{{AFTER_ITERATION}}|${iteration}|g" \
          "${tmpl}" > "${judge_prompt_file}"
    else
      sed -e "s|{{SOURCE_IMG}}|${source_img}|g" \
          -e "s|{{BEFORE_IMG}}|${before_img}|g" \
          -e "s|{{BEFORE_ITERATION}}|${BEST_KEPT_ITERATION}|g" \
          -e "s|{{AFTER_IMG}}|${after_img}|g" \
          -e "s|{{AFTER_ITERATION}}|${iteration}|g" \
          "${tmpl}" > "${judge_prompt_file}"
    fi
  fi

  # Invoke judge
  local judge_raw
  judge_raw=$(claude -p "$(cat "${judge_prompt_file}")" \
    --allowedTools "Read" \
    --output-format json 2>/dev/null) || true
  rm -f "${judge_prompt_file}"

  if [[ -z "${judge_raw}" ]]; then
    warn "Judge: no output, defaulting to neutral"
    echo '50|[]'
    return
  fi

  # Parse judge output
  echo "${judge_raw}" | node --input-type=commonjs -e "
    let raw = require('fs').readFileSync('/dev/stdin', 'utf-8').trim();
    try {
      // Handle potential markdown fences or extra text
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.log('50|[]'); process.exit(0); }
      const d = JSON.parse(jsonMatch[0]);
      const score = d.improved === true ? 100 : (d.improved === false ? 0 : 50);
      const diagnosis = JSON.stringify(d.diagnosis || []);
      console.log(score + '|' + diagnosis);
    } catch {
      console.log('50|[]');
    }
  " 2>/dev/null || echo '50|[]'
}
```

- [ ] **Step 4: Modify the evaluation call to pass iteration number**

Find line 76:

```bash
  eval_output=$(${EVALUATE} "${PORT}" 2>/dev/null) || true
```

Replace with:

```bash
  eval_output=$(${EVALUATE} "${PORT}" "${ITERATION}" 2>/dev/null) || true
```

- [ ] **Step 5: Add judge invocation and composite recomputation after evaluation**

Find the block around lines 152-157 where the evaluation result is parsed and the keep decision is made:

```bash
  # Run immutable evaluator
  log "Running evaluation..."
  eval_result=$(run_evaluation)
  IFS='|' read -r score desktop nav_score <<< "${eval_result}"

  # Compare with best — strict improvement required
  keep=$(node -e "console.log(${score} > ${BEST_SCORE} ? 'yes' : 'no')" \
    2>/dev/null || echo "no")
```

Replace that entire block with:

```bash
  # Run immutable evaluator
  log "Running evaluation..."
  eval_result=$(run_evaluation)
  IFS='|' read -r _eval_composite desktop nav_score <<< "${eval_result}"

  # Run LLM judge
  log "Running judge comparison..."
  judge_result=$(run_judge "${ITERATION}")
  IFS='|' read -r judge_score judge_diagnosis <<< "${judge_result}"

  # Write judge diagnosis for next iteration's polish agent
  echo "${judge_diagnosis}" > "${PROJECT_DIR}/autoresearch/results/judge-feedback.json"

  # Recompute composite: pixelmatch 55% + nav 25% + judge 20%
  score=$(node -e "
    const pm = ${desktop} || 0;
    const nav = ${nav_score} || 0;
    const judge = ${judge_score} || 50;
    console.log(Math.round((pm * 0.55 + nav * 0.25 + judge * 0.20) * 100) / 100);
  " 2>/dev/null || echo "0")

  # Compare with best — strict improvement required
  keep=$(node -e "console.log(${score} > ${BEST_SCORE} ? 'yes' : 'no')" \
    2>/dev/null || echo "no")
```

- [ ] **Step 6: Update the kept/reverted logging to track best-kept iteration**

Find the block where `keep == "yes"` (around line 159):

```bash
  if [[ "${keep}" == "yes" ]]; then
    ok "IMPROVED: ${BEST_SCORE} -> ${score} (desktop=${desktop}, nav=${nav_score})"
    BEST_SCORE="${score}"
    CONSECUTIVE_REVERTS=0
```

Replace with:

```bash
  if [[ "${keep}" == "yes" ]]; then
    ok "IMPROVED: ${BEST_SCORE} -> ${score} (desktop=${desktop}, nav=${nav_score}, judge=${judge_score})"
    BEST_SCORE="${score}"
    BEST_KEPT_ITERATION=${ITERATION}
    CONSECUTIVE_REVERTS=0
```

- [ ] **Step 7: Update results.tsv header and logging format**

Find the results.tsv header initialization (around line 46):

```bash
  printf "iteration\tcommit\tscore\tvisual_desktop\tnav_completeness\tstatus\tdescription\n" \
    > "${RESULTS_FILE}"
```

Replace with:

```bash
  printf "iteration\tcommit\tscore\tvisual_desktop\tnav_completeness\tjudge\tstatus\tdescription\n" \
    > "${RESULTS_FILE}"
```

Find the kept result printf (around line 163):

```bash
    printf "%d\t%s\t%s\t%s\t%s\timproved\t%s [%s]\n" \
      "${ITERATION}" "${local_commit}" "${score}" \
      "${desktop}" "${nav_score}" \
      "${commit_msg}" "${changed_files}" \
      >> "${RESULTS_FILE}"
```

Replace with:

```bash
    printf "%d\t%s\t%s\t%s\t%s\t%s\timproved\t%s [%s]\n" \
      "${ITERATION}" "${local_commit}" "${score}" \
      "${desktop}" "${nav_score}" "${judge_score}" \
      "${commit_msg}" "${changed_files}" \
      >> "${RESULTS_FILE}"
```

Find the reverted result printf (around line 176):

```bash
    printf "%d\t%s\t%s\t%s\t%s\treverted\t%s [%s]\n" \
      "${ITERATION}" "${local_commit}" "${score}" \
      "${desktop}" "${nav_score}" \
      "${commit_msg}" "${changed_files}" \
      >> "${RESULTS_FILE}"
```

Replace with:

```bash
    printf "%d\t%s\t%s\t%s\t%s\t%s\treverted\t%s [%s]\n" \
      "${ITERATION}" "${local_commit}" "${score}" \
      "${desktop}" "${nav_score}" "${judge_score}" \
      "${commit_msg}" "${changed_files}" \
      >> "${RESULTS_FILE}"
```

Also find the no-changes printf (around line 127):

```bash
    printf "%d\t-\t%s\t-\t-\tno_changes\tAgent made no modifications\n" \
      "${ITERATION}" "${BEST_SCORE}" >> "${RESULTS_FILE}"
```

Replace with:

```bash
    printf "%d\t-\t%s\t-\t-\t-\tno_changes\tAgent made no modifications\n" \
      "${ITERATION}" "${BEST_SCORE}" >> "${RESULTS_FILE}"
```

- [ ] **Step 8: Update the revert log line**

Find:

```bash
    warn "NO IMPROVEMENT: ${score} <= ${BEST_SCORE} — reverting"
```

Replace with:

```bash
    warn "NO IMPROVEMENT: ${score} <= ${BEST_SCORE} (judge=${judge_score}) — reverting"
```

- [ ] **Step 9: Verify the full loop template**

Read the modified `loop.sh.tmpl` in full. Check:
- `BEST_KEPT_ITERATION` initialized to 0
- `run_judge()` function defined after `run_evaluation()`
- Evaluation passes `${ITERATION}` to evaluator
- Judge runs after evaluator
- Composite recomputed with 3 weights
- `BEST_KEPT_ITERATION` updated on keep
- results.tsv has judge column in header and all printf lines
- Judge diagnosis written to `judge-feedback.json`

- [ ] **Step 10: Commit**

```bash
git add skills/migrate-header/templates/loop.sh.tmpl
git commit -m "feat(migrate-header): integrate LLM judge into polish loop"
```

---

### Task 4: Update program.md.tmpl with judge feedback and scoring description

**Files:**
- Modify: `skills/migrate-header/templates/program.md.tmpl`

- [ ] **Step 1: Read the current template**

Read `skills/migrate-header/templates/program.md.tmpl` in full.

- [ ] **Step 2: Add judge feedback section**

After the "How to Read History" section (which ends around line 44 with
"Try something fundamentally different.") and before the "How the
Evaluator Scores You" section, insert:

```markdown
## Judge Feedback

If `autoresearch/results/judge-feedback.json` exists, read it FIRST.
It contains a diagnosis from the previous iteration — a list of specific
visual differences between your rendered header and the source, identified
by comparing screenshots. Address these items before exploring other
changes.

Example:
```json
[
  "Header background is #f5f5f5, source is #1a1a2e — dark background missing",
  "Nav links are stacked vertically, source shows horizontal flex layout",
  "Logo is 40px tall, source shows ~28px — reduce logo height"
]
```

These observations come from comparing the source screenshot against
your latest rendered screenshot. They are more reliable than guessing
from the pixelmatch diff image. Prioritize fixing these items.
```

- [ ] **Step 3: Update the scoring description**

Find the "How the Evaluator Scores You" section (around line 48):

```markdown
After you exit, an immutable evaluator runs. It produces a composite score (0-100):
- **70% weight**: Visual similarity via pixelmatch (desktop only)
- **30% weight**: Nav completeness (are all {{NAV_ITEM_COUNT}} source nav items present in the rendered HTML?)
```

Replace with:

```markdown
After you exit, two evaluations run:

1. **Pixelmatch evaluator** — compares your rendered header screenshot against the source pixel-by-pixel
2. **LLM judge** — compares source, previous best, and your current render to assess semantic improvement

The composite score (0-100) combines:
- **55% weight**: Visual similarity via pixelmatch (desktop only)
- **25% weight**: Nav completeness (are all {{NAV_ITEM_COUNT}} source nav items present in the rendered HTML?)
- **20% weight**: LLM judge (did this iteration improve? YES=100, NO=0)
```

- [ ] **Step 4: Verify the changes**

Read the modified template. Confirm:
- Judge feedback section appears before scoring description
- Scoring description reflects the new 55/25/20 weights
- No `{{...}}` template variables introduced (section is static text)

- [ ] **Step 5: Commit**

```bash
git add skills/migrate-header/templates/program.md.tmpl
git commit -m "feat(migrate-header): add judge feedback section and update scoring weights in program.md"
```

---

### Task 5: Verify and sync

**Files:**
- No file changes — verification only

- [ ] **Step 1: Read all modified template files end to end**

Read each file and verify internal consistency:
- `evaluate.js.tmpl`: `ITERATION` from argv[3], per-iteration screenshot saved
- `judge.md.tmpl`: template variables match what `loop.sh` substitutes
- `judge-first.md.tmpl`: same variables minus `BEFORE_*`
- `loop.sh.tmpl`: `run_judge()` uses correct template paths and variables, composite formula is `pm*0.55 + nav*0.25 + judge*0.20`, results.tsv has 8 columns (iteration, commit, score, visual_desktop, nav_completeness, judge, status, description)
- `program.md.tmpl`: weights match loop.sh (55/25/20), judge feedback path matches loop.sh output path

- [ ] **Step 2: Commit any fixes found**

```bash
git add skills/migrate-header/templates/
git commit -m "fix(migrate-header): consistency fixes from verification pass"
```

Only run this if fixes were needed. Skip if everything was clean.

# LLM Judge Evaluator for Header Migration Polish Loop

**Date:** 2026-04-02
**Status:** Approved
**Approach:** A (judge score in composite, diagnosis in file)

## Summary

Add an LLM-based judge agent to the header migration polish loop. After
each iteration's pixelmatch evaluation, a second Claude session compares
three screenshots (source, before, after) and produces a binary
improved/not-improved judgment plus a structured diagnosis. The judgment
factors into the composite score at 20% weight. The diagnosis feeds the
next iteration's polish agent as actionable guidance.

## Motivation

Pixelmatch is purely pixel-level — it penalizes subpixel rendering
differences that don't matter and misses structural improvements that
do. An LLM comparing screenshots can judge semantic similarity (layout,
colors, typography, spacing) and provide qualitative feedback the polish
agent can act on directly, instead of re-analyzing the diff image every
iteration.

Binary YES/NO judgments are reliable from LLMs (ordinal comparison is
easier than cardinal scoring). The 20% composite weight is enough to tip
marginal keep/revert decisions but not enough to override clear
pixelmatch signals.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Judge invocation | `claude -p` in loop.sh | No SDK dependency, reads images natively, runs outside evaluate.js |
| Score type | Binary (improved YES/NO) | LLMs are reliable at comparative judgments, unreliable at precise numeric scores |
| Composite weights | pixelmatch 55%, nav 25%, judge 20% | Judge can tip marginal cases but not override clear signals |
| Screenshot retention | All iterations saved as `desktop-rendered-{N}.png` | Debugging value, judge needs before/after pair |
| Before baseline | Last kept iteration's screenshot | Reverted iterations shouldn't be the baseline — git state matches the last kept iteration |
| First iteration | Judge defaults to 50 (neutral) | No before screenshot exists; don't bias the first keep/revert decision |
| Judge failure | Defaults to judge_score=50 (neutral), empty diagnosis | Don't penalize or reward iterations for judge infrastructure failures |
| Diagnosis delivery | `judge-feedback.json` read by polish agent | Structured guidance replaces ad-hoc diff image analysis |

## Updated Loop Flow

```
For each iteration:
  1. Record HEAD before
  2. Spawn POLISH agent → reads judge-feedback.json, makes changes, commits
  3. Check if changes were made
  4. Run EVALUATOR (evaluate.js) → pixelmatch + nav score
     Saves desktop-rendered.png AND desktop-rendered-{N}.png
  5. Spawn JUDGE agent → reads source + before + after screenshots
     → outputs {improved, confidence, diagnosis}
  6. Compute composite: pixelmatch * 0.55 + nav * 0.25 + judge * 0.20
     (judge = 100 if improved, 0 if not, 50 on first iteration or failure)
  7. Keep/revert based on composite > BEST_SCORE
  8. If kept: update BEST_KEPT_ITERATION tracker
  9. Write diagnosis to autoresearch/results/judge-feedback.json
```

## Changes by File

### `templates/evaluate.js.tmpl`

Minimal change: accept iteration number as second argument, save
per-iteration screenshot.

- Accept `process.argv[3]` as iteration number (optional, defaults to
  'latest')
- After cropping the rendered header screenshot, save to both:
  - `desktop-rendered.png` (overwritten each time, backward compat)
  - `desktop-rendered-{N}.png` (accumulated for judge and debugging)
- No change to score computation — evaluator still outputs its own
  `compositeScore` (pixelmatch * 0.70 + nav * 0.30) in JSON. Loop.sh
  ignores this field and recomputes with judge weight.

### `templates/judge.md.tmpl` (new file)

Prompt template for the judge agent. Three-image comparison with
structured JSON output.

**Template variables:**
- `{{SOURCE_IMG}}` — path to source desktop screenshot
- `{{BEFORE_IMG}}` — path to last kept iteration's rendered screenshot
- `{{BEFORE_ITERATION}}` — iteration number of the before screenshot
- `{{AFTER_IMG}}` — path to current iteration's rendered screenshot
- `{{AFTER_ITERATION}}` — current iteration number

**Prompt structure:**

```
You are comparing two attempts at migrating a website header.

## Source (the target to match)
Read this image: {{SOURCE_IMG}}

## Before (iteration {{BEFORE_ITERATION}})
Read this image: {{BEFORE_IMG}}

## After (iteration {{AFTER_ITERATION}})
Read this image: {{AFTER_IMG}}

## Your task

Compare Before and After against the Source. Did the After iteration
move closer to matching the Source header?

Consider: layout structure, colors, typography, spacing, logo placement,
nav item arrangement, overall visual fidelity. Ignore minor subpixel
differences and antialiasing.

Respond with ONLY this JSON (no other text):

{
  "improved": true or false,
  "confidence": "high" or "medium" or "low",
  "diagnosis": [
    "specific thing to fix or improve next",
    "another specific thing",
    "..."
  ]
}

The diagnosis list should be 3-5 actionable items describing what the
After screenshot still gets wrong compared to Source. Be specific —
reference positions (left/right/center), colors, sizes, spacing.
```

**First iteration variant:** When no before screenshot exists, the
prompt uses only source + after images and asks: "Does this rendered
header bear structural resemblance to the source? List what needs to
change to match it." The `improved` field defaults to `true` if the
header renders at all.

### `templates/loop.sh.tmpl`

**New variables:**
- `BEST_KEPT_ITERATION=0` — tracks which iteration's screenshot is the
  current "before" baseline
- `JUDGE_PROMPT` — path to populated judge prompt file

**After evaluator runs (step 4 → step 5):**

Build the judge prompt from the template:
- Replace `{{SOURCE_IMG}}` with `autoresearch/source/desktop.png`
- Replace `{{BEFORE_IMG}}` with `autoresearch/results/desktop-rendered-${BEST_KEPT_ITERATION}.png`
  (or skip if iteration 1)
- Replace `{{AFTER_IMG}}` with `autoresearch/results/desktop-rendered-${ITERATION}.png`
- Replace iteration numbers

Invoke the judge:

```bash
JUDGE_OUTPUT=$(claude -p "$(cat "${JUDGE_PROMPT_FILE}")" \
  --allowedTools "Read" \
  --output-format json 2>/dev/null) || true
```

Parse the output:
- Extract `improved` → convert to score (100 or 0)
- Extract `diagnosis` → write to `autoresearch/results/judge-feedback.json`
- On parse failure → judge_score=50, empty diagnosis

**Recompute composite:**

```bash
# pixelmatch * 0.55 + nav * 0.25 + judge * 0.20
composite=$(node -e "
  const pm = ${desktop};
  const nav = ${nav_score};
  const judge = ${judge_score};
  console.log(Math.round((pm * 0.55 + nav * 0.25 + judge * 0.20) * 100) / 100);
")
```

**Keep/revert uses the new composite** instead of the evaluator's
composite.

**If kept:** `BEST_KEPT_ITERATION=${ITERATION}`

**Results.tsv:** Add `judge` column between `nav_completeness` and
`status`.

### `templates/program.md.tmpl`

Add a new section after "How to Read History":

```markdown
## Judge Feedback

If `autoresearch/results/judge-feedback.json` exists, read it FIRST.
It contains a diagnosis from the previous iteration — a list of specific
visual differences between your rendered header and the source. Address
these items before exploring other changes.

Example:
```json
{
  "diagnosis": [
    "Header background is #f5f5f5, source is #1a1a2e — dark background missing",
    "Nav links are stacked vertically, source shows horizontal flex layout",
    "Logo is 40px tall, source shows ~28px — reduce logo height"
  ]
}
```

These observations come from comparing the source screenshot against
your latest rendered screenshot. They are more reliable than guessing
from the pixelmatch diff image. Prioritize fixing these items.
```

### `scripts/setup-polish-loop.js`

No changes needed. The judge prompt template uses its own replacement
logic in `loop.sh`, not the setup script's template system. The
`program.md.tmpl` change (adding the judge feedback section) flows
through the existing template replacement — no new `{{...}}` variables
needed since the section is static text.

## What Does NOT Change

- `evaluate.js` score computation (still outputs pixelmatch * 0.70 +
  nav * 0.30 internally — loop.sh recomputes)
- Polish agent's allowed tools and file restrictions
- Pixelmatch comparison logic (threshold, padding, diff image)
- Nav completeness check
- Max iterations and plateau detection thresholds
- The polish agent prompt in `program.md` (it gains the judge feedback
  section but loses nothing)

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| First iteration (no before) | Judge uses 2-image prompt (source + after), defaults improved=true, score=50 |
| Judge call fails | judge_score=50 (neutral), empty diagnosis, logged as warning |
| Judge returns unparseable output | Same as failure — score=50, empty diagnosis |
| Reverted iteration | Screenshot still saved as desktop-rendered-{N}.png but BEST_KEPT_ITERATION unchanged |
| Multiple consecutive reverts | Judge always compares against last kept iteration, not last reverted |
| Polish agent ignores judge feedback | No enforcement — judge feedback is advisory input, not a constraint |

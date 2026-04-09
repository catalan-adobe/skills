# Per-Row Visual Polish Loops

Optimize the migrate-header visual polish loop by spawning one loop per header row, converging in parallel, then running adaptive reconciliation on the full header.

## Motivation

The current polish loop iterates on the entire header as one unit. This causes two problems:

1. **Cross-row interference** -- fixing one row's CSS regresses another row, wasting iterations on oscillation.
2. **Speed** -- serial iteration on the full header is slow. Parallel per-row loops cut wall-clock time proportionally.

Row isolation eliminates interference. Parallel dispatch reduces total time. Adaptive reconciliation catches any cross-row issues cheaply.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Per-row CSS files | `row-N.css` composed via `@import` in `header.css` | Agents must not edit the same file concurrently |
| CSS isolation | Section-metadata classes (already exist) | No new mechanism needed |
| Per-row scoring | pixelmatch 50% + judge 50% | Nav completeness is a whole-header concern |
| Screenshots | Element screenshot per row DOM node | Cleaner than crop-from-full-page, no coordinate drift |
| Parallel execution | Agent tool (one per row) | Matches Phase 3 extraction pattern |
| Reconciliation | Adaptive: evaluate full header; if >= 85%, skip; else short loop (5 iterations) | Avoids wasting iterations when rows converge cleanly |
| Git ratchet | File-scoped add/checkout per row (no reset --hard) | Prevents parallel agents from corrupting each other |

## File Layout

```
loop-row-0.sh
loop-row-1.sh
program-row-0.md
program-row-1.md
autoresearch/
  evaluate-row-0.js
  evaluate-row-1.js
  source/
    desktop.png                    # full header (for reconciliation)
    desktop-row-0.png              # cropped source for row 0
    desktop-row-1.png              # cropped source for row 1
    nav-structure.json             # for reconciliation only
  results/
    row-0/                         # row 0 screenshots, scores, judge history
    row-1/                         # row 1 screenshots, scores, judge history
blocks/header/
  header.css                       # @import row-0.css; @import row-1.css;
  row-0.css                        # owned by row-0 agent
  row-1.css                        # owned by row-1 agent
```

## setup-polish-loop.js Changes

### New flag: `--row=N`

When present, generates infrastructure for one row only. When absent, generates full-header infrastructure (backward compatible, used for reconciliation).

### Per-row mode (`--row=0`)

- Reads only `row-0.json` from `--rows-dir`
- Generates `loop-row-0.sh`, `program-row-0.md`, `evaluate-row-0.js`
- Evaluator uses element screenshot of the row's CSS selector
- Scoring: pixelmatch 50% + judge 50% (no nav completeness)
- Source screenshot: crops `desktop.png` using row bounds at setup time, writes `source/desktop-row-0.png`
- Results directory: `results/row-0/`
- `program-row-0.md` scopes the agent to `row-0.css` only

### Init mode (`--init-css`)

A separate flag, run once before any `--row=N` calls:

```bash
node setup-polish-loop.js --init-css --rows-dir=... --target-dir=...
```

- Reads `rows.json` to determine row count
- Creates empty `row-N.css` stub files in `blocks/header/`
- Writes `header.css` with `@import url('row-N.css')` rules
- Preserves any existing non-row content in `header.css` (global resets, shared vars)

### Reconciliation mode (no `--row`, no `--init-css`)

Generates full-header infrastructure (`loop.sh`, `program.md`, `evaluate.js`) exactly as today. Used for the optional reconciliation pass in Phase 5.3. Generated during 5.1 alongside per-row files.

### New templates

| Template | Based on | Key differences |
|----------|----------|-----------------|
| `evaluate-row.js.tmpl` | `evaluate.js.tmpl` | Element screenshot by selector, no nav completeness, results in `row-N/` subdir |
| `loop-row.sh.tmpl` | `loop.sh.tmpl` | `HEADER_FILES=blocks/header/row-N.css`, file-scoped git ratchet, `row-N-` prefixed sessions, results file at `results-row-N.tsv` |
| `program-row.md.tmpl` | `program.md.tmpl` | Scoped to one row, references `row-N.css`, row-specific description and visual tree |

Judge templates (`judge.md.tmpl`, `judge-first.md.tmpl`) are unchanged -- they work with any source vs rendered screenshot pair.

## SKILL.md Phase 5 Rewrite

### 5.1 -- Polish Loop Setup (per-row)

1. Generate `header.css` with `@import` rules and empty `row-N.css` stubs:
   ```bash
   node setup-polish-loop.js --init-css --rows-dir=... --target-dir=...
   ```
2. For each row in `rows.json`, generate per-row loop infrastructure:
   ```bash
   node setup-polish-loop.js --row=N --rows-dir=... --url=... --source-dir=... --target-dir=... --port=3000 --max-iterations=30 --skill-home=...
   ```
3. Generate full-header infrastructure for reconciliation (no `--row` flag):
   ```bash
   node setup-polish-loop.js --rows-dir=... --url=... --source-dir=... --target-dir=... --port=3000 --max-iterations=5 --skill-home=...
   ```
4. Verify generated files exist: `loop-row-N.sh`, `program-row-N.md`, `evaluate-row-N.js` for each row, plus `loop.sh`, `evaluate.js` for reconciliation.

### 5.2 -- Parallel Row Polish

Start AEM dev server once (shared). Dispatch one Agent per row in a single message:

```
Agent({ description: "Polish row 0", prompt: "cd $PROJECT_ROOT && ./loop-row-0.sh ..." })
Agent({ description: "Polish row 1", prompt: "cd $PROJECT_ROOT && ./loop-row-1.sh ..." })
```

Wait for all agents to complete. Each converges independently via plateau detection or max iterations.

Session naming: each row uses `row-N-eval` for evaluator, `row-N-judge` for judge. No collisions.

### 5.3 -- Adaptive Reconciliation

1. Run full-header evaluator once (existing `evaluate.js` -- screenshots entire `<header>`, pixelmatch vs `source/desktop.png`, checks nav completeness).
2. If composite score >= 85%: skip reconciliation, log "rows converged cleanly."
3. If composite score < 85%: run existing full-header polish loop with `--max-iterations=5`.

The 85% threshold is a starting point. Tune after 3-5 real migrations.

## Git Ratchet Isolation

### Per-row loops

Each `loop-row-N.sh` scopes git operations to its own file:

- **Stage:** `git add blocks/header/row-N.css`
- **Revert:** `git checkout -- blocks/header/row-N.css` (file-scoped, not `reset --hard`)
- **Commit messages:** `row-0-iteration-3: ...` prefix to avoid log conflicts

File-scoped operations prevent parallel agents from corrupting each other's work.

### Reconciliation loop

Uses the original `reset --hard` approach -- runs alone after all row loops complete, no concurrency concern.

## Evaluator Changes (evaluate-row.js.tmpl)

### Element screenshot

```javascript
cli('screenshot', `--selector=${ROW_SELECTOR}`, `--filename=${renderedPath}`);
```

Fallback: if `playwright-cli screenshot --selector=` is not supported, use full-page screenshot + crop from row bounds (detected at setup time).

### No nav completeness

`checkNavCompleteness()` is removed from per-row evaluator. Nav completeness is checked only during reconciliation by the full-header evaluator.

### Scoring

Per-row evaluator outputs pixelmatch similarity only. `loop-row-N.sh` computes: `pixel * 0.50 + judge * 0.50`.

## Scope

### In scope

- `setup-polish-loop.js` gains `--row` flag
- Three new templates: `evaluate-row.js.tmpl`, `loop-row.sh.tmpl`, `program-row.md.tmpl`
- `header.css` rewritten to use `@import` rules
- SKILL.md Phase 5 rewritten (5.1/5.2/5.3)
- File-scoped git ratchet per row
- Adaptive reconciliation with 85% threshold

### Not in scope

- Judge template changes
- Phase 1-4 changes
- Phase 6 changes
- Mobile/responsive viewports
- Per-row `nav.plain.html` (stays whole-header)

## Risks

| Risk | Mitigation |
|------|------------|
| Parallel playwright-cli sessions cause flaky screenshots on shared dev server | Each evaluator retries once on empty/corrupt screenshots |
| 85% threshold is wrong (too high: skips needed reconciliation; too low: always runs it) | Tune after 3-5 real migrations |
| `@import` adds extra HTTP requests in dev | Acceptable for dev-only migration tool |

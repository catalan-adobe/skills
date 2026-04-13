# Playwright-CLI Usage Improvements (Follow-up)

Identified during per-row polish loop implementation (2026-04-10). All items are pre-existing code that works in production — improvements, not fixes.

## 1. Switch eval calls to --raw

**Files:** `evaluate.js.tmpl`, `capture-visual-tree.js`, `detect-overlays-fallback.js`

Currently `eval` output goes through `parseEvalOutput()` (cdp-helpers.js) which strips the `### Result` / `### Ran Playwright code` envelope and handles tricky string unwrapping. Using `--raw` eliminates this complexity.

**Change:** Add `--raw` to all `cli('eval', ...)` calls, remove `parseEvalOutput` wrapping, simplify `cliEval` helper.

**Risk:** Low. `--raw` is documented and tested. The main concern is verifying that all callers handle the raw output correctly (no envelope to strip means the output format changes).

## 2. Full-header evaluator: use locator.screenshot()

**File:** `evaluate.js.tmpl`

Currently takes a full-viewport screenshot, gets header bounding rect via `eval`, then crops in Node using `cropHeaderFromScreenshot()` (50+ lines of pixel copying). The per-row evaluator already uses `page.locator(selector).screenshot()` via `run-code --filename=`.

**Change:** Replace screenshot + eval + crop with `run-code --filename=` using `page.locator('header').screenshot()`. Delete `cropHeaderFromScreenshot()`.

**Risk:** Medium. The full-header evaluator is used by the reconciliation loop. Playwright's `locator.screenshot()` handles device pixel ratio automatically, which might produce different-sized images than the current manual crop. Need to verify pixelmatch still works correctly with the new screenshots.

## 3. --config flag position

**Files:** `capture-visual-tree.js`, `detect-overlays-fallback.js`, `css-query.js`

Our code puts `--config=file.json` after the URL: `open https://example.com --config=file.json`. The docs show `--config file.json open URL` (before the subcommand). Both likely work but the documented form is different.

**Change:** Move `--config` before `open` in all three scripts.

**Risk:** Low, but requires testing with browser recipes to confirm the flag is still picked up.

## 4. css-query.js run-code envelope parsing

**File:** `css-query.js` (line 84)

Uses inline `run-code` without `--raw`, then parses the envelope via `parseRunCodeOutput()`. Could use `--raw` to simplify, but queries are small and frequent — the overhead of the parser is negligible.

**Priority:** Low. Only change if touching css-query.js for another reason.

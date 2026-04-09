# Per-Row Visual Polish Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spawn one visual polish loop per header row in parallel, then run adaptive reconciliation on the full header.

**Architecture:** `setup-polish-loop.js` gains `--row=N` and `--init-css` flags to generate per-row infrastructure (loop script, evaluator, program prompt). Three new templates mirror the existing full-header templates but scoped to a single row. SKILL.md Phase 5 becomes three sub-phases: setup, parallel row dispatch, adaptive reconciliation.

**Tech Stack:** Node.js (ESM), Bash, Vitest, pixelmatch/pngjs, playwright-cli

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `skills/migrate-header/scripts/setup-polish-loop.js` | Modify | Add `--row=N`, `--init-css` flags; per-row file generation; source screenshot cropping |
| `skills/migrate-header/templates/evaluate-row.js.tmpl` | Create | Per-row evaluator: element screenshot, pixelmatch, no nav completeness |
| `skills/migrate-header/templates/loop-row.sh.tmpl` | Create | Per-row outer loop: file-scoped git ratchet, row-prefixed sessions |
| `skills/migrate-header/templates/program-row.md.tmpl` | Create | Per-row polish agent prompt: scoped to `row-N.css` |
| `skills/migrate-header/SKILL.md` | Modify (lines 823–901) | Phase 5 rewrite: 5.1 setup, 5.2 parallel dispatch, 5.3 reconciliation |
| `tests/migrate-header/setup-polish-loop.test.js` | Modify | Add tests for `--row`, `--init-css`, `cropSourceRow`, `generateInitCss` |

Existing templates (`evaluate.js.tmpl`, `loop.sh.tmpl`, `program.md.tmpl`, `judge.md.tmpl`, `judge-first.md.tmpl`) are **unchanged** — they serve the reconciliation pass.

---

### Task 1: `evaluate-row.js.tmpl` — Per-Row Evaluator Template

**Files:**
- Create: `skills/migrate-header/templates/evaluate-row.js.tmpl`

This is the per-row evaluator. It screenshots a single row element, compares against the cropped source, and outputs pixelmatch similarity. No nav completeness. Results go to `row-N/` subdirectory.

- [ ] **Step 1: Create `evaluate-row.js.tmpl`**

Based on `evaluate.js.tmpl` with these changes:
- Replace `SESSION = 'header-eval'` with `SESSION = '{{ROW_SESSION}}'`
- Replace the full-viewport screenshot + header crop logic with a single element screenshot using `{{ROW_SELECTOR}}`
- Remove `checkNavCompleteness()` and `normalizeNavText()` entirely
- Remove `cropHeaderFromScreenshot()` — not needed for element screenshots
- Change `SOURCE_DIR` source image from `desktop.png` to `desktop-row-{{ROW_INDEX}}.png`
- Change `RESULTS_DIR` to `join(__dirname, 'results', 'row-{{ROW_INDEX}}')`
- Output only `similarity` in the composite — no `navCompleteness` field
- Add screenshot retry: if rendered image is missing or 0 bytes after first attempt, sleep 2s and retry once

```javascript
/** IMMUTABLE EVALUATOR — the agent must not modify this file.
 *
 * Captures a single header row element, compares against cropped source,
 * and outputs a pixelmatch score. Used by loop-row-N.sh for keep/discard.
 *
 * Usage: node autoresearch/evaluate-row-{{ROW_INDEX}}.js <port> <iteration>
 * Output: JSON to stdout with score and breakdown
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { parseEvalOutput } from '{{SKILL_HOME}}/scripts/cdp-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(__dirname, 'source');
const RESULTS_DIR = join(__dirname, 'results', 'row-{{ROW_INDEX}}');
const PORT = process.argv[2] || '{{PORT}}';
const PAGE_PATH = '{{PAGE_PATH}}';
const ITERATION = process.argv[3] || 'latest';
const BASE_URL = `http://localhost:${PORT}${PAGE_PATH}`;
const SESSION = '{{ROW_SESSION}}';
const ROW_SELECTOR = '{{ROW_SELECTOR}}';

mkdirSync(RESULTS_DIR, { recursive: true });

const EXEC_OPTS = { encoding: 'utf-8', timeout: 30000 };

function cli(...args) {
  return execFileSync(
    'playwright-cli', [`-s=${SESSION}`, ...args], EXEC_OPTS,
  ).trim();
}

function cliEval(js) {
  return parseEvalOutput(cli('eval', js));
}

function compareImages(sourcePath, renderedPath, diffPath) {
  if (!existsSync(sourcePath)) return { similarity: 0, error: 'source missing' };
  if (!existsSync(renderedPath)) return { similarity: 0, error: 'rendered missing' };

  const sourceImg = PNG.sync.read(readFileSync(sourcePath));
  const renderedImg = PNG.sync.read(readFileSync(renderedPath));

  const width = Math.max(sourceImg.width, renderedImg.width);
  const height = Math.max(sourceImg.height, renderedImg.height);

  const padPng = (img, w, h) => {
    const padded = new PNG({ width: w, height: h });
    for (let i = 0; i < padded.data.length; i += 4) {
      padded.data[i] = 255;
      padded.data[i + 1] = 255;
      padded.data[i + 2] = 255;
      padded.data[i + 3] = 255;
    }
    for (let y = 0; y < img.height && y < h; y++) {
      for (let x = 0; x < img.width && x < w; x++) {
        const srcIdx = (y * img.width + x) * 4;
        const dstIdx = (y * w + x) * 4;
        padded.data[dstIdx] = img.data[srcIdx];
        padded.data[dstIdx + 1] = img.data[srcIdx + 1];
        padded.data[dstIdx + 2] = img.data[srcIdx + 2];
        padded.data[dstIdx + 3] = img.data[srcIdx + 3];
      }
    }
    return padded;
  };

  const src = sourceImg.width === width && sourceImg.height === height
    ? sourceImg : padPng(sourceImg, width, height);
  const ren = renderedImg.width === width && renderedImg.height === height
    ? renderedImg : padPng(renderedImg, width, height);

  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(
    src.data,
    ren.data,
    diff.data,
    width,
    height,
    { threshold: 0.15, alpha: 0.5 },
  );

  writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  const similarity = ((totalPixels - mismatchedPixels) / totalPixels) * 100;
  return {
    similarity: Math.round(similarity * 100) / 100,
    mismatchedPixels,
    totalPixels,
    width,
    height,
    sourceHeight: sourceImg.height,
    renderedHeight: renderedImg.height,
  };
}

function takeElementScreenshot(outputPath) {
  try {
    cli('screenshot', `--selector=${ROW_SELECTOR}`, `--filename=${outputPath}`);
    if (existsSync(outputPath) && readFileSync(outputPath).length > 0) {
      return true;
    }
  } catch {
    // Fall through to retry
  }
  // Retry once after settling
  execFileSync('sleep', ['2']);
  try {
    cli('screenshot', `--selector=${ROW_SELECTOR}`, `--filename=${outputPath}`);
    return existsSync(outputPath) && readFileSync(outputPath).length > 0;
  } catch {
    return false;
  }
}

// Main evaluation
const results = { viewports: {}, compositeScore: 0 };

try {
  cli('open', BASE_URL);
} catch (err) {
  console.error(JSON.stringify({ error: `Failed to open ${BASE_URL}: ${err.message}` }));
  process.exit(1);
}

const sourcePath = join(SOURCE_DIR, `desktop-row-{{ROW_INDEX}}.png`);
const renderedPath = join(RESULTS_DIR, 'desktop-rendered.png');
const diffPath = join(RESULTS_DIR, 'desktop-diff.png');

try {
  cli('resize', '1440', '900');
  execFileSync('sleep', ['2']);

  const captured = takeElementScreenshot(renderedPath);

  if (captured) {
    const iterPath = join(RESULTS_DIR, `desktop-rendered-${ITERATION}.png`);
    writeFileSync(iterPath, readFileSync(renderedPath));

    const comparison = compareImages(sourcePath, renderedPath, diffPath);
    results.viewports.desktop = { ...comparison, weight: 1.0 };
  } else {
    results.viewports.desktop = {
      similarity: 0, error: 'element screenshot failed', weight: 1.0,
    };
  }
} catch (err) {
  results.viewports.desktop = {
    similarity: 0, error: err.message, weight: 1.0,
  };
}

try {
  cli('close');
} catch {
  // Session may already be closed
}

results.compositeScore = results.viewports.desktop?.similarity || 0;

console.log(JSON.stringify(results, null, 2));

writeFileSync(
  join(RESULTS_DIR, 'latest-evaluation.json'),
  JSON.stringify(results, null, 2),
);
```

- [ ] **Step 2: Verify template placeholders are consistent**

Confirm these placeholders exist in the template:
- `{{ROW_INDEX}}` — row number (0, 1, ...)
- `{{ROW_SELECTOR}}` — CSS selector for the row element
- `{{ROW_SESSION}}` — playwright-cli session name (e.g., `row-0-eval`)
- `{{PORT}}`, `{{PAGE_PATH}}`, `{{SKILL_HOME}}` — shared with existing templates

- [ ] **Step 3: Commit**

```bash
git add skills/migrate-header/templates/evaluate-row.js.tmpl
git commit -m "feat(migrate-header): add per-row evaluator template"
```

---

### Task 2: `loop-row.sh.tmpl` — Per-Row Loop Template

**Files:**
- Create: `skills/migrate-header/templates/loop-row.sh.tmpl`

Per-row outer loop. Key differences from `loop.sh.tmpl`:
- `HEADER_FILES="blocks/header/row-{{ROW_INDEX}}.css"` — only its own CSS file
- File-scoped git ratchet: `git checkout -- blocks/header/row-N.css` instead of `reset --hard`
- Results file: `results-row-{{ROW_INDEX}}.tsv`
- Session names: `row-{{ROW_INDEX}}-judge` for judge
- Commit messages: `row-{{ROW_INDEX}}-iteration-N: ...`
- Scoring: `pixel * 0.50 + judge * 0.50` (no nav weight)

- [ ] **Step 1: Create `loop-row.sh.tmpl`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Per-row autoresearch loop for EDS header migration.
# Scoped to row-{{ROW_INDEX}} — only modifies blocks/header/row-{{ROW_INDEX}}.css.

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
EVALUATE="node ${PROJECT_DIR}/autoresearch/evaluate-row-{{ROW_INDEX}}.js"
RESULTS_FILE="${PROJECT_DIR}/results-row-{{ROW_INDEX}}.tsv"
PROGRAM_FILE="${PROJECT_DIR}/program-row-{{ROW_INDEX}}.md"
PORT="${AEM_PORT:-{{PORT}}}"
MAX_ITERATIONS="${MAX_ITERATIONS:-{{MAX_ITERATIONS}}}"
MAX_CONSECUTIVE_REVERTS="${MAX_CONSECUTIVE_REVERTS:-{{MAX_CONSECUTIVE_REVERTS}}}"
ROW_CSS="blocks/header/row-{{ROW_INDEX}}.css"
BEST_SCORE=0
ITERATION=0
CONSECUTIVE_REVERTS=0
BEST_KEPT_ITERATION=0
JUDGE_TMPL_DIR="{{SKILL_HOME}}/templates"
JUDGE_NEUTRAL=$'50\t{"layout_ok":true,"precision_ok":false,"active_gate":1,"diagnosis":[],"structure_issues":[],"precision_issues":[],"reasoning":""}'
ROW_RESULTS_DIR="${PROJECT_DIR}/autoresearch/results/row-{{ROW_INDEX}}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[row-{{ROW_INDEX}}]${NC} $1"; }
ok()  { echo -e "${GREEN}[row-{{ROW_INDEX}}]${NC} $1"; }
warn() { echo -e "${YELLOW}[row-{{ROW_INDEX}}]${NC} $1"; }
err() { echo -e "${RED}[row-{{ROW_INDEX}}]${NC} $1"; }

cleanup() {
  echo ""
  log "Stopping... Final best score: ${BEST_SCORE}"
  if [[ -f "${RESULTS_FILE}" ]]; then
    log "Results saved to ${RESULTS_FILE}"
    log "Total iterations: ${ITERATION}"
    log "Consecutive reverts at exit: ${CONSECUTIVE_REVERTS}"
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

mkdir -p "${ROW_RESULTS_DIR}"

# Initialize results file
if [[ ! -f "${RESULTS_FILE}" ]]; then
  printf "iteration\tcommit\tscore\tvisual_desktop\tjudge\tstatus\tdescription\n" \
    > "${RESULTS_FILE}"
fi

# Resume support: read best score and iteration count from existing results
if [[ -f "${RESULTS_FILE}" ]]; then
  existing_best=$(tail -n +2 "${RESULTS_FILE}" \
    | awk -F'\t' '{print $3}' | sort -rn | head -1)
  if [[ -n "${existing_best}" ]]; then
    BEST_SCORE="${existing_best}"
    ITERATION=$(tail -n +2 "${RESULTS_FILE}" | wc -l | tr -d ' ')
    log "Resuming from iteration ${ITERATION}, best score: ${BEST_SCORE}"
  fi
fi

# Check dev server is reachable
check_server() {
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:${PORT}/" 2>/dev/null) || true
  if [[ "${status}" != "200" ]]; then
    err "Dev server not running on port ${PORT}."
    err "Start it with: cd ${PROJECT_DIR} && aem up --html-folder ."
    exit 1
  fi
}

# Run evaluator and extract score
run_evaluation() {
  local eval_output
  eval_output=$(${EVALUATE} "${PORT}" "${ITERATION}" 2>/dev/null) || true

  if [[ -z "${eval_output}" ]]; then
    echo "0"
    return
  fi

  echo "${eval_output}" | node --input-type=commonjs -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log(d.compositeScore||0);
  " 2>/dev/null || echo "0"
}

# Run LLM judge: compare source + before + after row screenshots
run_judge() {
  local iteration=$1
  local source_img="${PROJECT_DIR}/autoresearch/source/desktop-row-{{ROW_INDEX}}.png"
  local styles_json="${PROJECT_DIR}/autoresearch/extraction/styles.json"
  local css_query="{{SKILL_HOME}}/scripts/css-query.js"
  local after_img="${ROW_RESULTS_DIR}/desktop-rendered-${iteration}.png"
  local judge_prompt_file="/tmp/judge-row-{{ROW_INDEX}}-prompt-$$.md"

  if [[ ! -f "${after_img}" ]]; then
    warn "Judge: after screenshot not found, skipping"
    printf '%s\n' "${JUDGE_NEUTRAL}"
    return
  fi

  local common_seds=(
    -e "s|{{SOURCE_IMG}}|${source_img}|g"
    -e "s|{{AFTER_IMG}}|${after_img}|g"
    -e "s|{{AFTER_ITERATION}}|${iteration}|g"
    -e "s|{{STYLES_JSON}}|${styles_json}|g"
    -e "s|{{CSS_QUERY}}|${css_query}|g"
    -e "s|{{PORT}}|${PORT}|g"
  )

  if [[ ${BEST_KEPT_ITERATION} -eq 0 ]]; then
    local tmpl="${JUDGE_TMPL_DIR}/judge-first.md.tmpl"
    if [[ ! -f "${tmpl}" ]]; then
      warn "Judge: first-iteration template not found, skipping"
      printf '%s\n' "${JUDGE_NEUTRAL}"
      return
    fi
    sed "${common_seds[@]}" "${tmpl}" > "${judge_prompt_file}"
  else
    local before_img="${ROW_RESULTS_DIR}/desktop-rendered-${BEST_KEPT_ITERATION}.png"
    local tmpl="${JUDGE_TMPL_DIR}/judge.md.tmpl"
    if [[ ! -f "${tmpl}" ]]; then
      warn "Judge: template not found, skipping"
      printf '%s\n' "${JUDGE_NEUTRAL}"
      return
    fi
    if [[ ! -f "${before_img}" ]]; then
      warn "Judge: before screenshot not found, using first-iteration template"
      tmpl="${JUDGE_TMPL_DIR}/judge-first.md.tmpl"
      sed "${common_seds[@]}" "${tmpl}" > "${judge_prompt_file}"
    else
      sed "${common_seds[@]}" \
          -e "s|{{BEFORE_IMG}}|${before_img}|g" \
          -e "s|{{BEFORE_ITERATION}}|${BEST_KEPT_ITERATION}|g" \
          "${tmpl}" > "${judge_prompt_file}"
    fi
  fi

  # Open css-query session on rendered page for Gate 2
  node "${css_query}" open "http://localhost:${PORT}/" --session=row-{{ROW_INDEX}}-judge 2>/dev/null || true

  local judge_raw
  judge_raw=$(claude -p "$(cat "${judge_prompt_file}")" \
    --allowedTools "Read,Bash" \
    --output-format json 2>"${ROW_RESULTS_DIR}/judge-stderr.log") || true
  rm -f "${judge_prompt_file}"

  node "${css_query}" close --session=row-{{ROW_INDEX}}-judge 2>/dev/null || true

  if [[ -z "${judge_raw}" ]]; then
    warn "Judge: no output, defaulting to neutral"
    printf '%s\n' "${JUDGE_NEUTRAL}"
    return
  fi

  echo "${judge_raw}" | node --input-type=commonjs -e "
    const raw = require('fs').readFileSync('/dev/stdin', 'utf-8').trim();
    try {
      const envelope = JSON.parse(raw);
      const d = JSON.parse(envelope.result);
      const score = d.improved === true ? 100 : (d.improved === false ? 0 : 50);
      const detail = JSON.stringify({
        layout_ok: d.layout_ok === true,
        precision_ok: d.precision_ok === true,
        active_gate: d.active_gate || 1,
        diagnosis: d.diagnosis || [],
        structure_issues: d.structure_issues || [],
        precision_issues: d.precision_issues || [],
        reasoning: d.reasoning || '',
      });
      console.log(score + '\t' + detail);
    } catch {
      console.log('50\t' + JSON.stringify({layout_ok:true,precision_ok:false,active_gate:1,diagnosis:[],structure_issues:[],precision_issues:[],reasoning:''}));
    }
  " 2>/dev/null || printf '%s\n' "${JUDGE_NEUTRAL}"
}

# Main loop
log "Starting row-{{ROW_INDEX}} polish loop"
log "Max iterations: ${MAX_ITERATIONS}"
log "Plateau threshold: ${MAX_CONSECUTIVE_REVERTS} consecutive reverts"
log "Evaluator: ${EVALUATE}"
echo ""

check_server

while [[ ${ITERATION} -lt ${MAX_ITERATIONS} ]]; do
  ITERATION=$((ITERATION + 1))
  log "=== Iteration ${ITERATION}/${MAX_ITERATIONS} (best: ${BEST_SCORE}, reverts: ${CONSECUTIVE_REVERTS}/${MAX_CONSECUTIVE_REVERTS}) ==="

  # Snapshot row CSS before agent session
  cp "${PROJECT_DIR}/${ROW_CSS}" "/tmp/row-{{ROW_INDEX}}-backup-$$.css" 2>/dev/null || true

  # Fresh claude session with row program
  log "Launching fresh Claude session..."
  (cd "${PROJECT_DIR}" && claude -p "$(cat "${PROGRAM_FILE}")" \
    --allowedTools "Edit,Write,Read,Glob,Grep,Bash" \
    > /dev/null 2>&1) || true

  # Check if row CSS changed
  has_changes=false
  if ! diff -q "${PROJECT_DIR}/${ROW_CSS}" "/tmp/row-{{ROW_INDEX}}-backup-$$.css" \
    >/dev/null 2>&1; then
    has_changes=true
  fi

  if [[ "${has_changes}" == "false" ]]; then
    warn "No changes detected, skipping evaluation"
    printf "%d\t-\t%s\t-\t-\tno_changes\tAgent made no modifications\n" \
      "${ITERATION}" "${BEST_SCORE}" >> "${RESULTS_FILE}"
    CONSECUTIVE_REVERTS=$((CONSECUTIVE_REVERTS + 1))
    if [[ ${CONSECUTIVE_REVERTS} -ge ${MAX_CONSECUTIVE_REVERTS} ]]; then
      err "Plateau: ${CONSECUTIVE_REVERTS} consecutive non-improvements. Stopping."
      break
    fi
    continue
  fi

  # Stage and commit the row CSS
  git -C "${PROJECT_DIR}" add "${ROW_CSS}" 2>/dev/null || true
  git -C "${PROJECT_DIR}" commit \
    -m "row-{{ROW_INDEX}}-iteration-${ITERATION}: agent modifications" \
    2>/dev/null || true

  local_commit=$(git -C "${PROJECT_DIR}" rev-parse --short HEAD)
  commit_msg=$(git -C "${PROJECT_DIR}" log -1 --format=%s)

  # Run immutable evaluator
  log "Running evaluation..."
  desktop=$(run_evaluation)

  # Run LLM judge
  log "Running judge comparison..."
  judge_result=$(run_judge "${ITERATION}")
  IFS=$'\t' read -r judge_score judge_detail <<< "${judge_result}"

  # Write judge feedback for next iteration
  echo "${judge_detail}" > "${ROW_RESULTS_DIR}/judge-feedback.json"

  # Composite: pixelmatch 50% + judge 50% (no nav weight)
  score=$(node -e "
    const pm = ${desktop} || 0;
    const judge = ${judge_score} || 50;
    console.log(Math.round((pm * 0.50 + judge * 0.50) * 100) / 100);
  " 2>/dev/null || echo "0")

  keep=$(node -e "console.log(${score} > ${BEST_SCORE} ? 'yes' : 'no')" \
    2>/dev/null || echo "no")

  if [[ "${keep}" == "yes" ]]; then
    iteration_status="kept"
    ok "IMPROVED: ${BEST_SCORE} -> ${score} (desktop=${desktop}, judge=${judge_score})"
    BEST_SCORE="${score}"
    BEST_KEPT_ITERATION=${ITERATION}
    CONSECUTIVE_REVERTS=0
    printf "%d\t%s\t%s\t%s\t%s\timproved\t%s\n" \
      "${ITERATION}" "${local_commit}" "${score}" \
      "${desktop}" "${judge_score}" \
      "${commit_msg}" \
      >> "${RESULTS_FILE}"
  else
    iteration_status="reverted"
    warn "NO IMPROVEMENT: ${score} <= ${BEST_SCORE} (judge=${judge_score}) — reverting"
    # File-scoped revert — does not affect other rows
    git -C "${PROJECT_DIR}" checkout -- "${ROW_CSS}" 2>/dev/null || true
    # Also revert the commit
    git -C "${PROJECT_DIR}" reset --soft HEAD~1 2>/dev/null || true
    git -C "${PROJECT_DIR}" checkout -- "${ROW_CSS}" 2>/dev/null || true
    CONSECUTIVE_REVERTS=$((CONSECUTIVE_REVERTS + 1))
    printf "%d\t%s\t%s\t%s\t%s\treverted\t%s\n" \
      "${ITERATION}" "${local_commit}" "${score}" \
      "${desktop}" "${judge_score}" \
      "${commit_msg}" \
      >> "${RESULTS_FILE}"

    if [[ ${CONSECUTIVE_REVERTS} -ge ${MAX_CONSECUTIVE_REVERTS} ]]; then
      err "Plateau: ${CONSECUTIVE_REVERTS} consecutive non-improvements. Stopping."
      break
    fi
  fi

  # Append to cumulative judge history
  node -e "
    const fs = require('fs');
    const detail = JSON.parse(process.argv[1] || '{}');
    const entry = {
      ...detail,
      iteration: ${ITERATION},
      composite: ${score},
      desktop: ${desktop},
      judge: ${judge_score},
      status: '${iteration_status}',
    };
    fs.appendFileSync(
      '${ROW_RESULTS_DIR}/judge-history.jsonl',
      JSON.stringify(entry) + '\n'
    );
  " "${judge_detail}" 2>/dev/null || true

  rm -f "/tmp/row-{{ROW_INDEX}}-backup-$$.css"
  echo ""
done

rm -f "/tmp/row-{{ROW_INDEX}}-backup-$$.css"
log "Row-{{ROW_INDEX}} loop finished. Best score: ${BEST_SCORE} after ${ITERATION} iterations."
```

- [ ] **Step 2: Commit**

```bash
git add skills/migrate-header/templates/loop-row.sh.tmpl
git commit -m "feat(migrate-header): add per-row loop template"
```

---

### Task 3: `program-row.md.tmpl` — Per-Row Polish Agent Prompt

**Files:**
- Create: `skills/migrate-header/templates/program-row.md.tmpl`

Scoped version of `program.md.tmpl`. Key differences:
- Agent owns only `blocks/header/row-{{ROW_INDEX}}.css`
- Cannot modify `header.css`, `header.js`, `nav.plain.html`, or other row files
- Scoring explanation: pixelmatch 50% + judge 50%
- Source reference uses `desktop-row-{{ROW_INDEX}}.png`
- Results at `autoresearch/results/row-{{ROW_INDEX}}/`
- Row-specific description and visual tree subtree
- CSS query session: `row-{{ROW_INDEX}}-css-src`

- [ ] **Step 1: Create `program-row.md.tmpl`**

```markdown
# Row {{ROW_INDEX}} Migration — Autoresearch Program

## Goal

Polish row {{ROW_INDEX}} of the header from {{URL}} to match the source with maximum visual fidelity.

**Your row:**
{{ROW_DESCRIPTION}}

**Row height: ~{{ROW_HEIGHT}}px at desktop.** Matching this height is critical for the visual score.

## Your Environment

- AEM Edge Delivery Services dev server running at http://localhost:{{PORT}}
- Content served from project root via `aem up --html-folder .`
- Test page: http://localhost:{{PORT}}/
- Your row is rendered via section-metadata class `{{ROW_SECTION_STYLE}}`

## What You CAN Modify

You may ONLY modify this one file:

1. `blocks/header/row-{{ROW_INDEX}}.css` — Your row's styles

## What You CANNOT Modify

Everything else is off-limits. In particular:
- `blocks/header/header.css` — imports row files, managed by orchestrator
- `blocks/header/header.js` — shared decoration logic
- `blocks/header/row-*.css` (other rows) — owned by other agents
- `nav.plain.html` — shared nav structure
- `autoresearch/` — evaluation infrastructure (immutable)
- `loop-row-*.sh`, `program-row-*.md` — loop infrastructure
- `scripts/`, `styles/` — EDS core files

## How to Read History

Before making changes, ALWAYS review what has been tried:
1. `cat results-row-{{ROW_INDEX}}.tsv` — Full experiment log (iteration, score, status, description)
2. `cat autoresearch/results/row-{{ROW_INDEX}}/latest-evaluation.json` — Last evaluation breakdown
3. **Read the diff image** — `autoresearch/results/row-{{ROW_INDEX}}/desktop-diff.png` shows pixel-level mismatches. Read this image to see WHERE the differences are.
4. `cat autoresearch/results/row-{{ROW_INDEX}}/judge-feedback.json` (if exists) — Judge assessment from previous iteration

If results show repeated reverts for similar approaches, try something fundamentally different.

## Judge Feedback

If `autoresearch/results/row-{{ROW_INDEX}}/judge-feedback.json` exists, read it FIRST.
It contains a three-gate assessment from the previous iteration. See the gate descriptions:

- **Gate 1 (`layout_ok: false`)** — structural layout is wrong. Fix element positions, sizes, order.
- **Gate 2 (`precision_ok: false`)** — layout correct but fonts, sizes, dimensions don't match. Fix specific CSS values.
- **Gate 3 (both ok)** — structure and precision correct. Fix colors, spacing, decorative details.

Fix issues from the **active gate** only.

## How the Evaluator Scores You

After you exit, two evaluations run:

1. **Pixelmatch evaluator** — screenshots your row element and compares against the source row screenshot
2. **LLM judge** — compares source, previous best, and current render

The composite score (0-100) combines:
- **50% weight**: Visual similarity via pixelmatch
- **50% weight**: LLM judge (improved? YES=100, NO=0)

The outer loop keeps your changes if the score improves, reverts if it doesn't.

## Source Reference

- `autoresearch/source/desktop-row-{{ROW_INDEX}}.png` — Cropped screenshot of source row at 1440px

## Source Visual Tree (your row only)

```
{{ROW_VISUAL_TREE}}
```

## CSS Query Tool

Query the source page's actual CSS values:

```bash
node "{{SKILL_HOME}}/scripts/css-query.js" open "{{URL}}" --session=row-{{ROW_INDEX}}-css-src
node "{{SKILL_HOME}}/scripts/css-query.js" query "<selector>" "<properties>" --session=row-{{ROW_INDEX}}-css-src
node "{{SKILL_HOME}}/scripts/css-query.js" close --session=row-{{ROW_INDEX}}-css-src
```

## Available Icons

{{ICON_GUIDANCE}}

## Constraints

1. **CSS only.** You can only edit `row-{{ROW_INDEX}}.css`. No JS changes.
2. **The row must render.** A broken row scores 0. Prefer incremental progress.
3. **Commit before exiting.** `git add blocks/header/row-{{ROW_INDEX}}.css && git commit -m "description"`
4. **Read results first.** Do not repeat approaches that were reverted.

## Strategy

Open a CSS query session at the start of every iteration:
```bash
node "{{SKILL_HOME}}/scripts/css-query.js" open "{{URL}}" --session=row-{{ROW_INDEX}}-css-src
```

### Phase 1: Structure (score < 30)
Get elements rendering in the correct positions within the row.

### Phase 2: Dimensions (score 30-50)
Match the row height (~{{ROW_HEIGHT}}px). Query source for exact values.

### Phase 3: Colors and layout (score 50-70)
Query source for exact colors, spacing, alignment values.

### Phase 4: Visual polish (score > 70)
Query specific properties for pixel-accurate matching.

## NEVER STOP

Continue working until you have made your changes and committed them. Then exit cleanly.
```

- [ ] **Step 2: Commit**

```bash
git add skills/migrate-header/templates/program-row.md.tmpl
git commit -m "feat(migrate-header): add per-row program prompt template"
```

---

### Task 4: `setup-polish-loop.js` — Add `--init-css` and `--row=N` Flags

**Files:**
- Modify: `skills/migrate-header/scripts/setup-polish-loop.js`
- Test: `tests/migrate-header/setup-polish-loop.test.js`

Add two new modes to the existing setup script:
1. `--init-css` — generates `header.css` with `@import` rules and empty `row-N.css` stubs
2. `--row=N` — generates per-row loop infrastructure (evaluator, loop script, program prompt)

The existing mode (no `--row`, no `--init-css`) stays unchanged for reconciliation.

- [ ] **Step 1: Write tests for `cropSourceRow`**

Add to `tests/migrate-header/setup-polish-loop.test.js`:

```javascript
import {
  loadRowFiles,
  buildHeaderDescription,
  countNavItems,
  buildNavStructure,
  synthesizeStyles,
  cropSourceRow,
  generateInitCss,
  buildRowReplacements,
} from '../../skills/migrate-header/scripts/setup-polish-loop.js';

// ... existing tests ...

describe('cropSourceRow', () => {
  it('crops a PNG to the specified row bounds', () => {
    // Create a 100x100 red PNG in memory
    const { PNG } = await import('pngjs');
    const img = new PNG({ width: 100, height: 100 });
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 255;     // R
      img.data[i + 1] = 0;   // G
      img.data[i + 2] = 0;   // B
      img.data[i + 3] = 255; // A
    }
    const sourceBuf = PNG.sync.write(img);

    const result = cropSourceRow(sourceBuf, { y: 10, height: 30 }, 100);
    const cropped = PNG.sync.read(result);
    expect(cropped.width).toBe(100);
    expect(cropped.height).toBe(30);
  });

  it('clamps bounds that exceed image dimensions', () => {
    const { PNG } = await import('pngjs');
    const img = new PNG({ width: 50, height: 50 });
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 0;
      img.data[i + 1] = 0;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
    const sourceBuf = PNG.sync.write(img);

    const result = cropSourceRow(sourceBuf, { y: 40, height: 30 }, 50);
    const cropped = PNG.sync.read(result);
    expect(cropped.width).toBe(50);
    expect(cropped.height).toBe(10); // clamped to 50-40
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/migrate-header/setup-polish-loop.test.js`
Expected: FAIL — `cropSourceRow` is not exported

- [ ] **Step 3: Write tests for `generateInitCss`**

```javascript
describe('generateInitCss', () => {
  it('generates @import rules for each row', () => {
    const rows = loadFixtures();
    const css = generateInitCss(rows);
    expect(css).toContain("@import url('row-0.css');");
    expect(css).toContain("@import url('row-1.css');");
  });

  it('preserves row order', () => {
    const rows = loadFixtures();
    const css = generateInitCss(rows);
    const idx0 = css.indexOf('row-0.css');
    const idx1 = css.indexOf('row-1.css');
    expect(idx0).toBeLessThan(idx1);
  });
});
```

- [ ] **Step 4: Write tests for `buildRowReplacements`**

```javascript
describe('buildRowReplacements', () => {
  it('returns row-specific template values', () => {
    const rows = loadFixtures();
    const r = buildRowReplacements(rows[0], {
      port: '3000',
      maxIterations: '30',
      url: 'https://example.com',
      skillHome: '/path/to/skill',
    });
    expect(r['{{ROW_INDEX}}']).toBe('0');
    expect(r['{{ROW_SELECTOR}}']).toBeDefined();
    expect(r['{{ROW_SESSION}}']).toBe('row-0-eval');
    expect(r['{{ROW_HEIGHT}}']).toBe('44');
    expect(r['{{ROW_SECTION_STYLE}}']).toBe('brand');
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run tests/migrate-header/setup-polish-loop.test.js`
Expected: FAIL — functions not exported

- [ ] **Step 6: Implement `cropSourceRow` in `setup-polish-loop.js`**

Add after the existing `synthesizeStyles` function:

```javascript
export function cropSourceRow(pngBuffer, bounds, sourceWidth) {
  const { PNG } = await import('pngjs');
  // Use dynamic import at call site — PNG is only needed for cropping
  const source = PNG.sync.read(pngBuffer);
  const y = Math.round(bounds.y);
  const h = Math.min(
    Math.round(bounds.height),
    source.height - y,
  );
  const w = Math.min(sourceWidth, source.width);

  const cropped = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const srcIdx = ((y + row) * source.width + col) * 4;
      const dstIdx = (row * w + col) * 4;
      cropped.data[dstIdx] = source.data[srcIdx];
      cropped.data[dstIdx + 1] = source.data[srcIdx + 1];
      cropped.data[dstIdx + 2] = source.data[srcIdx + 2];
      cropped.data[dstIdx + 3] = source.data[srcIdx + 3];
    }
  }
  return PNG.sync.write(cropped);
}
```

Note: `cropSourceRow` needs `pngjs` which is installed by the evaluator's npm init step. Since this runs at setup time before that, we need to handle this. Two options: (a) use the `pngjs` already installed in autoresearch/ after npm init, or (b) import it dynamically. Since `setup-polish-loop.js` runs after directory creation but before the evaluator npm init, we should install pngjs early or use a simpler approach.

**Simpler approach — use the existing `cropHeaderFromScreenshot` logic inline with `sharp` or just re-use pngjs by ensuring it's available.** The cleanest path: move `npm init` + `npm install pixelmatch pngjs` to happen before per-row setup calls. This is already the case since `--init-css` runs first and can do the npm install, then `--row=N` calls can import pngjs.

Actually, the simplest approach: `cropSourceRow` accepts a parsed PNG object instead of a buffer, and the caller handles pngjs import. But since this is a setup script that runs on the developer's machine (not in the EDS project), we can just add pngjs as a dependency of the script itself. However, the skill's scripts don't have their own package.json.

**Revised approach:** Do the cropping in `--init-css` mode (which runs first), using a child process that calls into the autoresearch dir where pngjs is installed. OR, simpler: use Node's built-in capabilities. Since we're just slicing a PNG, we can shell out to `ffmpeg` which is already a dependency of the skill ecosystem:

```bash
ffmpeg -i source/desktop.png -vf "crop=in_w:ROW_HEIGHT:0:ROW_Y" source/desktop-row-N.png
```

But that adds an ffmpeg dependency to header migration which doesn't otherwise need it.

**Final approach:** Have `--init-css` also run `npm init -y && npm install pixelmatch pngjs` in the autoresearch dir (moving it from the default mode). Then `--row=N` can import pngjs from there. This is the cleanest split.

- [ ] **Step 7: Implement `generateInitCss`**

```javascript
export function generateInitCss(rows) {
  const imports = rows.map(
    (_, i) => `@import url('row-${i}.css');`,
  );
  return imports.join('\n') + '\n';
}
```

- [ ] **Step 8: Implement `buildRowReplacements`**

```javascript
export function buildRowReplacements(row, opts) {
  return {
    '{{ROW_INDEX}}': String(row.index),
    '{{ROW_SELECTOR}}': row.selector || `header > :nth-child(${row.index + 1})`,
    '{{ROW_SESSION}}': `row-${row.index}-eval`,
    '{{ROW_HEIGHT}}': String(Math.round(row.bounds.height)),
    '{{ROW_SECTION_STYLE}}': row.suggestedSectionStyle || `row-${row.index}`,
    '{{ROW_DESCRIPTION}}': row.description || `Row ${row.index}`,
    '{{ROW_VISUAL_TREE}}': row.vtSubtree || 'Visual tree not available.',
    '{{PORT}}': opts.port,
    '{{PAGE_PATH}}': '/',
    '{{MAX_ITERATIONS}}': opts.maxIterations,
    '{{MAX_CONSECUTIVE_REVERTS}}': '5',
    '{{URL}}': opts.url,
    '{{SKILL_HOME}}': opts.skillHome,
    '{{ICON_GUIDANCE}}': opts.iconGuidance || '',
  };
}
```

- [ ] **Step 9: Add `--init-css` mode to `parseArgs` and `main`**

Update `parseArgs` to accept `--init-css` and `--row` flags:

```javascript
function parseArgs(argv) {
  const named = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (m) named[m[1]] = m[2];
    // Boolean flags (no =value)
    if (arg === '--init-css') named['init-css'] = 'true';
  }

  const initCss = named['init-css'] === 'true';
  const rowIndex = named['row'] !== undefined ? parseInt(named['row'], 10) : null;

  if (initCss) {
    // --init-css only needs rows-dir and target-dir
    const required = ['rows-dir', 'target-dir'];
    const missing = required.filter((k) => !named[k]);
    if (missing.length > 0) {
      console.error(`Missing: ${missing.map((k) => `--${k}`).join(', ')}`);
      process.exit(1);
    }
    return { mode: 'init-css', rowsDir: resolve(named['rows-dir']), targetDir: resolve(named['target-dir']) };
  }

  // Full mode (--row=N or default reconciliation)
  const required = ['rows-dir', 'url', 'source-dir', 'target-dir'];
  const missing = required.filter((k) => !named[k]);
  if (missing.length > 0) {
    console.error(`Missing: ${missing.map((k) => `--${k}`).join(', ')}`);
    process.exit(1);
  }

  return {
    mode: rowIndex !== null ? 'row' : 'full',
    rowIndex,
    rowsDir: resolve(named['rows-dir']),
    url: named['url'],
    sourceDir: resolve(named['source-dir']),
    targetDir: resolve(named['target-dir']),
    explicitPort: named['port'] || null,
    maxIterations: named['max-iterations'] || '30',
    skillHome: named['skill-home'] || join(__dirname, '..'),
  };
}
```

- [ ] **Step 10: Add `mainInitCss` function**

```javascript
function mainInitCss(args) {
  const rows = loadRowFiles(args.rowsDir);
  if (rows.length === 0) {
    console.error(`No row-*.json files found in: ${args.rowsDir}`);
    process.exit(1);
  }

  const headerDir = join(args.targetDir, 'blocks', 'header');
  mkdirSync(headerDir, { recursive: true });

  // Create empty row-N.css stubs
  for (let i = 0; i < rows.length; i++) {
    const rowCssPath = join(headerDir, `row-${i}.css`);
    if (!existsSync(rowCssPath)) {
      writeFileSync(rowCssPath, `/* Row ${i}: ${rows[i].description || ''} */\n`);
      log(`  Created blocks/header/row-${i}.css`);
    }
  }

  // Write header.css with @import rules
  const headerCssPath = join(headerDir, 'header.css');
  let existingContent = '';
  if (existsSync(headerCssPath)) {
    existingContent = readFileSync(headerCssPath, 'utf-8');
  }

  // Remove any existing @import row lines, preserve other content
  const nonImportLines = existingContent
    .split('\n')
    .filter((line) => !line.match(/^@import url\('row-\d+\.css'\);/))
    .join('\n')
    .trim();

  const importBlock = generateInitCss(rows);
  const finalCss = importBlock + (nonImportLines ? '\n\n' + nonImportLines + '\n' : '');
  writeFileSync(headerCssPath, finalCss);
  log(`  Wrote blocks/header/header.css with ${rows.length} @import rules`);

  // Install npm dependencies for evaluator (needed by --row mode for cropping)
  const autoresearchDir = join(args.targetDir, 'autoresearch');
  mkdirSync(autoresearchDir, { recursive: true });
  execSync('npm init -y', { cwd: autoresearchDir, stdio: 'pipe' });
  const pkgPath = join(autoresearchDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.type = 'module';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  execSync('npm install pixelmatch pngjs', { cwd: autoresearchDir, stdio: 'pipe' });
  log('  Installed pixelmatch + pngjs in autoresearch/');

  log(`Init CSS complete: ${rows.length} rows.`);
}
```

- [ ] **Step 11: Add `mainRow` function**

```javascript
async function mainRow(args) {
  const rows = loadRowFiles(args.rowsDir);
  const row = rows.find((r) => r.index === args.rowIndex);
  if (!row) {
    console.error(`Row ${args.rowIndex} not found in ${args.rowsDir}`);
    process.exit(1);
  }

  const port = detectPort(args.targetDir, args.explicitPort);

  // Crop source screenshot for this row
  const sourceDesktop = join(args.sourceDir, 'desktop.png');
  if (existsSync(sourceDesktop)) {
    const pngjsPath = join(args.targetDir, 'autoresearch', 'node_modules', 'pngjs', 'lib', 'pngjs.js');
    const { PNG } = await import(pngjsPath);
    const sourceBuf = readFileSync(sourceDesktop);
    const sourceImg = PNG.sync.read(sourceBuf);
    const y = Math.round(row.bounds.y);
    const h = Math.min(Math.round(row.bounds.height), sourceImg.height - y);
    const w = sourceImg.width;

    const cropped = new PNG({ width: w, height: h });
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const srcIdx = ((y + r) * sourceImg.width + c) * 4;
        const dstIdx = (r * w + c) * 4;
        cropped.data[dstIdx] = sourceImg.data[srcIdx];
        cropped.data[dstIdx + 1] = sourceImg.data[srcIdx + 1];
        cropped.data[dstIdx + 2] = sourceImg.data[srcIdx + 2];
        cropped.data[dstIdx + 3] = sourceImg.data[srcIdx + 3];
      }
    }

    const sourceOutDir = join(args.targetDir, 'autoresearch', 'source');
    mkdirSync(sourceOutDir, { recursive: true });
    writeFileSync(
      join(sourceOutDir, `desktop-row-${args.rowIndex}.png`),
      PNG.sync.write(cropped),
    );
    log(`  Cropped source row ${args.rowIndex}: ${w}x${h}px`);
  }

  // Build row-specific replacements
  const replacements = buildRowReplacements(row, {
    port,
    maxIterations: args.maxIterations,
    url: args.url,
    skillHome: args.skillHome,
    iconGuidance: buildIconGuidance(args.targetDir),
  });

  // Load row templates
  const evaluateTmpl = loadTemplate('evaluate-row.js.tmpl');
  const loopTmpl = loadTemplate('loop-row.sh.tmpl');
  const programTmpl = loadTemplate('program-row.md.tmpl');

  function applyReplacements(template) {
    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
      while (result.includes(key)) {
        result = result.replace(key, value);
      }
    }
    return result;
  }

  const autoresearchDir = join(args.targetDir, 'autoresearch');
  const rowResultsDir = join(autoresearchDir, 'results', `row-${args.rowIndex}`);
  mkdirSync(rowResultsDir, { recursive: true });

  // Write per-row evaluator
  writeFileSync(
    join(autoresearchDir, `evaluate-row-${args.rowIndex}.js`),
    applyReplacements(evaluateTmpl),
  );
  log(`  Wrote autoresearch/evaluate-row-${args.rowIndex}.js`);

  // Write per-row loop script
  const loopPath = join(args.targetDir, `loop-row-${args.rowIndex}.sh`);
  writeFileSync(loopPath, applyReplacements(loopTmpl));
  chmodSync(loopPath, 0o755);
  log(`  Wrote loop-row-${args.rowIndex}.sh`);

  // Write per-row program prompt
  writeFileSync(
    join(args.targetDir, `program-row-${args.rowIndex}.md`),
    applyReplacements(programTmpl),
  );
  log(`  Wrote program-row-${args.rowIndex}.md`);

  log(`Row ${args.rowIndex} infrastructure ready.`);
}
```

- [ ] **Step 12: Update `main` to dispatch by mode**

Replace the existing `main()` function body's first lines to branch on mode:

```javascript
async function main() {
  const args = parseArgs(process.argv);

  if (args.mode === 'init-css') {
    mainInitCss(args);
    return;
  }

  if (args.mode === 'row') {
    await mainRow(args);
    return;
  }

  // Existing full-header mode (reconciliation) — unchanged below this line
  const rows = loadRowFiles(args.rowsDir);
  // ... rest of existing main() ...
}
```

Also update the entry point at the bottom of the file:

```javascript
const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 13: Remove npm install from existing `main` (now in `mainInitCss`)**

In the existing full-header mode (now reached only for reconciliation), remove the npm init/install block (lines 367-380) since `--init-css` already handles it. Replace with a check:

```javascript
// Verify npm deps exist (installed by --init-css)
const pngjsCheck = join(autoresearchDir, 'node_modules', 'pngjs');
if (!existsSync(pngjsCheck)) {
  log('Installing evaluator dependencies...');
  execSync('npm init -y', { cwd: autoresearchDir, stdio: 'pipe' });
  const pkgPath = join(autoresearchDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.type = 'module';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  execSync('npm install pixelmatch pngjs', { cwd: autoresearchDir, stdio: 'pipe' });
  log('  Installed pixelmatch + pngjs');
}
```

- [ ] **Step 14: Export new functions**

Add to the existing exports at the top-level scope:

```javascript
export { cropSourceRow, generateInitCss, buildRowReplacements };
```

- [ ] **Step 15: Run all tests**

Run: `npx vitest run tests/migrate-header/setup-polish-loop.test.js`
Expected: All tests pass (existing + new)

- [ ] **Step 16: Commit**

```bash
git add skills/migrate-header/scripts/setup-polish-loop.js tests/migrate-header/setup-polish-loop.test.js
git commit -m "feat(migrate-header): add --init-css and --row flags to setup script"
```

---

### Task 5: Add `selector` Field to Row Fixtures

**Files:**
- Modify: `tests/migrate-header/fixtures/row-0.json`
- Modify: `tests/migrate-header/fixtures/row-1.json`

The `buildRowReplacements` function reads `row.selector`. The existing fixtures don't have this field. Add it so tests work.

- [ ] **Step 1: Add `selector` to fixtures**

In `row-0.json`, add after `"index": 0,`:
```json
"selector": "header > div:nth-child(1)",
```

In `row-1.json`, add after `"index": 1,`:
```json
"selector": "header > div:nth-child(2)",
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `npx vitest run tests/migrate-header/setup-polish-loop.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add tests/migrate-header/fixtures/row-0.json tests/migrate-header/fixtures/row-1.json
git commit -m "test(migrate-header): add selector field to row fixtures"
```

---

### Task 6: SKILL.md Phase 5 Rewrite

**Files:**
- Modify: `skills/migrate-header/SKILL.md` (lines 823–901)

Replace Phase 5 with three sub-phases: setup, parallel row dispatch, adaptive reconciliation.

- [ ] **Step 1: Replace Phase 5 section (lines 823–901)**

Replace everything from `### Phase 5: Visual Polish` through `Mark Phase 5 as completed. Then proceed to Phase 6 — do NOT stop here.` with:

```markdown
### Phase 5: Visual Polish

Mark Phase 5 as in_progress.

#### 5.1 Polish Loop Setup

**Initialize per-row CSS structure:**

```bash
node "$SKILL_HOME/scripts/setup-polish-loop.js" \
  "--init-css" \
  "--rows-dir=$PROJECT_ROOT/autoresearch/extraction" \
  "--target-dir=$PROJECT_ROOT"
```

**Generate per-row loop infrastructure** — run once for each row in `rows.json`:

```bash
ROWS_JSON="$PROJECT_ROOT/autoresearch/source/rows.json"
ROW_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROWS_JSON','utf-8')).length)")

for i in $(seq 0 $((ROW_COUNT - 1))); do
  node "$SKILL_HOME/scripts/setup-polish-loop.js" \
    "--row=$i" \
    "--rows-dir=$PROJECT_ROOT/autoresearch/extraction" \
    "--url=$URL" \
    "--source-dir=$PROJECT_ROOT/autoresearch/source" \
    "--target-dir=$PROJECT_ROOT" \
    "--port=3000" \
    "--max-iterations=$MAX_ITERATIONS" \
    "--skill-home=$SKILL_HOME"
done
```

**Generate full-header infrastructure for reconciliation:**

```bash
node "$SKILL_HOME/scripts/setup-polish-loop.js" \
  "--rows-dir=$PROJECT_ROOT/autoresearch/extraction" \
  "--url=$URL" \
  "--source-dir=$PROJECT_ROOT/autoresearch/source" \
  "--target-dir=$PROJECT_ROOT" \
  "--port=3000" \
  "--max-iterations=5" \
  "--skill-home=$SKILL_HOME"
```

**Verify generated files:**

```bash
ROWS_JSON="$PROJECT_ROOT/autoresearch/source/rows.json"
ROW_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROWS_JSON','utf-8')).length)")

for i in $(seq 0 $((ROW_COUNT - 1))); do
  for f in "autoresearch/evaluate-row-${i}.js" "program-row-${i}.md" "loop-row-${i}.sh"; do
    if [[ ! -f "$PROJECT_ROOT/$f" ]]; then
      echo "ERROR: Missing $f"
      exit 1
    fi
  done
done

# Reconciliation files
for f in autoresearch/evaluate.js program.md loop.sh; do
  if [[ ! -f "$PROJECT_ROOT/$f" ]]; then
    echo "ERROR: Missing reconciliation file $f"
    exit 1
  fi
done
chmod +x "$PROJECT_ROOT"/loop-row-*.sh "$PROJECT_ROOT/loop.sh"
echo "Polish loop infrastructure ready."
```

#### 5.2 Dev Server + Parallel Row Polish

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

**Dispatch parallel row agents** — read `rows.json` and launch one Agent per row in a single message. Each agent runs its row's loop script.

For each row (index `I`, description from `rows.json`), dispatch:

```
Agent({
  description: "Polish row I (description)",
  prompt: "Run the visual polish loop for row I of a header migration.\n\nExecute this command and wait for it to complete:\n\n```bash\ncd $PROJECT_ROOT && ./loop-row-I.sh 2>&1 | tee autoresearch/results/row-I/loop.log\n```\n\nThe loop runs autonomously — do not interfere with iterations.\nIt terminates on plateau (5 consecutive reverts) or max iterations.\nDo NOT wrap with timeout. Each iteration takes 8-12 minutes.\nWhen the loop finishes, report the final line of output.",
  allowedTools: "Bash,Read"
})
```

**All row agents MUST be dispatched in a single message** so they run in parallel.

Wait for all agents to complete. Each row converges independently.

Do NOT attempt to control individual iterations. The loops handle
scoring, commit/revert decisions, and termination.

Do NOT wrap the loops with `timeout` or any time limit. Each iteration
takes 8-12 minutes. This is expected — let them run to completion.

#### 5.3 Adaptive Reconciliation

After all row loops finish, evaluate the full header to decide if reconciliation is needed.

**Run full-header evaluation:**

```bash
RECON_SCORE=$(node "$PROJECT_ROOT/autoresearch/evaluate.js" 3000 recon 2>/dev/null \
  | node --input-type=commonjs -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    const pm = d.viewports?.desktop?.similarity || 0;
    const nav = d.navCompleteness?.score || 0;
    console.log(Math.round((pm * 0.70 + nav * 0.30) * 100) / 100);
  " 2>/dev/null || echo "0")
echo "Full header score after row loops: ${RECON_SCORE}%"
```

**Decision gate:**

```bash
NEEDS_RECON=$(node -e "console.log(${RECON_SCORE} < 85 ? 'yes' : 'no')")
if [[ "${NEEDS_RECON}" == "yes" ]]; then
  echo "Score ${RECON_SCORE}% < 85% — running reconciliation loop..."
  cd "$PROJECT_ROOT" && ./loop.sh 2>&1 | tee autoresearch/results/reconciliation.log
  echo "Reconciliation finished."
else
  echo "Score ${RECON_SCORE}% >= 85% — rows converged cleanly, skipping reconciliation."
fi
```

Mark Phase 5 as completed. Then proceed to Phase 6 — do NOT stop here.
```

- [ ] **Step 2: Verify no broken markdown or placeholder references**

Read the modified SKILL.md and check that Phase 5 connects cleanly to Phase 4 (ends at line 822) and Phase 6 (starts at line 903).

- [ ] **Step 3: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): rewrite Phase 5 for per-row parallel polish loops"
```

---

### Task 7: Integration Smoke Test

**Files:**
- None created — manual verification

Run the full test suite and verify the setup script works end-to-end with both modes.

- [ ] **Step 1: Run all existing tests**

```bash
npx vitest run tests/migrate-header/
```

Expected: All tests pass.

- [ ] **Step 2: Verify template placeholder consistency**

Check that every `{{PLACEHOLDER}}` in the three new templates has a matching key in `buildRowReplacements`:

```bash
grep -oE '\{\{[A-Z_]+\}\}' skills/migrate-header/templates/evaluate-row.js.tmpl \
  skills/migrate-header/templates/loop-row.sh.tmpl \
  skills/migrate-header/templates/program-row.md.tmpl \
  | sort -u
```

Cross-reference each against `buildRowReplacements` keys. Any missing = bug.

- [ ] **Step 3: Verify SKILL.md Phase 5 references correct file names**

Check that SKILL.md references `loop-row-I.sh`, `program-row-I.md`, `evaluate-row-I.js`, `results-row-I.tsv` consistently.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(migrate-header): integration fixes for per-row polish loops"
```

(Skip if no fixes needed.)

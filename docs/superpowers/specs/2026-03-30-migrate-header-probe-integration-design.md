# migrate-header: browser-probe & page-collect Integration

Integrate `browser-probe` (PR #39) and `page-collect` (PR #40) into the
`migrate-header` pipeline so that bot-protected sites are handled
automatically and icon extraction uses a clean interface.

## Problem

migrate-header has three playwright consumers that all use bare headless
Chromium with no bot-protection handling:

1. **Stage 4** — overlay detection via inline `playwright-cli` bash
2. **Stage 5** — `capture-snapshot.js` via `playwright-cli` session
3. **Stage 6b** — `page-collect.js` via Playwright Node API

If the target site runs Akamai, Cloudflare, DataDome, or AWS WAF, all
three fail silently — producing empty snapshots, missing icons, and
broken migrations.

Additionally, Stage 6b's path resolution for page-collect uses a fragile
`../../` traversal that breaks if skill directories move.

## Approach

Run `browser-probe` once at pipeline start (new Stage 2b). Save the
recipe to `autoresearch/browser-recipe.json`. Thread the recipe path to
all three downstream consumers via a `--browser-recipe` flag.

## Changes

### 1. SKILL.md — New Stage 2b: Browser Probe

Insert between Stage 2 (Validate) and Stage 3 (Prepare Working Directory).

**State variable:** Add `BROWSER_RECIPE=""` to the pipeline state block.

**Skill resolution:**
```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  BROWSER_PROBE_DIR="$(dirname "$CLAUDE_SKILL_DIR")/browser-probe/scripts"
else
  BROWSER_PROBE_DIR="$(dirname "$(find ~/.claude \
    -path "*/browser-probe/scripts/browser-probe.js" \
    -type f 2>/dev/null | head -1)" 2>/dev/null)"
fi
```

**Execution:**
```bash
node "$BROWSER_PROBE_DIR/browser-probe.js" "$URL" \
  "$PROJECT_ROOT/autoresearch"
```

**Result handling:**
- Read `probe-report.json`, check `firstSuccess`
- `firstSuccess` = `default` → no recipe needed, `BROWSER_RECIPE=""`
- `firstSuccess` = non-null, non-default → LLM generates
  `browser-recipe.json` per browser-probe Step 3-4, sets
  `BROWSER_RECIPE="$PROJECT_ROOT/autoresearch/browser-recipe.json"`
- `firstSuccess` = null → pipeline stops with actionable error
- browser-probe not installed → warn and continue without recipe

**Pipeline diagram update:**
```
URL --> PARSE --> VALIDATE --> PROBE --> PREPARE --> OVERLAY --> SNAPSHOT --> EXTRACT --> ...
                               ^^^                  (recipe)    (recipe)    (recipe)
```

### 2. capture-snapshot.js — `--browser-recipe` Flag

**Arg parsing:** Add `--browser-recipe=<path>` to `parseArgs()`,
returned as `browserRecipe` field.

**`openPage()` changes:**
1. If `browserRecipe` is provided, read and parse the JSON
2. Write `recipe.cliConfig` to a temp file at
   `/tmp/header-capture-config.json`
3. Call `cli('open', url, '--config=/tmp/header-capture-config.json')`
   plus `--persistent` if `recipe.persistent === true`
4. If `recipe.stealthInitScript` is non-null, call
   `cli('eval', recipe.stealthInitScript)` immediately after open,
   before `waitForStable()`
5. Clean up temp config file in the existing `finally` block

**No other changes** — DOM extraction, screenshots, nav items all work
the same once the page loads.

**SKILL.md Stage 5 update:**
```bash
node "$SKILL_HOME/scripts/capture-snapshot.js" \
  "$URL" \
  "$PROJECT_ROOT/autoresearch/source" \
  "--header-selector=$HEADER_SELECTOR" \
  "--overlay-recipe=$PROJECT_ROOT/autoresearch/overlay-recipe.json" \
  "--browser-recipe=$BROWSER_RECIPE"
```

### 3. page-collect.js — `--browser-recipe` Flag

**Arg parsing:** Add `--browser-recipe <path>` to `parseArgs()`,
returned as `browserRecipe` field.

**`launchBrowser()` changes:**
1. If `browserRecipe` is provided, read and parse the JSON
2. Map `cliConfig.launchOptions.channel` → `chromium.launch({ channel })`
3. Extract `--user-agent=...` from `cliConfig.launchOptions.args` →
   override `userAgent` in `browser.newContext()`
4. If `stealthInitScript` is non-null, call
   `page.addInitScript(stealthInitScript)` before `page.goto()` —
   this is the Playwright Node API equivalent that runs before any
   page JS executes

**SKILL.md Stage 6b update:**
```bash
node "$PAGE_COLLECT" icons "$SOURCE_URL" \
  --output "$ICON_OUTPUT" \
  --browser-recipe "$BROWSER_RECIPE"
```

### 4. SKILL.md Stage 4 — Overlay Detection Recipe Threading

Stage 4 uses inline `playwright-cli` bash. When `BROWSER_RECIPE` is
set, decompose the recipe into playwright-cli flags:

```bash
if [[ -n "$BROWSER_RECIPE" && -f "$BROWSER_RECIPE" ]]; then
  # Write cliConfig to temp file
  PROBE_CONFIG="/tmp/overlay-probe-config.json"
  node -e "
    const fs = require('fs');
    const r = JSON.parse(fs.readFileSync('$BROWSER_RECIPE','utf-8'));
    fs.writeFileSync('$PROBE_CONFIG', JSON.stringify(r.cliConfig, null, 2));
  "
  STEALTH=$(node -e "
    const fs = require('fs');
    const r = JSON.parse(fs.readFileSync('$BROWSER_RECIPE','utf-8'));
    console.log(r.stealthInitScript || '');
  ")

  playwright-cli -s=overlay-detect open --config="$PROBE_CONFIG"
  if [[ -n "$STEALTH" ]]; then
    playwright-cli -s=overlay-detect eval "$STEALTH"
  fi
  playwright-cli -s=overlay-detect goto "$URL"
else
  playwright-cli -s=overlay-detect open "$URL"
fi
```

Key: `open` without URL → inject stealth → `goto` URL. Stealth must
run before navigation per browser-probe reference docs.

Fallback (no recipe) is the existing code unchanged.

### 5. SKILL.md Stage 6b — Path Resolution Fix

Replace fragile `../../` traversal:
```bash
PAGE_COLLECT="$(dirname "$CLAUDE_SKILL_DIR")/../page-collect/scripts/page-collect.js"
```

With consistent sibling-skill lookup:
```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  PAGE_COLLECT="$(dirname "$CLAUDE_SKILL_DIR")/page-collect/scripts/page-collect.js"
else
  PAGE_COLLECT="$(find ~/.claude \
    -path "*/page-collect/scripts/page-collect.js" \
    -type f 2>/dev/null | head -1)"
fi
```

`dirname "$CLAUDE_SKILL_DIR"` gives the parent `skills/` directory,
then direct path to sibling. Same pattern used for page-prep (line 139).

## Error Handling

| Scenario | Behavior |
|----------|----------|
| browser-probe not installed | Warn, continue without recipe |
| Probe succeeds with `default` | No recipe needed, empty `BROWSER_RECIPE` |
| Probe succeeds with stealth/chrome | Generate recipe, thread to consumers |
| All probe configs fail | Stop pipeline — blocked site = useless snapshots |
| Recipe provided but consumer can't parse | Fail fast with clear message |
| page-collect not installed | Warn, continue without icons (existing) |

## Files Changed

| File | Change |
|------|--------|
| `skills/migrate-header/SKILL.md` | Add Stage 2b, update Stages 4/5/6b, add state var, fix path resolution |
| `skills/migrate-header/scripts/capture-snapshot.js` | Add `--browser-recipe` flag, apply config + stealth in `openPage()` |
| `skills/page-collect/scripts/page-collect.js` | Add `--browser-recipe` flag, apply channel/UA/stealth in `launchBrowser()` |

## Files Unchanged

- `skills/browser-probe/` — producer only, no changes
- `skills/migrate-header/scripts/extract-layout.js` — consumes snapshots, not browser sessions
- `skills/migrate-header/scripts/extract-branding.js` — same
- `skills/migrate-header/scripts/setup-polish-loop.js` — operates on extracted data
- All reference docs — no new patterns needed

# Browser Universal Skill Design

## Problem

Skills that need browser interaction hardcode a specific layer (Playwright MCP, CDP, Slicc playwright-cli, cmux-browser). This makes them context-dependent — a skill written for Playwright MCP breaks when the user is in Slicc or has Chrome with CDP.

## Goal

A pure-prompt skill that detects the available browser interaction layer, loads the right command reference dynamically, and provides a universal verb mapping. Other skills depend on `browser-universal` instead of a specific layer.

## Constraints

- Pure prompt (SKILL.md only) — no scripts, no static reference files
- Command references fetched from source of truth at runtime, not maintained locally
- Consuming skill or user can specify a layer preference
- Universal verbs cover: navigate, snapshot, click, fill, eval, screenshot, wait, tabs
- No `CLAUDE_SKILL_DIR` fallback needed — this skill has no bundled scripts. CDP detection delegates script location to the `cdp-connect` skill's own resolution logic.

## Skill Structure

```
skills/browser-universal/
  SKILL.md    <- detection + dispatch + universal verb mapping
```

No `scripts/`, no `references/`. Command references come from:

- **Playwright MCP**: tools already in LLM context (MCP protocol)
- **Slicc**: probed locally via `playwright-cli help`, enriched from GitHub
- **cmux-browser**: probed locally via `cmux browser --help` or similar
- **CDP**: probed from local `cdp.js` help output

## Detection

Four parallel checks determine which layers are available:

| Layer | Detection Method | Signal |
|-------|-----------------|--------|
| Playwright MCP | Check if `mcp__plugin_playwright_playwright__browser_navigate` exists in available tools | Tool is listed in context |
| Slicc | Run `playwright-cli help` via Bash | Returns Slicc-specific help output (look for "snapshot", "tab-list", and other Slicc commands) |
| cmux-browser | Run `cmux ping` via Bash | Returns success (cmux is running) |
| CDP | Run `node "$CDP_JS" list --port 9222` via Bash | Returns tab list (not connection error) |

### CDP Script Location

`browser-universal` does not bundle `cdp.js`. To locate it, use the same resolution as `cdp-connect`:

```bash
CDP_JS="$(command -v cdp.js 2>/dev/null || \
  find ~/.claude -path "*/cdp-connect/scripts/cdp.js" -type f 2>/dev/null | head -1)"
```

If `cdp.js` is not found, CDP is marked as unavailable.

### cmux Surface Discovery

cmux-browser requires a browser surface. After detection via `cmux ping`, discover the surface:

```bash
cmux identify --no-caller    # get current workspace/surface/pane
cmux list-pane-surfaces      # list surfaces in current pane
```

If no browser surface exists, one can be created with `cmux new-surface --type browser --pane <ref> --url <url>`. All subsequent commands use `cmux browser --surface <ref> <subcommand>`.

### Layer Selection

1. If the consuming skill or user specifies a preference, use that
2. Otherwise, default priority: **Slicc > cmux-browser > Playwright MCP > CDP**

Rationale: Slicc is the richest integrated environment (auth teleport, cookies, HAR, session history) and covers workflows others cannot. cmux-browser is second — full browser control within the cmux terminal environment, with unique features like annotations and state save/load. Playwright MCP is third — full MCP integration, ref-based targeting, and the most common layer for standalone Claude Code users. CDP is the fallback — always available if Chrome has a debug port, but selector-based and more manual.

### No Layer Detected

If all four checks fail, the skill reports clearly:

```
No browser interaction layer detected. To enable one:
- Playwright MCP: install the Playwright MCP plugin for Claude Code
- Slicc: run `npx sliccy` to launch a Slicc session
- cmux-browser: start cmux and create a browser surface
- CDP: launch Chrome with `chrome --remote-debugging-port=9222`
```

The consuming skill should treat this as a blocking error — browser interaction is not possible until a layer is available.

## Dynamic Reference Loading

### Playwright MCP

No fetch needed. SKILL.md includes a short inline section:

- Use the `mcp__plugin_playwright_playwright__*` tools directly
- Ref-based targeting: `browser_snapshot` first, then use `ref` param
- Workflow: snapshot, interact, snapshot again (refs invalidate after state changes)

Static inline guidance is appropriate here because the tools are already in context and just need orchestration instructions.

### Slicc playwright-cli

Two-step approach:

1. **Primary**: run `playwright-cli help` locally to get the current command list from the installed version
2. **Enrichment**: fetch the full SKILL.md from GitHub for workflow guidance, gotchas, and examples:

```
WebFetch https://raw.githubusercontent.com/ai-ecoverse/slicc/main/src/defaults/workspace/skills/playwright-cli/SKILL.md
```

If the WebFetch fails (network error, 404, repo restructured), the local help output is sufficient to operate. The GitHub fetch adds depth but is not required.

### cmux-browser

Probe locally — cmux is a local CLI tool:

```bash
cmux browser --help          # get available subcommands
cmux list-pane-surfaces      # discover existing browser surfaces
```

The help output is the reference. SKILL.md adds inline notes about cmux-specific concepts: surface refs (never hardcode — discover via `cmux identify`), the `--surface <ref>` pattern for all commands, and the HTTP-only URL constraint (no `file://`).

### CDP

Locate `cdp.js` (see CDP Script Location above) and probe locally:

```bash
node "$CDP_JS" list    # verify connection
node "$CDP_JS"         # print help with all commands
```

The help output is the reference. SKILL.md adds inline notes about CDP-specific concepts (selector-based targeting, `ax-tree` for page understanding).

## Universal Verbs

The mapping that consuming skills rely on:

| Verb | Description | Playwright MCP | Slicc | cmux-browser | CDP |
|------|-------------|---------------|-------|-------------|-----|
| `navigate <url>` | Go to URL | `browser_navigate` | `goto` | `navigate` | `navigate` |
| `snapshot` | Read page state | `browser_snapshot` | `snapshot` | `snapshot --compact` | `ax-tree` |
| `click <target>` | Click element | `browser_click` (ref) | `click` (ref) | `click` (selector) | `click` (selector) |
| `fill <target> <text>` | Type into input | `browser_type` (ref) | `fill` (ref) | `fill` (selector) | `type` (selector) |
| `eval <expr>` | Run JS | `browser_evaluate` | `eval` | `eval` | `eval` |
| `screenshot` | Capture visual | `browser_take_screenshot` | `screenshot` | `snapshot` | `screenshot` |
| `wait <condition>` | Wait for state | `browser_wait_for` | eval polling | `wait --load-state` | eval polling |
| `tabs.list` | List tabs | `browser_tabs` | `tab-list` | `tab list` | `list` |
| `tabs.open <url>` | New tab | `browser_tabs` (create) | `tab-new` / `open` | `tab new` | `eval "window.open('<url>')"` then `list` |
| `tabs.select <id>` | Switch tab | `browser_tabs` (select) | `tab-select` (index) | `tab switch` | `--id <target-id>` |
| `tabs.close` | Close tab | `browser_tabs` (close) | `tab-close` / `close` | `tab close` | `eval "window.close()"` (limited) |

### Targeting Models

- **Playwright MCP and Slicc**: ref-based. Snapshot first, use ref IDs (`e5`, `e12`).
- **cmux-browser and CDP**: selector-based. Use CSS selectors (`#submit`, `.btn-primary`).

### Universal Pattern

After any state-changing action (click, fill, navigate), re-read page state (snapshot) before the next interaction. This applies to all layers.

### Layer-Specific Limitations

**CDP**: Tab management uses JS workarounds (`window.open()`, `window.close()`) which are less reliable than native tab APIs. `window.close()` only works on tabs opened by script.

**cmux-browser**: All commands require `--surface <ref>` prefix. No `file://` URLs — content must be served over HTTP. Surface refs are dynamic — always discover via `cmux identify`, never hardcode.

## SKILL.md Outline

```
---
name: browser-universal
description: "Detect available browser interaction layer (Playwright MCP,
Slicc playwright-cli, cmux-browser, CDP) and load the right commands.
Use before any browser interaction in skills that shouldn't hardcode
a specific layer."
---

# Browser Universal

## 1. Detection
  [parallel checks for all four layers]
  [layer preference: accept from consuming skill or user, else default]
  [no-layer-detected error with setup guidance]

## 2. Load Reference
  [branch by detected layer]
  - Playwright MCP: inline guidance (tools already in context)
  - Slicc: local help + optional GitHub fetch for enrichment
  - cmux-browser: local help + surface discovery
  - CDP: locate cdp.js, run help, inline targeting notes

## 3. Universal Verbs
  [mapping table]
  [targeting model callout: refs vs selectors]
  [universal re-snapshot pattern]

## 4. Layer-Specific Notes
  [gotchas and limitations per layer]
```

Estimated size: ~180-220 lines.

## How Other Skills Consume This

A consuming skill includes a dependency line:

```
Before interacting with any browser, invoke the `browser-universal` skill.
```

The LLM invokes it, gets detection results and the layer-native reference, then continues with the consuming skill's instructions using the layer-native commands.

### Example: Consuming Skill

```markdown
# My Scraping Skill

Before interacting with any browser, invoke the `browser-universal` skill.

Once a browser layer is active:
1. Navigate to the target URL
2. Snapshot the page to understand its structure
3. Click the "Load More" button if present
4. Eval JavaScript to extract the data: `document.querySelectorAll('.item')`
5. Screenshot the final state for verification

Use the layer-native commands provided by browser-universal.
```

The consuming skill describes *what* to do (navigate, snapshot, click). The browser-universal skill has already told the LLM *how* to do it for the active layer.

## Deliverables

When implementing, update these files:

- `skills/browser-universal/SKILL.md` — the skill itself
- `README.md` — add entry to the skills table
- `.claude/CLAUDE.md` — add entry to the Available Skills table
- `.claude-plugin/plugin.json` — add to skill list
- `.claude-plugin/marketplace.json` — update description if needed

## Out of Scope

- Script wrapper / unified CLI binary
- Automatic layer switching mid-session
- Layer-specific features beyond the universal verb set (consuming skills can use them directly once the layer is detected)

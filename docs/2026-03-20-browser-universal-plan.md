# Browser Universal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a pure-prompt skill that detects available browser interaction layers and provides the right commands dynamically.

**Architecture:** Single SKILL.md with four sections: detection, reference loading, universal verb mapping, and layer-specific notes. No scripts — references come from runtime probing and GitHub fetch. Other skills depend on this instead of hardcoding a browser layer.

**Tech Stack:** Pure Markdown prompt (SKILL.md)

**Spec:** `docs/2026-03-20-browser-universal-design.md`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `skills/browser-universal/SKILL.md` | The skill itself |
| Modify | `README.md` | Add skill entry |
| Modify | `.claude/CLAUDE.md` | Add to Available Skills table |
| Modify | `.claude-plugin/plugin.json` | Add to description + keywords |
| Modify | `.claude-plugin/marketplace.json` | Update description |

---

### Task 1: Create SKILL.md

The core deliverable. A single file containing detection logic, dynamic reference loading, universal verb mapping, and layer-specific notes.

**Files:**
- Create: `skills/browser-universal/SKILL.md`

- [ ] **Step 1: Write the SKILL.md frontmatter and detection section**

```markdown
---
name: browser-universal
description: >-
  Detect available browser interaction layer (Playwright MCP, Slicc
  playwright-cli, cmux-browser, CDP) and load the right commands. Use before
  any browser interaction in skills that shouldn't hardcode a specific layer.
  Triggers on: browser universal, detect browser, browser layer, browser
  setup, which browser, browser interaction, open browser, use browser.
---

# Browser Universal

Detect which browser interaction layer is available and load its commands.
Four supported layers: Playwright MCP, Slicc playwright-cli, cmux-browser, CDP.

## Layer Preference

If the consuming skill or user specifies a layer, use that directly and skip
detection. Otherwise, detect and use default priority below.

## Detection

Run these checks in parallel to determine available layers:

### 1. Playwright MCP

Check if `mcp__plugin_playwright_playwright__browser_navigate` exists in your
available tools. If yes, Playwright MCP is available. No shell command needed.

### 2. Slicc playwright-cli

```bash
playwright-cli help 2>/dev/null
```

Available if the output contains Slicc-specific commands (`snapshot`, `tab-list`,
`teleport`). A generic `playwright-cli` without these is NOT Slicc.

### 3. cmux-browser

```bash
cmux ping 2>/dev/null
```

Available if this returns success (exit code 0).

### 4. CDP

```bash
CDP_JS="$(command -v cdp.js 2>/dev/null || \
  find ~/.claude -path "*/cdp-connect/scripts/cdp.js" -type f 2>/dev/null | head -1)"
[[ -n "$CDP_JS" ]] && node "$CDP_JS" list --port 9222
```

Available if `cdp.js` is found AND `list` returns tab output (not a connection
error). Store `CDP_JS` for all subsequent CDP commands.

### Default Priority

If multiple layers are detected, use: **Slicc > cmux-browser > Playwright MCP > CDP**

### No Layer Detected

If all checks fail, report this to the user and stop:

```
No browser interaction layer detected. To enable one:
- Playwright MCP: install the Playwright MCP plugin for Claude Code
- Slicc: run `npx sliccy` to launch a Slicc session
- cmux-browser: start cmux and create a browser surface
- CDP: launch Chrome with `chrome --remote-debugging-port=9222`
```

Do not proceed with browser actions — this is a blocking error.
```

- [ ] **Step 2: Write the dynamic reference loading section**

Append to SKILL.md after the detection section:

```markdown
## Load Reference

Based on the detected layer, load its command reference:

### If Playwright MCP

Tools are already in your context. Use `mcp__plugin_playwright_playwright__*`
tools directly. Key guidance:

- **Targeting**: ref-based. Call `browser_snapshot` first to get an accessibility
  tree with element refs (`[ref="e5"]`). Use refs in `browser_click`,
  `browser_type`, etc.
- **Refs invalidate** after any state-changing action (click, type, navigate).
  Always re-snapshot before the next interaction.
- **Tabs**: `browser_tabs` handles list, create, select, and close.
- **Wait**: `browser_wait_for` accepts text to wait for or a timeout.
- **Screenshot**: `browser_take_screenshot` captures the current viewport.

### If Slicc playwright-cli

Run `playwright-cli help` to get the installed command list. Then fetch the
full workflow reference:

Use the WebFetch tool to fetch the enriched reference (optional — local help
is sufficient if this fails):

    WebFetch https://raw.githubusercontent.com/ai-ecoverse/slicc/main/src/defaults/workspace/skills/playwright-cli/SKILL.md

Key guidance:

- **Targeting**: ref-based. Run `playwright-cli snapshot` to get element refs.
  Use refs with `click`, `fill`, `dblclick`, `hover`, `select`.
- **Refs invalidate** after state-changing commands. Re-snapshot before next
  ref-based action.
- **Navigate current tab**: `playwright-cli goto <url>`
- **Open new tab**: `playwright-cli open <url>` (background) or
  `playwright-cli tab-new <url>`
- **Tabs**: `tab-list`, `tab-select <index>`, `tab-close`
- **Session history**: `cat /.playwright/session.md` for command log recovery.

### If cmux-browser

Run these to get the command surface and discover browser surfaces:

```bash
cmux browser --help
cmux identify --no-caller
cmux list-pane-surfaces
```

If no browser surface exists, create one:

```bash
cmux new-surface --type browser --pane <ref> --url <url>
```

All commands follow the pattern: `cmux browser --surface <ref> <subcommand>`.

Key guidance:

- **Targeting**: selector-based. Use CSS selectors for `click`, `fill`, `type`.
- **Surface refs are dynamic** — discover via `cmux identify`, never hardcode.
- **No `file://` URLs** — content must be served over HTTP.
- **Snapshot**: `cmux browser --surface <ref> snapshot --compact`
- **Navigate**: `cmux browser --surface <ref> navigate <url>`
- **Eval**: `cmux browser --surface <ref> eval <expression>`
- **Tabs**: `cmux browser --surface <ref> tab new|list|switch|close`
- **Wait**: `cmux browser --surface <ref> wait --load-state complete`
- **Unique features**: `highlight <selector>`, `addstyle <css>`,
  `addscript <js>`, `state save|load <path>` for checkpointing.

### If CDP

Store the resolved `CDP_JS` path. All commands use `node "$CDP_JS" <command>`.

Run `node "$CDP_JS"` (no args) to see the full command list.

Key guidance:

- **Targeting**: selector-based. Use CSS selectors for `click`, `type`.
- **Page understanding**: `ax-tree` is the primary method (semantic roles and
  names). Use `dom` as fallback for raw HTML.
- **Screenshots**: save to `/tmp/`, then use the Read tool to view the PNG.
- **Eval**: supports promises: `eval "await fetch('/api').then(r=>r.json())"`
- **Tab targeting**: use `list` to see tabs with IDs, then `--id <target-id>`
  on any command.
- **Tab workarounds**: `eval "window.open('<url>')"` then `list` for new tabs.
  `eval "window.close()"` to close (only works on script-opened tabs).
- **Streaming**: `console` and `network` commands stream events for debugging
  (not available in other layers).
```

- [ ] **Step 3: Write the universal verbs and layer-specific notes sections**

Append to SKILL.md after the reference loading section:

```markdown
## Universal Verbs

Quick reference mapping universal actions to layer-specific commands:

| Verb | Playwright MCP | Slicc | cmux-browser | CDP |
|------|---------------|-------|-------------|-----|
| navigate | `browser_navigate` | `goto` | `navigate` | `navigate` |
| snapshot | `browser_snapshot` | `snapshot` | `snapshot --compact` | `ax-tree` |
| click | `browser_click` (ref) | `click` (ref) | `click` (selector) | `click` (selector) |
| fill | `browser_type` (ref) | `fill` (ref) | `fill` (selector) | `type` (selector) |
| eval | `browser_evaluate` | `eval` | `eval` | `eval` |
| screenshot | `browser_take_screenshot` | `screenshot` | `snapshot` | `screenshot` |
| wait | `browser_wait_for` | eval polling | `wait --load-state` | eval polling |
| tabs.list | `browser_tabs` | `tab-list` | `tab list` | `list` |
| tabs.open | `browser_tabs` (create) | `open` / `tab-new` | `tab new` | `eval "window.open()"` |
| tabs.select | `browser_tabs` (select) | `tab-select` (index) | `tab switch` | `--id <target-id>` |
| tabs.close | `browser_tabs` (close) | `tab-close` | `tab close` | `eval "window.close()"` |

### Targeting Models

- **Ref-based** (Playwright MCP, Slicc): snapshot first → use ref IDs
  (`e5`, `e12`) → refs invalidate after state changes → re-snapshot.
- **Selector-based** (cmux-browser, CDP): use CSS selectors (`#submit`,
  `.btn-primary`, `button[type="submit"]`).

### Universal Pattern

After **any** state-changing action (click, fill, navigate, tab switch),
re-read page state (snapshot) before the next interaction. This applies to
every layer.

## Layer-Specific Notes

### Playwright MCP
- `browser_snapshot` returns an accessibility tree — prefer it over
  screenshots for understanding page structure.
- `browser_run_code` can execute arbitrary Playwright code for complex
  interactions not covered by individual tools.

### Slicc
- `open` opens tabs in the **background** by default. Use `--foreground`
  to make it current. If no current tab exists, the first `open` becomes
  current automatically.
- Session log at `/.playwright/session.md` — read it to recover context
  after compaction.
- Teleport for auth handoffs in tray sessions (unique to Slicc).

### cmux-browser
- Every command needs `--surface <ref>`. Discover refs with
  `cmux identify --no-caller`, never hardcode them.
- No `file://` URLs. Serve content over HTTP first.
- `highlight`, `addstyle`, `addscript` are additive — reload with
  `navigate` to clear injected CSS/JS.
- `state save` / `state load` for checkpointing page state between steps.

### CDP
- Tab management uses JS workarounds (`window.open()`, `window.close()`)
  which are less reliable than native APIs. `window.close()` only works
  on tabs opened by script.
- `console` and `network` streaming commands are unique to CDP — useful
  for debugging but not available in other layers.
- Default timeout is 5s. Set `CDP_TIMEOUT=10000` or use `--timeout 15`
  for slow pages.
```

- [ ] **Step 4: Review the complete SKILL.md**

Read the full file and verify:
- Frontmatter `name` and `description` are set correctly
- All four detection methods are present with exact commands
- Reference loading has fallback handling (Slicc WebFetch failure, CDP_JS not found)
- Universal verb table has all 11 verbs with all 4 layers
- Layer-specific notes cover gotchas from the spec
- Estimated size is within ~180-220 lines

- [ ] **Step 5: Commit**

```bash
git add skills/browser-universal/SKILL.md
git commit -m "Add browser-universal skill for layer-agnostic browser interaction"
```

---

### Task 2: Update project manifests

Add the new skill to all project manifest files.

> **Note:** `slack-cdp` and `cmux-demo` are missing from some manifests (pre-existing gap). This plan adds `browser-universal` only.

**Files:**
- Modify: `README.md`
- Modify: `.claude/CLAUDE.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Add README.md entry**

Add after the `### page-prep` section (before `## License`):

```markdown
### browser-universal

Detect available browser interaction layer (Playwright MCP, Slicc
playwright-cli, cmux-browser, CDP) and load the right commands. Other
skills depend on this instead of hardcoding a specific browser layer.
Supports layer preference, dynamic reference loading from source of truth,
and a universal verb mapping for navigate, snapshot, click, fill, eval,
screenshot, wait, and tab management.

**Dependencies:** none

See [SKILL.md](skills/browser-universal/SKILL.md) for details.
```

- [ ] **Step 2: Add .claude/CLAUDE.md table entry**

Add to the `## Available Skills` table:

```markdown
| `browser-universal` | Detect browser layer and load commands for layer-agnostic interaction |
```

- [ ] **Step 3: Update plugin.json**

Replace the `description` field (line 3) with:

```json
"description": "Claude Code skills: memory-triage (promote auto memory to shared config), demo-narrate (voice-over generation for screen recordings), ai-fluency-assessment (4D fluency framework), gemini-icon-set (colorful icon sets via Imagen 4), video-digest (multimodal video summarization), cdp-connect (zero-dep CDP browser control), screencast (guided screen recording), cmux-setup (cmux workspace coloring), page-prep (detect and remove webpage overlays for clean interaction), browser-universal (layer-agnostic browser interaction)."
```

Append these to the end of the `keywords` array (after `"popup"`):

```json
"browser-universal", "browser-detection", "playwright", "slicc"
```

- [ ] **Step 4: Update marketplace.json**

Two description fields need updating:

Top-level `description` (line 3):

```json
"description": "Claude Code skills by @catalan-adobe — memory triage, demo narration, AI fluency assessment, screencast (guided screen recording), cmux-setup (workspace coloring), page-prep (webpage overlay removal), browser-universal (layer-agnostic browser interaction), and more."
```

`plugins[0].description` (line 16):

```json
"description": "Memory triage, demo narration, AI fluency, cmux-setup, browser-universal, and workflow skills for Claude Code"
```

- [ ] **Step 5: Commit**

```bash
git add README.md .claude/CLAUDE.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "Add browser-universal to project manifests"
```

---

### Task 3: Sync and smoke test

Verify the skill is discoverable and the SKILL.md parses correctly.

**Files:** none (verification only)

- [ ] **Step 1: Run sync script**

```bash
./scripts/sync-skills.sh
```

Verify output includes `browser-universal` in the copied skills list.

- [ ] **Step 2: Verify file is in place**

Use the Read tool to read `~/.claude/commands/browser-universal.md` (first 5 lines).

Expected: the frontmatter with `name: browser-universal`.

- [ ] **Step 3: Verify SKILL.md size**

```bash
wc -l skills/browser-universal/SKILL.md
```

Expected: ~180-220 lines (matching spec estimate).

- [ ] **Step 4: Quick content check**

Verify these key strings are present in the SKILL.md:

```bash
grep -c "mcp__plugin_playwright_playwright__browser_navigate" skills/browser-universal/SKILL.md
grep -c "playwright-cli help" skills/browser-universal/SKILL.md
grep -c "cmux ping" skills/browser-universal/SKILL.md
grep -c "cdp.js" skills/browser-universal/SKILL.md
grep -c "No browser interaction layer detected" skills/browser-universal/SKILL.md
```

Each should return at least 1.

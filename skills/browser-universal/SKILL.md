---
name: browser-universal
description: >-
  Detect available browser interaction layer (Playwright MCP, Slicc
  playwright-cli, cmux-browser, CDP) and load the right commands — then
  navigate, click, fill, and screenshot through a unified verb set. Use before
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
full workflow reference (optional — local help is sufficient if this fails):

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

# Browser Universal Skill Design

## Problem

Skills that need browser interaction hardcode a specific layer (Playwright MCP, CDP, Slicc playwright-cli). This makes them context-dependent — a skill written for Playwright MCP breaks when the user is in Slicc or has Chrome with CDP.

## Goal

A pure-prompt skill that detects the available browser interaction layer, loads the right command reference dynamically, and provides a universal verb mapping. Other skills depend on `browser-universal` instead of a specific layer.

## Constraints

- Pure prompt (SKILL.md only) — no scripts, no static reference files
- Command references fetched from source of truth at runtime, not maintained locally
- Consuming skill or user can specify a layer preference
- Universal verbs cover: navigate, snapshot, click, fill, eval, screenshot, wait, tabs

## Skill Structure

```
skills/browser-universal/
  SKILL.md    <- detection + dispatch + universal verb mapping
```

No `scripts/`, no `references/`. Command references come from:

- **Playwright MCP**: tools already in LLM context (MCP protocol)
- **Slicc**: fetched from GitHub at runtime
- **CDP**: probed from local `cdp.js` help output

## Detection

Three parallel checks determine which layers are available:

| Layer | Detection Method | Signal |
|-------|-----------------|--------|
| Playwright MCP | Check if `mcp__plugin_playwright_playwright__browser_navigate` exists in available tools | Tool is listed in context |
| Slicc | Run `which playwright-cli` via Bash | Returns a path |
| CDP | Run `node "$CDP_JS" list --port 9222` via Bash | Returns tab list |

### Layer Selection

1. If the consuming skill or user specifies a preference, use that
2. Otherwise, default priority: **Slicc > Playwright MCP > CDP**

Rationale: Slicc is the richest environment (auth teleport, cookies, HAR, session history). Playwright MCP is second — full MCP integration, ref-based targeting. CDP is the fallback — always available if Chrome has a debug port, but selector-based and more manual.

## Dynamic Reference Loading

### Playwright MCP

No fetch needed. SKILL.md includes a short inline section:

- Use the `mcp__plugin_playwright_playwright__*` tools directly
- Ref-based targeting: `browser_snapshot` first, then use `ref` param
- Workflow: snapshot, interact, snapshot again (refs invalidate after state changes)

Static inline guidance is appropriate here because the tools are already in context and just need orchestration instructions.

### Slicc playwright-cli

Fetch at runtime:

```
WebFetch https://raw.githubusercontent.com/ai-ecoverse/slicc/main/src/defaults/workspace/skills/playwright-cli/SKILL.md
```

The full SKILL.md becomes the reference. Always current with whatever Slicc has shipped.

### CDP

Locate `cdp.js` and probe locally:

```bash
node "$CDP_JS" list    # verify connection
node "$CDP_JS"         # print help with all commands
```

The help output is the reference. SKILL.md adds inline notes about CDP-specific concepts (selector-based targeting, `ax-tree` for page understanding).

## Universal Verbs

The mapping that consuming skills rely on:

| Verb | Description | Playwright MCP | Slicc | CDP |
|------|-------------|---------------|-------|-----|
| `navigate <url>` | Go to URL | `browser_navigate` | `open` / `goto` | `navigate` |
| `snapshot` | Read page state | `browser_snapshot` | `snapshot` | `ax-tree` |
| `click <target>` | Click element | `browser_click` (ref) | `click` (ref) | `click` (selector) |
| `fill <target> <text>` | Type into input | `browser_type` (ref) | `fill` (ref) | `type` (selector) |
| `eval <expr>` | Run JS | `browser_evaluate` | `eval` | `eval` |
| `screenshot` | Capture visual | `browser_take_screenshot` | `screenshot` | `screenshot` |
| `wait <condition>` | Wait for state | `browser_wait_for` | eval polling | eval polling |
| `tabs.list` | List tabs | `browser_tabs` | `tab-list` | `list` |
| `tabs.open <url>` | New tab | `browser_tabs` (create) | `tab-new` | not native |
| `tabs.select <id>` | Switch tab | `browser_tabs` (select) | `tab-select` (index) | `--id <target-id>` |
| `tabs.close` | Close tab | `browser_tabs` (close) | `tab-close` / `close` | not supported |

### Targeting Models

- **Playwright MCP and Slicc**: ref-based. Snapshot first, use ref IDs (`e5`, `e12`).
- **CDP**: selector-based. Use CSS selectors (`#submit`, `.btn-primary`).

### Universal Pattern

After any state-changing action (click, fill, navigate), re-read page state (snapshot) before the next interaction. This applies to all layers.

### CDP Limitations

CDP has gaps in tab management (no native new-tab or close-tab). The skill notes these when CDP is the active layer.

## SKILL.md Outline

```
---
name: browser-universal
description: "Detect available browser interaction layer (Playwright MCP,
Slicc playwright-cli, CDP) and load the right commands. Use before any
browser interaction in skills that shouldn't hardcode a specific layer."
---

# Browser Universal

## 1. Detection
  [parallel checks for all three layers]
  [layer preference: accept from consuming skill or user, else default]

## 2. Load Reference
  [branch by detected layer]
  - Playwright MCP: inline guidance
  - Slicc: WebFetch SKILL.md from GitHub
  - CDP: locate cdp.js, run help, inline targeting notes

## 3. Universal Verbs
  [mapping table]
  [targeting model callout]
  [universal re-snapshot pattern]

## 4. Layer-Specific Notes
  [gotchas per layer]
```

Estimated size: ~150-200 lines.

## How Other Skills Consume This

A consuming skill includes:

```
Before interacting with any browser, invoke the `browser-universal` skill.
```

The LLM invokes it, gets detection results and the right reference, then continues with the consuming skill's instructions using the universal verbs or the layer-native commands.

## Out of Scope

- Script wrapper / unified CLI binary
- Automatic layer switching mid-session
- Layer-specific features beyond the universal verb set (consuming skills can use them directly once the layer is detected)

# Design: cdp-connect Skill

**Date:** 2026-03-12
**Status:** Draft

## Purpose

Connect Claude Code to an existing Chrome browser via CDP (Chrome DevTools
Protocol), mid-session, with zero dependencies. Enables autonomous browser
interaction — navigate, click, type, screenshot, evaluate JS, read console —
against a browser the agent already started (e.g. a dev server that launches
Chrome with `--remote-debugging-port=9222`).

## Problem

Claude Code's Playwright MCP plugin always launches its own Chromium. It
cannot attach to an existing Chrome instance. Adding an MCP server requires
a session restart. We need a skill that works on demand, mid-conversation.

## Key Insight

Node 22 (already required by the host project, SLICC) ships a built-in
`WebSocket` global. CDP is just JSON-RPC over WebSocket. No dependencies
needed — not even `ws`.

### Proof of Concept (verified working)

```bash
# 1. Discover targets
curl -s http://localhost:9222/json

# 2. Connect and interact
WS_URL=$(curl -s http://localhost:9222/json | \
  node -e "process.stdin.on('data',d=>{
    const t=JSON.parse(d).find(p=>p.type==='page');
    console.log(t.webSocketDebuggerUrl)
  })")

node -e "
const ws = new WebSocket('$WS_URL');
ws.onopen = () => {
  ws.send(JSON.stringify({
    id:1, method:'Runtime.evaluate',
    params:{expression:'document.title'}
  }));
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id === 1) {
    console.log('Title:', msg.result?.result?.value);
    ws.close();
  }
};
"
```

## Prior Art

| Project | Approach | Trade-offs |
|---------|----------|------------|
| `mitsuhiko/agent-stuff` web-browser | SKILL.md + Node scripts (`cdp.js`, `nav.js`, etc.) | Requires `ws` npm package |
| `vercel-labs/agent-browser` | Full CLI, `connect 9222` | Heavy (~684MB Chromium download) |
| `@playwright/mcp --cdp-endpoint` | MCP flag to connect to existing browser | Requires session restart |
| `chrome-devtools-mcp --browserUrl` | Google's MCP for CDP | Requires session restart |

## Architecture

SKILL.md + single helper script. Zero dependencies (Node 22 built-in
WebSocket).

```
skills/cdp-connect/SKILL.md           — When/how to use each command
skills/cdp-connect/scripts/cdp.js     — CDP client, all commands
```

The script absorbs all WebSocket boilerplate, connection management,
timeout handling, and output formatting. The SKILL.md stays small (~80
lines) and teaches the agent *what* to do, not *how* to WebSocket.

### Why a script instead of pure prompt?

The original design proposed a single SKILL.md with inline `node -e`
templates for each CDP command. This was reconsidered because:

1. **Repetition** — Every command repeats the same WebSocket connect →
   send → receive → close → timeout pattern (~15-20 lines each). With
   9+ commands, that's 150-180 lines of near-identical boilerplate.
2. **Agent drift** — With that much inline code in context, the agent
   starts improvising: tweaking boilerplate, forgetting timeouts,
   dropping the env-var safety pattern. On simple tasks ("screenshot"),
   250 lines of templates nudge it toward unnecessary complexity.
3. **Error handling** — Each inline block needs its own error handling
   (connection refused, timeout, invalid target). Either duplicated
   everywhere or inconsistently applied.
4. **Composability** — To chain commands (navigate → wait → screenshot),
   the agent must mentally stitch templates. With a script, it chains
   simple shell commands.

The original rationale for pure-prompt was avoiding the `ws` npm
dependency. Node 22's built-in WebSocket makes a script *also* zero-dep,
eliminating the trade-off. `mitsuhiko/agent-stuff` needed `ws`; we don't.

## Skill Design

### CLI Interface

```bash
cdp.js list                          # discover targets
cdp.js navigate <url> [--id <tid>]   # go to page
cdp.js eval <expr> [--id <tid>]      # evaluate JS, return result
cdp.js screenshot <path> [--id <tid>] # save screenshot as PNG
cdp.js ax-tree [--id <tid>]          # accessibility tree (primary)
cdp.js dom [--id <tid>]              # outer HTML (fallback)
cdp.js click <selector> [--id <tid>] # click element via selector
cdp.js type <selector> <text> [--id <tid>] # type into element
cdp.js console [--timeout 10] [--id <tid>] # stream console events
cdp.js network [--timeout 10] [--id <tid>] # stream network events
```

All commands default to `--port 9222` and auto-select the first page
target. Use `--id <target-id>` to target a specific tab (from `list`).

### CDP Method Mapping

| Command | CDP Method | Notes |
|---------|-----------|-------|
| `list` | HTTP `GET /json` | List pages, workers, extensions with unique IDs |
| `navigate` | `Page.navigate` | Enables `Page` domain first |
| `eval` | `Runtime.evaluate` | Returns value, supports `awaitPromise` |
| `screenshot` | `Page.captureScreenshot` | Decodes base64, writes PNG file |
| `ax-tree` | `Accessibility.getFullAXTree` | Primary page understanding method |
| `dom` | `DOM.getDocument` + `DOM.getOuterHTML` | Raw HTML fallback |
| `click` | `Runtime.evaluate` (querySelector + click) | Simple and reliable |
| `type` | `Runtime.evaluate` (focus + value + input event) | Triggers input events |
| `console` | `Runtime.consoleAPICalled` event | Long-running with timeout |
| `network` | `Network.requestWillBeSent` event | Long-running with timeout |

### Script Internals

The script centralizes:

- **Connection** — Single `connect(targetId?)` function handles `/json`
  discovery, target selection by ID, WebSocket setup
- **Command dispatch** — `send(method, params)` → returns result promise
  with timeout (`CDP_TIMEOUT` env var, default 5s)
- **Error handling** — Connection refused, target not found, CDP errors,
  timeouts — all produce clear exit-code-1 messages
- **Output** — JSON to stdout for structured data, file path for
  screenshots. Agent reads result directly or via Read tool for images.
- **No shell injection** — Args passed via `process.argv`, not shell
  interpolation

### Trigger Keywords

`cdp connect`, `connect to browser`, `connect to chrome`,
`attach to browser`, `interact with browser`, `drive browser`,
`browser automation`, `control chrome`, `connect 9222`

### Non-Goals

- No browser launching (Playwright MCP or `npm run dev:full` handles that)
- No persistent connection management (each command is fire-and-forget)
- No dependency installation (Node 22 built-in WebSocket only)
- No screenshot rendering in terminal (save to file → Read tool)

## Design Decisions

### Why fire-and-forget per command?

WebSocket connections can't persist across bash invocations. Each CDP
command opens a connection, sends, receives, closes. This is fine for
the expected use cases (navigate, evaluate, screenshot). For event
streaming (console, network), a long-running node process with timeout
is the pattern.

### Why not wrap in a .jsh script for SLICC?

This skill is for Claude Code, not for SLICC's agent. SLICC already has
`BrowserAPI` + `playwright-cli` for its own agent. This skill lets
Claude Code (the developer) interact with the browser SLICC launched.

## Resolved Questions

1. **Screenshot handling** — Save to file + return path. Claude Code can
   read images via the Read tool, so `save to /tmp/screenshot.png` →
   `Read /tmp/screenshot.png` gives the agent visual feedback.

2. **Accessibility tree** — Include as the *primary* method for
   understanding page state. AX tree gives semantic structure, roles,
   names, and actionable elements in compact text — far more useful than
   raw DOM for an agent. Raw DOM as fallback only.

3. **Event streaming** — 10s default timeout. Teach a `CDP_TIMEOUT`
   pattern the agent adjusts based on context (longer for network
   waterfall capture after navigation).

4. **Multi-page / target selection** — Each target has a unique `id` in
   the `/json` endpoint, even when the same URL is open in multiple tabs.
   Teach ID-based selection, not URL/title filtering.

   **Target identification hierarchy:**

   | Mechanism | Endpoint | Use case |
   |-----------|----------|----------|
   | `GET /json` | HTTP | List all targets with unique `id`, `url`, `title`, `webSocketDebuggerUrl` |
   | `GET /json/version` | HTTP | Get browser-level WebSocket URL (not tied to any tab) |
   | `Target.getTargets()` | Browser WS | All targets with `targetId`, `browserContextId` |
   | `Target.attachToTarget` | Browser WS | Attach to specific `targetId` → get `sessionId` for multiplexed commands |
   | `Target.setDiscoverTargets` | Browser WS | Event stream for tab open/close/change |

   **Pattern:** List targets via `/json` → agent picks by unique `id` →
   connect to that target's `webSocketDebuggerUrl`. For advanced multi-tab
   orchestration, use browser-level WebSocket with `Target.*` methods.

5. **Shell injection** — Eliminated by script approach. Args passed via
   `process.argv`, not shell interpolation into `node -e` strings.

6. **Pure prompt vs script** — Script wins. Same zero-dep story (Node 22
   WebSocket), but SKILL.md drops from ~300 to ~80 lines, agent drift
   risk drops, error handling is centralized, and commands compose
   naturally as shell pipelines.

## Next Steps

1. Write `skills/cdp-connect/scripts/cdp.js` — CLI with all commands
2. Write `skills/cdp-connect/SKILL.md` — concise prompt (~80 lines)
3. Test against a running SLICC instance
4. Add to skills project, sync, publish

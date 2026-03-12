# cdp-connect Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a zero-dependency CDP skill that connects Claude Code to an existing Chrome browser mid-session.

**Architecture:** SKILL.md (~70 lines) teaches when/how to use commands. `cdp.js` (~180 lines) handles all WebSocket boilerplate, connection, and CDP methods. Node 22 built-in `WebSocket` and `fetch` — no npm packages.

**Tech Stack:** Node 22 (WebSocket, fetch), Chrome DevTools Protocol (JSON-RPC over WebSocket)

**Spec:** `docs/plans/2026-03-12-cdp-connect-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `skills/cdp-connect/scripts/cdp.js` | CDP client CLI — all commands |
| Create | `skills/cdp-connect/SKILL.md` | Skill prompt — when/how to use |
| Modify | `scripts/sync-skills.sh` | Support `.js` scripts (currently only `.sh`) |
| Modify | `.claude/CLAUDE.md` | Add cdp-connect to Available Skills table |
| Modify | `.claude-plugin/plugin.json` | Add cdp-connect to description and keywords |
| Modify | `README.md` | Add cdp-connect section |

---

## Chunk 1: Implementation

Tasks 1-4 are independent and can run in parallel.

### Task 1: Write cdp.js

**Files:**
- Create: `skills/cdp-connect/scripts/cdp.js`

- [ ] **Step 1: Create the script**

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const DEFAULT_TIMEOUT = 5000;
const STREAM_TIMEOUT = 10000;

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { port: 9222, id: null, timeout: null };
  const positional = [];
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--port': flags.port = parseInt(raw[++i], 10); break;
      case '--id': flags.id = raw[++i]; break;
      case '--timeout': flags.timeout = parseInt(raw[++i], 10) * 1000; break;
      default: positional.push(raw[i]);
    }
  }
  return { command: positional[0], args: positional.slice(1), ...flags };
}

// --- Core ---

async function getTargets(port) {
  let res;
  try {
    res = await fetch(`http://localhost:${port}/json`);
  } catch {
    die(`Cannot connect to CDP on port ${port}. Is Chrome running with --remote-debugging-port=${port}?`);
  }
  return res.json();
}

async function connectTarget(port, targetId) {
  const targets = await getTargets(port);
  const pages = targets.filter(t => t.type === 'page');
  if (pages.length === 0) die('No page targets found');
  const target = targetId
    ? pages.find(p => p.id === targetId)
    : pages[0];
  if (!target) die(`Target ${targetId} not found. Run 'list' to see available targets.`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket connection failed'));
  });
  return ws;
}

let nextId = 0;
function send(ws, method, params = {}, timeout = DEFAULT_TIMEOUT) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout after ${timeout}ms: ${method}`));
    }, timeout);
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function listen(ws, eventMethod, timeout = STREAM_TIMEOUT) {
  return new Promise((resolve) => {
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === eventMethod) {
        console.log(JSON.stringify(msg.params));
      }
    };
    ws.addEventListener('message', handler);
    setTimeout(() => {
      ws.removeEventListener('message', handler);
      ws.close();
      resolve();
    }, timeout);
  });
}

// --- Commands ---

async function cmdList(port) {
  const targets = await getTargets(port);
  const pages = targets.filter(t => t.type === 'page');
  for (const p of pages) {
    console.log(`${p.id}\t${p.url}\t${p.title}`);
  }
  if (pages.length === 0) console.log('No page targets found.');
}

async function cmdNavigate(url, port, id, timeout) {
  if (!url) die('Usage: cdp.js navigate <url>');
  const ws = await connectTarget(port, id);
  await send(ws, 'Page.enable', {}, timeout);
  const result = await send(ws, 'Page.navigate', { url }, timeout);
  ws.close();
  console.log(JSON.stringify(result));
}

async function cmdEval(expr, port, id, timeout) {
  if (!expr) die('Usage: cdp.js eval <expression>');
  const ws = await connectTarget(port, id);
  const result = await send(ws, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }, timeout);
  ws.close();
  if (result.exceptionDetails) {
    die(`Eval error: ${result.exceptionDetails.text}`);
  }
  const value = result.result?.value;
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
}

async function cmdScreenshot(path, port, id, timeout) {
  if (!path) die('Usage: cdp.js screenshot <path>');
  const ws = await connectTarget(port, id);
  const result = await send(ws, 'Page.captureScreenshot', {
    format: 'png',
  }, timeout);
  ws.close();
  const buf = Buffer.from(result.data, 'base64');
  fs.writeFileSync(path, buf);
  console.log(`Screenshot saved: ${path} (${buf.length} bytes)`);
}

async function cmdAxTree(port, id, timeout) {
  const ws = await connectTarget(port, id);
  const result = await send(ws, 'Accessibility.getFullAXTree', {}, timeout);
  ws.close();
  for (const node of result.nodes ?? []) {
    const role = node.role?.value ?? '';
    const name = node.name?.value ?? '';
    if (role && name) console.log(`[${role}] ${name}`);
    else if (role) console.log(`[${role}]`);
  }
}

async function cmdDom(port, id, timeout) {
  const ws = await connectTarget(port, id);
  const doc = await send(ws, 'DOM.getDocument', { depth: -1 }, timeout);
  const html = await send(ws, 'DOM.getOuterHTML', {
    nodeId: doc.root.nodeId,
  }, timeout);
  ws.close();
  console.log(html.outerHTML);
}

async function cmdClick(selector, port, id, timeout) {
  if (!selector) die('Usage: cdp.js click <selector>');
  const ws = await connectTarget(port, id);
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Element not found: ' + ${JSON.stringify(selector)};
      el.click();
      return 'Clicked: ' + el.tagName + ' ' + (el.textContent?.slice(0, 50) ?? '');
    })()`,
    returnByValue: true,
  }, timeout);
  ws.close();
  console.log(result.result?.value);
}

async function cmdType(selector, text, port, id, timeout) {
  if (!selector || text === undefined) die('Usage: cdp.js type <selector> <text>');
  const ws = await connectTarget(port, id);
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Element not found: ' + ${JSON.stringify(selector)};
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Typed into: ' + el.tagName + '#' + (el.id || el.name || '');
    })()`,
    returnByValue: true,
  }, timeout);
  ws.close();
  console.log(result.result?.value);
}

async function cmdConsole(port, id, timeout) {
  const ws = await connectTarget(port, id);
  await send(ws, 'Runtime.enable', {}, timeout);
  console.error(`Streaming console for ${timeout / 1000}s...`);
  await listen(ws, 'Runtime.consoleAPICalled', timeout);
}

async function cmdNetwork(port, id, timeout) {
  const ws = await connectTarget(port, id);
  await send(ws, 'Network.enable', {}, timeout);
  console.error(`Streaming network for ${timeout / 1000}s...`);
  await listen(ws, 'Network.requestWillBeSent', timeout);
}

// --- Main ---

async function main() {
  const { command, args: cmdArgs, port, id, timeout } = parseArgs(process.argv);
  const t = timeout ?? DEFAULT_TIMEOUT;
  const st = timeout ?? STREAM_TIMEOUT;

  switch (command) {
    case 'list': await cmdList(port); break;
    case 'navigate': await cmdNavigate(cmdArgs[0], port, id, t); break;
    case 'eval': await cmdEval(cmdArgs[0], port, id, t); break;
    case 'screenshot': await cmdScreenshot(cmdArgs[0], port, id, t); break;
    case 'ax-tree': await cmdAxTree(port, id, t); break;
    case 'dom': await cmdDom(port, id, t); break;
    case 'click': await cmdClick(cmdArgs[0], port, id, t); break;
    case 'type': await cmdType(cmdArgs[0], cmdArgs[1], port, id, t); break;
    case 'console': await cmdConsole(port, id, st); break;
    case 'network': await cmdNetwork(port, id, st); break;
    default:
      console.error([
        'Usage: cdp.js <command> [args] [--port N] [--id ID] [--timeout SECS]',
        '',
        'Commands:',
        '  list                          Show browser tabs with IDs',
        '  navigate <url>                Navigate to URL',
        '  eval <expr>                   Evaluate JavaScript',
        '  screenshot <path>             Save screenshot as PNG',
        '  ax-tree                       Accessibility tree (primary)',
        '  dom                           Full HTML (fallback)',
        '  click <selector>              Click element',
        '  type <selector> <text>        Type into element',
        '  console [--timeout N]         Stream console events',
        '  network [--timeout N]         Stream network events',
      ].join('\n'));
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => die(err.message));
```

- [ ] **Step 2: Make executable**

Run: `chmod +x skills/cdp-connect/scripts/cdp.js`

- [ ] **Step 3: Verify syntax**

Run: `node --check skills/cdp-connect/scripts/cdp.js`
Expected: no output (clean parse)

- [ ] **Step 4: Verify help output**

Run: `node skills/cdp-connect/scripts/cdp.js`
Expected: Usage message listing all commands, exit code 0

- [ ] **Step 5: Commit**

```bash
git add skills/cdp-connect/scripts/cdp.js
git commit -m "Add cdp.js CDP client script (zero deps, Node 22)"
```

---

### Task 2: Write SKILL.md

**Files:**
- Create: `skills/cdp-connect/SKILL.md`

- [ ] **Step 1: Create the skill prompt**

```markdown
---
name: cdp-connect
description: Connect Claude Code to an existing Chrome browser via CDP (Chrome DevTools Protocol). Zero dependencies — uses Node 22 built-in WebSocket. Attach to any Chrome running with --remote-debugging-port, then navigate, click, type, screenshot, evaluate JS, read accessibility tree, and monitor console/network. Use when you need to interact with a browser the agent already started, control an existing Chrome instance, or drive browser automation without Playwright MCP. Triggers on: "cdp connect", "connect to browser", "connect to chrome", "attach to browser", "interact with browser", "drive browser", "browser automation", "control chrome", "connect 9222".
---

# CDP Connect

Connect to an existing Chrome browser via Chrome DevTools Protocol.
Zero dependencies — Node 22 built-in WebSocket only.

## Prerequisites

Chrome must be running with remote debugging enabled:

` ` `bash
# Launched manually:
chrome --remote-debugging-port=9222

# Or by a dev server that launches Chrome:
npm run dev  # if it opens Chrome with --remote-debugging-port
` ` `

## Script

` ` `bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  CDP_JS="${CLAUDE_SKILL_DIR}/scripts/cdp.js"
else
  CDP_JS="$(command -v cdp.js 2>/dev/null || \
    find ~/.claude -path "*/cdp-connect/scripts/cdp.js" -type f 2>/dev/null | head -1)"
fi
if [[ -z "$CDP_JS" || ! -f "$CDP_JS" ]]; then
  echo "Error: cdp.js not found. Ask the user for the path." >&2
fi
` ` `

Store in `CDP_JS` and use for all commands below.

## Commands

` ` `bash
node "$CDP_JS" list                            # Show all tabs with IDs
node "$CDP_JS" navigate <url> [--id <tid>]     # Navigate to URL
node "$CDP_JS" eval <expr> [--id <tid>]        # Evaluate JavaScript
node "$CDP_JS" screenshot <path> [--id <tid>]  # Save screenshot as PNG
node "$CDP_JS" ax-tree [--id <tid>]            # Accessibility tree (primary)
node "$CDP_JS" dom [--id <tid>]                # Full HTML (fallback)
node "$CDP_JS" click <selector> [--id <tid>]   # Click element
node "$CDP_JS" type <sel> <text> [--id <tid>]  # Type into element
node "$CDP_JS" console [--timeout 10]          # Stream console events
node "$CDP_JS" network [--timeout 10]          # Stream network events
` ` `

All commands default to port 9222. Override with `--port N`.
Use `--id <target-id>` from `list` output to target a specific tab.

## Workflow

1. **Discover** — `list` to see tabs and their unique IDs
2. **Understand** — `ax-tree` for page structure (prefer over `dom`)
3. **Interact** — `navigate`, `click`, `type`, `eval` as needed
4. **Verify** — `screenshot /tmp/shot.png`, then Read the PNG
5. **Debug** — `console` or `network` to stream events

## Tips

- `ax-tree` is the primary way to understand page state — semantic
  roles and names are more useful than raw HTML for an agent
- For screenshots, save to `/tmp/` and use the Read tool to view
- `eval` supports promises: `eval "await fetch('/api').then(r=>r.json())"`
- Increase timeout for slow pages: `--timeout 15`
- `CDP_TIMEOUT=10000` env var overrides default 5s timeout globally
- When multiple tabs are open, always `list` first and use `--id`
```

Note: replace `` ` ` ` `` with actual triple backticks (escaped here for plan readability).

- [ ] **Step 2: Commit**

```bash
git add skills/cdp-connect/SKILL.md
git commit -m "Add cdp-connect SKILL.md prompt"
```

---

### Task 3: Update sync script for .js files

**Files:**
- Modify: `scripts/sync-skills.sh`

- [ ] **Step 1: Change glob from `*.sh` to all files in scripts/**

Replace:
```bash
  for script in "${skill_dir}scripts/"*.sh; do
```

With:
```bash
  for script in "${skill_dir}scripts/"*; do
```

This copies `.js`, `.sh`, `.py`, or any future script type.

- [ ] **Step 2: Verify**

Run: `./scripts/sync-skills.sh`
Expected: `Synced 6 skills to /Users/catalan/.claude/commands/`

Run: `ls -la ~/.local/bin/cdp.js`
Expected: regular file, executable

- [ ] **Step 3: Commit**

```bash
git add scripts/sync-skills.sh
git commit -m "Support all script types in sync-skills.sh"
```

---

### Task 4: Update project manifests

**Files:**
- Modify: `.claude/CLAUDE.md` (Available Skills table)
- Modify: `.claude-plugin/plugin.json` (description, keywords)
- Modify: `README.md` (add cdp-connect section)

- [ ] **Step 1: Add to CLAUDE.md Available Skills table**

Add row:
```
| `cdp-connect` | Connect to existing Chrome browser via CDP |
```

- [ ] **Step 2: Update plugin.json**

Add `cdp-connect (zero-dep CDP browser control)` to description.
Add keywords: `"cdp"`, `"chrome"`, `"browser"`, `"devtools"`, `"automation"`.

- [ ] **Step 3: Add README section**

After the video-digest section, add:

```markdown
### cdp-connect

Connect Claude Code to an existing Chrome browser via Chrome DevTools
Protocol. Zero dependencies — uses Node 22 built-in WebSocket. Navigate,
click, type, screenshot, evaluate JS, read accessibility tree, and
monitor console/network events against any Chrome running with
`--remote-debugging-port`.

**Dependencies:** Node 22+ (built-in WebSocket and fetch)

See [SKILL.md](skills/cdp-connect/SKILL.md) for the full command reference.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md .claude-plugin/plugin.json README.md
git commit -m "Add cdp-connect to project manifests"
```

---

## Chunk 2: Integration

### Task 5: Sync, verify, and live test

Depends on Tasks 1-4 being complete.

- [ ] **Step 1: Sync skills**

Run: `./scripts/sync-skills.sh`
Expected: `Synced 6 skills to /Users/catalan/.claude/commands/`

- [ ] **Step 2: Verify cdp.js is on PATH**

Run: `command -v cdp.js`
Expected: `/Users/catalan/.local/bin/cdp.js`

- [ ] **Step 3: Live test against Chrome**

Launch Chrome with debugging (or use an existing instance):
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --no-first-run --no-default-browser-check \
  "https://example.com" &
```

Test each command:
```bash
node "$(command -v cdp.js)" list
node "$(command -v cdp.js)" eval "document.title"
node "$(command -v cdp.js)" ax-tree | head -20
node "$(command -v cdp.js)" screenshot /tmp/cdp-test.png
node "$(command -v cdp.js)" navigate "https://example.org"
node "$(command -v cdp.js)" click "a"
node "$(command -v cdp.js)" dom | head -5
```

Verify screenshot is readable:
```bash
file /tmp/cdp-test.png
```
Expected: `PNG image data`

- [ ] **Step 4: Fix any issues found during testing**

- [ ] **Step 5: Final commit and push**

```bash
git push -u origin <branch>
```

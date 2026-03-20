# Slack CDP Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code skill that controls Slack desktop via CDP + REST API — navigation via keyboard shortcuts, data operations via the Slack Web API executed inside the renderer.

**Architecture:** Single Node.js script (`slack-cdp.js`) with subcommands, following `cdp-connect/cdp.js` patterns. CDP WebSocket for connection/key events; `Runtime.evaluate` runs `fetch()` inside Slack's renderer calling `app.slack.com/api/*` with the xoxc token from `localStorage.localConfig_v2`. Token never leaves the Electron process.

**Tech Stack:** Node 22 (built-in WebSocket + fetch), no npm dependencies. Depends on `cdp-connect` skill for `cdp.js` (click, screenshot, ax-tree).

**Target repo:** `/Users/catalan/repos/ai/catalan-adobe/skills/`
**Spec:** `../notes/ai/specs/2026-03-19-slack-cdp-skill-design.md`

---

## File Map

| File | Purpose |
|------|---------|
| Create: `skills/slack-cdp/SKILL.md` | Orchestration prompt — tells Claude when/how to use each subcommand |
| Create: `skills/slack-cdp/scripts/slack-cdp.js` | Single script with all subcommands |

---

### Task 1: Script Skeleton — CDP Core + Arg Parsing

**Files:**
- Create: `skills/slack-cdp/scripts/slack-cdp.js`

This task builds the reusable foundation: arg parsing, CDP target discovery (filtering for Slack specifically), WebSocket connection, the `send()` helper (copied from cdp.js pattern), and the `slackAPI()` helper that runs fetch inside the renderer.

- [ ] **Step 1: Create script with arg parsing and CDP core**

```javascript
#!/usr/bin/env node
'use strict';

// --- Constants ---
const API_BASE = 'https://app.slack.com/api';
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT = 8000;
const NAV_SETTLE_MS = 2000;

// --- Arg parsing (follows cdp.js convention) ---
function parseArgs(argv) {
  const flags = { port: DEFAULT_PORT, channel: null, limit: null };
  const positional = [];
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--port': flags.port = parseInt(raw[++i], 10); break;
      case '--channel': flags.channel = raw[++i]; break;
      case '--limit': flags.limit = parseInt(raw[++i], 10); break;
      default: positional.push(raw[i]);
    }
  }
  return { command: positional[0], args: positional.slice(1), ...flags };
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CDP connection (Slack-specific target discovery) ---
async function findSlackTarget(port) {
  let res;
  try {
    res = await fetch(`http://localhost:${port}/json`);
  } catch {
    die(
      `Cannot connect to CDP on port ${port}.\n` +
      `Start Slack with: /Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=${port}`
    );
  }
  const targets = await res.json();
  const slack = targets.find(
    (t) => t.type === 'page' && t.url?.includes('app.slack.com')
  );
  if (!slack) die('No Slack page target found. Is Slack running?');
  return slack;
}

async function connectSlack(port) {
  const target = await findSlackTarget(port);
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

// --- Slack API via renderer eval ---
async function slackEval(ws, apiMethod, params = {}) {
  const paramStr = JSON.stringify(params);
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const cfg = JSON.parse(localStorage.localConfig_v2);
      const tk = cfg.teams[cfg.lastActiveTeamId].token;
      const p = ${paramStr};
      const body = new URLSearchParams(Object.assign({ token: tk }, p));
      const resp = await fetch('${API_BASE}/${apiMethod}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include'
      });
      return JSON.stringify(await resp.json());
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    die(`API error (${apiMethod}): ${result.exceptionDetails.text}`);
  }
  return JSON.parse(result.result?.value || '{"ok":false,"error":"empty"}');
}

// --- DOM eval helper ---
async function domEval(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    die(`Eval error: ${result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

// --- Key input helpers ---
async function sendKey(ws, key, code, vk, modifiers = 0) {
  await send(ws, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key, code,
    windowsVirtualKeyCode: vk, modifiers,
  });
  await send(ws, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, code,
    windowsVirtualKeyCode: vk, modifiers,
  });
}

async function insertText(ws, text) {
  await send(ws, 'Input.insertText', { text });
}

// --- Main dispatcher (placeholder) ---
async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.command) {
    console.error([
      'Usage: slack-cdp.js <command> [args] [--port N]',
      '',
      'Commands:',
      '  connect                 Verify connection and auth',
      '  navigate <query>        Switch channel/DM via Cmd+K',
      '  read [--channel ID]     Read recent messages',
      '  send <channel> <msg>    Send a message',
      '  search <query>          Search messages',
      '  whoami                  Current user info',
      '  unread                  List unread channels',
      '  status [":emoji: text"] Get or set status',
      '  where                   Current view info',
    ].join('\n'));
    process.exit(0);
  }
  die(`Unknown command: ${opts.command}`);
}

main().catch((err) => die(err.message));
```

- [ ] **Step 2: Verify the script runs and shows help**

Run: `node skills/slack-cdp/scripts/slack-cdp.js`
Expected: usage text with 9 commands listed, exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/catalan/repos/ai/catalan-adobe/skills
git add skills/slack-cdp/scripts/slack-cdp.js
git commit -m "feat(slack-cdp): script skeleton with CDP core and Slack API helper"
```

---

### Task 2: `connect` and `whoami` Subcommands

**Files:**
- Modify: `skills/slack-cdp/scripts/slack-cdp.js`

These two are the simplest API-only commands and prove the full path works: CDP → WebSocket → renderer eval → Slack API → formatted output.

- [ ] **Step 1: Add `connect` command**

```javascript
async function cmdConnect(port) {
  const ws = await connectSlack(port);
  const auth = await slackEval(ws, 'auth.test');
  ws.close();
  if (!auth.ok) die(`Auth failed: ${auth.error}`);
  console.log(`Connected to: Slack (${auth.team})`);
  console.log(`User: ${auth.user} — ${auth.user_id}`);
  console.log(`Team: ${auth.team} — ${auth.team_id}`);
  console.log(`Enterprise: ${auth.is_enterprise_install ? 'yes' : 'no'}`);
}
```

- [ ] **Step 2: Add `whoami` command**

```javascript
async function cmdWhoami(port) {
  const ws = await connectSlack(port);
  const auth = await slackEval(ws, 'auth.test');
  if (!auth.ok) { ws.close(); die(`Auth failed: ${auth.error}`); }
  const user = await slackEval(ws, 'users.info', { user: auth.user_id });
  ws.close();
  const u = user.user;
  const status = u.profile?.status_emoji
    ? `${u.profile.status_emoji} ${u.profile.status_text || ''}`
    : '(none)';
  console.log(`User: ${u.real_name} (@${u.name}) — ${u.id}`);
  console.log(`Team: ${auth.team} — ${auth.team_id}`);
  console.log(`Enterprise: ${auth.is_enterprise_install ? 'yes' : 'no'}`);
  console.log(`Status: ${status}`);
}
```

- [ ] **Step 3: Wire into main dispatcher**

Replace the `die(`Unknown command`)` with a switch:

```javascript
const ws_cmds = {
  connect: () => cmdConnect(opts.port),
  whoami: () => cmdWhoami(opts.port),
};
const fn = ws_cmds[opts.command];
if (!fn) die(`Unknown command: ${opts.command}`);
await fn();
```

- [ ] **Step 4: Verify against live Slack**

Run: `node skills/slack-cdp/scripts/slack-cdp.js connect --port 9222`
Expected: `Connected to: Slack (Adobe)` + user/team info.

Run: `node skills/slack-cdp/scripts/slack-cdp.js whoami --port 9222`
Expected: Full name, handle, status.

- [ ] **Step 5: Commit**

```bash
git add skills/slack-cdp/scripts/slack-cdp.js
git commit -m "feat(slack-cdp): add connect and whoami commands"
```

---

### Task 3: `where` and `navigate` Subcommands

**Files:**
- Modify: `skills/slack-cdp/scripts/slack-cdp.js`

`where` is pure DOM reading. `navigate` is the CDP key-event sequence we validated in the session.

- [ ] **Step 1: Add `where` command**

```javascript
async function cmdWhere(port) {
  const ws = await connectSlack(port);
  const info = await domEval(ws, `
    const path = window.location.pathname;
    const parts = path.split('/');
    const tab = document.querySelector('[role=tab][aria-selected=true]');
    return JSON.stringify({
      title: document.title.replace(/ - Slack$/, ''),
      channel: parts[3] || null,
      tab: tab ? tab.textContent.trim() : null,
      path: path,
    });
  `);
  ws.close();
  const d = JSON.parse(info);
  console.log(`Title: ${d.title}`);
  if (d.channel) console.log(`Channel: ${d.channel}`);
  if (d.tab) console.log(`Tab: ${d.tab} (selected)`);
  console.log(`URL: ${d.path}`);
}
```

- [ ] **Step 2: Add `navigate` command**

```javascript
async function cmdNavigate(query, port) {
  if (!query) die('Usage: slack-cdp.js navigate <query>');
  const ws = await connectSlack(port);
  // Cmd+K
  await sendKey(ws, 'k', 'KeyK', 75, 4);
  await wait(600);
  // Type query
  await insertText(ws, query);
  await wait(1500);
  // Enter
  await sendKey(ws, 'Enter', 'Enter', 13);
  await wait(NAV_SETTLE_MS);
  // Read resulting title
  const title = await domEval(ws, `return document.title.replace(/ - Slack$/, '');`);
  ws.close();
  console.log(`Navigated to: ${title}`);
}
```

- [ ] **Step 3: Wire into dispatcher**

Add to the switch: `where`, `navigate`.

- [ ] **Step 4: Verify against live Slack**

Run: `node skills/slack-cdp/scripts/slack-cdp.js where --port 9222`
Expected: Title, channel ID, selected tab.

Run: `node skills/slack-cdp/scripts/slack-cdp.js navigate "Andrei Tuicu" --port 9222`
Expected: `Navigated to: Andrei Stefan Tuicu (DM) - Adobe`

Run: `node skills/slack-cdp/scripts/slack-cdp.js where --port 9222`
Expected: Title matches Andrei, channel ID present.

- [ ] **Step 5: Commit**

```bash
git add skills/slack-cdp/scripts/slack-cdp.js
git commit -m "feat(slack-cdp): add where and navigate commands"
```

---

### Task 4: `search` and `read` Subcommands

**Files:**
- Modify: `skills/slack-cdp/scripts/slack-cdp.js`

Both are API-only. `read` needs the current channel ID from the URL when `--channel` is not provided.

- [ ] **Step 1: Add helper to get current channel from URL**

```javascript
async function getCurrentChannel(ws) {
  const path = await domEval(ws, `return window.location.pathname;`);
  const parts = path.split('/');
  if (parts.length >= 4 && parts[3]) return parts[3];
  die('Cannot determine current channel from URL. Use --channel <id>.');
}
```

- [ ] **Step 2: Add `search` command**

```javascript
async function cmdSearch(query, limit, port) {
  if (!query) die('Usage: slack-cdp.js search <query>');
  const ws = await connectSlack(port);
  const data = await slackEval(ws, 'search.messages', {
    query, count: String(limit || 5),
  });
  ws.close();
  if (!data.ok) die(`Search failed: ${data.error}`);
  const total = data.messages?.total || 0;
  const matches = data.messages?.matches || [];
  console.log(`Search: "${query}" — ${total} results (showing ${matches.length})`);
  console.log('');
  for (const m of matches) {
    const chan = m.channel?.name ? `#${m.channel.name}` : m.channel?.id || '?';
    const user = m.username || m.user || '?';
    const date = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString().slice(0, 10) : '?';
    const text = (m.text || '').replace(/\n/g, ' ').slice(0, 120);
    console.log(`  [${chan}] @${user} (${date}): ${text}`);
  }
}
```

- [ ] **Step 3: Add `read` command**

```javascript
async function cmdRead(channelFlag, limit, port) {
  const ws = await connectSlack(port);
  const channel = channelFlag || await getCurrentChannel(ws);
  const data = await slackEval(ws, 'conversations.history', {
    channel, limit: String(limit || 10),
  });
  if (!data.ok) {
    ws.close();
    if (data.error === 'enterprise_is_restricted') {
      die(`conversations.history is restricted. Use search or navigate to the channel.`);
    }
    die(`Read failed: ${data.error}`);
  }
  ws.close();
  const msgs = (data.messages || []).reverse();
  console.log(`${channel} — ${msgs.length} messages`);
  console.log('');
  for (const m of msgs) {
    const ts = m.ts ? new Date(parseFloat(m.ts) * 1000).toLocaleString() : '?';
    const user = m.user || m.username || m.bot_id || '?';
    const text = (m.text || '').replace(/\n/g, ' ').slice(0, 200);
    console.log(`  [${ts}] ${user}: ${text}`);
  }
}
```

- [ ] **Step 4: Wire into dispatcher**

Add `search` and `read` to the switch.

- [ ] **Step 5: Verify against live Slack**

Run: `node skills/slack-cdp/scripts/slack-cdp.js search "header migration" --port 9222`
Expected: Search results with channel, user, date, text.

Run: `node skills/slack-cdp/scripts/slack-cdp.js read --port 9222`
Expected: Messages from current channel.

- [ ] **Step 6: Commit**

```bash
git add skills/slack-cdp/scripts/slack-cdp.js
git commit -m "feat(slack-cdp): add search and read commands"
```

---

### Task 5: `send`, `unread`, and `status` Subcommands

**Files:**
- Modify: `skills/slack-cdp/scripts/slack-cdp.js`

- [ ] **Step 1: Add `send` command**

```javascript
async function cmdSend(channelArg, message, port) {
  if (!message) die('Usage: slack-cdp.js send <channel|current> <message>');
  const ws = await connectSlack(port);
  const channel = channelArg === 'current'
    ? await getCurrentChannel(ws)
    : channelArg;
  const data = await slackEval(ws, 'chat.postMessage', {
    channel, text: message,
  });
  ws.close();
  if (!data.ok) die(`Send failed: ${data.error}`);
  console.log(`Sent to ${data.channel} (ts: ${data.ts})`);
}
```

- [ ] **Step 2: Add `unread` command**

```javascript
async function cmdUnread(port) {
  const ws = await connectSlack(port);
  // Try client.counts first, fall back to sidebar DOM
  const data = await slackEval(ws, 'client.counts');
  if (data.ok && data.channels) {
    ws.close();
    const unread = data.channels
      .filter((c) => c.has_unreads || c.mention_count > 0)
      .sort((a, b) => (b.mention_count || 0) - (a.mention_count || 0));
    if (unread.length === 0) { console.log('No unread channels.'); return; }
    console.log('Unread channels:');
    for (const c of unread) {
      const count = c.mention_count || 'new';
      console.log(`  ${c.name || c.id} (${count})`);
    }
    return;
  }
  // Fallback: read sidebar DOM
  const sidebarText = await domEval(ws, `
    const items = [...document.querySelectorAll('.p-channel_sidebar__channel--unread')];
    return JSON.stringify(items.map(el => el.textContent.trim().substring(0, 60)));
  `);
  ws.close();
  const items = JSON.parse(sidebarText || '[]');
  if (items.length === 0) { console.log('No unread channels.'); return; }
  console.log('Unread channels:');
  for (const item of items) console.log(`  ${item}`);
}
```

- [ ] **Step 3: Add `status` command**

```javascript
async function cmdStatus(statusArg, port) {
  const ws = await connectSlack(port);
  if (!statusArg) {
    // Get status
    const auth = await slackEval(ws, 'auth.test');
    const user = await slackEval(ws, 'users.info', { user: auth.user_id });
    ws.close();
    const p = user.user?.profile;
    if (p?.status_emoji || p?.status_text) {
      console.log(`Status: ${p.status_emoji || ''} ${p.status_text || ''}`.trim());
      if (p.status_expiration) {
        const exp = new Date(p.status_expiration * 1000).toLocaleString();
        console.log(`Expires: ${exp}`);
      }
    } else {
      console.log('Status: (none)');
    }
    return;
  }
  // Set status: parse ":emoji: text" format
  const emojiMatch = statusArg.match(/^(:[\w+-]+:)\s*(.*)/);
  const emoji = emojiMatch ? emojiMatch[1] : '';
  const text = emojiMatch ? emojiMatch[2] : statusArg;
  const data = await slackEval(ws, 'users.profile.set', {
    profile: JSON.stringify({
      status_text: text,
      status_emoji: emoji,
    }),
  });
  ws.close();
  if (!data.ok) die(`Status update failed: ${data.error}`);
  console.log(`Status set: ${emoji} ${text}`.trim());
}
```

- [ ] **Step 4: Wire into dispatcher and verify**

Add `send`, `unread`, `status` to the switch.

Run: `node skills/slack-cdp/scripts/slack-cdp.js status --port 9222`
Expected: Current status or "(none)".

Run: `node skills/slack-cdp/scripts/slack-cdp.js unread --port 9222`
Expected: List of unread channels or "No unread channels."

(Skip `send` verification to avoid spamming.)

- [ ] **Step 5: Commit**

```bash
git add skills/slack-cdp/scripts/slack-cdp.js
git commit -m "feat(slack-cdp): add send, unread, and status commands"
```

---

### Task 6: SKILL.md — Orchestration Prompt

**Files:**
- Create: `skills/slack-cdp/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

The SKILL.md should contain:

1. **Frontmatter** — name, description with trigger keywords
2. **Prerequisites** — Slack must be running with `--remote-debugging-port=9222`
3. **Script location block** — `${CLAUDE_SKILL_DIR}/scripts/slack-cdp.js` with fallback to `command -v` and `~/.local/bin/`
4. **Command reference** — all 9 subcommands with usage
5. **Decision tree** — API first → keyboard shortcuts → CDP click → screenshot (last resort)
6. **Chaining patterns** — navigate+read, search+navigate, unread+read
7. **Verification** — always `where` after `navigate`, never screenshot
8. **Error recovery** — if connect fails, tell user to restart Slack with the flag
9. **CDP fallback** — for operations that need `cdp.js` (click, screenshot, ax-tree), include the cdp-connect script location block

`★ Insight ─────────────────────────────────────`
The SKILL.md is the most important file in the skill — it's what Claude reads to decide *when* and *how* to use the tool. A well-written SKILL.md means Claude makes good decisions autonomously; a poor one means constant user correction. The decision tree section is critical: it prevents Claude from defaulting to screenshots when a DOM check would suffice.
`─────────────────────────────────────────────────`

- [ ] **Step 2: Verify skill loads in Claude Code**

From the skills repo, check that the skill is discoverable:
```bash
ls skills/slack-cdp/SKILL.md skills/slack-cdp/scripts/slack-cdp.js
```

- [ ] **Step 3: Commit**

```bash
git add skills/slack-cdp/
git commit -m "feat(slack-cdp): add SKILL.md orchestration prompt"
```

---

### Task 7: Install Script to PATH + Final Verification

**Files:**
- No new files — symlink + end-to-end test

- [ ] **Step 1: Symlink to ~/.local/bin/**

```bash
ln -sf /Users/catalan/repos/ai/catalan-adobe/skills/skills/slack-cdp/scripts/slack-cdp.js ~/.local/bin/slack-cdp.js
chmod +x ~/.local/bin/slack-cdp.js
```

- [ ] **Step 2: End-to-end verification sequence**

```bash
slack-cdp.js connect
slack-cdp.js whoami
slack-cdp.js where
slack-cdp.js navigate "general"
slack-cdp.js where
slack-cdp.js search "meeting notes" --limit 3
slack-cdp.js status
slack-cdp.js unread
```

All 8 commands should complete without errors.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(slack-cdp): complete skill with 9 subcommands"
```

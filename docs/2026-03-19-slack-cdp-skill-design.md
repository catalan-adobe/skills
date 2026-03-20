# Slack CDP Skill — Design Spec

**Date:** 2026-03-19
**Status:** Approved
**Repo:** catalan-adobe/skills
**Path:** `skills/slack-cdp/`

## Overview

A Claude Code skill for controlling Slack desktop via CDP + REST API. Combines UI automation (CDP key events for navigation) with REST API calls (search, messaging, reading) executed from within Slack's Electron renderer.

## Architecture

```
Claude Code
  ↓ invokes
slack-cdp.js <subcommand> [args] --port 9222
  ↓ connects
localhost:9222/json → WebSocket to Slack page target
  ↓ executes
Runtime.evaluate → async IIFE inside Slack renderer
  ↓ calls
app.slack.com/api/* (same-origin, d cookie auto-included)
```

**Two layers:**
- **CDP layer** — key events for navigation (Cmd+K), click for UI elements, eval for DOM state
- **API layer** — `Runtime.evaluate` runs fetch() inside the renderer, calling `app.slack.com/api/*` with the xoxc token from `localStorage.localConfig_v2`

**Dependencies:**
- `cdp-connect` skill must be installed (provides `cdp.js` for `click`, `screenshot`, `ax-tree`)
- Node 22+ (built-in `WebSocket` and `fetch`)
- No npm dependencies

## Skill Structure

```
skills/slack-cdp/
  SKILL.md              — orchestration prompt
  scripts/
    slack-cdp.js        — single Node.js script with subcommands
```

## Subcommands

### connect

Verify Slack is running on CDP, extract token, validate auth.

```bash
slack-cdp.js connect [--port 9222]
```

**Output:**
```
Connected to: Slack (Adobe)
User: catalan (David Catalan)
Team: Adobe (E23RE8G4F)
Enterprise: yes
```

**Flow:**
1. GET `localhost:{port}/json` → find target with `type: "page"` and URL containing `app.slack.com`
2. WebSocket connect to target
3. `Runtime.evaluate`: parse `localStorage.localConfig_v2`, extract team info
4. `Runtime.evaluate`: call `app.slack.com/api/auth.test` with token
5. Print user, team, enterprise info
6. Exit

### navigate

Switch to a channel, DM, or app via Cmd+K quick switcher.

```bash
slack-cdp.js navigate <query> [--port 9222]
```

**Output:**
```
Navigated to: Andrei Stefan Tuicu (DM)
```

**Flow:**
1. Connect WebSocket
2. `Input.dispatchKeyEvent`: Cmd+K (rawKeyDown, modifiers: 4)
3. Wait 600ms
4. `Input.insertText`: query
5. Wait 1500ms (search results)
6. `Input.dispatchKeyEvent`: Enter
7. Wait 2000ms (page load)
8. `Runtime.evaluate`: read `document.title`
9. Print navigation result
10. Exit

### read

Read recent messages from current or specified channel.

```bash
slack-cdp.js read [--channel <id>] [--limit 10] [--port 9222]
```

**Output:**
```
#aem-agent-ex-modernization — 10 messages

[2026-03-19 14:32] @karl.pauls: The new migration script is ready...
[2026-03-19 14:35] @catalan: Let me review it...
...
```

**Flow:**
1. Connect WebSocket
2. If no `--channel`: extract channel ID from `window.location.pathname` (`/client/{team}/{channel}`)
3. `Runtime.evaluate`: call `conversations.history` with channel ID and limit
4. Format messages: timestamp, username, text (truncated to 200 chars)
5. Print
6. Exit

**Fallback:** If `conversations.history` returns `enterprise_is_restricted`, fall back to extracting message text from the DOM via `[data-qa="message_content"]` selectors.

### send

Send a message to current or specified channel.

```bash
slack-cdp.js send <channel-id-or-current> <message> [--port 9222]
```

**Output:**
```
Sent to #aem-agent-ex-modernization (C0895NK2431)
```

**Flow:**
1. Connect WebSocket
2. If channel is `current`: extract from URL
3. `Runtime.evaluate`: call `chat.postMessage` with channel and text
4. Print confirmation with channel name and ID
5. Exit

### search

Full-text search across workspace.

```bash
slack-cdp.js search <query> [--limit 5] [--port 9222]
```

**Output:**
```
Search: "header migration" — 42 results (showing 5)

1. [#franklin-import] @catalan (2026-03-15): The header extraction script now handles...
2. [#aem-agent-ex] @karl.pauls (2026-03-14): Migration approach for complex headers...
...
```

**Flow:**
1. Connect WebSocket
2. `Runtime.evaluate`: call `search.messages` with query and count
3. Format: channel, author, date, text excerpt
4. Print
5. Exit

### whoami

Current user, team, workspace info.

```bash
slack-cdp.js whoami [--port 9222]
```

**Output:**
```
User: David Catalan (@catalan) — W4SG7FY1L
Team: Adobe — E23RE8G4F
Enterprise: yes
Status: (none)
```

**Flow:**
1. Connect WebSocket
2. `Runtime.evaluate`: call `auth.test` + `users.info`
3. Print user details
4. Exit

### unread

List channels/DMs with unread messages.

```bash
slack-cdp.js unread [--port 9222]
```

**Output:**
```
Unread channels:
  #milo-community (9+)
  #fps-private (3)
  @Karl Pauls (1)
```

**Flow:**
1. Connect WebSocket
2. `Runtime.evaluate`: call `client.counts` or `users.counts`
3. Format: channel name, unread count, sorted by priority (DMs > mentions > channels)
4. Print
5. Exit

**Note:** If the counts API is enterprise-restricted, fall back to reading sidebar DOM: `.p-channel_sidebar__channel--unread` elements with their text content.

### status

Get or set Slack status.

```bash
slack-cdp.js status [--port 9222]              # get current
slack-cdp.js status ":emoji: Status text" [--port 9222]  # set
```

**Output (get):**
```
Status: :coffee: On a break (clears in 30 min)
```

**Output (set):**
```
Status set: :hammer: Building a skill
```

**Flow:**
1. Connect WebSocket
2. Get: `Runtime.evaluate` → `users.profile.get`
3. Set: parse emoji from `:emoji:` prefix, `Runtime.evaluate` → `users.profile.set`
4. Print
5. Exit

### where

What view am I on?

```bash
slack-cdp.js where [--port 9222]
```

**Output:**
```
Title: Kite (DM) - Adobe
Channel: D0AMFH9QS0H
Tab: Messages (selected)
URL: /client/E23RE8G4F/D0AMFH9QS0H
```

**Flow:**
1. Connect WebSocket
2. `Runtime.evaluate`: read `document.title`, `window.location.pathname`, query `[role=tab][aria-selected=true]`
3. Print
4. Exit

## Token Handling

**Stateless, no caching.** Every command:
1. Evaluates `localStorage.localConfig_v2` fresh via `Runtime.evaluate`
2. Calls the API within the renderer context using `credentials: 'include'`
3. Token never leaves the Electron process
4. Token never printed to stdout, never passed as CLI argument
5. Token never stored on disk

This design means:
- File-guard hooks won't block the script (no `.token` in bash commands)
- No secret management needed
- Token rotation happens transparently (Slack refreshes tokens internally)

## API Base URL

All API calls MUST use `https://app.slack.com/api/` (same origin as the renderer), NOT `https://slack.com/api/` (blocked by CORS).

The `d` cookie (`xoxd-*`) is automatically included via `credentials: 'include'` when fetching from the same origin.

## SKILL.md Content (Outline)

The SKILL.md instructs Claude on:

1. **Prerequisites** — Slack must be running with `--remote-debugging-port=9222`
2. **Script location** — `${CLAUDE_SKILL_DIR}/scripts/slack-cdp.js` with fallback
3. **Decision tree for operations:**
   - Data operations (read, search, send, status) → use API subcommands
   - Navigation → use `navigate` subcommand (Cmd+K)
   - UI state checking → use `where` subcommand
   - UI element interaction → delegate to `cdp.js click`
   - Visual debugging (last resort) → delegate to `cdp.js screenshot`
4. **Chaining patterns:**
   - "Go to #channel and read recent messages" → `navigate channel` then `read`
   - "Search for X and go to that channel" → `search X`, extract channel, `navigate`
   - "Check my unreads and summarize" → `unread`, then `read` each channel
5. **Verification:** Always use `where` after `navigate`, never screenshot
6. **Error handling:** If `connect` fails, tell user to restart Slack with `--remote-debugging-port=9222`

## Enterprise Grid Considerations

Some API methods return `enterprise_is_restricted` for `xoxc` tokens on Enterprise Grid workspaces. Known restrictions:
- `conversations.list` — restricted (use channel ID from URL instead)
- `client.counts` — may be restricted (fall back to sidebar DOM)

Working methods (validated):
- `auth.test`, `search.messages`, `users.info`, `conversations.history`, `chat.postMessage`, `users.profile.get/set`

## Out of Scope

- Message composition/drafting (Claude composes, skill only sends)
- File uploads
- Slack app/bot installation
- Token caching or persistence
- Screenshot-based verification
- Slack web app (browser) — desktop Electron only
- Multi-workspace switching (single active workspace per invocation)

## Risk / Gotchas

- **Selector drift:** `data-qa` attributes are the most stable but can change on major Slack redesigns (~every 2 years). DOM fallbacks should use `data-qa` first, `p-`/`c-` classes second.
- **Enterprise restrictions:** Some API methods blocked. Each subcommand has a DOM fallback path.
- **ToS gray area:** Using `xoxc` tokens extracted from localStorage is not officially supported. Personal use, read-heavy workloads, low-frequency calls minimize risk.
- **CDP requires restart:** Slack must be launched with `--remote-debugging-port`. Can't attach to running instance.
- **Target ID instability:** The CDP target ID changes between Slack restarts. Script discovers it dynamically via `/json` endpoint.

---
name: slack-cdp
description: >
  Control Slack desktop via CDP and REST API. Navigate channels, read/send
  messages, search conversations, check unreads, and manage status — all
  through Slack's Electron app with zero API tokens or bot setup. Requires
  Slack running with --remote-debugging-port. Triggers on: slack, read slack,
  search slack, slack unreads, send slack message, slack status, navigate
  slack, check slack, slack messages, go to channel, slack DM.
---

# Slack CDP

Control Slack desktop via Chrome DevTools Protocol + REST API.
Two layers: CDP key events for navigation, Slack Web API (via
renderer eval) for data operations. Zero dependencies beyond
Node 22 and the `cdp-connect` skill.

## Prerequisites

Slack must be running with remote debugging enabled:

```bash
/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9222
```

If `connect` fails, tell the user to quit Slack and relaunch with
that flag. Their session persists — they stay logged in.

## Scripts

**slack-cdp.js** — main script:

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  SLACK_JS="${CLAUDE_SKILL_DIR}/scripts/slack-cdp.js"
else
  SLACK_JS="$(command -v slack-cdp.js 2>/dev/null || \
    find ~/.claude -path "*/slack-cdp/scripts/slack-cdp.js" -type f 2>/dev/null | head -1)"
fi
if [[ -z "$SLACK_JS" || ! -f "$SLACK_JS" ]]; then
  echo "Error: slack-cdp.js not found." >&2
fi
```

**cdp.js** — for UI operations (click, screenshot, ax-tree):

```bash
CDP_JS="$(command -v cdp.js 2>/dev/null || echo "$HOME/.local/bin/cdp.js")"
```

## Commands

```bash
node "$SLACK_JS" connect                          # Verify CDP + auth
node "$SLACK_JS" where                            # Current view info
node "$SLACK_JS" navigate <query>                 # Cmd+K quick switcher
node "$SLACK_JS" read [--channel ID] [--limit N]  # Read messages
node "$SLACK_JS" send <channel|current> <message> # Send message
node "$SLACK_JS" search <query> [--limit N]       # Full-text search
node "$SLACK_JS" whoami                           # User and team info
node "$SLACK_JS" unread                           # Unread channels
node "$SLACK_JS" status [":emoji: text"]          # Get or set status
```

All commands default to port 9222. Override with `--port N`.

## Decision Tree

When the user asks about Slack, pick the right tool:

1. **Data operations** (read, search, send, status, unread, whoami)
   → Use the API subcommands. Fast, reliable, structured output.

2. **Navigation** (go to a channel, switch DM, open an app)
   → Use `navigate <query>`. Works from any view.

3. **Verify current state** (what channel am I in?)
   → Use `where`. Reads title, channel ID, active tab from DOM.

4. **Click a UI element** (tab, button, sidebar item)
   → Delegate to `cdp.js click '<selector>'` with `data-qa` selectors.

5. **Visual debugging** (something looks wrong, need to see the screen)
   → Last resort: `cdp.js screenshot /tmp/slack.png`

**Never screenshot to verify navigation.** Use `where` instead.

## Chaining Patterns

Common multi-step operations:

**Go to a channel and read messages:**
```bash
node "$SLACK_JS" navigate "engineering"
node "$SLACK_JS" read --limit 20
```

**Search and navigate to result:**
```bash
node "$SLACK_JS" search "deployment issue" --limit 5
# Extract channel from results, then:
node "$SLACK_JS" navigate "channel-name"
```

**Summarize unreads:**
```bash
node "$SLACK_JS" unread
# For each unread channel:
node "$SLACK_JS" read --channel <ID> --limit 10
```

## Verification

After `navigate`, always verify with `where`:
```bash
node "$SLACK_JS" navigate "Andrei Tuicu"
node "$SLACK_JS" where
# Confirm title matches expected destination
```

## Clicking UI Elements

For tab switching or button clicks not covered by subcommands,
use `cdp.js` with Slack's `data-qa` selectors:

```bash
node "$CDP_JS" click '[data-qa="messages"][role="tab"]' --port 9222
node "$CDP_JS" click '[data-qa="message_input"]' --port 9222
```

Prefer `data-qa` attributes (Slack's own QA hooks) over CSS classes.

## Error Recovery

| Error | Fix |
|-------|-----|
| `Cannot connect to CDP on port 9222` | Restart Slack with `--remote-debugging-port=9222` |
| `No Slack page target found` | Slack is running but not fully loaded — wait and retry |
| `enterprise_is_restricted` | API method blocked on Enterprise Grid — use `search` or DOM fallback |
| `Auth failed` | Slack session expired — re-login in Slack, then retry |

## Tips

- `navigate` uses Cmd+K — works from any view, no need to check starting state
- `send current <msg>` sends to whatever channel is currently open
- `search` returns results across all channels — good for finding channel IDs
- `status` with no args reads current status; with args sets it
- `read` without `--channel` reads from the currently visible channel

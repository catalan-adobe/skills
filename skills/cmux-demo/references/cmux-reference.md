# cmux Command Reference & Advanced Patterns

Read this file when generating demo scripts — it contains the full
command reference, advanced patterns, integration configs, and gotchas.

## Table of Contents

- [Command Reference](#cmux-command-reference)
- [SF Symbols for Sidebar](#sf-symbols-for-sidebar)
- [Yazi Integration](#yazi-integration)
- [Advanced Patterns](#advanced-patterns)
  - Signal-Based Agent Coordination
  - Visual Effects (flash, animated resize, swap)
  - Browser Annotations (CSS overlays, DOM highlighting, JS injection)
  - Pane Reset with respawn-pane
  - Pane Reorganization (break-pane, join-pane)
  - Multi-Window Demos
  - Event Hooks
  - Data Passing via Buffers
- [Important Notes](#important-notes)

---

## cmux Command Reference

### Discovery
```bash
cmux ping                                  # verify cmux is running
cmux identify [--no-caller]                # current workspace/surface/pane
cmux capabilities                          # list supported features
cmux find-window [--content] [--select] <query>  # search across workspaces
```

### Layout
```bash
cmux new-pane --direction right|left|up|down
cmux new-split up|down|left|right --surface <ref>
cmux new-surface --type browser --pane <ref> --url <url>
cmux close-surface --surface <ref>
cmux resize-pane --pane <ref> -L|-R|-U|-D [--amount N]
cmux swap-pane --pane <ref> --target-pane <ref>
cmux break-pane [--surface <ref>]          # pane → own workspace
cmux join-pane --target-pane <ref> [--surface <ref>]
cmux trigger-flash [--surface <ref>]       # visual attention flash
```

### Navigation
```bash
cmux select-workspace --workspace <ref>
cmux focus-pane --pane <ref>
cmux move-surface --surface <ref> --focus true
cmux reorder-workspace --workspace <ref> --index <n>
cmux reorder-surface --surface <ref> --index <n>
```

### Terminal I/O
```bash
cmux send --surface <ref> "text"           # regular characters
cmux send-key --surface <ref> Enter        # special keys only
cmux send --workspace <ref> "text"         # cross-workspace (active surface)
cmux read-screen --surface <ref>           # read terminal output
cmux respawn-pane --surface <ref> [--command <cmd>]  # restart pane
cmux pipe-pane --command <shell-cmd> --surface <ref>  # stream output
cmux set-buffer --name <name> <text>       # store data
cmux paste-buffer --name <name> --surface <ref>       # paste into pane
```

### Synchronization
```bash
cmux wait-for <name> [--timeout <seconds>] # wait for a named signal
cmux wait-for -S <name>                    # send a signal
cmux set-hook <event> <command>            # event-driven trigger
cmux set-hook --list                       # list registered hooks
cmux set-hook --unset <event>              # remove a hook
```

### Browser
```bash
cmux browser --surface <ref> navigate <url>
cmux browser --surface <ref> snapshot --compact
cmux browser --surface <ref> get url|title|text|html
cmux browser --surface <ref> click|fill|type|eval|press
cmux browser --surface <ref> highlight <selector>
cmux browser --surface <ref> addstyle <css>
cmux browser --surface <ref> addscript <script>
cmux browser --surface <ref> state save|load <path>
cmux browser --surface <ref> tab new|list|switch|close
cmux browser --surface <ref> wait [--load-state complete]
# No file:// URLs — must serve via HTTP
```

### Sidebar Metadata
```bash
cmux set-status "key" "value" --icon "sf.symbol" --color "#hex"
cmux clear-status "key"
cmux set-progress 0.5 --label "text"
cmux clear-progress
cmux log --level info --source "name" -- "message"
cmux clear-log
cmux notify --title "T" --subtitle "S" --body "B"
```

### Workspaces
```bash
cmux new-workspace [--command <text>]
cmux list-workspaces
cmux rename-workspace --workspace <ref> "name"
cmux workspace-action --workspace <ref> --action mark-unread
cmux close-workspace --workspace <ref>
cmux clear-notifications
cmux list-notifications
```

### Windows (Multi-Monitor)
```bash
cmux new-window
cmux list-windows
cmux focus-window --window <ref>
cmux close-window --window <ref>
cmux move-workspace-to-window --workspace <ref> --window <ref>
```

---

## SF Symbols for Sidebar

Good demo status icons (these are macOS SF Symbol names):

| Icon | Meaning |
|------|---------|
| `hammer.fill` | Building / setup |
| `terminal.fill` | Terminal activity |
| `folder.fill` | File browsing |
| `globe` | Web / browser |
| `person.2.fill` | Multi-agent |
| `arrow.triangle.swap` | Switching / navigation |
| `star.fill` | Complete / success |
| `play.fill` | Running / active |
| `gear` | Configuration |
| `magnifyingglass` | Search / discovery |
| `doc.text.fill` | Documentation |
| `cpu` | Processing |

---

## Yazi Integration

If yazi is available and the user wants a file browser panel, configure
the integration:

### Required config: `~/.config/yazi/yazi.toml`
```toml
[mgr]
ratio = [1, 3, 0]

[plugin]
previewers = []
preloaders = []

[opener]
preview = [
  { run = 'cmux-preview "$1"', desc = "Preview in cmux browser", for = "unix" },
]

[open]
prepend_rules = [
  { mime = "text/*", use = "preview" },
  { mime = "image/*", use = "preview" },
  { mime = "application/json", use = "preview" },
  { mime = "application/pdf", use = "preview" },
]
```

Key: use `[mgr]` not `[manager]`, and `prepend_rules` not `rules` —
wrong key names are silently ignored.

### Required script: `~/.local/bin/cmux-preview`
```bash
#!/bin/bash
set -euo pipefail
FILE="$1"
SURFACE="${CMUX_PREVIEW_SURFACE:-surface:6}"
PORT="${CMUX_PREVIEW_PORT:-8787}"
FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  python3 -m http.server "$PORT" --bind 127.0.0.1 -d / &>/dev/null &
  sleep 0.3
fi
URL="http://127.0.0.1:${PORT}${FILE}"
cmux browser --surface "$SURFACE" navigate "$URL" 2>/dev/null
```

Launch yazi with the preview surface exported:
```bash
cmux send --surface "$YAZI_SF" \
  "export CMUX_PREVIEW_SURFACE=$BROWSER_SF && yazi /path/to/files\n"
```

---

## Advanced Patterns

### Signal-Based Agent Coordination

Instead of polling `list-notifications`, use `wait-for` for clean
synchronization between the demo script and spawned agents:

```bash
# In the demo script (orchestrator):
cmux wait-for "agent-1-done" --timeout 60

# In the agent's command (runs when agent finishes):
# Hook the agent's exit to send a signal:
cmux send --workspace "$A1_WS" \
  "claude -p 'Do the task' && cmux wait-for -S agent-1-done\n"
```

`wait-for` blocks until the signal is sent — no polling, no sleep
loops, no race conditions. Use notification polling (`wait_for_completions`)
as a fallback when the agent's exit command can't be controlled.

For multi-agent coordination, chain signals:
```bash
# Spawn both agents with signal-on-complete
cmux send --workspace "$A1_WS" "task1 && cmux wait-for -S a1-done\n"
cmux send --workspace "$A2_WS" "task2 && cmux wait-for -S a2-done\n"

# Wait for both (sequentially — each blocks until signal)
cmux wait-for "a1-done" --timeout 120
cmux wait-for "a2-done" --timeout 120
```

### Visual Effects

#### Attention Flash
Flash a surface at act transitions to direct the audience's eye:
```bash
cmux trigger-flash --surface "$TERM_SF"
sleep 0.3
```

Use at the start of each act, right after `set-status`, before
sending commands. Subtle but effective for screen recordings.

**Important:** After `cmux select-workspace`, `cmux identify` still
returns the *caller's* surface, not the switched-to workspace's
active surface. To flash an agent's surface during a workspace tour,
capture the agent's surface ref at creation time:
```bash
# At creation time:
A1_SF=$(cmux list-pane-surfaces --workspace "$A1_WS" \
  | grep -oE 'surface:[0-9]+' | head -1)

# During the tour:
cmux select-workspace --workspace "$A1_WS"
cmux trigger-flash --surface "$A1_SF"  # uses captured ref
```

#### Animated Pane Resize
Grow or shrink panes smoothly to reveal content:
```bash
# Grow browser pane rightward by 20 cells in 5 steps
for i in $(seq 1 5); do
  cmux resize-pane --pane "$BROWSER_PANE" -R --amount 4
  sleep 0.08
done
```

The `animate_resize` library function wraps this pattern. Common
use: start with a small preview pane, expand it when showing results.

Directions: `-L` (left), `-R` (right), `-U` (up), `-D` (down).

#### Pane Swap
Rearrange layout without rebuilding:
```bash
cmux swap-pane --pane "$PANE_A" --target-pane "$PANE_B"
```

### Browser Annotations

Inject CSS overlays to label what the audience is seeing:

```bash
# Add a floating label
cmux browser --surface "$BROWSER_SF" addstyle \
  "body::after{content:'Live Preview';position:fixed;top:10px;right:10px;\
background:rgba(0,0,0,0.8);color:#fff;padding:8px 16px;border-radius:6px;\
font:14px/1.4 -apple-system,system-ui,sans-serif;z-index:99999;\
pointer-events:none}"
```

The `browser_annotate` library function provides a cleaner interface:
```bash
browser_annotate "$BROWSER_SF" "Step 3: Preview" "top-right"
```

Positions: `top-left`, `top-right`, `bottom-left`, `bottom-right`, `center`.

#### DOM Highlighting
Call out specific UI elements:
```bash
cmux browser --surface "$BROWSER_SF" highlight "button.primary"
```

#### Injecting Scripts
Run JavaScript in the browser for dynamic content:
```bash
cmux browser --surface "$BROWSER_SF" addscript \
  "document.title = 'Demo: Migration Complete'"
```

#### Browser State Checkpoints
Save and restore browser state between acts:
```bash
cmux browser --surface "$BROWSER_SF" state save "/tmp/demo-checkpoint-act2.json"
# ... later, to reset:
cmux browser --surface "$BROWSER_SF" state load "/tmp/demo-checkpoint-act2.json"
```

### Pane Reset with `respawn-pane`

Reset a terminal pane to a fresh state without rebuilding the layout:
```bash
cmux respawn-pane --surface "$TERM_SF" --command "echo 'Ready for Act 3'"
```

This kills the existing process and starts a new shell (or command).
Useful for "reset to act N" workflows where the layout is fine but
the terminal content needs to restart.

### Pane Reorganization Mid-Demo

Break a pane out into its own workspace (spotlight a terminal):
```bash
cmux break-pane --surface "$TERM_SF"
# Terminal is now in a new workspace tab — audience sees it full-screen
```

Join it back later:
```bash
cmux join-pane --surface "$TERM_SF" --target-pane "$MAIN_PANE"
```

### Multi-Window Demos

For multi-monitor setups or when you want separate macOS windows:

```bash
# Create a second window
WIN2=$(cmux new-window | grep -o 'window:[^ ]*' | head -1)

# Move the browser workspace to the second window
cmux move-workspace-to-window --workspace "$BROWSER_WS" --window "$WIN2"
```

Each window is a full macOS window with its own sidebar, workspaces,
and panes. Use this for:
- **Presentation mode** — slides on one screen, demo on another
- **Agent monitoring** — main work on primary, agent workspaces on secondary
- **Before/after** — original site on one screen, migrated version on another

### Event Hooks

React to events instead of sleeping:
```bash
# Run a command when a workspace is selected
cmux set-hook pane-focus-in "cmux set-status demo 'Active' --icon terminal.fill --color '#00FF88'"
```

Available hooks follow tmux conventions. Use `cmux set-hook --list`
to see currently registered hooks, and `cmux set-hook --unset <event>`
to remove them.

### Data Passing via Buffers

Pass data between panes without temp files:
```bash
# Store data
cmux set-buffer --name "result" "Migration complete: 42 pages"

# Paste into a terminal pane
cmux paste-buffer --name "result" --surface "$TERM_SF"
```

---

## Important Notes

- **Self-awareness first**: Use `cmux identify --no-caller` at
  preflight to discover the script's own surface. Never inject
  keystrokes into the surface you're running in.
- **cmux detection**: Run `cmux ping` once at preflight. If it fails,
  the script cannot run — exit with a clear message.
- **No hardcoded refs**: Surface and workspace IDs are assigned
  dynamically. Always parse them from command output.
- **send vs send-key**: `send-key` is ONLY for special keys (Enter,
  Tab). Regular characters (j, k, q, any text) must use `send`.
  Arrow key names are not recognized by `send-key`.
- **Workspace refs don't reset**: After closing workspace:2 and
  creating a new one, it might be workspace:4. Always discover via
  `list-workspaces`.
- **Browser needs HTTP**: cmux browser (WKWebView) cannot load
  `file://` URLs. Serve content via HTTP.
- **Cross-workspace send**: `cmux send --workspace <ref>` targets the
  active surface in that workspace. Adding `--surface` is optional for
  explicit targeting.
- **Prefer signals over polling**: Use `cmux wait-for` for agent
  coordination instead of polling `list-notifications`. Signals are
  instant and don't race.
- **Cleanup is essential**: Every demo script must have a `cleanup`
  subcommand AND a `trap do_cleanup EXIT` after the cleanup block.
  The trap ensures cleanup runs even if the script errors mid-way.
  Without it, a failed `cmux` call under `set -e` leaves orphaned
  surfaces, HTTP servers, and sidebar metadata behind. Also
  `set-hook --unset` any hooks you registered.
- **Sidebar can't be toggled**: Sidebar visibility is user-controlled.
  The script can only set/clear metadata entries, not show/hide the
  sidebar itself.
- **Pause for the audience**: Transitions need sleep delays so viewers
  can see what changed. Use named pause functions for consistency.
  Complement with `trigger-flash` for visual emphasis.
- **Browser annotations are additive**: `addstyle`/`addscript` inject
  into the page permanently. Use `browser navigate` to reload and
  clear them, or design CSS with unique class names you can toggle.
- **Respawn vs rebuild**: Use `respawn-pane` to reset a terminal
  without tearing down the layout. Much faster than close + recreate.
- **Multi-window cleanup**: If the demo creates extra windows, close
  them in cleanup. `cmux close-window` closes a window and all its
  workspaces.

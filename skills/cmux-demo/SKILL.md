---
name: cmux-demo
description: >
  ESSENTIAL for cmux terminal demos and scripted workflows — contains
  critical CLI patterns, gotchas, and conventions beyond `cmux help`.
  Produces a runnable bash script and markdown playbook. Covers
  multi-pane IDE layouts, browser previews, yazi integration,
  multi-agent orchestration with signal coordination, sidebar metadata,
  visual effects, multi-window setups, and pane lifecycle. ALWAYS use
  when the user mentions cmux and wants to build a demo, script a
  walkthrough, orchestrate layouts, or automate cmux workflows.
  Triggers on: "cmux demo", "terminal demo", "demo script",
  "cmux layout", "cmux orchestration", "showcase", "scripted demo",
  "demo playbook", "cmux walkthrough", "cmux presentation",
  "multi-agent cmux", "cmux script".
---

# cmux Demo

Create advanced, scripted demos that orchestrate the cmux terminal into
a multi-pane IDE-style environment — with browser previews, file
browsers, parallel agent workspaces, and rich sidebar feedback — all
driven from a single bash script.

The skill produces two artifacts:
1. **A runnable `.sh` script** — self-contained, runs without LLM pauses,
   includes cleanup
2. **A `.md` playbook** — human-readable reference with layout diagrams,
   command explanations, and gotchas

## Utility Library

A sourceable bash library is bundled at `scripts/cmux-demo-lib.sh`. It
provides reusable functions that every demo script should use. Locate it
the same way other skills in this repo locate their scripts:

```bash
CMUX_LIB="${CLAUDE_SKILL_DIR}/scripts/cmux-demo-lib.sh"
```

With fallback:
```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  CMUX_LIB="${CLAUDE_SKILL_DIR}/scripts/cmux-demo-lib.sh"
else
  CMUX_LIB="$(find ~/.claude -path "*/cmux-demo/scripts/cmux-demo-lib.sh" \
    -type f 2>/dev/null | head -1)"
fi
```

The generated demo script should **copy** the library functions it needs
inline (not source the library at runtime) so the script is fully
self-contained. Use the library as a reference for correct implementations.

### Library Functions

| Function | Purpose |
|----------|---------|
| **Basics** | |
| `cmux_log`, `cmux_warn`, `cmux_err` | Colored logging |
| `cmux_require` | Verify cmux is running |
| `parse_field <output> <prefix>` | Extract `surface:NN` / `workspace:NN` from cmux output |
| `detect_tools` | Check available panel-content tools (yazi, python3, node, claude) |
| **Self-Awareness** | |
| `cmux_identify` | Get current workspace/surface/pane context (JSON) |
| `cmux_self <field>` | Get a specific ref (e.g., `cmux_self "workspace"` → `workspace:1`) |
| **HTTP** | |
| `ensure_http_server [port] [root]` | Start HTTP server if not running |
| `kill_http_server [port]` | Kill HTTP server by port |
| **Agent Coordination** | |
| `wait_for_signal <name> [timeout]` | Wait for a named signal (preferred) |
| `send_signal <name>` | Send a signal to unblock a waiter |
| `wait_for_completions <n> [timeout]` | Poll notifications for agent completion (fallback) |
| **Visual Effects** | |
| `flash_surface <ref>` | Flash a surface to draw audience attention |
| `animate_resize <pane> <dir> <total> <steps>` | Animated pane resize (grow/shrink over N steps) |
| **Browser Annotations** | |
| `browser_annotate <surface> <text> [position]` | Inject a CSS overlay label (top-left/right, bottom-left/right, center) |
| `browser_highlight <surface> <selector>` | Highlight a DOM element |
| **Pane Lifecycle** | |
| `respawn <surface> [command]` | Restart a pane's command without rebuilding layout |
| `breakout <surface>` | Break a pane out into its own workspace |
| `join_into <surface> <target-pane>` | Join a surface into an existing pane |
| **Multi-Window** | |
| `create_window` | Create a new macOS window, return ref |
| `move_to_window <workspace> <window>` | Move workspace to a different window |
| **Workspaces** | |
| `create_workspace [name]` | Create + rename workspace, return ref |
| `demo_cleanup [port]` | Tear down all workspaces, surfaces, sidebar metadata |
| **Timing** | |
| `pause_short`, `pause_medium`, `pause_long` | Named timing pauses (configurable via env) |

## Pipeline Overview

```
User describes their demo
  1. Discover environment — cmux status, available tools, suggest installs
  2. Design the demo — acts, layout, panel content, sidebar narrative
  3. User confirms/adjusts the plan
  4. Generate the .sh script and .md playbook
  5. Test run the script
  6. Iterate based on feedback
```

## Execution

### Step 1: Discover Environment

Before designing anything, probe what's available.

First, discover the script's own context so it never accidentally
injects into user-controlled surfaces:

```bash
cmux identify --no-caller
# → workspace:1 surface:1 pane:1
```

Store `MY_SURFACE` so the script knows where it lives and avoids it
when sending commands to other panes.

Then check available tools:

```bash
source "$CMUX_LIB"
detect_tools
```

This checks for: `cmux`, `yazi`, `python3`, `node`, `npx`, `claude`.

**If a tool is missing, don't block — suggest alternatives:**

| Missing | Impact | Alternative |
|---------|--------|-------------|
| `yazi` | No file browser panel | Use `ls`/`tree` in a terminal pane, or `ranger`, `lf`, `nnn` |
| `python3` | No HTTP server for browser preview | Use `npx serve`, or `node` one-liner |
| `node`/`npx` | No fallback HTTP server | Use `python3 -m http.server` |
| `claude` | No multi-agent workspaces | Use any CLI command as agent stand-in, or skip the act |
| `yazi` config | No cmux-preview integration | Preview files via `cmux browser navigate` directly |

Present findings as a table and suggest `brew install <tool>` for
anything the user might want. Proceed with whatever is available —
the demo plan adapts to the toolset.

### Step 2: Design the Demo

Work with the user to design the demo structure. Gather:

1. **What's being demoed?** — a product, a workflow, a tool, a concept
2. **Who's the audience?** — developers, stakeholders, general
3. **What panels do they want?** — IDE layout, browser preview, file
   browser, terminals, agent workspaces
4. **How many acts?** — typically 3-7 natural segments
5. **Sidebar narrative?** — status updates, progress bar, notifications

Don't over-interview. A brief like "demo my EDS migration workflow with
yazi + browser preview, 4 acts" is enough to proceed.

#### Layout Patterns

Offer these proven layouts as starting points:

**IDE Layout** (most common):
```
+---------------------+--------------------+
|                     |  Terminal | Browser |
|   Main Claude Code  |  (tabbed pane)     |
|   (surface:1)       +--------------------+
|                     |  File Browser      |
|                     |  (yazi / ls)       |
+---------------------+--------------------+
```

**Multi-Agent Hub**:
```
+---------------------+
|   Main workspace    |  <- orchestrator
+---------------------+
| Agent 1 | Agent 2   |  <- separate workspace tabs
+---------------------+
```

**Presentation Mode**:
```
+---------------------+--------------------+
|                     |                    |
|   Terminal          |   Browser Preview  |
|   (commands)        |   (live output)    |
|                     |                    |
+---------------------+--------------------+
```

**Full Studio** (IDE + Multi-Agent):
```
+---------------------+--------------------+
|                     |  Terminal | Browser |
|   Claude Code       |  (tabbed)          |
|   (main workspace)  +--------------------+
|                     |  File Browser      |
+---------------------+--------------------+
+ Agent 1 workspace tab                    +
+ Agent 2 workspace tab                    +
```

**Multi-Window** (multi-monitor setups):
```
Window 1 (primary display)       Window 2 (secondary display)
+------------------------+       +------------------------+
|  Main Claude Code      |       |  Browser Preview       |
|  + terminal pane       |       |  (full-screen browser) |
+------------------------+       +------------------------+
```
Create with `cmux new-window`, then `cmux move-workspace-to-window`.

**Dynamic Layout** (panes resize mid-demo):
```
Act 1: Equal split           Act 2: Browser expanded
+----------+----------+      +-----+------------------+
| Terminal | Browser   |  →   | Trm | Browser (wider)  |
+----------+----------+      +-----+------------------+
```
Use `cmux resize-pane --pane <ref> -R --amount 20` to grow/shrink.
`animate_resize` in the library does this in smooth steps.

### Step 3: User Confirms

Present the demo plan as a numbered act list with:
- Act name and what happens
- Which cmux commands are used
- Panel content for each surface
- Sidebar metadata updates (icon, color, label)
- Estimated timing

Let the user adjust before generating.

### Step 4: Generate Artifacts

Generate both artifacts into the user's chosen output directory.

#### 4a. The Script (`.sh`)

The script must be **fully self-contained** — inline the utility
functions it uses from `cmux-demo-lib.sh`, don't source it at runtime.

**Required structure:**

```bash
#!/usr/bin/env bash
set -euo pipefail

# [Demo title] — scripted cmux demo
# Run:     bash demo.sh
# Cleanup: bash demo.sh cleanup

# ── Configuration ─────────────────────────────
PAUSE_SHORT=1.5
PAUSE_MEDIUM=2
PAUSE_LONG=3

# ── Utility Functions ─────────────────────────
# (inlined from cmux-demo-lib.sh)
log() { printf "\033[1;34m▸ %s\033[0m\n" "$1"; }

parse_field() {
  local output="$1" prefix="$2"
  grep -o "${prefix}:[^ ]*" <<< "$output" | head -1
}

wait_for_completions() { ... }

do_cleanup() { ... }

if [[ "${1:-}" == "cleanup" ]]; then
  do_cleanup
  exit 0
fi

# Ensure cleanup runs on any error or exit
trap do_cleanup EXIT

# ── Preflight ─────────────────────────────────
log "Preflight"
cmux ping >/dev/null 2>&1 || { echo "Error: cmux not running" >&2; exit 1; }
# ... start HTTP server if needed, kill stale processes

# ── Act 1 — [Name] ───────────────────────────
log "Act 1 — [Name]"
cmux set-status "demo" "[Label]" --icon "[sf.symbol]" --color "#hex"
# ... cmux commands with pauses

# ── Act N — [Name] ───────────────────────────
# ...

# ── Finale ────────────────────────────────────
log "Demo complete!"
cmux set-progress 1.0 --label "Demo complete!"
cmux notify --title "[Demo Name]" --subtitle "All acts complete" \
  --body "[Summary of what was shown]"

echo ""
echo "Run 'bash $0 cleanup' to tear down."
```

**Script conventions:**
- Discover own context via `cmux identify` — never assume surface:1
- Parse dynamic refs from cmux output — never hardcode surface/workspace IDs
- Use `parse_field` to extract `surface:NN`, `pane:NN`, `workspace:NN`
- Track all created resources in variables for cleanup
- Sidebar status updates at each act transition (icon + color + label)
- `trigger-flash` on the active surface at act transitions for visual emphasis
- Named pauses between visual transitions (the audience needs time to see)
- `cleanup` subcommand that tears down everything created
- Comments with act headers using `# ── Act N — Name ──` visual separators
- Use `respawn-pane` for "reset to act N" without rebuilding layout
- Add `trap do_cleanup EXIT` after the cleanup subcommand block so
  interrupted runs don't leave orphaned surfaces and servers

**Script gotchas to handle correctly:**

| Gotcha | Correct Pattern |
|--------|-----------------|
| Dynamic surface refs | `out=$(cmux new-pane --direction right); SF=$(parse_field "$out" "surface")` |
| Workspace discovery | `cmux new-workspace >/dev/null` then `cmux list-workspaces \| grep -oE 'workspace:[0-9]+' \| tail -1` |
| Cross-workspace send | `cmux send --workspace "$WS" "command\n"` (targets active surface) |
| Regular chars vs special keys | `cmux send` for chars (j, k, q); `cmux send-key` only for Enter, Tab |
| Browser tab visibility | `cmux move-surface --surface "$BROWSER_SF" --focus true` after content loads |
| Notification polling | `cmux clear-notifications` before spawning, then `wait_for_completions N` |
| HTTP server root | Root at `/` when previewing files from arbitrary paths |
| Interactive app quit | Send `q` via `cmux send` before `close-surface` (yazi, vim, etc.) |
| Attention flash | `cmux trigger-flash --surface "$SF"` at act transitions |
| Animated resize | `cmux resize-pane --pane "$PANE" -R --amount 5` in a loop for smooth grow |
| Signal coordination | Agent runs `cmux wait-for -S "done"`, orchestrator `cmux wait-for "done"` |
| Self-identification | `cmux identify --no-caller` to discover own surface/workspace/pane |
| Browser annotations | `cmux browser --surface "$SF" addstyle "css"` for overlay labels |
| DOM highlighting | `cmux browser --surface "$SF" highlight "selector"` during browser demos |
| Pane respawn | `cmux respawn-pane --surface "$SF" --command "cmd"` to reset without rebuild |
| Multi-window | `cmux new-window` + `move-workspace-to-window` for multi-monitor |
| Pane reorganization | `cmux break-pane` / `join-pane` / `swap-pane` mid-demo |
| Flash after workspace switch | `identify` returns CALLER's surface, not the switched-to workspace. Capture agent surface refs at creation time and flash those instead. |
| Trap for cleanup | `trap do_cleanup EXIT` after the cleanup subcommand block |

#### 4b. The Playbook (`.md`)

The playbook is a human-readable companion to the script. Structure:

```markdown
# [Demo Title] — cmux Demo Playbook

[1-2 sentence description of what the demo shows]

## Prerequisites
- cmux terminal app (verify: `cmux ping`)
- [tool requirements with install commands]

## Surface Reference Guide
| Role | Variable | Created in |
|------|----------|------------|
| Main pane | `surface:1` | Pre-existing |
| ... | ... | ... |

## [Act N — Name]
Sidebar status: `icon.name` / `#color` / "label"

1. [Step with cmux command in code block]
2. [Step with explanation of what happens]

**Key gotchas:**
- [Act-specific gotchas]

---

## Layout Diagram
[ASCII art showing the final panel arrangement]

## Cleanup
[Cleanup commands]

## Sidebar Commands Reference
[Quick reference for status, progress, log, notify]

## Dependencies
[Config files, scripts, or tools needed]
```

### Step 5: Test Run

After generating, run the script:

```bash
bash <script>.sh
```

Watch for errors, timing issues, or visual glitches. Common problems:
- **Surface refs mismatch** — the script hardcoded an ID instead of parsing
- **Too-fast transitions** — audience can't see what happened; increase pauses
- **Browser tab hidden** — forgot `move-surface --focus true`
- **Agent workspace not found** — workspace ref parsing failed

### Step 6: Iterate

Based on user feedback, adjust:
- **Timing** — increase/decrease pauses per act
- **Content** — change what commands run in terminal panes
- **Layout** — add/remove/reposition panes
- **Sidebar** — adjust icons, colors, labels
- **Acts** — add, remove, reorder, merge

Regenerate both artifacts after changes. The cleanup subcommand makes
re-running safe — `bash demo.sh cleanup && bash demo.sh`.

## Reference Material

Read `references/cmux-reference.md` when generating demo scripts.
It contains:

- **cmux Command Reference** — all commands grouped by category
  (discovery, layout, navigation, terminal I/O, synchronization,
  browser, sidebar, workspaces, windows)
- **SF Symbols for Sidebar** — icon names for demo status updates
- **Yazi Integration** — config files and preview script for file
  browser → browser preview integration
- **Advanced Patterns** — signal-based agent coordination, visual
  effects (flash, animated resize, swap), browser annotations (CSS
  overlays, DOM highlighting, JS injection, state checkpoints), pane
  reset with respawn-pane, pane reorganization (break/join), multi-
  window demos, event hooks, data passing via buffers
- **Important Notes** — gotchas and safety rules

## Standalone Installation

1. Copy `SKILL.md` to `~/.claude/commands/cmux-demo.md`
2. Copy `scripts/cmux-demo-lib.sh` to `~/.local/bin/cmux-demo-lib.sh`
   and `chmod +x` it
3. The library is for reference during generation — the produced demo
   scripts are self-contained and don't require it at runtime

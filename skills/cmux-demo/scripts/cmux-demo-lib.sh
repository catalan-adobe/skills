#!/usr/bin/env bash
# cmux-demo-lib.sh — Sourceable utility library for cmux demo scripts
# Source this file, don't execute it directly.
#
# Usage in generated demo scripts:
#   source "$(dirname "$0")/cmux-demo-lib.sh" 2>/dev/null \
#     || source cmux-demo-lib.sh 2>/dev/null \
#     || { echo "Error: cmux-demo-lib.sh not found" >&2; exit 1; }

set -euo pipefail

# ── Logging ──────────────────────────────────────────────

cmux_log() { printf "\033[1;34m▸ %s\033[0m\n" "$1"; }
cmux_warn() { printf "\033[1;33m⚠ %s\033[0m\n" "$1"; }
cmux_err() { printf "\033[1;31m✗ %s\033[0m\n" "$1" >&2; }

# ── Preflight ────────────────────────────────────────────

# Verify cmux is available and responding.
cmux_require() {
  if ! cmux ping >/dev/null 2>&1; then
    cmux_err "cmux not running. This script must run inside a cmux terminal."
    return 1
  fi
}

# ── Output Parsing ───────────────────────────────────────

# Extract a typed ref from cmux command output.
# Usage: parse_field "OK surface:83 workspace:1" "surface"
#   => "surface:83"
parse_field() {
  local output="$1" prefix="$2"
  grep -o "${prefix}:[^ ]*" <<< "$output" | head -1
}

# ── Tool Discovery ───────────────────────────────────────

# Check which panel-content tools are available.
# Prints a JSON-like status summary to stdout.
# Returns 0 if cmux itself is available, 1 otherwise.
detect_tools() {
  local tools=()

  # Core (required)
  if cmux ping >/dev/null 2>&1; then
    tools+=("cmux:yes")
  else
    tools+=("cmux:no")
    printf '%s\n' "${tools[@]}"
    return 1
  fi

  # File browser
  if command -v yazi >/dev/null 2>&1; then
    tools+=("yazi:yes")
  else
    tools+=("yazi:no")
  fi

  # HTTP server candidates (for browser preview)
  if command -v python3 >/dev/null 2>&1; then
    tools+=("python3:yes")
  else
    tools+=("python3:no")
  fi
  if command -v node >/dev/null 2>&1; then
    tools+=("node:yes")
  else
    tools+=("node:no")
  fi
  if command -v npx >/dev/null 2>&1; then
    tools+=("npx:yes")
  else
    tools+=("npx:no")
  fi

  # Claude CLI (for multi-agent)
  if command -v claude >/dev/null 2>&1; then
    tools+=("claude:yes")
  else
    tools+=("claude:no")
  fi

  printf '%s\n' "${tools[@]}"
  return 0
}

# ── HTTP Server ──────────────────────────────────────────

# Start an HTTP server rooted at a given directory if not already running.
# Usage: ensure_http_server [port] [root_dir]
ensure_http_server() {
  local port="${1:-8787}"
  local root="${2:-/}"

  if lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 -m http.server "$port" --bind 127.0.0.1 -d "$root" &>/dev/null &
  elif command -v npx >/dev/null 2>&1; then
    npx -y serve -l "$port" -n "$root" &>/dev/null &
  else
    cmux_err "No HTTP server available. Install python3 or node."
    return 1
  fi
  sleep 0.5
}

# Kill the HTTP server on a given port.
kill_http_server() {
  local port="${1:-8787}"
  lsof -ti :"$port" | xargs kill 2>/dev/null || true
}

# ── Self-Awareness ───────────────────────────────────────

# Get the current workspace/surface/pane context.
# Usage: my_ctx=$(cmux_identify)
# Returns JSON with workspace, surface, pane refs.
cmux_identify() {
  cmux identify --no-caller 2>/dev/null
}

# Get a specific field from identify output.
# Usage: my_ws=$(cmux_self "workspace")
cmux_self() {
  local field="$1"
  cmux identify --no-caller 2>/dev/null | grep -o "${field}:[^ ]*" | head -1
}

# ── Agent Coordination ───────────────────────────────────

# Signal-based synchronization (preferred over polling).
# Agent sends: cmux wait-for -S "agent-1-done"
# Orchestrator waits: wait_for_signal "agent-1-done" 60
wait_for_signal() {
  local signal_name="$1"
  local timeout="${2:-120}"
  cmux wait-for "$signal_name" --timeout "$timeout" 2>/dev/null
}

# Send a signal that a waiting process can receive.
# Usage: send_signal "agent-1-done"
send_signal() {
  local signal_name="$1"
  cmux wait-for -S "$signal_name" 2>/dev/null
}

# Wait for N "Completed" notifications from Claude sessions.
# Fallback for when signal-based coordination isn't possible.
# Relies on cmux notifications created by claude hooks on session end.
# Call `cmux clear-notifications` BEFORE spawning agents.
# Usage: wait_for_completions <expected_count> [timeout_seconds]
wait_for_completions() {
  local expected="$1"
  local timeout="${2:-120}"
  local elapsed=0

  while (( elapsed < timeout )); do
    local count
    set +e
    count=$(cmux list-notifications 2>/dev/null | grep -c "Completed")
    set -e
    if (( count >= expected )); then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  cmux_warn "Timed out after ${timeout}s waiting for $expected agent completions (got $count)"
  return 1
}

# ── Workspace Helpers ────────────────────────────────────

# Create a new workspace and return its ref (workspace:NN).
# cmux new-workspace returns a UUID, not a ref — this discovers the ref.
# Usage: ws_ref=$(create_workspace "Agent 1: Poet")
create_workspace() {
  local name="${1:-}"
  cmux new-workspace >/dev/null

  local ws
  ws=$(cmux list-workspaces | grep -oE 'workspace:[0-9]+' \
    | grep -v 'workspace:1$' | tail -1)

  if [[ -n "$name" && -n "$ws" ]]; then
    cmux rename-workspace --workspace "$ws" "$name"
  fi
  echo "$ws"
}

# ── Visual Effects ───────────────────────────────────────

# Flash a surface to draw audience attention.
# Usage: flash_surface "$TERM_SF"
flash_surface() {
  local surface="$1"
  cmux trigger-flash --surface "$surface" 2>/dev/null || true
}

# Animate a pane resize over multiple steps.
# Usage: animate_resize "$PANE" "R" 20 5
#   Grows pane right by 20 cells in 5 steps.
animate_resize() {
  local pane="$1" direction="$2" total="${3:-20}" steps="${4:-5}"
  local per_step=$((total / steps))
  local i=0
  while (( i < steps )); do
    cmux resize-pane --pane "$pane" "-${direction}" --amount "$per_step" 2>/dev/null || true
    sleep 0.1
    i=$((i + 1))
  done
}

# ── Browser Annotations ─────────────────────────────────

# Inject a CSS overlay label into a browser surface.
# Usage: browser_annotate "$BROWSER_SF" "Step 3: Preview" "top-right"
browser_annotate() {
  local surface="$1" text="$2" position="${3:-top-right}"
  local css_pos=""
  case "$position" in
    top-left)     css_pos="top:10px;left:10px" ;;
    top-right)    css_pos="top:10px;right:10px" ;;
    bottom-left)  css_pos="bottom:10px;left:10px" ;;
    bottom-right) css_pos="bottom:10px;right:10px" ;;
    center)       css_pos="top:50%;left:50%;transform:translate(-50%,-50%)" ;;
  esac
  local safe_text
  safe_text=$(printf '%s' "$text" | sed "s/'/\\\\'/g")
  cmux browser --surface "$surface" addstyle \
    "body::after{content:'${safe_text}';position:fixed;${css_pos};background:rgba(0,0,0,0.8);color:#fff;padding:8px 16px;border-radius:6px;font:14px/1.4 -apple-system,system-ui,sans-serif;z-index:99999;pointer-events:none}" \
    2>/dev/null || true
}

# Highlight a DOM element in a browser surface.
# Usage: browser_highlight "$BROWSER_SF" "button.primary"
browser_highlight() {
  local surface="$1" selector="$2"
  cmux browser --surface "$surface" highlight "$selector" 2>/dev/null || true
}

# ── Pane Lifecycle ───────────────────────────────────────

# Restart a pane's command without rebuilding layout.
# Usage: respawn "$TERM_SF" "echo 'Reset!'"
respawn() {
  local surface="$1" command="${2:-}"
  if [[ -n "$command" ]]; then
    cmux respawn-pane --surface "$surface" --command "$command" 2>/dev/null || true
  else
    cmux respawn-pane --surface "$surface" 2>/dev/null || true
  fi
}

# Break a pane out into its own workspace.
# Usage: breakout "$SURFACE"
breakout() {
  local surface="$1"
  cmux break-pane --surface "$surface" 2>/dev/null || true
}

# Join a surface into a target pane.
# Usage: join_into "$SURFACE" "$TARGET_PANE"
join_into() {
  local surface="$1" target_pane="$2"
  cmux join-pane --surface "$surface" --target-pane "$target_pane" 2>/dev/null || true
}

# ── Multi-Window ─────────────────────────────────────────

# Create a new macOS window and return its ref.
# Usage: win_ref=$(create_window)
create_window() {
  local out
  out=$(cmux new-window 2>/dev/null)
  parse_field "$out" "window"
}

# Move a workspace to a different window (multi-monitor setups).
# Usage: move_to_window "$WS" "$WIN"
move_to_window() {
  local workspace="$1" window="$2"
  cmux move-workspace-to-window --workspace "$workspace" --window "$window" 2>/dev/null || true
}

# ── Cleanup ──────────────────────────────────────────────

# Tear down all non-primary workspaces and extra surfaces.
# Usage: demo_cleanup [http_port]
demo_cleanup() {
  local http_port="${1:-8787}"

  # Close agent workspaces
  local ws
  for ws in $(cmux list-workspaces 2>/dev/null \
    | grep -oE 'workspace:[0-9]+' | grep -v 'workspace:1$'); do
    cmux close-workspace --workspace "$ws" 2>/dev/null || true
  done

  # Quit interactive apps and close extra surfaces
  local sf
  for sf in $(cmux list-panels 2>/dev/null \
    | grep -oE 'surface:[0-9]+' | sort -t: -k2 -n | tail -n +2); do
    cmux send --surface "$sf" "q" 2>/dev/null || true
    sleep 0.2
    cmux close-surface --surface "$sf" 2>/dev/null || true
  done

  # Clear sidebar metadata
  cmux clear-status "demo" 2>/dev/null || true
  cmux clear-progress 2>/dev/null || true
  cmux clear-log 2>/dev/null || true

  # Restore focus
  cmux select-workspace --workspace workspace:1 2>/dev/null || true
  cmux focus-pane --pane pane:1 2>/dev/null || true

  # Kill HTTP server
  kill_http_server "$http_port"
}

# ── Timing / Pauses ──────────────────────────────────────

# Named pauses for demo pacing. Override via environment variables.
PAUSE_SHORT="${CMUX_DEMO_PAUSE_SHORT:-1.5}"
PAUSE_MEDIUM="${CMUX_DEMO_PAUSE_MEDIUM:-2}"
PAUSE_LONG="${CMUX_DEMO_PAUSE_LONG:-3}"

pause_short() { sleep "$PAUSE_SHORT"; }
pause_medium() { sleep "$PAUSE_MEDIUM"; }
pause_long() { sleep "$PAUSE_LONG"; }

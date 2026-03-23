---
name: screencast
description: >
  Record your screen to video from Claude Code. Guided capture setup:
  pick a display, window, or screen region, then start/stop recording
  on demand. Uses ffmpeg — cross-platform (macOS, Linux, Windows).
  Produces MP4 with sensible defaults. Pairs with demo-narrate for
  voice-over. Triggers on: screencast, record screen, screen recording,
  capture screen, record window, record region, start recording,
  screen capture video.
---

# Screencast

Record your screen to an MP4 video. Guided setup to pick what to
record (full screen, specific window, or custom region), then
start/stop recording on demand.

## Prerequisites

- ffmpeg (required)

## Script

All recording logic goes through the helper script bundled with
this skill at `scripts/screencast.js`.

**Locating the script:**

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  SCREENCAST_JS="${CLAUDE_SKILL_DIR}/scripts/screencast.js"
else
  SCREENCAST_JS="$(command -v screencast.js 2>/dev/null || \
    find ~/.claude -path "*/screencast/scripts/screencast.js" -type f 2>/dev/null | head -1)"
fi
if [[ -z "$SCREENCAST_JS" || ! -f "$SCREENCAST_JS" ]]; then
  echo "Error: screencast.js not found. Ask the user for the path." >&2
fi
```

Store in `SCREENCAST_JS` and use for all commands below.

## Commands

```bash
node "$SCREENCAST_JS" deps                                  # Check ffmpeg + platform
node "$SCREENCAST_JS" list-screens                          # List available displays
node "$SCREENCAST_JS" list-windows                          # List open windows with geometry
node "$SCREENCAST_JS" start [flags]                         # Start recording
node "$SCREENCAST_JS" stop                                  # Stop recording
node "$SCREENCAST_JS" status                                # Check if recording
node "$SCREENCAST_JS" pick-window                          # macOS: click to select a window
node "$SCREENCAST_JS" pick-region                          # macOS: drag to select a region
```

Start flags:
- `--screen <index>` — display to record (default: 0 = main)
- `--region <x,y,w,h>` — crop to a specific rectangle
- `--window <id>` — record a specific window (resolves geometry)
- `--fps <N>` — frame rate (default: 30)
- `--output <path>` — output file (default: `screencast_<timestamp>.mp4`)

All commands return JSON output.

## Platform Features (macOS only)

On macOS, two additional commands provide interactive selection:

- `pick-window` — Click on any window to select it. Shows a blue
  highlight on hover. Returns JSON with `{id, app, title, x, y, w, h}`.
- `pick-region` — Drag a rectangle on screen to select a capture
  area. Shows dimensions while dragging. Returns JSON with `{x, y, w, h}`.

Both require Xcode Command Line Tools (`xcode-select --install`).
The Swift helper compiles on first use (~1s) and is cached at
`~/.cache/screencast/screencast-picker` for subsequent runs.

Press Escape to cancel either picker. Returns `{cancelled: true}`.

## Workflow

### Step 1: Check Dependencies

```bash
node "$SCREENCAST_JS" deps
```

If ffmpeg is missing, tell the user:

- macOS: `brew install ffmpeg`
- Linux: `sudo apt install ffmpeg`
- Windows: `winget install ffmpeg` or download from ffmpeg.org

### Step 2: Choose What to Record

Check platform from the `deps` output.

**On macOS**, offer interactive selection (pick-window or pick-region) first.

If the user chooses interactive:
```bash
node "$SCREENCAST_JS" pick-window
# or
node "$SCREENCAST_JS" pick-region
```

Use the returned `id` with `--window`, or `x,y,w,h` with `--region`.
If the picker returns `{cancelled: true}`, ask what they'd like to do instead.

**On all platforms** (or if the user prefers manual selection):

Ask the user what they want to record. Three options:

**Full screen (default):**
```bash
node "$SCREENCAST_JS" list-screens
```
Present the list. If only one screen, use it automatically.
Note the screen dimensions for reference.

**Specific window:**
```bash
node "$SCREENCAST_JS" list-windows
```
Present a numbered list showing app name, window title, and
dimensions. The user picks by number. Use the window's `id`
field with the `--window` flag.

**Custom region:**
The user provides coordinates as `x,y,width,height`. Offer the
screen dimensions as reference: "Your main display is 2560x1440.
Top-left is 0,0."

### Step 3: Confirm and Start

Confirm the target, FPS, and output path before starting.

When the user says start:

```bash
node "$SCREENCAST_JS" start --window <id> --output <path>
# or: start --region <x,y,w,h> --output <path>
# or: start --screen <index> --output <path>
```

Confirm recording is active. The conversation continues normally
while recording runs in the background.

### Step 4: Stop Recording

When the user says "stop" or "stop recording":

```bash
node "$SCREENCAST_JS" stop
```

Report: file path, duration, and file size.

### Edge Cases

- If the user starts a new conversation topic without stopping,
  check `status` and remind them recording is still active.
- If `start` reports a recording is already in progress, inform
  the user and offer to stop the existing one first.
- If `stop` finds a dead process, report it and note whether a
  partial file exists.

## Tips

- Pairs with `demo-narrate` — record a silent screencast, then
  use demo-narrate to add AI-generated voice-over.
- Window recording on macOS accounts for Retina scaling
  automatically — coordinates are converted to physical pixels.
- The recording process survives if Claude Code exits. Start a
  new session and run `stop` to end it.
- Output uses H.264 with `ultrafast` preset — optimized for low
  CPU during recording, not minimal file size.
- **macOS permission:** Screen recording requires the terminal app
  to be added to System Settings > Privacy & Security > Screen &
  System Audio Recording. If ffmpeg starts but produces no file,
  this is the likely cause. Grant the permission and retry.

## Standalone Installation

1. Copy `SKILL.md` to `~/.claude/commands/screencast.md`
2. Copy `scripts/screencast.js` to `~/.local/bin/screencast.js`
   and `chmod +x` it
3. The fallback search will find it via `command -v screencast.js`

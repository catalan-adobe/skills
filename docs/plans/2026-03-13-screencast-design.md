# Screencast Skill Design

Guided screen recording from Claude Code using ffmpeg.

## Problem

The skills repo covers video post-production (`demo-narrate`) and
consumption (`video-digest`), but nothing handles capture. Users
must manually invoke ffmpeg or use GUI tools to record their screen
before feeding it into the pipeline.

## Solution

A `screencast` skill that guides the user through target selection
(screen, window, or region) and manages a background ffmpeg recording
with start/stop control.

## Structure

```
skills/screencast/
  SKILL.md                # Prompt — orchestrates the guided workflow
  scripts/screencast.js   # Node.js, zero npm deps, all ffmpeg + platform logic
```

## Shell Script (`screencast.js`)

Node.js (not bash) for true cross-platform support, matching the
precedent set by `cdp-connect/cdp.js`. Zero npm dependencies — uses
only Node 22 built-in modules (`child_process`, `fs`, `path`, `os`).

### Subcommands

| Subcommand | Output | Purpose |
|------------|--------|---------|
| `deps` | JSON `{ffmpeg, platform, backend}` | Preflight check |
| `list-windows` | JSON array `[{id, app, title, x, y, w, h}]` | Window discovery |
| `list-screens` | JSON array `[{index, name, width, height}]` | Display discovery |
| `start [flags]` | JSON `{pid, output, target}` | Begin recording |
| `stop` | JSON `{output, duration, size}` | Stop recording |
| `status` | JSON `{recording, pid, elapsed, output}` | Check state |

### Start flags

- `--screen <index>` — which display (default: main)
- `--region <x,y,w,h>` — crop to region
- `--window <id>` — resolve window geometry, record that region
- `--fps <N>` — frame rate (default: 30)
- `--output <path>` — output file (default: `screencast_<timestamp>.mp4`)

## Recording Flow (SKILL.md Orchestration)

Three-phase interaction: discover, configure, record.

### Phase 1: Discover

Run `screencast.js deps`. Report platform, ffmpeg version, available
backend. If ffmpeg is missing, offer install command.

### Phase 2: Configure

Claude asks what to record:

- **Full screen:** `list-screens`, user picks one (or default to main)
- **Window:** `list-windows`, present numbered list, user picks one.
  Script resolves geometry internally.
- **Region:** User provides `x,y,w,h` directly. Claude helps with
  display dimensions for reference.

Claude confirms selection before starting:
> "Ready to record [target] at 30fps to `filename.mp4`. Say start
> when ready, stop when done."

### Phase 3: Record

`start` spawns ffmpeg as a detached background process. Claude
confirms recording is active. Conversation continues normally.

When user says "stop", `stop` sends SIGINT to ffmpeg for graceful
shutdown, reports file path, duration, and size.

## ffmpeg Command Construction

### macOS (avfoundation)

```bash
# Full screen
ffmpeg -f avfoundation -framerate 30 -capture_cursor 1 -i "1:none" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 23 output.mp4

# Region (crop after full-screen capture)
ffmpeg -f avfoundation -framerate 30 -capture_cursor 1 -i "1:none" \
  -vf "crop=W:H:X:Y" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 23 output.mp4
```

Retina/HiDPI: AVFoundation captures at physical pixel resolution.
Window geometry from the OS is in logical points. The script
multiplies coordinates by the screen scale factor.

### Linux (x11grab)

```bash
# Full screen
ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -i :0.0 \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 23 output.mp4

# Region (native offset)
ffmpeg -f x11grab -framerate 30 -video_size WxH -i :0.0+X,Y \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 23 output.mp4
```

Wayland not supported in v1 (known limitation).

### Windows (gdigrab)

```bash
# Full screen
ffmpeg -f gdigrab -framerate 30 -i desktop \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 23 output.mp4

# Region
ffmpeg -f gdigrab -framerate 30 -offset_x X -offset_y Y \
  -video_size WxH -i desktop \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 23 output.mp4

# Window (native)
ffmpeg -f gdigrab -framerate 30 -i title="Window Title" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 23 output.mp4
```

### Common output settings

| Setting | Value | Rationale |
|---------|-------|-----------|
| Codec | libx264 | Universal playback |
| Pixel format | yuv420p | Browser/QuickTime compatibility |
| Preset | ultrafast | Minimize CPU during live capture |
| CRF | 23 | Good quality, reasonable file size |
| FPS | 30 | Smooth for UI demos |
| Audio | none | Narration added separately via demo-narrate |

## Window Discovery

Per-platform window enumeration, all returned as JSON arrays:

- **macOS:** JXA (`osascript -l JavaScript`) using
  `CGWindowListCopyWindowInfo` for window ID, owner, title, bounds
- **Linux:** `xdotool search --name ""` + `xdotool getwindowgeometry`
  or `wmctrl -lG`
- **Windows:** PowerShell `Get-Process` with `MainWindowHandle`,
  window rect via .NET `GetWindowRect`

## PID Management & Process Lifecycle

### State file

Single well-known path: `~/.screencast.state`

```json
{
  "pid": 12345,
  "output": "/path/to/screencast_20260313_142055.mp4",
  "startedAt": "2026-03-13T14:20:55Z",
  "target": {"mode": "window", "app": "Terminal", "geometry": [100, 200, 1200, 800]},
  "platform": "darwin"
}
```

### Start

1. Check state file exists and PID alive -> refuse
2. Build ffmpeg command per platform
3. Spawn ffmpeg detached (`child_process.spawn`, `detached: true`,
   stdio to log file)
4. Write state file
5. Return `{pid, output}`

### Stop

1. Read state file, get PID
2. Verify PID alive (`process.kill(pid, 0)`)
3. Send SIGINT (Unix) or `taskkill` (Windows)
4. Wait for exit (poll, max 5s)
5. Escalate to SIGTERM if needed
6. Delete state file
7. Run `ffprobe` for duration, `fs.statSync` for size
8. Return `{output, duration, size}`

### Status

1. State file exists + PID alive: `{recording: true, ...}`
2. State file exists + PID dead: stale, clean up, `{recording: false, stale: true}`
3. No state file: `{recording: false}`

### Resilience

- ffmpeg runs detached: survives Claude Code session death
- State file persists: new session can `stop` a recording started
  in a previous session
- `status` auto-cleans stale state files
- Single recording at a time (start refuses if active)

## Scope Boundaries

**In scope (v1):**
- Full screen, window, and region recording
- macOS (avfoundation), Linux (x11grab), Windows (gdigrab)
- Start/stop with background process management
- Window and screen listing with JSON output
- MP4 output with sensible defaults

**Out of scope (v1):**
- Audio capture (use `demo-narrate` for voice-over)
- Multiple simultaneous recordings
- Wayland support
- Quality presets / `--quality` flag
- GIF output
- Webcam overlay

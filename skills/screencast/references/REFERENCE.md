# Screencast Reference

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

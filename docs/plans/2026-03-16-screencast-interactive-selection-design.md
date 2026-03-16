# Screencast Interactive Selection — Design Spec

## Summary

Add interactive window and region selection to the screencast skill on macOS. Two new subcommands — `pick-window` (click to select) and `pick-region` (drag to select) — provide a native macOS selection UX similar to Cmd+Shift+4. These are macOS-only features; other platforms continue using the existing list-based workflow.

## Motivation

The current workflow requires users to read a numbered window list or type pixel coordinates manually. Interactive selection is faster, more intuitive, and matches the macOS experience users already know.

## Architecture

```
screencast.js  ──compile if needed──>  screencast-picker (binary)
               ──invoke──>            --mode window | region
               <──JSON on stdout──    {id, app, title, x, y, w, h}
```

### Components

1. **`screencast-picker.swift`** — Single Swift source file in `skills/screencast/scripts/`. Compiled on first use via `swiftc`, binary cached at `~/.cache/screencast/screencast-picker`. Recompiles when source mtime is newer than binary.

2. **`screencast.js` additions** — Two new subcommands (`pick-window`, `pick-region`) that handle compilation, invoke the picker, and return JSON. A shared `compilePicker()` function manages the build step.

3. **`SKILL.md` updates** — Platform Features section, updated workflow offering interactive selection on macOS.

## Swift Picker Design

### Shared Behavior (both modes)

- Creates a borderless, transparent, fullscreen `NSWindow` covering the primary display at level `.screenSaver` (1000) — high enough to sit above app windows and floating panels, but below system-critical UI like force-quit dialogs
- Requires an `NSWindow` subclass that overrides `canBecomeKey` to return `true` — borderless windows return `false` by default, which silently drops keyboard events
- Registers an `NSTrackingArea` with `.mouseMoved` and `.activeAlways` on the content view to receive mouse move events (not delivered by default)
- Sets cursor to crosshair (`NSCursor.crosshair`)
- Escape key cancels: exits with code 1, no stdout output
- Click/release outputs JSON to stdout, exits with code 0
- No menu bar, no dock icon (`NSApplication.setActivationPolicy(.accessory)`)
- 60-second inactivity timeout — if no click/drag/escape within 60s, the picker exits with code 2 and `screencast.js` outputs `{error: "Picker timed out"}`

### Window Mode (`--mode window`)

1. On mouse move: query `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)` for all on-screen windows, excluding the overlay's own window
2. Hit-test the mouse position against window bounds to find the topmost window under the cursor
3. Draw a blue-tinted highlight rectangle (rounded corners, ~0.15 opacity fill, 2px border) over the matched window's bounds
4. On click: output JSON with `{id, app, title, x, y, w, h}` for the highlighted window
5. If no window is under the cursor (e.g., desktop), do nothing on click

### Region Mode (`--mode region`)

1. Overlay fills the screen with a dark semi-transparent backdrop (~0.2 opacity black)
2. On mouse down: record start point
3. On mouse drag: clear the selected rectangle from the dark overlay (user sees actual screen content through the cutout), draw a 1px white border around it, show a floating label with `W x H` dimensions (in screen points)
4. On mouse release: output JSON with `{x, y, w, h}` in screen points
5. Minimum drag threshold of 10px — clicks without drag are ignored (prevents accidental zero-size selections)

### Coordinate Space

macOS uses two coordinate systems that the picker must bridge:

- **CoreGraphics (CG)**: Origin at top-left of primary display. Used by `CGWindowListCopyWindowInfo` for window bounds.
- **AppKit**: Origin at bottom-left of primary display. Used by `NSWindow`/`NSView` for drawing.

The picker must convert CG Y-coordinates to AppKit for overlay drawing:
```
appkitY = primaryScreenHeight - cgY - windowHeight
```

**Output coordinates** are in CG screen points (top-left origin) — this matches what ffmpeg and the existing `screencast.js` expect. All values are integers (CG returns `CGFloat`, picker truncates via `Int()`).

**Multi-monitor**: v1 covers the primary display only. The overlay spans `NSScreen.main` and ignores windows on secondary displays. This is documented as a known limitation.

`screencast.js` already handles Retina scaling by multiplying by the display's scale factor in `resolveWindowGeometry()`. The same scaling applies to picker output.

## screencast.js Changes

### `compilePicker()`

```
function compilePicker():
  sourceFile = path to screencast-picker.swift (via SKILL_DIR or fallback search)
  cacheDir = ~/.cache/screencast/
  binaryPath = cacheDir/screencast-picker

  if binaryPath exists AND binaryPath.mtime >= sourceFile.mtime:
    return binaryPath

  create cacheDir if needed
  run: xcrun swiftc -O -o binaryPath sourceFile -framework AppKit -framework CoreGraphics
  if swiftc fails: throw with error message
  return binaryPath
```

### `cmdPickWindow()`

- macOS-only gate: if platform !== 'darwin', output `{error: "..."}`, exit 1
- Call `compilePicker()`
- Spawn binary with `--mode window`
- On exit 0: parse and output JSON
- On exit 1: output `{cancelled: true}`
- On compilation or runtime error: output `{error: "..."}` with actionable message

### `cmdPickRegion()`

- Same structure as `cmdPickWindow()` but with `--mode region`
- Output: `{x, y, w, h}` (no window id/app/title fields)

### Command Registration

Add to the switch in `main()`:
- `pick-window` -> `cmdPickWindow()`
- `pick-region` -> `cmdPickRegion()`

Update the usage/help text to include both commands with "(macOS only)" annotation.

## SKILL.md Changes

### New Section: Platform Features

Add after the Commands section:

```markdown
## Platform Features (macOS only)

On macOS, two additional commands provide interactive selection:

- `pick-window` — Click on any window to select it. Shows a blue
  highlight on hover.
- `pick-region` — Drag a rectangle on screen to select a capture
  area. Shows dimensions while dragging.

Both require Xcode Command Line Tools (`xcode-select --install`).
The Swift helper compiles on first use (~1s) and is cached for
subsequent runs.
```

### Updated Workflow (Step 2)

On macOS, the workflow should check platform and offer interactive selection first:

```
Check platform (from deps output).
If macOS:
  "You're on macOS — I can let you click on a window or drag a region
   to select what to record. Or you can pick from a list / type
   coordinates. Which do you prefer?"

  If user chooses interactive window: run pick-window, use returned id
  If user chooses interactive region: run pick-region, use returned coords
  If user chooses list/manual: fall through to existing flow

If not macOS:
  existing list-based flow (unchanged)
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Not macOS | `{error: "Interactive selection is only available on macOS"}`, exit 1 |
| `xcrun swiftc` not found | `{error: "Xcode Command Line Tools required. Run: xcode-select --install"}`, exit 1 |
| Compilation fails | `{error: "Failed to compile picker: <swiftc stderr>"}`, exit 1 |
| User presses Escape | Exit 1, no stdout. `screencast.js` outputs `{cancelled: true}` |
| Picker timeout (60s) | Exit 2. `screencast.js` outputs `{error: "Picker timed out"}` |
| Screen recording permission denied | `CGWindowListCopyWindowInfo` returns entries with redacted metadata (null titles, zeroed bounds) rather than an empty list. Detect by checking if all returned windows have zero-size bounds — if so, output `{error: "Screen recording permission required. Check System Settings > Privacy & Security > Screen & System Audio Recording."}` |

## Files Changed

| File | Change |
|------|--------|
| `skills/screencast/scripts/screencast-picker.swift` | New — Swift picker source |
| `skills/screencast/scripts/screencast.js` | Add `compilePicker()`, `cmdPickWindow()`, `cmdPickRegion()` |
| `skills/screencast/SKILL.md` | Platform Features section, updated workflow |

## Known Limitations (v1)

- **Primary display only** — picker overlay covers `NSScreen.main`. Windows on secondary monitors are not selectable. Multi-monitor support is a future enhancement.
- **Sync script copies `.swift` source** — `scripts/sync-skills.sh` copies all files from `skills/<name>/scripts/` to `~/.local/bin/`. The `.swift` source file will be copied there too. This is benign (not executable without `swiftc`) and not worth adding a glob filter for one file.

## Out of Scope

- Background window capture (ScreenCaptureKit) — separate future enhancement
- Multi-monitor support — secondary display selection
- Linux/Windows interactive selection — no equivalent native UI without heavy deps
- Audio capture during selection

# screencast Skill

## macOS AppKit Gotchas (picker overlay)

- `NSCursor.set()` is a momentary override — AppKit resets the cursor on every mouse move via its cursor rect machinery. Use `resetCursorRects()` for persistent per-view cursors.
- `CGWindowListCopyWindowInfo` returns entries with redacted metadata (null titles, zeroed bounds) when Screen Recording permission is denied — not an empty list. Detect by counting layer-0 windows vs usable windows.
- CG coordinates (origin top-left) vs AppKit coordinates (origin bottom-left): `appkitY = screenHeight - cgY - height`. Output CG for ffmpeg compatibility.
- Borderless `NSWindow` returns `false` from `canBecomeKey` — must subclass and override, or keyboard events (Escape) are silently dropped.

## Swift Compile-on-First-Use Pattern

- Use `xcrun swiftc` (not bare `swiftc`) — handles partial Xcode installs where CLT path differs
- Cache compiled binary at `~/.cache/screencast/`, recompile when source mtime > binary mtime
- Reserve distinct exit codes for the parent process: 0=success, 1=cancel, 2=timeout, 3=permission denied, 4=usage error
- The `.swift` source ships in `skills/screencast/scripts/` and gets copied to `~/.local/bin/` by sync script (benign — not executable without swiftc)

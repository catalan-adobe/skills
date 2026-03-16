# Screencast Interactive Selection — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add macOS-only `pick-window` and `pick-region` subcommands to the screencast skill using a compiled Swift overlay helper.

**Architecture:** A Swift source file compiles on first use into a cached binary. Two new `screencast.js` subcommands invoke it and map exit codes to JSON. SKILL.md gets a Platform Features section and an updated workflow for macOS.

**Tech Stack:** Swift (AppKit, CoreGraphics), Node.js (existing screencast.js), `node:test` for testing.

**Spec:** `docs/plans/2026-03-16-screencast-interactive-selection-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `skills/screencast/scripts/screencast-picker.swift` | Create | Swift overlay: window highlight + region drag |
| `skills/screencast/scripts/screencast.js` | Modify | `compilePicker()`, `cmdPickWindow()`, `cmdPickRegion()`, updated help |
| `skills/screencast/SKILL.md` | Modify | Platform Features section, updated workflow |
| `tests/screencast/screencast.test.js` | Modify | Tests for `compilePicker()` |

---

## Task 1: Swift Picker Source

**Files:**
- Create: `skills/screencast/scripts/screencast-picker.swift`

This file is not testable with `node:test`. Verified by compilation in Task 3 and manual testing in Task 5.

- [ ] **Step 1: Create the Swift picker**

```swift
import AppKit
import CoreGraphics

// MARK: - Entry Point

let args = CommandLine.arguments
guard args.count >= 3, args[1] == "--mode" else {
    fputs("Usage: screencast-picker --mode window|region\n", stderr)
    exit(1)
}
let mode = args[2]
guard mode == "window" || mode == "region" else {
    fputs("Invalid mode: \(mode). Use 'window' or 'region'.\n", stderr)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// MARK: - KeyableWindow (borderless windows drop keyboard events without this)

class KeyableWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

// MARK: - Coordinate Helpers
// CG: origin top-left. AppKit: origin bottom-left.

func cgToAppKit(cgY: CGFloat, height: CGFloat, screenHeight: CGFloat) -> CGFloat {
    screenHeight - cgY - height
}

func appKitToCG(appKitY: CGFloat, height: CGFloat, screenHeight: CGFloat) -> CGFloat {
    screenHeight - appKitY - height
}

// MARK: - Window Info

struct WindowInfo {
    let id: Int
    let app: String
    let title: String
    let bounds: CGRect
}

func getOnScreenWindows(excludingPID pid: pid_t) -> [WindowInfo] {
    guard let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else { return [] }

    var windows: [WindowInfo] = []
    var totalLayer0 = 0
    for info in list {
        guard let layer = info[kCGWindowLayer as String] as? Int,
              layer == 0 else { continue }
        totalLayer0 += 1
        guard let ownerPID = info[kCGWindowOwnerPID as String] as? Int,
              pid_t(ownerPID) != pid else { continue }
        guard let ownerName = info[kCGWindowOwnerName as String] as? String
        else { continue }
        guard let boundsDict = info[kCGWindowBounds as String] as? [String: Any]
        else { continue }
        let bounds = CGRect(
            x: boundsDict["X"] as? CGFloat ?? 0,
            y: boundsDict["Y"] as? CGFloat ?? 0,
            width: boundsDict["Width"] as? CGFloat ?? 0,
            height: boundsDict["Height"] as? CGFloat ?? 0
        )
        guard bounds.width > 0, bounds.height > 0 else { continue }
        windows.append(WindowInfo(
            id: info[kCGWindowNumber as String] as? Int ?? 0,
            app: ownerName,
            title: info[kCGWindowName as String] as? String ?? "",
            bounds: bounds
        ))
    }

    // Permission detection: if CG returned layer-0 windows but all had
    // zeroed/redacted bounds, Screen Recording permission is likely denied.
    if windows.isEmpty && totalLayer0 > 0 {
        fputs("Screen recording permission required. Grant access in "
            + "System Settings > Privacy & Security > Screen & System Audio Recording.\n", stderr)
        exit(3)
    }

    return windows
}

// MARK: - JSON Output

func outputJSON(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    NSApplication.shared.terminate(nil)
}

// MARK: - Window Picker View

class WindowPickerView: NSView {
    let screenHeight: CGFloat
    var highlightedWindow: WindowInfo?
    private var trackingArea: NSTrackingArea?

    init(frame: NSRect, screenHeight: CGFloat) {
        self.screenHeight = screenHeight
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea { removeTrackingArea(existing) }
        trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .activeAlways, .inVisibleRect],
            owner: self
        )
        addTrackingArea(trackingArea!)
    }

    override func mouseMoved(with event: NSEvent) {
        let loc = event.locationInWindow
        let cgPoint = CGPoint(x: loc.x, y: screenHeight - loc.y)
        let windows = getOnScreenWindows(
            excludingPID: ProcessInfo.processInfo.processIdentifier
        )
        highlightedWindow = windows.first { $0.bounds.contains(cgPoint) }
        setNeedsDisplay(bounds)
        if highlightedWindow != nil {
            NSCursor.pointingHand.set()
        } else {
            NSCursor.crosshair.set()
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let win = highlightedWindow else { return }
        outputJSON([
            "id": win.id, "app": win.app, "title": win.title,
            "x": Int(win.bounds.origin.x), "y": Int(win.bounds.origin.y),
            "w": Int(win.bounds.width), "h": Int(win.bounds.height),
        ])
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { exit(1) }
    }

    override var acceptsFirstResponder: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()
        guard let win = highlightedWindow else { return }
        let y = cgToAppKit(
            cgY: win.bounds.origin.y,
            height: win.bounds.height,
            screenHeight: screenHeight
        )
        let rect = NSRect(
            x: win.bounds.origin.x, y: y,
            width: win.bounds.width, height: win.bounds.height
        )
        let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
        NSColor.systemBlue.withAlphaComponent(0.15).setFill()
        path.fill()
        NSColor.systemBlue.withAlphaComponent(0.6).setStroke()
        path.lineWidth = 2
        path.stroke()
    }
}

// MARK: - Region Picker View

class RegionPickerView: NSView {
    let screenHeight: CGFloat
    var dragStart: NSPoint?
    var dragCurrent: NSPoint?
    private var trackingArea: NSTrackingArea?
    private let label = NSTextField(labelWithString: "")

    init(frame: NSRect, screenHeight: CGFloat) {
        self.screenHeight = screenHeight
        super.init(frame: frame)
        label.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .medium)
        label.textColor = .white
        label.backgroundColor = NSColor.black.withAlphaComponent(0.7)
        label.drawsBackground = true
        label.isBezeled = false
        label.isHidden = true
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea { removeTrackingArea(existing) }
        trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .activeAlways, .inVisibleRect],
            owner: self
        )
        addTrackingArea(trackingArea!)
    }

    override func mouseDown(with event: NSEvent) {
        dragStart = event.locationInWindow
        dragCurrent = dragStart
    }

    override func mouseDragged(with event: NSEvent) {
        dragCurrent = event.locationInWindow
        setNeedsDisplay(bounds)
        updateLabel()
    }

    override func mouseUp(with event: NSEvent) {
        guard let start = dragStart, let end = dragCurrent else { return }
        let rect = normalizedRect(from: start, to: end)
        guard rect.width >= 10, rect.height >= 10 else {
            dragStart = nil
            dragCurrent = nil
            label.isHidden = true
            setNeedsDisplay(bounds)
            return
        }
        let cgY = appKitToCG(
            appKitY: rect.origin.y,
            height: rect.height,
            screenHeight: screenHeight
        )
        outputJSON([
            "x": Int(rect.origin.x), "y": Int(cgY),
            "w": Int(rect.width), "h": Int(rect.height),
        ])
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { exit(1) }
    }

    override var acceptsFirstResponder: Bool { true }

    private func normalizedRect(from a: NSPoint, to b: NSPoint) -> NSRect {
        NSRect(
            x: min(a.x, b.x), y: min(a.y, b.y),
            width: abs(a.x - b.x), height: abs(a.y - b.y)
        )
    }

    private func updateLabel() {
        guard let start = dragStart, let current = dragCurrent else { return }
        let rect = normalizedRect(from: start, to: current)
        guard rect.width >= 1, rect.height >= 1 else {
            label.isHidden = true
            return
        }
        label.stringValue = " \(Int(rect.width)) x \(Int(rect.height)) "
        label.sizeToFit()
        let lx = min(rect.maxX + 8, bounds.width - label.frame.width - 4)
        let ly = max(rect.minY - label.frame.height - 8, 4)
        label.frame.origin = NSPoint(x: lx, y: ly)
        label.isHidden = false
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.2).setFill()
        bounds.fill()
        guard let start = dragStart, let current = dragCurrent else { return }
        let rect = normalizedRect(from: start, to: current)
        guard rect.width >= 1, rect.height >= 1 else { return }
        NSColor.clear.setFill()
        rect.fill(using: .copy)
        let border = NSBezierPath(rect: rect)
        NSColor.white.withAlphaComponent(0.8).setStroke()
        border.lineWidth = 1
        border.stroke()
    }
}

// MARK: - Setup and Run

guard let screen = NSScreen.main else {
    fputs("No main screen found.\n", stderr)
    exit(1)
}

let screenFrame = screen.frame
let window = KeyableWindow(
    contentRect: screenFrame,
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.level = .screenSaver
window.isOpaque = false
window.backgroundColor = .clear
window.ignoresMouseEvents = false
window.hasShadow = false

let contentView: NSView
if mode == "window" {
    contentView = WindowPickerView(frame: screenFrame, screenHeight: screenFrame.height)
} else {
    contentView = RegionPickerView(frame: screenFrame, screenHeight: screenFrame.height)
}
window.contentView = contentView
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(contentView)
NSCursor.crosshair.set()

DispatchQueue.main.asyncAfter(deadline: .now() + 60) { exit(2) }

if #available(macOS 14.0, *) {
    NSApp.activate()
} else {
    app.activate(ignoringOtherApps: true)
}
app.run()
```

- [ ] **Step 2: Commit**

```bash
git add skills/screencast/scripts/screencast-picker.swift
git commit -m "feat(screencast): add Swift picker for interactive selection"
```

---

## Task 2: compilePicker() + Tests

**Files:**
- Modify: `skills/screencast/scripts/screencast.js:726-733` (exports)
- Modify: `tests/screencast/screencast.test.js`

- [ ] **Step 1: Write failing tests for compilePicker**

Add to `tests/screencast/screencast.test.js`:

```javascript
// ─── Task: compilePicker ─────────────────────────────────────────────────────

describe('compilePicker', () => {
  const CACHE_DIR = path.join(os.tmpdir(), `screencast-picker-test-${process.pid}`);
  const FAKE_SOURCE = path.join(os.tmpdir(), `screencast-picker-test-${process.pid}.swift`);

  before(() => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(FAKE_SOURCE, '// fake swift source\n');
  });

  afterEach(() => {
    delete require.cache[SCRIPT];
    mod = null;
  });

  it('returns error when not on macOS', () => {
    load();
    if (os.platform() !== 'darwin') {
      assert.throws(() => mod.compilePicker(FAKE_SOURCE, CACHE_DIR), /macOS/);
    }
  });

  it('throws when source file does not exist', function () {
    if (os.platform() !== 'darwin') { this.skip(); return; }
    load();
    assert.throws(
      () => mod.compilePicker('/tmp/nonexistent-picker.swift', CACHE_DIR),
      /ENOENT|not found/
    );
  });

  it('returns binary path after compilation on macOS', function () {
    if (os.platform() !== 'darwin') { this.skip(); return; }
    load();
    const result = mod.compilePicker(
      path.resolve(__dirname, '../../skills/screencast/scripts/screencast-picker.swift'),
      CACHE_DIR
    );
    assert.ok(result.endsWith('screencast-picker'), `expected binary path, got: ${result}`);
    assert.ok(fs.existsSync(result), 'binary should exist after compilation');
  });

  it('skips recompilation when binary is newer than source', function () {
    if (os.platform() !== 'darwin') { this.skip(); return; }
    load();
    // First compile
    const binaryPath = mod.compilePicker(
      path.resolve(__dirname, '../../skills/screencast/scripts/screencast-picker.swift'),
      CACHE_DIR
    );
    const stat1 = fs.statSync(binaryPath);
    // Second compile (should skip)
    const binaryPath2 = mod.compilePicker(
      path.resolve(__dirname, '../../skills/screencast/scripts/screencast-picker.swift'),
      CACHE_DIR
    );
    const stat2 = fs.statSync(binaryPath2);
    assert.equal(stat1.mtimeMs, stat2.mtimeMs, 'binary mtime should not change');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node --test tests/screencast/screencast.test.js`
Expected: FAIL — `mod.compilePicker is not a function`

- [ ] **Step 3: Implement compilePicker()**

Add to `screencast.js` after the `resolveAvfoundationIndex()` function (before `cmdStart`), in the "Subcommands" section:

```javascript
// ─── Interactive picker (macOS only) ─────────────────────────────────────────

/**
 * Locate the Swift picker source file.
 * @returns {string}
 */
function findPickerSource() {
  const candidates = [
    process.env.CLAUDE_SKILL_DIR
      ? path.join(process.env.CLAUDE_SKILL_DIR, 'scripts', 'screencast-picker.swift')
      : null,
    path.join(__dirname, 'screencast-picker.swift'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'screencast-picker.swift not found. Expected in same directory as screencast.js.'
  );
}

/**
 * Compile the Swift picker if needed. Returns path to binary.
 * @param {string} [sourceFile] - Override source path (for testing)
 * @param {string} [cacheDir] - Override cache directory (for testing)
 * @returns {string}
 */
function compilePicker(sourceFile, cacheDir) {
  if (os.platform() !== 'darwin') {
    throw new Error('Interactive selection is only available on macOS');
  }

  const source = sourceFile ?? findPickerSource();
  const cache = cacheDir ?? path.join(os.homedir(), '.cache', 'screencast');
  const binary = path.join(cache, 'screencast-picker');

  // Skip if binary exists and is newer than source
  if (fs.existsSync(binary)) {
    const srcStat = fs.statSync(source);
    const binStat = fs.statSync(binary);
    if (binStat.mtimeMs >= srcStat.mtimeMs) return binary;
  }

  fs.mkdirSync(cache, { recursive: true });

  const result = spawnSync('xcrun', [
    'swiftc', '-O', '-o', binary, source,
    '-framework', 'AppKit', '-framework', 'CoreGraphics',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (stderr.includes('xcrun') || result.error) {
      throw new Error(
        'Xcode Command Line Tools required. Run: xcode-select --install'
      );
    }
    throw new Error(`Failed to compile picker: ${stderr}`);
  }

  return binary;
}
```

- [ ] **Step 4: Export compilePicker**

Update the `module.exports` at the bottom of `screencast.js`:

```javascript
module.exports = {
  parseArgs, detectPlatform, buildFfmpegArgs,
  readState, writeState, clearState, isAlive,
  resolveWindowGeometry, compilePicker,
};
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `node --test tests/screencast/screencast.test.js`
Expected: All PASS (non-darwin tests skip gracefully)

- [ ] **Step 6: Commit**

```bash
git add skills/screencast/scripts/screencast.js tests/screencast/screencast.test.js
git commit -m "feat(screencast): add compilePicker() with mtime caching"
```

---

## Task 3: Pick Subcommands

**Files:**
- Modify: `skills/screencast/scripts/screencast.js:694-724` (main switch + help text)

- [ ] **Step 1: Add cmdPickWindow() and cmdPickRegion()**

Add after `compilePicker()` in `screencast.js`:

```javascript
/**
 * Run the picker in the given mode and map exit codes to JSON.
 * @param {'window'|'region'} pickerMode
 */
function runPicker(pickerMode) {
  if (os.platform() !== 'darwin') {
    die('Interactive selection is only available on macOS');
  }

  let binary;
  try {
    binary = compilePicker();
  } catch (err) {
    die(err.message);
  }

  const result = spawnSync(binary, ['--mode', pickerMode], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 70000, // 10s buffer beyond the 60s picker timeout
  });

  if (result.status === 0) {
    const output = JSON.parse(result.stdout.trim());
    json(output);
  } else if (result.status === 1) {
    json({ cancelled: true });
  } else if (result.status === 2) {
    die('Picker timed out');
  } else if (result.status === 3) {
    die('Screen recording permission required. '
      + 'Check System Settings > Privacy & Security > Screen & System Audio Recording.');
  } else {
    const stderr = (result.stderr || '').trim();
    die(`Picker failed (exit ${result.status}): ${stderr}`);
  }
}

function cmdPickWindow() {
  runPicker('window');
}

function cmdPickRegion() {
  runPicker('region');
}
```

- [ ] **Step 2: Register in main() switch**

Add two cases to the switch in `main()`:

```javascript
case 'pick-window': cmdPickWindow(); break;
case 'pick-region': cmdPickRegion(); break;
```

- [ ] **Step 3: Update help text**

Add to the usage array in the default case:

```javascript
'  pick-window                     Click to select a window (macOS only)',
'  pick-region                     Drag to select a region (macOS only)',
```

- [ ] **Step 4: Run existing tests — no regressions**

Run: `node --test tests/screencast/screencast.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add skills/screencast/scripts/screencast.js
git commit -m "feat(screencast): add pick-window and pick-region subcommands"
```

---

## Task 4: SKILL.md Updates

**Files:**
- Modify: `skills/screencast/SKILL.md`

- [ ] **Step 1: Add pick commands to Commands section**

After the existing command list block, add `pick-window` and `pick-region`:

```bash
node "$SCREENCAST_JS" pick-window                          # macOS: click to select a window
node "$SCREENCAST_JS" pick-region                          # macOS: drag to select a region
```

- [ ] **Step 2: Add Platform Features section**

Add after the Commands section (before Workflow):

```markdown
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
```

- [ ] **Step 3: Update Step 2 workflow for macOS**

Replace the existing Step 2 content with a platform-aware version. Add the macOS interactive option before the existing three options:

```markdown
### Step 2: Choose What to Record

Check platform from the `deps` output.

**On macOS**, offer interactive selection first:

> "You're on macOS — I can let you **click on a window** or
> **drag a region** to select what to record. Or you can pick
> from a list / type coordinates. Which do you prefer?"

If the user chooses interactive:
```bash
node "$SCREENCAST_JS" pick-window
# or
node "$SCREENCAST_JS" pick-region
```

Use the returned `id` with `--window`, or `x,y,w,h` with `--region`.
If the picker returns `{cancelled: true}`, ask what they'd like to do instead.

**On all platforms** (or if the user prefers manual selection):
```

Then keep the existing Full screen / Specific window / Custom region options unchanged.

- [ ] **Step 4: Commit**

```bash
git add skills/screencast/SKILL.md
git commit -m "docs(screencast): add macOS interactive selection to workflow"
```

---

## Task 5: Integration Test

Manual verification on macOS. Not automated.

- [ ] **Step 1: Compile the picker**

```bash
node skills/screencast/scripts/screencast.js pick-window
```

Expected: Picker compiles (first run), overlay appears, blue highlight follows mouse over windows. Click outputs JSON. Escape exits with `{cancelled: true}`.

- [ ] **Step 2: Test region mode**

```bash
node skills/screencast/scripts/screencast.js pick-region
```

Expected: Dark overlay appears, drag creates a cutout with dimensions label. Release outputs JSON. Drags under 10px are ignored. Escape exits with `{cancelled: true}`.

- [ ] **Step 3: Test cache invalidation**

```bash
# Touch the source file to trigger recompile
touch skills/screencast/scripts/screencast-picker.swift
node skills/screencast/scripts/screencast.js pick-window
```

Expected: Recompiles (brief ~1s delay), then picker works normally.

- [ ] **Step 4: Sync skills and test from installed location**

```bash
./scripts/sync-skills.sh
```

Verify the screencast skill still works when invoked from a fresh Claude Code session.

- [ ] **Step 5: Run full test suite**

```bash
node --test tests/screencast/screencast.test.js
```

Expected: All tests pass.

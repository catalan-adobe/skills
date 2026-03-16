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

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

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

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

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
window.invalidateCursorRects(for: contentView)

DispatchQueue.main.asyncAfter(deadline: .now() + 60) { exit(2) }

if #available(macOS 14.0, *) {
    NSApp.activate()
} else {
    app.activate(ignoringOtherApps: true)
}
app.run()

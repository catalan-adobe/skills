# cdp-ext-pilot Design Spec

## Overview

**Name:** `cdp-ext-pilot`

**Purpose:** Launch Chrome with an unpacked extension loaded, open its UI
(sidepanel, popup, or options page), and hand off to `cdp-connect` for
interaction. Handles Chrome for Testing auto-installation, branded Chrome
`Extensions.loadUnpacked` pipe workaround, and the `userGesture` trick for
sidepanels.

**Depends on:** `cdp-connect` (loaded first for `cdp.js` and CDP commands)

**Draft description (< 1024 chars):**
Launch Chrome with an unpacked extension and test its UI via CDP. Auto-installs
Chrome for Testing if needed. Loads the extension, opens sidepanel/popup/options
page, and hands off to cdp-connect for interaction (click, type, screenshot,
ax-tree). Handles Chrome 137+ branded build restrictions (Extensions.loadUnpacked
via pipe), sidepanel user gesture requirements, and React input quirks. Use when
you need to test a Chrome extension's UI, automate extension interactions, or
validate extension behavior on a target page. Triggers on: chrome extension test,
test extension, load unpacked extension, extension sidepanel, extension popup,
test chrome extension, extension testing, chrome extension automation, ext pilot.

## Background

Chrome 137+ branded builds removed the `--load-extension` CLI flag for
security reasons. Loading unpacked extensions now requires either:

- **Chrome for Testing / Chromium:** `--load-extension` still works (simple path)
- **Branded Chrome:** `Extensions.loadUnpacked` CDP method via
  `--remote-debugging-pipe` + `--enable-unsafe-extension-debugging` (pipe path)

**Validated:** The pipe path works end-to-end on branded Chrome Canary 148. The
extension persists in the `--user-data-dir` profile after the pipe session
closes. Restarting Chrome with `--remote-debugging-port` (same profile, no
`--load-extension` flag) loads the extension automatically. Tested 2026-03-23.

Opening a sidepanel programmatically requires `chrome.sidePanel.open()`, which
Chrome restricts to user gesture context. The workaround: call
`chrome.runtime.sendMessage()` from the extension's content script execution
context with CDP's `Runtime.evaluate` using `userGesture: true`.

## Script: `cdp-ext-pilot.mjs`

Pure Node.js (22+), zero dependencies. Uses built-in WebSocket, fetch,
child_process, fs. Only external tool: `unzip` (pre-installed on macOS/Linux).

### Subcommands

| Subcommand | Args | What it does |
|---|---|---|
| `launch` | `<ext-path> [--port N]` | Find/install Chrome, launch with extension, return extension ID. Default port 9222. |
| `open` | `<sidepanel\|popup\|options> [--port N]` | Open extension UI surface, return CDP target ID. |
| `status` | `[--port N]` | Report session state as JSON (see output format below). |
| `close` | `[--port N]` | Kill Chrome, remove temp profile and session file. |

### Session State

Stored at `/tmp/ext-pilot-session-<port>.json` (keyed by port to support
concurrent sessions):

```json
{
  "pid": 12345,
  "extensionId": "ldeflgioiinadddfenphcghpphndkjij",
  "extensionPath": "/path/to/extension/dist",
  "profileDir": "/tmp/cdp-ext-pilot-12345",
  "port": 9222,
  "chromePath": "/path/to/chrome",
  "chromeVariant": "chrome-for-testing"
}
```

### Status Output Format

`status` prints JSON to stdout and exits 0 if Chrome is running, 1 if not:

```json
{
  "running": true,
  "pid": 12345,
  "port": 9222,
  "extensionId": "ldeflgioiinadddfenphcghpphndkjij",
  "chromeVariant": "chrome-for-testing",
  "targets": [
    {"id": "ABC123", "type": "page", "url": "https://example.com", "title": "Example"}
  ]
}
```

## Chrome Discovery & Installation

### Detection Order

1. Chrome for Testing in cache (`~/.cache/cdp-ext-pilot/chrome-for-testing/`)
2. Chrome for Testing on `$PATH`
3. Chromium:
   - macOS: `/Applications/Chromium.app`
   - Linux: `/usr/bin/chromium-browser`, `/usr/bin/chromium`
4. Chrome Canary, Chrome Stable (branded -- triggers pipe path)

### Auto-Install Flow

When no suitable Chrome is found:

1. Fetch latest stable version from
   `https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json`
2. Download platform-appropriate zip (macOS arm64/x64, linux64)
3. Extract to `~/.cache/cdp-ext-pilot/chrome-for-testing/<version>/`
   (version in path so different versions coexist)
4. Verify binary runs (`--version`)

### Launch Strategy

| Chrome variant | Extension loading | CDP |
|---|---|---|
| Chrome for Testing / Chromium | `--load-extension` + `--remote-debugging-port` | Single launch |
| Branded Chrome | `--remote-debugging-pipe` -> `Extensions.loadUnpacked` -> restart with `--remote-debugging-port` | Two-step pipe dance |

### Profile

Always uses a temp profile (`/tmp/cdp-ext-pilot-<pid>/`) to avoid interfering
with the user's real Chrome profile. Cleaned up by `close` subcommand.

## Opening Extension UI Surfaces

### Pre-checks (all surfaces)

Before attempting to open any surface, the script reads `manifest.json` from
the extension path stored in the session file and validates:

- **Sidepanel:** `side_panel.default_path` exists in manifest
- **Popup:** `action.default_popup` exists in manifest
- **Options:** `options_page` or `options_ui.page` exists in manifest

If the manifest lacks the requested surface, the script exits with a clear
error: `"Extension manifest does not declare a <surface>. Available surfaces:
<list>"`.

### Sidepanel

1. Verify `side_panel` declared in manifest (pre-check above)
2. Navigate to a page if no page target exists (sidepanels need an active tab)
3. Connect to the page target via CDP WebSocket
4. `Runtime.enable` to discover execution contexts
5. Find the extension's content script context (origin contains extension ID)
6. `Runtime.evaluate` with `userGesture: true`:
   `chrome.runtime.sendMessage({type: "open_side_panel"})`
7. Poll `Target.getTargets` for the sidepanel target (timeout: 5s)
8. Return the sidepanel's CDP target ID

**If no content script context found:** The extension may not inject content
scripts, or the page URL may not match the content script's `matches` pattern.
The script prints an actionable error suggesting the user navigate to a matching
URL first.

**If sidepanel target never appears:** The extension likely lacks an
`open_side_panel` message handler. The script prints: `"Sidepanel declared in
manifest but could not be opened programmatically. The extension may require
a manual click on the toolbar icon, or it may need an 'open_side_panel'
message handler in its service worker."`.

### Popup / Options Page

Simpler path -- create a new tab at the extension URL:

- Popup: `chrome-extension://<id>/<action.default_popup>`
- Options: `chrome-extension://<id>/<options_page or options_ui.page>`

Uses `Target.createTarget` via the browser-level CDP WebSocket. Returns the
new target ID. Paths read from `manifest.json`.

**Caveat:** Opening popup.html as a tab runs it in a `page` context, not a
`popup` context. Extension code that checks `chrome.extension.getViews({type:
"popup"})` or relies on popup-specific lifecycle behavior will see different
results than a real toolbar popup click.

## SKILL.md Structure

~100 lines for the main SKILL.md. If gotchas and patterns exceed this, extract
to `references/extension-patterns.md` for progressive disclosure.

Three phases:

1. **Setup** -- `launch <ext-path>`, confirm extension loaded
2. **Open UI** -- `open sidepanel|popup|options`, get target ID
3. **Interact** -- Hand off to `cdp-connect` commands with `--id <target-id>`

### Tips Section (encoded gotchas)

- React inputs: `cdp.js type` sets DOM value (works for plain HTML inputs).
  For React-controlled inputs, use `cdp.js eval` with `Input.insertText`:
  focus the element first, then call `Input.insertText` via a CDP WebSocket
  script. Example pattern documented in tips.
- Popup-as-tab: runs in page context, not popup context (see caveat above)
- Sidepanel screenshots: use the sidepanel target ID, not the page target
- Content script contexts: `Runtime.enable` + look for `chrome-extension://`
  origin in `executionContextCreated` events
- Cookie banners: dismiss before testing (reference `page-prep` skill)
- Cleanup: run `close` when done

## What Ships

| Path | Ships? | Purpose |
|---|---|---|
| `skills/cdp-ext-pilot/SKILL.md` | Yes | Prompt orchestrating the workflow |
| `skills/cdp-ext-pilot/scripts/cdp-ext-pilot.mjs` | Yes | Node.js script with subcommands |
| `skills/cdp-ext-pilot/references/extension-patterns.md` | Yes (if needed) | Gotchas and patterns overflow |
| `tests/cdp-ext-pilot/` | No | Test cases (repo-only) |

No new dependencies. Plugin manifests (`plugin.json`, `marketplace.json`) and
`README.md` updated with new skill entry. `scripts/sync-skills.sh`
auto-discovers -- no changes needed.

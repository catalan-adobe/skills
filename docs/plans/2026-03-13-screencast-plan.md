# Screencast Skill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code skill for guided screen recording using ffmpeg, with cross-platform support and start/stop control.

**Architecture:** A SKILL.md prompt orchestrates a three-phase interaction (discover, configure, record). A `screencast.js` Node.js script (zero npm deps) handles all platform-specific ffmpeg commands, window/screen enumeration, and background process management via a JSON state file.

**Tech Stack:** Node 22 (built-in modules only), ffmpeg (avfoundation/x11grab/gdigrab)

**Spec:** `docs/plans/2026-03-13-screencast-design.md`

---

## File Map

| File | Responsibility |
|------|---------------|
| `skills/screencast/scripts/screencast.js` | All platform logic: deps check, window/screen listing, ffmpeg command building, start/stop/status process management |
| `skills/screencast/SKILL.md` | Prompt that orchestrates the 3-phase guided workflow |
| `tests/screencast/screencast.test.js` | Unit tests for arg parsing, command building, state management |
| `README.md` | Add screencast to Available Skills section |
| `.claude-plugin/plugin.json` | Add screencast to plugin description + keywords |
| `.claude-plugin/marketplace.json` | Add screencast to marketplace description |

---

## Chunk 1: Core Script Infrastructure

### Task 1: Script skeleton with arg parsing and subcommand dispatch

**Files:**
- Create: `skills/screencast/scripts/screencast.js`
- Create: `tests/screencast/screencast.test.js`

- [ ] **Step 1: Write test for arg parsing**

Create the test file. Use Node's built-in `node:test` and `node:assert` (no npm deps). Test that the parser extracts subcommands, flags, and positional args correctly.

```js
// tests/screencast/screencast.test.js
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Import internals — screencast.js must export parseArgs for testing
// We'll use a conditional export pattern (same as cdp.js runs as CLI)

describe('parseArgs', () => {
  // Dynamically load to avoid top-level side effects
  let parseArgs;
  it('setup', () => {
    // screencast.js exports parseArgs when required as module
    ({ parseArgs } = require('../../skills/screencast/scripts/screencast.js'));
  });

  it('parses subcommand with no flags', () => {
    const result = parseArgs(['node', 'screencast.js', 'deps']);
    assert.equal(result.command, 'deps');
    assert.deepEqual(result.args, []);
  });

  it('parses start with --region flag', () => {
    const result = parseArgs([
      'node', 'screencast.js', 'start',
      '--region', '100,200,800,600',
      '--output', '/tmp/test.mp4',
    ]);
    assert.equal(result.command, 'start');
    assert.equal(result.region, '100,200,800,600');
    assert.equal(result.output, '/tmp/test.mp4');
  });

  it('parses start with --window flag', () => {
    const result = parseArgs([
      'node', 'screencast.js', 'start',
      '--window', '12345',
      '--fps', '60',
    ]);
    assert.equal(result.command, 'start');
    assert.equal(result.window, '12345');
    assert.equal(result.fps, 60);
  });

  it('parses start with --screen flag', () => {
    const result = parseArgs([
      'node', 'screencast.js', 'start',
      '--screen', '2',
    ]);
    assert.equal(result.command, 'start');
    assert.equal(result.screen, 2);
  });

  it('uses defaults for unspecified flags', () => {
    const result = parseArgs(['node', 'screencast.js', 'start']);
    assert.equal(result.command, 'start');
    assert.equal(result.fps, 30);
    assert.equal(result.screen, 0);
    assert.equal(result.region, null);
    assert.equal(result.window, null);
    assert.equal(result.output, null);
  });

  it('parses stop and status with no flags', () => {
    assert.equal(
      parseArgs(['node', 'screencast.js', 'stop']).command,
      'stop',
    );
    assert.equal(
      parseArgs(['node', 'screencast.js', 'status']).command,
      'status',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/screencast/screencast.test.js`
Expected: FAIL — cannot find module `screencast.js`

- [ ] **Step 3: Write screencast.js skeleton with parseArgs and subcommand dispatch**

```js
#!/usr/bin/env node
'use strict';

const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STATE_FILE = path.join(os.homedir(), '.screencast.state');

function die(msg) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

function json(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function parseArgs(argv) {
  const flags = {
    fps: 30,
    screen: 0,
    region: null,
    window: null,
    output: null,
  };
  const positional = [];
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--fps': flags.fps = parseInt(raw[++i], 10); break;
      case '--screen': flags.screen = parseInt(raw[++i], 10); break;
      case '--region': flags.region = raw[++i]; break;
      case '--window': flags.window = raw[++i]; break;
      case '--output': flags.output = raw[++i]; break;
      default: positional.push(raw[i]);
    }
  }
  return { command: positional[0], args: positional.slice(1), ...flags };
}

// --- Subcommands (stubs) ---

function cmdDeps() { die('not implemented'); }
function cmdListWindows() { die('not implemented'); }
function cmdListScreens() { die('not implemented'); }
function cmdStart(_flags) { die('not implemented'); }
function cmdStop() { die('not implemented'); }
function cmdStatus() { die('not implemented'); }

// --- Main ---

function main() {
  const parsed = parseArgs(process.argv);

  switch (parsed.command) {
    case 'deps': cmdDeps(); break;
    case 'list-windows': cmdListWindows(); break;
    case 'list-screens': cmdListScreens(); break;
    case 'start': cmdStart(parsed); break;
    case 'stop': cmdStop(); break;
    case 'status': cmdStatus(); break;
    default:
      console.error([
        'Usage: screencast.js <command> [flags]',
        '',
        'Commands:',
        '  deps                         Check ffmpeg and platform',
        '  list-windows                 List open windows with geometry',
        '  list-screens                 List available displays',
        '  start [flags]                Start recording',
        '  stop                         Stop recording',
        '  status                       Check recording state',
        '',
        'Start flags:',
        '  --screen <index>             Display index (default: 0)',
        '  --region <x,y,w,h>           Crop region',
        '  --window <id>                Record specific window',
        '  --fps <N>                    Frame rate (default: 30)',
        '  --output <path>              Output file path',
      ].join('\n'));
      process.exit(parsed.command ? 1 : 0);
  }
}

// Allow importing parseArgs for testing
if (require.main === module) {
  main();
} else {
  module.exports = { parseArgs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/screencast/screencast.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add skills/screencast/scripts/screencast.js tests/screencast/screencast.test.js
git commit -m "feat(screencast): add script skeleton with arg parsing"
```

---

### Task 2: Platform detection and deps command

**Files:**
- Modify: `skills/screencast/scripts/screencast.js` — implement `cmdDeps`
- Modify: `tests/screencast/screencast.test.js` — add tests

- [ ] **Step 1: Write tests for platform detection**

Add to the test file:

```js
describe('detectPlatform', () => {
  let detectPlatform;
  it('setup', () => {
    ({ detectPlatform } = require('../../skills/screencast/scripts/screencast.js'));
  });

  it('returns a valid platform object', () => {
    const result = detectPlatform();
    assert.ok(['darwin', 'linux', 'win32'].includes(result.platform));
    assert.ok(['avfoundation', 'x11grab', 'gdigrab'].includes(result.backend));
    assert.equal(typeof result.ffmpeg, 'boolean');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/screencast/screencast.test.js`
Expected: FAIL — `detectPlatform` is not exported

- [ ] **Step 3: Implement detectPlatform and cmdDeps**

Add to `screencast.js`:

```js
function detectPlatform() {
  const platform = os.platform();
  const backendMap = { darwin: 'avfoundation', linux: 'x11grab', win32: 'gdigrab' };
  const backend = backendMap[platform];
  if (!backend) die(`Unsupported platform: ${platform}`);

  let ffmpeg = false;
  let ffmpegVersion = null;
  try {
    const out = execSync('ffmpeg -version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    ffmpeg = true;
    const match = out.match(/ffmpeg version (\S+)/);
    if (match) ffmpegVersion = match[1];
  } catch { /* ffmpeg not found */ }

  return { platform, backend, ffmpeg, ffmpegVersion };
}

function cmdDeps() {
  const info = detectPlatform();
  json(info);
  if (!info.ffmpeg) {
    process.exit(1);
  }
}
```

Update `module.exports` to include `detectPlatform`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/screencast/screencast.test.js`
Expected: All tests PASS

- [ ] **Step 5: Manual smoke test**

Run: `node skills/screencast/scripts/screencast.js deps`
Expected: JSON output with `ffmpeg: true`, `platform: "darwin"`, `backend: "avfoundation"`

- [ ] **Step 6: Commit**

```bash
git add skills/screencast/scripts/screencast.js tests/screencast/screencast.test.js
git commit -m "feat(screencast): add platform detection and deps command"
```

---

### Task 3: ffmpeg command builder

**Files:**
- Modify: `skills/screencast/scripts/screencast.js` — add `buildFfmpegArgs`
- Modify: `tests/screencast/screencast.test.js` — add builder tests

This is the core logic — pure function, no side effects, highly testable.

- [ ] **Step 1: Write tests for command builder**

```js
describe('buildFfmpegArgs', () => {
  let buildFfmpegArgs;
  it('setup', () => {
    ({ buildFfmpegArgs } = require('../../skills/screencast/scripts/screencast.js'));
  });

  it('builds macOS full-screen command', () => {
    const args = buildFfmpegArgs({
      backend: 'avfoundation',
      screenInput: '1',
      fps: 30,
      region: null,
      output: '/tmp/test.mp4',
    });
    assert.ok(args.includes('-f'));
    assert.ok(args.includes('avfoundation'));
    assert.ok(args.includes('-framerate'));
    assert.ok(args.includes('30'));
    assert.ok(args.includes('1:none'));
    assert.ok(!args.some(a => a.startsWith('crop=')));
    assert.ok(args.includes('/tmp/test.mp4'));
  });

  it('builds macOS region command with crop filter', () => {
    const args = buildFfmpegArgs({
      backend: 'avfoundation',
      screenInput: '1',
      fps: 30,
      region: { x: 100, y: 200, w: 800, h: 600 },
      output: '/tmp/test.mp4',
    });
    const vfIdx = args.indexOf('-vf');
    assert.ok(vfIdx !== -1);
    assert.equal(args[vfIdx + 1], 'crop=800:600:100:200');
  });

  it('builds Linux full-screen command', () => {
    const args = buildFfmpegArgs({
      backend: 'x11grab',
      fps: 30,
      region: null,
      screenSize: '1920x1080',
      display: ':0.0',
      output: '/tmp/test.mp4',
    });
    assert.ok(args.includes('x11grab'));
    assert.ok(args.includes('-video_size'));
    assert.ok(args.includes('1920x1080'));
    assert.ok(args.includes(':0.0'));
  });

  it('builds Linux region command with native offset', () => {
    const args = buildFfmpegArgs({
      backend: 'x11grab',
      fps: 30,
      region: { x: 100, y: 200, w: 800, h: 600 },
      display: ':0.0',
      output: '/tmp/test.mp4',
    });
    assert.ok(args.includes('800x600'));
    assert.ok(args.includes(':0.0+100,200'));
  });

  it('builds Windows full-screen command', () => {
    const args = buildFfmpegArgs({
      backend: 'gdigrab',
      fps: 30,
      region: null,
      output: 'C:\\tmp\\test.mp4',
    });
    assert.ok(args.includes('gdigrab'));
    assert.ok(args.includes('desktop'));
  });

  // Note: the spec mentions gdigrab's native `-i title="Window Title"` for
  // Windows window capture, but we use the uniform region-crop approach across
  // all platforms for consistency. Native window title capture can be added
  // later as a platform optimization if needed.

  it('builds Windows region command', () => {
    const args = buildFfmpegArgs({
      backend: 'gdigrab',
      fps: 30,
      region: { x: 100, y: 200, w: 800, h: 600 },
      output: 'C:\\tmp\\test.mp4',
    });
    assert.ok(args.includes('-offset_x'));
    assert.ok(args.includes('100'));
    assert.ok(args.includes('-offset_y'));
    assert.ok(args.includes('200'));
    assert.ok(args.includes('-video_size'));
    assert.ok(args.includes('800x600'));
  });

  it('always includes common output settings', () => {
    const args = buildFfmpegArgs({
      backend: 'avfoundation',
      screenInput: '1',
      fps: 30,
      region: null,
      output: '/tmp/test.mp4',
    });
    assert.ok(args.includes('-c:v'));
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('-pix_fmt'));
    assert.ok(args.includes('yuv420p'));
    assert.ok(args.includes('-preset'));
    assert.ok(args.includes('ultrafast'));
    assert.ok(args.includes('-crf'));
    assert.ok(args.includes('23'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/screencast/screencast.test.js`
Expected: FAIL — `buildFfmpegArgs` not exported

- [ ] **Step 3: Implement buildFfmpegArgs**

Add to `screencast.js`. This is a pure function — takes a config object, returns an array of ffmpeg CLI arguments.

```js
function buildFfmpegArgs({ backend, screenInput, fps, region, output,
                           screenSize, display }) {
  const args = ['-y'];

  if (backend === 'avfoundation') {
    args.push('-f', 'avfoundation', '-framerate', String(fps),
              '-capture_cursor', '1', '-i', `${screenInput}:none`);
    if (region) {
      args.push('-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y}`);
    }
  } else if (backend === 'x11grab') {
    args.push('-f', 'x11grab', '-framerate', String(fps));
    if (region) {
      args.push('-video_size', `${region.w}x${region.h}`,
                '-i', `${display || ':0.0'}+${region.x},${region.y}`);
    } else {
      args.push('-video_size', screenSize || '1920x1080',
                '-i', display || ':0.0');
    }
  } else if (backend === 'gdigrab') {
    args.push('-f', 'gdigrab', '-framerate', String(fps));
    if (region) {
      args.push('-offset_x', String(region.x), '-offset_y', String(region.y),
                '-video_size', `${region.w}x${region.h}`);
    }
    args.push('-i', 'desktop');
  }

  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-preset', 'ultrafast', '-crf', '23', output);
  return args;
}
```

Export it in `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/screencast/screencast.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add skills/screencast/scripts/screencast.js tests/screencast/screencast.test.js
git commit -m "feat(screencast): add ffmpeg command builder for all platforms"
```

---

## Chunk 2: Window/Screen Discovery + State Management

### Task 4: Screen listing

**Files:**
- Modify: `skills/screencast/scripts/screencast.js` — implement `cmdListScreens`

No unit test for this — it shells out to platform-specific commands. Test manually.

- [ ] **Step 1: Implement cmdListScreens**

```js
function cmdListScreens() {
  const platform = os.platform();

  if (platform === 'darwin') {
    // Use ffmpeg to list avfoundation devices, parse screen entries
    const out = execSync(
      'ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true',
      { encoding: 'utf8' },
    );
    const screens = [];
    const re = /\[(\d+)\]\s+Capture screen (\d+)/g;
    let match;
    while ((match = re.exec(out)) !== null) {
      screens.push({ index: parseInt(match[1], 10), name: `Screen ${match[2]}` });
    }
    // Get resolution via system_profiler
    try {
      const sp = execSync(
        'system_profiler SPDisplaysDataType -json',
        { encoding: 'utf8' },
      );
      const data = JSON.parse(sp);
      const displays = data.SPDisplaysDataType?.[0]?.spdisplays_ndrvs ?? [];
      for (let i = 0; i < screens.length && i < displays.length; i++) {
        const res = displays[i]._spdisplays_resolution;
        if (res) {
          const m = res.match(/(\d+)\s*x\s*(\d+)/);
          if (m) {
            screens[i].width = parseInt(m[1], 10);
            screens[i].height = parseInt(m[2], 10);
          }
        }
        const scale = displays[i].spdisplays_retina === 'spdisplays_yes' ? 2 : 1;
        screens[i].scale = scale;
      }
    } catch { /* non-critical */ }
    json(screens);

  } else if (platform === 'linux') {
    try {
      const out = execSync('xrandr --query', { encoding: 'utf8' });
      const screens = [];
      let idx = 0;
      for (const line of out.split('\n')) {
        const m = line.match(/^(\S+)\s+connected.*?(\d+)x(\d+)/);
        if (m) {
          screens.push({
            index: idx++,
            name: m[1],
            width: parseInt(m[2], 10),
            height: parseInt(m[3], 10),
            scale: 1,
          });
        }
      }
      json(screens);
    } catch { die('xrandr not found. Install xrandr or ensure X11 is running.'); }

  } else if (platform === 'win32') {
    try {
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms;
        [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
          @{ name=$_.DeviceName; width=$_.Bounds.Width; height=$_.Bounds.Height }
        } | ConvertTo-Json`;
      const out = execSync(`powershell -Command "${ps}"`, { encoding: 'utf8' });
      const raw = JSON.parse(out);
      const screens = (Array.isArray(raw) ? raw : [raw]).map((s, i) => ({
        index: i, name: s.name, width: s.width, height: s.height, scale: 1,
      }));
      json(screens);
    } catch (e) { die(`Screen listing failed: ${e.message}`); }
  }
}
```

- [ ] **Step 2: Manual smoke test**

Run: `node skills/screencast/scripts/screencast.js list-screens`
Expected: JSON array with at least one screen entry containing index, name, width, height, scale

- [ ] **Step 3: Commit**

```bash
git add skills/screencast/scripts/screencast.js
git commit -m "feat(screencast): add screen listing for macOS/Linux/Windows"
```

---

### Task 5: Window listing

**Files:**
- Modify: `skills/screencast/scripts/screencast.js` — implement `cmdListWindows`

- [ ] **Step 1: Implement cmdListWindows**

macOS uses JXA via `osascript -l JavaScript` calling `CGWindowListCopyWindowInfo`. Linux uses `wmctrl -lG`. Windows uses PowerShell.

```js
function cmdListWindows() {
  const platform = os.platform();

  if (platform === 'darwin') {
    const script = `
      ObjC.import('CoreGraphics');
      ObjC.import('Foundation');
      const kOnScreen = 1;      // kCGWindowListOptionOnScreenOnly
      const kNoDesktop = 16;    // kCGWindowListExcludeDesktopElements
      const list = ObjC.deepUnwrap(
        $.CGWindowListCopyWindowInfo(kOnScreen | kNoDesktop, 0)
      );
      const windows = list
        .filter(w => w.kCGWindowLayer === 0 && w.kCGWindowOwnerName)
        .map(w => ({
          id: w.kCGWindowNumber,
          app: w.kCGWindowOwnerName,
          title: w.kCGWindowName || '',
          x: Math.round(w.kCGWindowBounds.X),
          y: Math.round(w.kCGWindowBounds.Y),
          w: Math.round(w.kCGWindowBounds.Width),
          h: Math.round(w.kCGWindowBounds.Height),
        }));
      JSON.stringify(windows);
    `;
    const out = execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8' });
    json(JSON.parse(out.trim()));

  } else if (platform === 'linux') {
    try {
      const out = execSync('wmctrl -lG', { encoding: 'utf8' });
      const windows = out.trim().split('\n').map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          id: parts[0],
          app: parts.slice(7).join(' '),
          title: parts.slice(7).join(' '),
          x: parseInt(parts[2], 10),
          y: parseInt(parts[3], 10),
          w: parseInt(parts[4], 10),
          h: parseInt(parts[5], 10),
        };
      });
      json(windows);
    } catch { die('wmctrl not found. Install with: sudo apt install wmctrl'); }

  } else if (platform === 'win32') {
    const ps = `
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class Win32 {
          [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
          [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int c);
          public struct RECT { public int Left, Top, Right, Bottom; }
        }
"@
      Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
        $r = New-Object Win32+RECT;
        [Win32]::GetWindowRect($_.MainWindowHandle, [ref]$r) | Out-Null;
        $sb = New-Object System.Text.StringBuilder(256);
        [Win32]::GetWindowText($_.MainWindowHandle, $sb, 256) | Out-Null;
        @{ id=[string]$_.MainWindowHandle; app=$_.ProcessName;
           title=$sb.ToString();
           x=$r.Left; y=$r.Top; w=($r.Right-$r.Left); h=($r.Bottom-$r.Top) }
      } | ConvertTo-Json`;
    try {
      const out = execSync(`powershell -Command "${ps}"`, { encoding: 'utf8' });
      json(JSON.parse(out.trim()));
    } catch (e) { die(`Window listing failed: ${e.message}`); }
  }
}
```

- [ ] **Step 2: Manual smoke test**

Run: `node skills/screencast/scripts/screencast.js list-windows`
Expected: JSON array of windows with id, app, title, x, y, w, h

- [ ] **Step 3: Commit**

```bash
git add skills/screencast/scripts/screencast.js
git commit -m "feat(screencast): add window listing for macOS/Linux/Windows"
```

---

### Task 6: State management (start, stop, status)

**Files:**
- Modify: `skills/screencast/scripts/screencast.js` — implement cmdStart, cmdStop, cmdStatus
- Modify: `tests/screencast/screencast.test.js` — add state management tests

- [ ] **Step 1: Write tests for state file helpers**

```js
describe('state management', () => {
  const TEST_STATE = path.join(os.tmpdir(), '.screencast-test.state');
  let readState, writeState, clearState;

  it('setup', () => {
    ({ readState, writeState, clearState } =
      require('../../skills/screencast/scripts/screencast.js'));
  });

  afterEach(() => {
    try { fs.unlinkSync(TEST_STATE); } catch {}
  });

  it('writeState creates and readState reads a state file', () => {
    const state = { pid: 999, output: '/tmp/test.mp4', startedAt: new Date().toISOString() };
    writeState(state, TEST_STATE);
    const read = readState(TEST_STATE);
    assert.equal(read.pid, 999);
    assert.equal(read.output, '/tmp/test.mp4');
  });

  it('readState returns null when no file exists', () => {
    assert.equal(readState(TEST_STATE), null);
  });

  it('clearState removes the file', () => {
    writeState({ pid: 1 }, TEST_STATE);
    clearState(TEST_STATE);
    assert.equal(readState(TEST_STATE), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/screencast/screencast.test.js`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement state helpers**

```js
function readState(stateFile = STATE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch { return null; }
}

function writeState(state, stateFile = STATE_FILE) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function clearState(stateFile = STATE_FILE) {
  try { fs.unlinkSync(stateFile); } catch {}
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
```

Export `readState`, `writeState`, `clearState`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/screencast/screencast.test.js`
Expected: All tests PASS

- [ ] **Step 5: Implement cmdStart**

```js
function cmdStart(flags) {
  const existing = readState();
  if (existing && isAlive(existing.pid)) {
    die(`Recording already in progress (PID ${existing.pid}). Run 'stop' first.`);
  }
  if (existing) clearState(); // stale

  const info = detectPlatform();
  if (!info.ffmpeg) die('ffmpeg not found. Install with: brew install ffmpeg');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const output = flags.output || path.join(process.cwd(), `screencast_${timestamp}.mp4`);

  let region = null;
  if (flags.region) {
    const [x, y, w, h] = flags.region.split(',').map(Number);
    region = { x, y, w, h };
  }
  // TODO Task 7: resolve --window to region via window geometry

  // Resolve avfoundation device index from list-screens rather than assuming offset
  let screenInput = String(flags.screen);
  if (info.backend === 'avfoundation') {
    try {
      const devOut = execSync(
        'ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true',
        { encoding: 'utf8' },
      );
      const re = /\[(\d+)\]\s+Capture screen (\d+)/g;
      let m;
      while ((m = re.exec(devOut)) !== null) {
        if (parseInt(m[2], 10) === flags.screen) {
          screenInput = m[1];
          break;
        }
      }
    } catch { /* fall back to screen index as-is */ }
  }
  const ffmpegArgs = buildFfmpegArgs({
    backend: info.backend,
    screenInput,
    fps: flags.fps,
    region,
    output,
    display: process.env.DISPLAY || ':0.0',
  });

  const logFile = output.replace(/\.mp4$/, '.log');
  const logFd = fs.openSync(logFile, 'w');
  const child = spawn('ffmpeg', ffmpegArgs, {
    detached: true,
    stdio: ['pipe', logFd, logFd],
  });
  child.stdin.end();
  child.unref();

  const state = {
    pid: child.pid,
    output,
    logFile,
    startedAt: new Date().toISOString(),
    target: {
      mode: flags.window ? 'window' : flags.region ? 'region' : 'fullscreen',
      screen: flags.screen,
      region,
    },
    platform: info.platform,
  };
  writeState(state);
  json({ pid: child.pid, output, target: state.target });
}
```

- [ ] **Step 6: Implement cmdStop**

```js
function cmdStop() {
  const state = readState();
  if (!state) die('No recording in progress.');

  if (!isAlive(state.pid)) {
    clearState();
    const exists = fs.existsSync(state.output);
    die(`Recording process (PID ${state.pid}) is not running. ${exists ? 'Partial file may exist at: ' + state.output : 'No output file found.'}`);
  }

  // Send SIGINT for graceful shutdown (ffmpeg writes MP4 trailer)
  const isWin = os.platform() === 'win32';
  if (isWin) {
    try { execSync(`taskkill /PID ${state.pid}`, { stdio: 'pipe' }); }
    catch { /* may already be exiting */ }
  } else {
    process.kill(state.pid, 'SIGINT');
  }

  // Wait for exit (poll up to 5 seconds)
  const deadline = Date.now() + 5000;
  while (isAlive(state.pid) && Date.now() < deadline) {
    execSync('sleep 0.2');
  }
  if (isAlive(state.pid)) {
    process.kill(state.pid, 'SIGTERM');
  }

  clearState();

  // Get file info
  let duration = null;
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${state.output}"`,
      { encoding: 'utf8' },
    );
    duration = parseFloat(out.trim());
  } catch { /* ffprobe may not be available */ }

  let size = null;
  try { size = fs.statSync(state.output).size; }
  catch { /* file may not exist if recording was very short */ }

  json({ output: state.output, duration, size });
}
```

- [ ] **Step 7: Implement cmdStatus**

```js
function cmdStatus() {
  const state = readState();
  if (!state) {
    json({ recording: false });
    return;
  }
  if (!isAlive(state.pid)) {
    clearState();
    json({ recording: false, stale: true });
    return;
  }
  const elapsed = (Date.now() - new Date(state.startedAt).getTime()) / 1000;
  json({
    recording: true,
    pid: state.pid,
    elapsed: Math.round(elapsed),
    output: state.output,
    target: state.target,
  });
}
```

- [ ] **Step 8: Run tests**

Run: `node --test tests/screencast/screencast.test.js`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add skills/screencast/scripts/screencast.js tests/screencast/screencast.test.js
git commit -m "feat(screencast): add start/stop/status with state management"
```

---

### Task 7: Window geometry resolution for --window flag

**Files:**
- Modify: `skills/screencast/scripts/screencast.js` — add `resolveWindowGeometry`, wire into cmdStart

- [ ] **Step 1: Implement resolveWindowGeometry**

```js
function resolveWindowGeometry(windowId) {
  const platform = os.platform();

  if (platform === 'darwin') {
    const script = `
      ObjC.import('CoreGraphics');
      const list = ObjC.deepUnwrap(
        $.CGWindowListCopyWindowInfo(0, 0)
      );
      const w = list.find(w => w.kCGWindowNumber === ${parseInt(windowId, 10)});
      if (!w) throw new Error('Window not found');
      JSON.stringify({
        x: Math.round(w.kCGWindowBounds.X),
        y: Math.round(w.kCGWindowBounds.Y),
        w: Math.round(w.kCGWindowBounds.Width),
        h: Math.round(w.kCGWindowBounds.Height),
      });
    `;
    const out = execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8' });
    return JSON.parse(out.trim());

  } else if (platform === 'linux') {
    const out = execSync(`xdotool getwindowgeometry --shell ${windowId}`,
      { encoding: 'utf8' });
    const vals = {};
    for (const line of out.split('\n')) {
      const [k, v] = line.split('=');
      if (k && v) vals[k.trim()] = parseInt(v.trim(), 10);
    }
    return { x: vals.X, y: vals.Y, w: vals.WIDTH, h: vals.HEIGHT };

  } else if (platform === 'win32') {
    const ps = `
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class Win32 {
          [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
          public struct RECT { public int Left, Top, Right, Bottom; }
        }
"@
      $r = New-Object Win32+RECT;
      [Win32]::GetWindowRect([IntPtr]${windowId}, [ref]$r) | Out-Null;
      @{ x=$r.Left; y=$r.Top; w=($r.Right-$r.Left); h=($r.Bottom-$r.Top) } | ConvertTo-Json`;
    const out = execSync(`powershell -Command "${ps}"`, { encoding: 'utf8' });
    return JSON.parse(out.trim());
  }
}
```

- [ ] **Step 2: Wire into cmdStart**

In `cmdStart`, replace the `// TODO Task 7` comment:

```js
if (flags.window) {
  const geo = resolveWindowGeometry(flags.window);
  // On macOS, multiply by screen scale factor for physical pixels
  if (info.platform === 'darwin') {
    // Read scale from list-screens result or default to 2 for Retina
    let scale = 2;
    try {
      const sp = execSync('system_profiler SPDisplaysDataType -json', { encoding: 'utf8' });
      const data = JSON.parse(sp);
      const disp = data.SPDisplaysDataType?.[0]?.spdisplays_ndrvs?.[0];
      if (disp?.spdisplays_retina !== 'spdisplays_yes') scale = 1;
    } catch {}
    geo.x *= scale; geo.y *= scale; geo.w *= scale; geo.h *= scale;
  }
  region = geo;
}
```

- [ ] **Step 3: Manual smoke test**

Run: `node skills/screencast/scripts/screencast.js list-windows`
Pick a window ID from the output, then:
Run: `node skills/screencast/scripts/screencast.js start --window <id> --output /tmp/test-window.mp4`
Wait 3 seconds, then:
Run: `node skills/screencast/scripts/screencast.js stop`
Expected: MP4 file at `/tmp/test-window.mp4` showing the selected window's region

- [ ] **Step 4: Commit**

```bash
git add skills/screencast/scripts/screencast.js
git commit -m "feat(screencast): add window geometry resolution for --window flag"
```

---

## Chunk 3: SKILL.md and Project Integration

### Task 8: Write SKILL.md

**Files:**
- Create: `skills/screencast/SKILL.md`

- [ ] **Step 1: Write the skill prompt**

Follow the pattern from `cdp-connect/SKILL.md` — frontmatter, overview, script location with fallback, commands reference, and workflow.

The SKILL.md should guide Claude through:
1. Locate script (CLAUDE_SKILL_DIR with fallback)
2. Run `deps` — check ffmpeg
3. Ask user what to record (full screen / window / region)
4. For window: run `list-windows`, present numbered list, user picks
5. For full screen: run `list-screens`, user picks (or default main)
6. For region: ask for x,y,w,h, offer display dimensions as reference
7. Confirm target and filename
8. Run `start` with chosen flags
9. Confirm recording is active
10. When user says "stop" (or equivalent): run `stop`
11. Report file path, duration, size

```markdown
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

` ``bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  SCREENCAST_JS="${CLAUDE_SKILL_DIR}/scripts/screencast.js"
else
  SCREENCAST_JS="$(command -v screencast.js 2>/dev/null || \
    find ~/.claude -path "*/screencast/scripts/screencast.js" -type f 2>/dev/null | head -1)"
fi
if [[ -z "$SCREENCAST_JS" || ! -f "$SCREENCAST_JS" ]]; then
  echo "Error: screencast.js not found. Ask the user for the path." >&2
fi
` ``

Store in `SCREENCAST_JS` and use for all commands below.

## Commands

` ``bash
node "$SCREENCAST_JS" deps                                  # Check ffmpeg + platform
node "$SCREENCAST_JS" list-screens                          # List available displays
node "$SCREENCAST_JS" list-windows                          # List open windows with geometry
node "$SCREENCAST_JS" start [flags]                         # Start recording
node "$SCREENCAST_JS" stop                                  # Stop recording
node "$SCREENCAST_JS" status                                # Check if recording
` ``

Start flags:
- `--screen <index>` — display to record (default: 0 = main)
- `--region <x,y,w,h>` — crop to a specific rectangle
- `--window <id>` — record a specific window (resolves geometry)
- `--fps <N>` — frame rate (default: 30)
- `--output <path>` — output file (default: `screencast_<timestamp>.mp4`)

All commands return JSON output.

## Workflow

### Step 1: Check Dependencies

` ``bash
node "$SCREENCAST_JS" deps
` ``

If ffmpeg is missing, tell the user:

- macOS: `brew install ffmpeg`
- Linux: `sudo apt install ffmpeg`
- Windows: `winget install ffmpeg` or download from ffmpeg.org

### Step 2: Choose What to Record

Ask the user what they want to record. Three options:

**Full screen (default):**
` ``bash
node "$SCREENCAST_JS" list-screens
` ``
Present the list. If only one screen, use it automatically.
Note the screen dimensions for reference.

**Specific window:**
` ``bash
node "$SCREENCAST_JS" list-windows
` ``
Present a numbered list showing app name, window title, and
dimensions. The user picks by number. Use the window's `id`
field with the `--window` flag.

**Custom region:**
The user provides coordinates as `x,y,width,height`. Offer the
screen dimensions as reference: "Your main display is 2560x1440.
Top-left is 0,0."

### Step 3: Confirm and Start

Before starting, confirm the selection:

> "Ready to record [target description] at 30fps to
> `screencast_YYYYMMDD_HHMMSS.mp4`. Say **start** when ready,
> and **stop** when you're done."

When the user says start:

` ``bash
node "$SCREENCAST_JS" start --window <id> --output <path>
# or: start --region <x,y,w,h> --output <path>
# or: start --screen <index> --output <path>
` ``

Confirm recording is active. The conversation continues normally
while recording runs in the background.

### Step 4: Stop Recording

When the user says "stop" or "stop recording":

` ``bash
node "$SCREENCAST_JS" stop
` ``

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

## Standalone Installation

1. Copy `SKILL.md` to `~/.claude/commands/screencast.md`
2. Copy `scripts/screencast.js` to `~/.local/bin/screencast.js`
   and `chmod +x` it
3. The fallback search will find it via `command -v screencast.js`
```

Note: fix the triple-backtick escaping above — in the actual file, use real triple backticks.

- [ ] **Step 2: Verify SKILL.md renders correctly**

Run: `head -5 skills/screencast/SKILL.md` to check frontmatter.

- [ ] **Step 3: Commit**

```bash
git add skills/screencast/SKILL.md
git commit -m "feat(screencast): add SKILL.md prompt for guided recording"
```

---

### Task 9: Update project files (README, plugin.json, CLAUDE.md)

**Files:**
- Modify: `README.md` — add screencast section
- Modify: `.claude-plugin/plugin.json` — add to description and keywords
- Modify: `.claude-plugin/marketplace.json` — add screencast to description
- Modify: `.claude/CLAUDE.md` — add to Available Skills table

- [ ] **Step 1: Add screencast to README.md**

After the `cdp-connect` section, add:

```markdown
### screencast

Guided screen recording from Claude Code. Pick a display, window, or
custom region, then start/stop recording on demand. Uses ffmpeg for
cross-platform support (macOS, Linux, Windows). Produces MP4 with
sensible defaults. Pairs with demo-narrate for voice-over.

**Dependencies:** ffmpeg (required), Node 22+

See [SKILL.md](skills/screencast/SKILL.md) for the full workflow.
```

- [ ] **Step 2: Update plugin.json**

Add "screencast (guided screen recording)" to the description string and add keywords: `"screencast"`, `"recording"`, `"screen-capture"`, `"ffmpeg"`.

- [ ] **Step 3: Update .claude/CLAUDE.md**

- [ ] **Step 3: Update marketplace.json**

Add "screencast (guided screen recording)" to the plugin description in `.claude-plugin/marketplace.json`.

- [ ] **Step 4: Update .claude/CLAUDE.md**

Add to the Available Skills table:

```markdown
| `screencast` | Guided screen recording with ffmpeg |
```

- [ ] **Step 5: Commit**

```bash
git add README.md .claude-plugin/plugin.json .claude-plugin/marketplace.json .claude/CLAUDE.md
git commit -m "docs: add screencast skill to README, plugin.json, and CLAUDE.md"
```

---

### Task 10: Sync and end-to-end test

**Files:** none created

- [ ] **Step 1: Run sync script**

```bash
./scripts/sync-skills.sh
```

Expected: "Synced N skills to ~/.claude/commands/" (N should increase by 1)

- [ ] **Step 2: Verify files are in place**

```bash
ls -la ~/.claude/commands/screencast.md
ls -la ~/.local/bin/screencast.js
```

- [ ] **Step 3: End-to-end smoke test**

```bash
# 1. Deps check
node ~/.local/bin/screencast.js deps

# 2. List screens
node ~/.local/bin/screencast.js list-screens

# 3. List windows
node ~/.local/bin/screencast.js list-windows

# 4. Record 5 seconds of full screen
node ~/.local/bin/screencast.js start --output /tmp/e2e-test.mp4
sleep 5
node ~/.local/bin/screencast.js stop

# 5. Verify output
ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/e2e-test.mp4
```

Expected: Each command returns valid JSON. Final MP4 is ~5 seconds, playable.

- [ ] **Step 4: Test window recording**

```bash
# Pick a window
node ~/.local/bin/screencast.js list-windows | head -5
# Start with a window ID from the list
node ~/.local/bin/screencast.js start --window <id> --output /tmp/e2e-window.mp4
sleep 5
node ~/.local/bin/screencast.js stop
```

Expected: MP4 showing only the selected window's region.

- [ ] **Step 5: Test region recording**

```bash
node ~/.local/bin/screencast.js start --region 0,0,800,600 --output /tmp/e2e-region.mp4
sleep 5
node ~/.local/bin/screencast.js stop
```

Expected: MP4 showing only the 800x600 top-left region.

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(screencast): fixes from end-to-end testing"
```

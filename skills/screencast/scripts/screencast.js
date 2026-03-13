#!/usr/bin/env node
'use strict';

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_FILE = path.join(os.homedir(), '.screencast.state');

function die(msg) {
  console.log(JSON.stringify({ error: msg }));
  process.exit(1);
}

function json(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function parseArgs(argv) {
  const flags = { fps: 30, screen: 0, region: null, window: null, output: null };
  const positional = [];
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--fps':    flags.fps    = parseInt(raw[++i], 10); break;
      case '--screen': flags.screen = parseInt(raw[++i], 10); break;
      case '--region': flags.region = raw[++i]; break;
      case '--window': flags.window = raw[++i]; break;
      case '--output': flags.output = raw[++i]; break;
      default: positional.push(raw[i]);
    }
  }
  return { command: positional[0], args: positional.slice(1), ...flags };
}

// ─── Platform detection ───────────────────────────────────────────────────────

const BACKEND_MAP = {
  darwin: 'avfoundation',
  linux:  'x11grab',
  win32:  'gdigrab',
};

function detectPlatform() {
  const platform = os.platform();
  const backend = BACKEND_MAP[platform] ?? 'x11grab';

  let ffmpeg = false;
  let ffmpegVersion = null;
  try {
    const out = execSync('ffmpeg -version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpeg = true;
    const match = out.match(/ffmpeg version (\S+)/);
    ffmpegVersion = match ? match[1] : 'unknown';
  } catch {
    // ffmpeg not found
  }

  return { platform, backend, ffmpeg, ffmpegVersion };
}

// ─── ffmpeg command builder ───────────────────────────────────────────────────

/**
 * Parse a region string "x,y,w,h" into numeric parts.
 * @param {string} region
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
function parseRegion(region) {
  const [x, y, w, h] = region.split(',').map(Number);
  return { x, y, w, h };
}

/**
 * Build an array of ffmpeg CLI args for screen recording.
 * @param {{
 *   backend: string,
 *   screenInput: string|null,
 *   fps: number,
 *   region: string|null,
 *   output: string,
 *   screenSize: string,
 *   display: string|null
 * }} opts
 * @returns {string[]}
 */
function buildFfmpegArgs({ backend, screenInput, fps, region, output, screenSize, display }) {
  const args = ['-y'];

  if (backend === 'avfoundation') {
    args.push('-f', 'avfoundation');
    args.push('-framerate', String(fps));
    args.push('-capture_cursor', '1');
    args.push('-i', `${screenInput}:none`);
    if (region) {
      const { x, y, w, h } = parseRegion(region);
      args.push('-vf', `crop=${w}:${h}:${x}:${y}`);
    }
  } else if (backend === 'x11grab') {
    args.push('-f', 'x11grab');
    args.push('-framerate', String(fps));
    if (region) {
      const { x, y, w, h } = parseRegion(region);
      args.push('-video_size', `${w}x${h}`);
      args.push('-i', `${display}+${x},${y}`);
    } else {
      args.push('-video_size', screenSize);
      args.push('-i', display);
    }
  } else if (backend === 'gdigrab') {
    args.push('-f', 'gdigrab');
    args.push('-framerate', String(fps));
    if (region) {
      const { x, y, w, h } = parseRegion(region);
      args.push('-offset_x', String(x));
      args.push('-offset_y', String(y));
      args.push('-video_size', `${w}x${h}`);
    }
    args.push('-i', 'desktop');
  }

  // Common output codec settings
  args.push('-c:v', 'libx264');
  args.push('-pix_fmt', 'yuv420p');
  args.push('-preset', 'ultrafast');
  args.push('-crf', '23');
  args.push(output);

  return args;
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

function cmdDeps() {
  const info = detectPlatform();
  if (!info.ffmpeg) {
    json({ error: 'ffmpeg not found. Install via: brew install ffmpeg', ...info });
    process.exit(1);
  }
  json(info);
}

function listWindowsDarwin() {
  // JXA script — no single quotes; use castRefToObject to unwrap CFDictionary entries
  const jxaScript = [
    'ObjC.import("CoreGraphics");',
    'ObjC.import("Foundation");',
    'var raw = $.CGWindowListCopyWindowInfo(1, 0);',
    'var count = $.CFArrayGetCount(raw);',
    'var result = [];',
    'for (var i = 0; i < count; i++) {',
    '  var info = ObjC.deepUnwrap(ObjC.castRefToObject($.CFArrayGetValueAtIndex(raw, i)));',
    '  if (!info || info.kCGWindowLayer !== 0) continue;',
    '  if (!info.kCGWindowOwnerName) continue;',
    '  var b = info.kCGWindowBounds || {};',
    '  result.push({',
    '    id: info.kCGWindowNumber,',
    '    app: info.kCGWindowOwnerName,',
    '    title: info.kCGWindowName || "",',
    '    x: b.X || 0,',
    '    y: b.Y || 0,',
    '    w: b.Width || 0,',
    '    h: b.Height || 0',
    '  });',
    '}',
    'JSON.stringify(result);',
  ].join('\n');

  const result = spawnSync('osascript', ['-l', 'JavaScript', '-e', jxaScript], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    die(`osascript failed: ${result.stderr}`);
  }

  const windows = JSON.parse(result.stdout.trim());
  json(windows);
}

function listWindowsLinux() {
  const out = execSync('wmctrl -lG', { encoding: 'utf8' });
  const windows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(0x\w+)\s+\d+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)/);
    if (!m) continue;
    windows.push({
      id: m[1],
      app: '',
      title: m[6].trim(),
      x: parseInt(m[2], 10),
      y: parseInt(m[3], 10),
      w: parseInt(m[4], 10),
      h: parseInt(m[5], 10),
    });
  }
  json(windows);
}

function listWindowsWindows() {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$list = [System.Collections.Generic.List[object]]::new()
[Win32]::EnumWindows({
  param($hWnd)
  if ([Win32]::IsWindowVisible($hWnd)) {
    $sb = [System.Text.StringBuilder]::new(256)
    [Win32]::GetWindowText($hWnd, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t.Length -gt 0) {
      $r = [Win32+RECT]::new()
      [Win32]::GetWindowRect($hWnd, [ref]$r) | Out-Null
      $list.Add([PSCustomObject]@{
        id = $hWnd.ToInt64(); app = ""; title = $t;
        x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top
      })
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$list | ConvertTo-Json -Compress
`.trim();
  const out = execSync(`powershell -Command "${ps}"`, { encoding: 'utf8' });
  const windows = JSON.parse(out.trim());
  json(Array.isArray(windows) ? windows : [windows]);
}

function cmdListWindows() {
  const { platform } = detectPlatform();
  if (platform === 'darwin') {
    listWindowsDarwin();
  } else if (platform === 'linux') {
    listWindowsLinux();
  } else {
    listWindowsWindows();
  }
}

function listScreensDarwin() {
  // Get device indices from avfoundation
  const devOut = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const devText = (devOut.stdout || '') + (devOut.stderr || '');

  const screens = [];
  const re = /\[(\d+)\]\s+Capture screen (\d+)/g;
  let m;
  while ((m = re.exec(devText)) !== null) {
    screens.push({ index: parseInt(m[1], 10), name: `Capture screen ${m[2]}` });
  }

  // Get resolution and Retina scale from system_profiler
  let displayData = [];
  try {
    const spOut = execSync('system_profiler SPDisplaysDataType -json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const spJson = JSON.parse(spOut);
    const displays = spJson.SPDisplaysDataType?.[0]?.spdisplays_ndrvs ?? [];
    displayData = displays.map((d) => {
      const resStr = d['_spdisplays_resolution'] ?? d['spdisplays_resolution'] ?? '';
      const reRes = /(\d+)\s*[xX×]\s*(\d+)/;
      const rm = resStr.match(reRes);
      const width = rm ? parseInt(rm[1], 10) : null;
      const height = rm ? parseInt(rm[2], 10) : null;
      const isRetina = (d['spdisplays_retina'] ?? '') === 'spdisplays_yes';
      return { width, height, scale: isRetina ? 2 : 1 };
    });
  } catch {
    // system_profiler failed — continue without resolution
  }

  const result = screens.map((s, i) => ({
    index: s.index,
    name: s.name,
    width: displayData[i]?.width ?? null,
    height: displayData[i]?.height ?? null,
    scale: displayData[i]?.scale ?? 1,
  }));

  json(result);
}

function listScreensLinux() {
  const out = execSync('xrandr --query', { encoding: 'utf8' });
  const re = /^(\S+)\s+connected.*?(\d+)x(\d+)\+\d+\+\d+/gm;
  const screens = [];
  let m;
  let index = 0;
  while ((m = re.exec(out)) !== null) {
    screens.push({
      index,
      name: m[1],
      width: parseInt(m[2], 10),
      height: parseInt(m[3], 10),
      scale: 1,
    });
    index++;
  }
  json(screens);
}

function listScreensWindows() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms;
$screens = [System.Windows.Forms.Screen]::AllScreens;
$arr = @();
for ($i = 0; $i -lt $screens.Length; $i++) {
  $s = $screens[$i];
  $arr += [PSCustomObject]@{
    index = $i;
    name = $s.DeviceName;
    width = $s.Bounds.Width;
    height = $s.Bounds.Height;
    scale = 1;
  };
}
$arr | ConvertTo-Json -Compress
`.trim();
  const out = execSync(`powershell -Command "${ps}"`, { encoding: 'utf8' });
  const screens = JSON.parse(out.trim());
  json(Array.isArray(screens) ? screens : [screens]);
}

function cmdListScreens() {
  const { platform } = detectPlatform();
  if (platform === 'darwin') {
    listScreensDarwin();
  } else if (platform === 'linux') {
    listScreensLinux();
  } else {
    listScreensWindows();
  }
}

function cmdStart(opts) {
  json({ message: 'start not yet implemented', opts });
}

function cmdStop() {
  json({ message: 'stop not yet implemented' });
}

function cmdStatus() {
  json({ message: 'status not yet implemented' });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv);

  switch (opts.command) {
    case 'deps':         cmdDeps(); break;
    case 'list-windows': cmdListWindows(); break;
    case 'list-screens': cmdListScreens(); break;
    case 'start':        cmdStart(opts); break;
    case 'stop':         cmdStop(); break;
    case 'status':       cmdStatus(); break;
    default:
      process.stderr.write([
        'Usage: screencast.js <command> [flags]',
        '',
        'Commands:',
        '  deps                           Check dependencies',
        '  list-screens                   List available screens',
        '  list-windows                   List capturable windows',
        '  start [flags]                  Start recording',
        '    --fps N          Frame rate (default: 30)',
        '    --screen N       Screen index (default: 0)',
        '    --region X,Y,W,H Capture region',
        '    --window NAME    Capture specific window',
        '    --output PATH    Output file (default: auto-named .mp4)',
        '  stop                           Stop recording',
        '  status                         Show recording status',
      ].join('\n') + '\n');
      process.exit(opts.command ? 1 : 0);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { parseArgs, detectPlatform, buildFfmpegArgs };
}

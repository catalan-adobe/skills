#!/usr/bin/env node
'use strict';

const { execSync } = require('node:child_process');
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

function cmdListWindows() {
  json({ message: 'list-windows not yet implemented' });
}

function cmdListScreens() {
  json({ message: 'list-screens not yet implemented' });
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

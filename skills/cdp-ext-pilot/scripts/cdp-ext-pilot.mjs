#!/usr/bin/env node
// ESM module (.mjs) — uses Node 22 built-in WebSocket global (no import needed)
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
         unlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform, arch } from 'node:os';

const DEFAULT_PORT = 9222;
const CACHE_DIR = join(process.env.HOME, '.cache', 'cdp-ext-pilot');
const CfT_DIR = join(CACHE_DIR, 'chrome-for-testing');
const CfT_VERSIONS_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { port: DEFAULT_PORT };
  const positional = [];
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--port') flags.port = parseInt(raw[++i], 10);
    else positional.push(raw[i]);
  }
  return { command: positional[0], args: positional.slice(1), ...flags };
}

function sessionPath(port) {
  return `/tmp/ext-pilot-session-${port}.json`;
}

function loadSession(port) {
  const p = sessionPath(port);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return null; }
}

function saveSession(port, data) {
  writeFileSync(sessionPath(port), JSON.stringify(data, null, 2));
}

// --- Chrome Detection ---

function detectChrome() {
  // 1. Chrome for Testing in cache
  if (existsSync(CfT_DIR)) {
    const versions = readdirSync(CfT_DIR).sort().reverse();
    for (const v of versions) {
      const bin = cftBinaryPath(join(CfT_DIR, v));
      if (bin && existsSync(bin)) return { path: bin, variant: 'chrome-for-testing' };
    }
  }

  // 2. Chrome for Testing on PATH
  try {
    const p = execSync('command -v chrome-for-testing 2>/dev/null', { encoding: 'utf8' }).trim();
    if (p) return { path: p, variant: 'chrome-for-testing' };
  } catch {}

  // 3. Chromium
  const chromiumPaths = platform() === 'darwin'
    ? ['/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/chromium-browser', '/usr/bin/chromium'];
  for (const p of chromiumPaths) {
    if (existsSync(p)) return { path: p, variant: 'chromium' };
  }

  // 4. Branded Chrome (triggers pipe path)
  const brandedPaths = platform() === 'darwin'
    ? [
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  for (const p of brandedPaths) {
    if (existsSync(p)) return { path: p, variant: 'branded' };
  }

  return null;
}

function cftBinaryPath(versionDir) {
  if (platform() === 'darwin') {
    const app = join(versionDir, 'Google Chrome for Testing.app',
      'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(app)) return app;
    // Alternate structure
    const alt = join(versionDir, 'chrome-mac-arm64',
      'Google Chrome for Testing.app', 'Contents', 'MacOS',
      'Google Chrome for Testing');
    if (existsSync(alt)) return alt;
    // Also check chrome-mac-x64
    const altx = join(versionDir, 'chrome-mac-x64',
      'Google Chrome for Testing.app', 'Contents', 'MacOS',
      'Google Chrome for Testing');
    if (existsSync(altx)) return altx;
  } else {
    const bin = join(versionDir, 'chrome-linux64', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return null;
}

// --- Chrome for Testing Install ---

async function installChromeForTesting() {
  console.error('Downloading Chrome for Testing...');
  const res = await fetch(CfT_VERSIONS_URL);
  if (!res.ok) die(`Failed to fetch CfT versions: ${res.status}`);
  const data = await res.json();
  const stable = data.channels.Stable;
  const version = stable.version;

  const plat = platform() === 'darwin'
    ? (arch() === 'arm64' ? 'mac-arm64' : 'mac-x64')
    : 'linux64';
  const download = stable.downloads.chrome.find(d => d.platform === plat);
  if (!download) die(`No Chrome for Testing build for platform: ${plat}`);

  const destDir = join(CfT_DIR, version);
  if (existsSync(destDir)) {
    const bin = cftBinaryPath(destDir);
    if (bin) { console.error(`Chrome for Testing ${version} already cached.`); return bin; }
  }

  mkdirSync(destDir, { recursive: true });
  const zipPath = join(destDir, 'chrome.zip');
  console.error(`Downloading ${download.url}...`);
  const dlRes = await fetch(download.url);
  if (!dlRes.ok) die(`Download failed: ${dlRes.status}`);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  writeFileSync(zipPath, buf);

  console.error('Extracting...');
  execSync(`unzip -q -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });
  unlinkSync(zipPath);

  const bin = cftBinaryPath(destDir);
  if (!bin) die('Chrome for Testing binary not found after extraction');

  // Verify
  try {
    const ver = execSync(`"${bin}" --version 2>/dev/null`, { encoding: 'utf8' }).trim();
    console.error(`Installed: ${ver}`);
  } catch {
    console.error('Warning: could not verify Chrome version');
  }
  return bin;
}

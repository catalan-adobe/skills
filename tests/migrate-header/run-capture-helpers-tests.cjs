#!/usr/bin/env node
/**
 * Standalone integration test for capture-helpers.js via initScript.
 * Uses data: URLs to avoid HTTP server + execFileSync event loop conflict.
 * Outputs JSON results to stdout.
 */
const { execFileSync } = require('node:child_process');
const { writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const HELPERS_PATH = join(
  __dirname, '..', '..', 'skills', 'migrate-header', 'scripts', 'capture-helpers.js'
);
const SESSION = `test-helpers-${Date.now()}`;
const OPTS = { encoding: 'utf-8', timeout: 15000 };

function cli(...args) {
  return execFileSync(
    'playwright-cli', [`-s=${SESSION}`, ...args], OPTS
  ).trim();
}

function parseEvalOutput(raw) {
  const idx = raw.indexOf('### Result');
  const codeIdx = raw.indexOf('### Ran Playwright code');
  if (idx === -1) return raw;
  const start = idx + '### Result'.length;
  const end = codeIdx !== -1 ? codeIdx : raw.length;
  let value = raw.slice(start, end).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = JSON.parse(value);
  }
  return value;
}

function cliEval(js) {
  return parseEvalOutput(cli('eval', js));
}

const HTML = `<body style="margin:0">
<header style="width:1440px;height:80px;background:rgb(26,26,46);display:flex;align-items:center">
<nav><ul style="display:flex;gap:20px;list-style:none;margin:0;padding:0">
<li><a href="/products">Products</a>
  <div style="display:none"><ul>
    <li><a href="/products/featured">Featured Product Alpha</a></li>
    <li><a href="/products/new">New Release Beta</a></li>
  </ul></div>
</li>
<li><a href="/solutions">Solutions</a>
  <div style="visibility:hidden;position:absolute"><ul>
    <li><a href="/solutions/enterprise">Enterprise</a></li>
  </ul></div>
</li>
<li><a href="/resources">Resources</a>
  <div style="opacity:0;position:absolute"><ul>
    <li><a href="/resources/docs">Documentation</a></li>
  </ul></div>
</li>
</ul></nav></header>
<main style="height:2000px"><p>Content</p></main></body>`;

const DATA_URL = 'data:text/html,' + encodeURIComponent(HTML);

const configPath = join(tmpdir(), `test-config-${Date.now()}.json`);
writeFileSync(configPath, JSON.stringify({
  browser: { initScript: [HELPERS_PATH] },
}));

const results = { passed: false };

try {
  cli('open', DATA_URL, `--config=${configPath}`);
  execFileSync('sleep', ['2']);

  results.globalType = cliEval('typeof window.__captureHelpers');

  const headerRaw = cliEval(
    "window.__captureHelpers.captureHeaderDOM('header', ['backgroundColor'])"
  );
  results.headerTree = JSON.parse(headerRaw);

  const missingRaw = cliEval(
    "window.__captureHelpers.captureHeaderDOM('.nonexistent', [])"
  );
  results.missingSelector = JSON.parse(missingRaw);

  const navRaw = cliEval(
    "window.__captureHelpers.extractNavItems('header')"
  );
  results.navItems = JSON.parse(navRaw);

  const missingNavRaw = cliEval(
    "window.__captureHelpers.extractNavItems('.nonexistent')"
  );
  results.missingNav = JSON.parse(missingNavRaw);

  results.passed = true;
} finally {
  try { cli('close'); } catch { /* ignore */ }
  try { unlinkSync(configPath); } catch { /* ignore */ }
}

console.log(JSON.stringify(results));

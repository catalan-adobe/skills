#!/usr/bin/env node
/**
 * Standalone integration test for visual-tree-bundle.js via initScript.
 * Uses data: URLs to avoid HTTP server + execFileSync event loop conflict.
 * Outputs JSON results to stdout.
 */
const { execFileSync } = require('node:child_process');
const { writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const BUNDLE_PATH = join(
  __dirname, '..', '..', 'skills', 'visual-tree', 'scripts', 'visual-tree-bundle.js'
);
const SESSION = `test-vt-${Date.now()}`;
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
  // Strip outer quotes with slice — NOT JSON.parse. playwright-cli wraps
  // string results in quotes without proper escaping, so CSS url("...")
  // values break JSON.parse.
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value;
}

function cliEval(js) {
  return parseEvalOutput(cli('eval', js));
}

const HTML = `<body style="margin:0">
<div id="cookie" style="position:fixed;top:0;left:0;width:100%;height:50px;background:rgba(0,0,0,0.8);z-index:9999;color:white">Cookie banner</div>
<header style="width:100%;height:80px;background:rgb(26,26,46);display:flex;align-items:center;padding:0 20px;box-sizing:border-box">
<div style="width:120px;height:40px;background:white">Logo</div>
<nav style="display:flex;gap:24px;margin-left:40px">
<a href="/one" style="color:white">One</a>
<a href="/two" style="color:white">Two</a>
<a href="/three" style="color:white">Three</a>
</nav></header>
<main style="height:3000px;padding:100px 20px">
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;width:100%">
<div style="height:200px;background:#eee">Card 1</div>
<div style="height:200px;background:#eee">Card 2</div>
<div style="height:200px;background:#eee">Card 3</div>
</div></main></body>`;

const DATA_URL = 'data:text/html,' + encodeURIComponent(HTML);

const configPath = join(tmpdir(), `test-vt-config-${Date.now()}.json`);
writeFileSync(configPath, JSON.stringify({
  browser: { initScript: [BUNDLE_PATH] },
}));

const results = { passed: false };

try {
  cli('open', DATA_URL, `--config=${configPath}`);
  execFileSync('sleep', ['2']);

  results.globalType = cliEval('typeof window.__visualTree');

  const keysRaw = cliEval(
    'Object.keys(window.__visualTree.captureVisualTree(0))'
  );
  results.keys = JSON.parse(keysRaw);

  results.textFormat = cliEval(
    'window.__visualTree.captureVisualTree(0).textFormat'
  );

  const nodeMapRaw = cliEval(
    'window.__visualTree.captureVisualTree(0).nodeMap'
  );
  const nodeMap = JSON.parse(nodeMapRaw);
  results.nodeMapKeys = Object.keys(nodeMap);
  results.rootSelector = nodeMap.r?.selector;

  const dataRaw = cliEval(
    '({tag: window.__visualTree.captureVisualTree(0).data.tag, childCount: window.__visualTree.captureVisualTree(0).data.children.length})'
  );
  const dataInfo = JSON.parse(dataRaw);
  results.rootTag = dataInfo.tag;
  results.childCount = dataInfo.childCount;

  results.allLines = cliEval(
    'window.__visualTree.captureVisualTree(0).textFormat'
  ).split('\n').filter(Boolean).length;

  results.filteredLines = cliEval(
    'window.__visualTree.captureVisualTree(1024).textFormat'
  ).split('\n').filter(Boolean).length;

  const fullRaw = cliEval(
    'window.__visualTree.captureVisualTree(1024)'
  );
  try {
    JSON.parse(fullRaw);
    results.fullCaptureValid = true;
  } catch {
    results.fullCaptureValid = false;
  }

  results.passed = true;
} finally {
  try { cli('close'); } catch { /* ignore */ }
  try { unlinkSync(configPath); } catch { /* ignore */ }
}

console.log(JSON.stringify(results));

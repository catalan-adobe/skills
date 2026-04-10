#!/usr/bin/env node

/**
 * Captures a visual tree from a URL using the visual-tree skill's bundle.
 *
 * Locates the visual-tree bundle, builds a playwright-cli config with
 * initScript (merging browser-recipe if provided), opens the page,
 * captures the spatial hierarchy, and saves artifacts.
 *
 * IMPORTANT: Leaves the playwright-cli session OPEN for downstream use
 * (overlay dismissal, header detection). Caller must close it.
 *
 * Usage:
 *   node capture-visual-tree.js <url> <output-dir> \
 *     [--browser-recipe=path] [--session=visual-tree]
 *
 * Outputs (in output-dir):
 *   visual-tree.json  — full visual tree with nodeMap
 *   visual-tree.txt   — LLM-friendly text format
 *   overlays.json     — detected overlay entries
 *
 * Exit codes: 0 = success, 1 = bundle not found, 2 = capture failed
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEvalOutput } from './cdp-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 60000,
};

function log(msg) {
  console.error(msg);
}

export function parseArgs(argv) {
  const positional = [];
  let browserRecipe = null;
  let session = 'visual-tree';

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--browser-recipe=')) {
      browserRecipe = arg.split('=').slice(1).join('=');
    } else if (arg.startsWith('--session=')) {
      session = arg.split('=').slice(1).join('=');
    } else {
      positional.push(arg);
    }
  }

  if (positional.length < 2) {
    console.error(
      'Usage: node capture-visual-tree.js <url> <output-dir>'
      + ' [--browser-recipe=path] [--session=name]',
    );
    process.exit(1);
  }

  return {
    url: positional[0],
    outputDir: resolve(positional[1]),
    browserRecipe: browserRecipe ? resolve(browserRecipe) : null,
    session,
  };
}

export function locateBundle() {
  const skillDir = process.env.CLAUDE_SKILL_DIR;
  if (skillDir) {
    const path = join(dirname(skillDir), 'visual-tree', 'scripts', 'visual-tree-bundle.js');
    if (existsSync(path)) return path;
  }

  const home = process.env.HOME || '/tmp';
  const candidates = [
    join(home, '.claude', 'skills', 'visual-tree', 'scripts', 'visual-tree-bundle.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return null;
}

function cli(session, ...args) {
  return execFileSync(
    'playwright-cli',
    [`-s=${session}`, ...args],
    EXEC_OPTS,
  ).trim();
}

export function buildConfig(bundlePath, browserRecipePath) {
  const config = { browser: {} };
  let stealthTmpFile = null;

  if (browserRecipePath && existsSync(browserRecipePath)) {
    const recipe = JSON.parse(readFileSync(browserRecipePath, 'utf-8'));
    const cliConf = recipe.cliConfig || {};
    Object.assign(config.browser, cliConf.browser || {});

    // Write stealth script to temp file if present in recipe
    if (recipe.stealthInitScript) {
      stealthTmpFile = join(
        tmpdir(), `vt-stealth-${process.pid}.js`,
      );
      writeFileSync(stealthTmpFile, recipe.stealthInitScript);
    }
  }

  const existing = config.browser.initScript;
  const scripts = Array.isArray(existing)
    ? existing
    : existing ? [existing] : [];

  // Stealth first (must run before page scripts), then bundle last
  if (stealthTmpFile) scripts.unshift(stealthTmpFile);
  scripts.push(bundlePath);
  config.browser.initScript = scripts;

  return { config, stealthTmpFile };
}

function main() {
  const args = parseArgs(process.argv);
  mkdirSync(args.outputDir, { recursive: true });

  const bundle = locateBundle();
  if (!bundle) {
    log('ERROR: visual-tree bundle not found.');
    log('Install: sync visual-tree skill to ~/.claude/skills/');
    process.exit(1);
  }
  log(`Located visual-tree bundle: ${bundle}`);

  const configPath = join(tmpdir(), `vt-config-${process.pid}.json`);
  const rawPath = join(tmpdir(), `vt-raw-${process.pid}.txt`);
  const { config, stealthTmpFile } = buildConfig(bundle, args.browserRecipe);
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  try {
    cli(args.session, 'open', args.url, `--config=${configPath}`);
    cli(args.session, 'eval', 'document.readyState');
    execFileSync('sleep', ['2']);

    const raw = cli(
      args.session,
      'eval',
      'window.__visualTree.captureVisualTree(1024)',
    );
    writeFileSync(rawPath, raw);

    const value = parseEvalOutput(readFileSync(rawPath, 'utf-8'));
    const result = JSON.parse(value);

    writeFileSync(
      join(args.outputDir, 'visual-tree.json'),
      JSON.stringify(result, null, 2),
    );
    writeFileSync(
      join(args.outputDir, 'visual-tree.txt'),
      result.textFormat,
    );

    const overlays = [];
    for (const [id, info] of Object.entries(result.nodeMap)) {
      if (info.overlay) {
        overlays.push({
          nodeId: id,
          selector: info.selector,
          occluding: info.overlay.occluding,
        });
      }
    }
    writeFileSync(
      join(args.outputDir, 'overlays.json'),
      JSON.stringify(overlays, null, 2),
    );

    const nodeCount = result.textFormat.split('\n').length;
    log(`Visual tree captured: ${nodeCount} nodes, ${overlays.length} overlays`);
  } catch (err) {
    log(`ERROR: Visual tree capture failed: ${err.message}`);
    process.exit(2);
  } finally {
    for (const f of [configPath, rawPath, stealthTmpFile].filter(Boolean)) {
      try { unlinkSync(f); } catch { /* noop */ }
    }
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}

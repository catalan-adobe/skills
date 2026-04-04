#!/usr/bin/env node

/**
 * Fallback overlay detection using page-prep's CMP database.
 * Used when visual-tree capture fails or is unavailable.
 *
 * Refreshes the page-prep overlay database, generates a detection bundle,
 * injects it via playwright-cli initScript, extracts the report, and
 * converts it to an overlay recipe.
 *
 * Usage:
 *   node detect-overlays-fallback.js <url> <output-dir> \
 *     [--browser-recipe=path] [--page-prep-dir=path]
 *
 * Outputs (in output-dir):
 *   overlay-recipe.json — { selectors: [...], action: "remove" }
 *
 * Exit codes: 0 = success (recipe written), 1 = page-prep not found,
 *             2 = detection failed (empty recipe written as fallback)
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEvalOutput } from './cdp-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION = 'overlay-detect';
const EMPTY_RECIPE = { selectors: [], action: 'remove' };

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
  let pagePrepDir = null;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--browser-recipe=')) {
      browserRecipe = arg.split('=').slice(1).join('=');
    } else if (arg.startsWith('--page-prep-dir=')) {
      pagePrepDir = arg.split('=').slice(1).join('=');
    } else {
      positional.push(arg);
    }
  }

  if (positional.length < 2) {
    console.error(
      'Usage: node detect-overlays-fallback.js <url> <output-dir>'
      + ' [--browser-recipe=path] [--page-prep-dir=path]',
    );
    process.exit(1);
  }

  return {
    url: positional[0],
    outputDir: resolve(positional[1]),
    browserRecipe: browserRecipe ? resolve(browserRecipe) : null,
    pagePrepDir: pagePrepDir ? resolve(pagePrepDir) : null,
  };
}

export function locatePagePrep(explicitDir) {
  if (explicitDir && existsSync(join(explicitDir, 'overlay-db.js'))) {
    return explicitDir;
  }

  const skillDir = process.env.CLAUDE_SKILL_DIR;
  if (skillDir) {
    const path = join(dirname(skillDir), 'page-prep', 'scripts');
    if (existsSync(join(path, 'overlay-db.js'))) return path;
  }

  const home = process.env.HOME || '/tmp';
  const path = join(home, '.claude', 'skills', 'page-prep', 'scripts');
  if (existsSync(join(path, 'overlay-db.js'))) return path;

  return null;
}

function cli(...args) {
  return execFileSync('playwright-cli', [`-s=${SESSION}`, ...args], EXEC_OPTS).trim();
}

function writeRecipe(outputDir, recipe) {
  writeFileSync(
    join(outputDir, 'overlay-recipe.json'),
    JSON.stringify(recipe, null, 2),
  );
}

function main() {
  const args = parseArgs(process.argv);
  mkdirSync(args.outputDir, { recursive: true });

  const prepDir = locatePagePrep(args.pagePrepDir);
  if (!prepDir) {
    log('WARNING: page-prep skill not found. Writing empty recipe.');
    writeRecipe(args.outputDir, EMPTY_RECIPE);
    process.exit(1);
  }
  log(`Located page-prep: ${prepDir}`);

  const tmp = tmpdir();
  const pid = process.pid;
  const bundleFile = join(tmp, `overlay-bundle-${pid}.js`);
  const configFile = join(tmp, `overlay-detect-config-${pid}.json`);
  const stealthFile = join(tmp, `overlay-stealth-${pid}.js`);

  try {
    execSync(`node "${join(prepDir, 'overlay-db.js')}" refresh`, {
      encoding: 'utf-8', stdio: 'pipe',
    });

    const bundle = execSync(
      `node "${join(prepDir, 'overlay-db.js')}" bundle`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    writeFileSync(bundleFile, `window.__overlayReport = ${bundle};`);

    const config = { browser: { initScript: [bundleFile] } };
    if (args.browserRecipe && existsSync(args.browserRecipe)) {
      const recipe = JSON.parse(readFileSync(args.browserRecipe, 'utf-8'));
      const cliConf = recipe.cliConfig || {};
      Object.assign(config.browser, cliConf.browser || {});
      if (recipe.stealthInitScript) {
        writeFileSync(stealthFile, recipe.stealthInitScript);
        config.browser.initScript.unshift(stealthFile);
      }
    }
    writeFileSync(configFile, JSON.stringify(config, null, 2));

    cli('open', args.url, `--config=${configFile}`);
    const reportRaw = cli('eval', 'window.__overlayReport || {}');
    cli('close');

    const parsed = parseEvalOutput(reportRaw);
    let report;
    try {
      report = JSON.parse(parsed);
    } catch {
      log('WARNING: Could not parse overlay report. Writing empty recipe.');
      writeRecipe(args.outputDir, EMPTY_RECIPE);
      process.exit(2);
    }

    const selectors = (report.overlays || [])
      .map((o) => o.selector)
      .filter(Boolean);

    const recipe = { selectors, action: 'remove' };
    writeRecipe(args.outputDir, recipe);
    log(`Overlay detection: ${selectors.length} overlays found.`);
  } catch (err) {
    log(`WARNING: Overlay detection failed: ${err.message}`);
    writeRecipe(args.outputDir, EMPTY_RECIPE);
    try { cli('close'); } catch { /* noop */ }
    process.exit(2);
  } finally {
    for (const f of [bundleFile, configFile, stealthFile]) {
      try { unlinkSync(f); } catch { /* noop */ }
    }
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}

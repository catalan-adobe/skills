#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { PNG } = require(join(__dirname, 'node_modules', 'pngjs'));

const SESSION = 'header-capture';

const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
};

// Minimal computed styles kept for extract-layout.js row classification.
// Full CSS extraction is handled by extract-styles.js via CDP.
const STYLE_PROPS = ['backgroundColor', 'borderRadius'];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
];

function log(msg) {
  console.error(msg);
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let headerSelector = 'header';
  let overlayRecipe = null;
  let browserRecipe = null;

  for (const arg of args) {
    if (arg.startsWith('--header-selector=')) {
      headerSelector = arg.split('=')[1];
    } else if (arg.startsWith('--overlay-recipe=')) {
      overlayRecipe = arg.split('=')[1];
    } else if (arg.startsWith('--browser-recipe=')) {
      const val = arg.split('=')[1];
      browserRecipe = val || null;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length < 2) {
    console.error(
      'Usage: node capture-snapshot.js <url> <output-dir>'
      + ' [--header-selector=header]'
      + ' [--overlay-recipe=path/to/recipe.json]'
      + ' [--browser-recipe=path/to/recipe.json]'
    );
    process.exit(1);
  }

  return {
    url: positional[0],
    outputDir: resolve(positional[1]),
    headerSelector,
    overlayRecipe,
    browserRecipe,
  };
}

export function buildRecipeArgs(recipePath) {
  const helpersPath = join(__dirname, 'capture-helpers.js');

  if (!recipePath) {
    // No browser recipe — still need initScript for capture helpers
    const configPath = join(
      tmpdir(),
      `header-capture-config-${Date.now()}.json`
    );
    const config = { browser: { initScript: [helpersPath] } };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return {
      extraArgs: [`--config=${configPath}`],
      configPath,
      tempFiles: [configPath],
    };
  }

  let recipe;
  try {
    recipe = JSON.parse(readFileSync(recipePath, 'utf-8'));
  } catch (err) {
    console.error(
      `Failed to load browser recipe from ${recipePath}: ${err.message}`
    );
    process.exit(1);
  }

  const tempFiles = [];
  const config = { ...recipe.cliConfig };
  if (!config.browser) config.browser = {};

  // Always inject capture-helpers.js via initScript
  config.browser.initScript = [helpersPath];

  // Write stealth script to a temp file and prepend to initScript
  if (recipe.stealthInitScript) {
    const stealthPath = join(
      tmpdir(),
      `header-capture-stealth-${Date.now()}.js`
    );
    writeFileSync(stealthPath, recipe.stealthInitScript);
    tempFiles.push(stealthPath);
    config.browser.initScript.unshift(stealthPath);
  }

  const configPath = join(
    tmpdir(),
    `header-capture-config-${Date.now()}.json`
  );
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  tempFiles.push(configPath);

  const extraArgs = [`--config=${configPath}`];
  if (recipe.persistent) {
    extraArgs.push('--persistent');
  }

  return { extraArgs, configPath, tempFiles };
}

function cli(...args) {
  return execFileSync(
    'playwright-cli', [`-s=${SESSION}`, ...args], EXEC_OPTS
  ).trim();
}

function parseEvalOutput(raw) {
  const resultIdx = raw.indexOf('### Result');
  const codeIdx = raw.indexOf('### Ran Playwright code');
  if (resultIdx === -1) return raw;
  const start = resultIdx + '### Result'.length;
  const end = codeIdx !== -1 ? codeIdx : raw.length;
  let value = raw.slice(start, end).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = JSON.parse(value);
  }
  return value;
}

function cliEval(js) {
  const raw = cli('eval', js);
  return parseEvalOutput(raw);
}

function verifyInstalled() {
  try {
    execFileSync('playwright-cli', ['--version'], EXEC_OPTS);
  } catch {
    console.error(
      'playwright-cli not found.'
      + ' Install with: npm install -g @playwright/cli@latest'
    );
    process.exit(1);
  }
}

function openPage(url, recipeArgs) {
  log(`Opening ${url}...`);
  cli('open', url, ...recipeArgs.extraArgs);
}

function waitForStable() {
  for (let i = 0; i < 10; i++) {
    const state = cliEval('document.readyState');
    if (state === 'complete') return;
  }
  log('  Page did not reach readyState=complete, proceeding anyway');
}

function applyOverlayRecipe(recipePath) {
  const recipe = JSON.parse(readFileSync(recipePath, 'utf-8'));
  const selectors = recipe?.selectors;
  if (!Array.isArray(selectors) || selectors.length === 0) return;

  log('  Removing overlay elements...');
  for (const selector of selectors) {
    const escaped = selector.replace(/'/g, "\\'");
    const js = `document.querySelectorAll('${escaped}')`
      + `.forEach(el => el.remove())`;
    cliEval(js);
  }
}

function captureHeaderDOM(headerSelector) {
  log('  Extracting header DOM...');

  const selectorEscaped = headerSelector.replace(/'/g, "\\'");
  const stylePropsJSON = JSON.stringify(STYLE_PROPS);

  // Pure expression — calls initScript-injected helper
  const raw = cliEval(
    `window.__captureHelpers.captureHeaderDOM('${selectorEscaped}', ${stylePropsJSON})`
  );
  return JSON.parse(raw);
}

function extractNavItems(headerSelector) {
  log('  Extracting nav items...');

  const selectorEscaped = headerSelector.replace(/'/g, "\\'");

  // Pure expression — calls initScript-injected helper
  const raw = cliEval(
    `window.__captureHelpers.extractNavItems('${selectorEscaped}')`
  );
  return JSON.parse(raw);
}

function cropHeader(fullPath, cropPath, headerSelector) {
  const selectorEscaped = headerSelector.replace(/'/g, "\\'");
  const rectRaw = cliEval(
    `JSON.stringify(document.querySelector('${selectorEscaped}')?.getBoundingClientRect()?.toJSON() || null)`
  );
  const rect = JSON.parse(rectRaw);
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;

  const fullBuf = readFileSync(fullPath);
  const full = PNG.sync.read(fullBuf);
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(Math.round(rect.width), full.width - x);
  const h = Math.min(Math.round(rect.height), full.height - y);
  if (w <= 0 || h <= 0) return false;

  const cropped = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const srcIdx = ((y + row) * full.width + (x + col)) * 4;
      const dstIdx = (row * w + col) * 4;
      cropped.data[dstIdx] = full.data[srcIdx];
      cropped.data[dstIdx + 1] = full.data[srcIdx + 1];
      cropped.data[dstIdx + 2] = full.data[srcIdx + 2];
      cropped.data[dstIdx + 3] = full.data[srcIdx + 3];
    }
  }
  writeFileSync(cropPath, PNG.sync.write(cropped));
  return true;
}

function captureScreenshots(outputDir, headerSelector) {
  log('  Taking screenshots...');

  const screenshots = {};

  for (const vp of VIEWPORTS) {
    cli('resize', String(vp.width), String(vp.height));

    const filename = `${vp.name}.png`;
    const filepath = join(outputDir, filename);
    const fullPath = join(outputDir, `${vp.name}-full.png`);

    // Take full viewport screenshot
    cli('screenshot', `--filename=${fullPath}`);

    // Crop header from full screenshot
    const cropped = cropHeader(fullPath, filepath, headerSelector);
    if (!cropped) {
      log(
        `  Header not visible at ${vp.width}x${vp.height},`
        + ' using top-120px fallback'
      );
      // Fallback: crop top 120px from full screenshot
      const fullBuf = readFileSync(fullPath);
      const full = PNG.sync.read(fullBuf);
      const h = Math.min(120, full.height);
      const fallback = new PNG({ width: full.width, height: h });
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < full.width; col++) {
          const srcIdx = (row * full.width + col) * 4;
          const dstIdx = (row * full.width + col) * 4;
          fallback.data[dstIdx] = full.data[srcIdx];
          fallback.data[dstIdx + 1] = full.data[srcIdx + 1];
          fallback.data[dstIdx + 2] = full.data[srcIdx + 2];
          fallback.data[dstIdx + 3] = full.data[srcIdx + 3];
        }
      }
      writeFileSync(filepath, PNG.sync.write(fallback));
    }

    screenshots[vp.name] = filename;
  }

  return screenshots;
}

function closeSession() {
  try {
    execFileSync(
      'playwright-cli', [`-s=${SESSION}`, 'close'], EXEC_OPTS
    );
  } catch {
    // Session may already be closed
  }
}

function main() {
  const {
    url, outputDir, headerSelector, overlayRecipe, browserRecipe,
  } = parseArgs(process.argv);

  verifyInstalled();
  mkdirSync(outputDir, { recursive: true });

  const recipeArgs = buildRecipeArgs(browserRecipe);

  try {
    openPage(url, recipeArgs);
    waitForStable();

    if (overlayRecipe) {
      applyOverlayRecipe(overlayRecipe);
    }

    const headerTree = captureHeaderDOM(headerSelector);
    if (!headerTree) {
      log(
        `WARNING: header not found with selector "${headerSelector}"`
      );
    } else {
      log(
        `  Header: ${headerTree.boundingRect.width}`
        + `x${headerTree.boundingRect.height}`
      );
    }

    const navItems = extractNavItems(headerSelector);
    log(`  Found ${navItems.length} nav items`);

    const screenshots = captureScreenshots(outputDir, headerSelector);

    const snapshot = {
      url,
      timestamp: new Date().toISOString(),
      headerSelector,
      viewport: { width: 1440, height: 900 },
      screenshots,
      header: headerTree,
      navItems,
    };

    const snapshotPath = join(outputDir, 'snapshot.json');
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    log(`Wrote snapshot to ${snapshotPath}`);
  } finally {
    closeSession();
    for (const f of recipeArgs.tempFiles) {
      try { unlinkSync(f); } catch { /* temp file cleanup */ }
    }
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}

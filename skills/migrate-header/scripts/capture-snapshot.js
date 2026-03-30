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

const STYLE_PROPS = [
  'backgroundColor', 'color', 'fontSize', 'fontFamily', 'fontWeight',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'display', 'position', 'gap', 'borderRadius', 'background',
  'height', 'width', 'maxWidth', 'justifyContent', 'alignItems',
  'flexDirection', 'gridTemplateColumns', 'textDecoration', 'lineHeight',
  'letterSpacing', 'border', 'borderBottom', 'boxShadow', 'opacity',
  'overflow', 'zIndex',
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
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
  if (!recipePath) {
    return { extraArgs: [], stealthScript: null, configPath: null };
  }

  const recipe = JSON.parse(readFileSync(recipePath, 'utf-8'));
  const configPath = join(
    tmpdir(),
    `header-capture-config-${Date.now()}.json`
  );
  writeFileSync(configPath, JSON.stringify(recipe.cliConfig, null, 2));

  const extraArgs = [`--config=${configPath}`];
  if (recipe.persistent) {
    extraArgs.push('--persistent');
  }

  return {
    extraArgs,
    stealthScript: recipe.stealthInitScript || null,
    configPath,
  };
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
  if (recipeArgs.stealthScript) {
    log('  Injecting stealth script...');
    cliEval(recipeArgs.stealthScript);
  }
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

  const stylePropsJSON = JSON.stringify(STYLE_PROPS);
  const selectorEscaped = headerSelector.replace(/'/g, "\\'");

  const js = `(function() {
  var styleProps = ${stylePropsJSON};
  var header = document.querySelector('${selectorEscaped}');
  if (!header) return JSON.stringify(null);

  function traverse(node, depth) {
    if (depth > 10) return null;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    var rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    var computed = getComputedStyle(node);
    var computedStyles = {};
    for (var i = 0; i < styleProps.length; i++) {
      computedStyles[styleProps[i]] = computed[styleProps[i]] || '';
    }

    var children = [];
    for (var j = 0; j < node.children.length; j++) {
      var result = traverse(node.children[j], depth + 1);
      if (result) children.push(result);
    }

    var isLeaf = children.length === 0;
    var textContent = isLeaf
      ? (node.textContent || '').trim().slice(0, 100)
      : undefined;

    var attrs = {};
    var tag = node.tagName;
    if (tag === 'IMG') {
      var src = node.getAttribute('src');
      if (src) attrs.src = src;
      var alt = node.getAttribute('alt');
      if (alt !== null) attrs.alt = alt || '';
    }
    if (tag === 'A') {
      var href = node.getAttribute('href');
      if (href) attrs.href = href;
    }
    var dataSrc = node.getAttribute('data-src');
    if (dataSrc) attrs['data-src'] = dataSrc;

    var obj = {
      tag: tag,
      id: node.id || '',
      classes: Array.from(node.classList),
      attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
      boundingRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      computedStyles: computedStyles,
      children: children
    };

    if (textContent !== undefined) {
      obj.textContent = textContent;
    }

    return obj;
  }

  return JSON.stringify(traverse(header, 0));
})()`;

  const raw = cliEval(js);
  return JSON.parse(raw);
}

function extractNavItems(headerSelector) {
  log('  Extracting nav items...');

  const selectorEscaped = headerSelector.replace(/'/g, "\\'");

  const js = `(function() {
  var header = document.querySelector('${selectorEscaped}');
  if (!header) return JSON.stringify([]);

  var links = header.querySelectorAll('a');
  var items = [];

  for (var i = 0; i < links.length; i++) {
    var a = links[i];
    var text = (a.textContent || '').trim();
    if (!text) continue;

    var level = 0;
    var ancestor = a.parentElement;
    while (ancestor && ancestor !== header) {
      var tag = ancestor.tagName;
      if (tag === 'UL' || tag === 'OL') level++;
      ancestor = ancestor.parentElement;
    }
    if (level === 0) level = 1;

    var parent = undefined;
    if (level > 1) {
      var li = a.closest('li');
      if (li) {
        var parentLi = li.parentElement ? li.parentElement.closest('li') : null;
        if (parentLi) {
          var parentA = parentLi.querySelector(':scope > a');
          if (parentA) {
            parent = (parentA.textContent || '').trim();
          }
        }
      }
    }

    var item = { text: text, href: a.getAttribute('href') || '', level: level };
    if (parent) item.parent = parent;
    items.push(item);
  }

  return JSON.stringify(items);
})()`;

  const raw = cliEval(js);
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
    if (recipeArgs.configPath) {
      try { unlinkSync(recipeArgs.configPath); } catch { /* temp */ }
    }
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}

#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let headerSelector = 'header';
  let overlayRecipe = null;

  for (const arg of args) {
    if (arg.startsWith('--header-selector=')) {
      headerSelector = arg.split('=')[1];
    } else if (arg.startsWith('--overlay-recipe=')) {
      overlayRecipe = arg.split('=')[1];
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length < 2) {
    console.error(
      'Usage: node capture-snapshot.js <url> <output-dir>'
      + ' [--header-selector=header] [--overlay-recipe=path/to/recipe.json]'
    );
    process.exit(1);
  }

  return {
    url: positional[0],
    outputDir: resolve(positional[1]),
    headerSelector,
    overlayRecipe,
  };
}

function cli(...args) {
  return execFileSync(
    'playwright-cli', [`-s=${SESSION}`, ...args], EXEC_OPTS
  ).trim();
}

function cliEval(js) {
  return cli('eval', js);
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

function openPage(url) {
  log(`Opening ${url}...`);
  cli('open', url);
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

    var obj = {
      tag: node.tagName,
      id: node.id || '',
      classes: Array.from(node.classList),
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

function captureScreenshots(outputDir, headerSelector) {
  log('  Taking screenshots...');

  const screenshots = {};
  const selectorEscaped = headerSelector.replace(/'/g, "\\'");

  for (const vp of VIEWPORTS) {
    cli('resize', String(vp.width), String(vp.height));

    const filename = `${vp.name}.png`;
    const filepath = join(outputDir, filename);

    const hasHeader = cliEval(
      `!!document.querySelector('${selectorEscaped}')`
    );

    if (hasHeader === 'false') {
      log(
        `  Header not visible at ${vp.width}x${vp.height},`
        + ' using page-clip fallback'
      );
      cli(
        'screenshot',
        `--filename=${filepath}`,
        `--clip=0,0,${vp.width},120`
      );
    } else {
      cli(
        'screenshot',
        `--filename=${filepath}`,
        `--selector=${headerSelector}`
      );
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
    url, outputDir, headerSelector, overlayRecipe,
  } = parseArgs(process.argv);

  verifyInstalled();
  mkdirSync(outputDir, { recursive: true });

  try {
    openPage(url);
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
  }
}

main();

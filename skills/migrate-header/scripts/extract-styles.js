#!/usr/bin/env node

/**
 * extract-styles — CDP-powered CSS extraction for header migration.
 *
 * Opens a css-query.js session on the source URL, runs targeted queries
 * against key header elements, and outputs styles.json with authored
 * CSS values and provenance.
 *
 * Usage:
 *   node extract-styles.js <snapshot.json> <url> [--browser-recipe=path]
 *
 * Reads snapshot.json for header selector and element bounding rects.
 * Outputs JSON to stdout.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunCodeOutput } from './cdp-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_QUERY = join(__dirname, 'css-query.js');
const SESSION = 'extract-styles';

const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 30_000,
};

function log(msg) {
  console.error(msg);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let browserRecipe = null;

  for (const arg of args) {
    if (arg.startsWith('--browser-recipe=')) {
      const val = arg.split('=').slice(1).join('=');
      browserRecipe = val || null;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length < 2) {
    console.error(
      'Usage: node extract-styles.js <snapshot.json> <url>'
      + ' [--browser-recipe=path]'
    );
    process.exit(1);
  }

  return {
    snapshotPath: resolve(positional[0]),
    url: positional[1],
    browserRecipe,
  };
}

function cssQuery(...args) {
  const result = execFileSync(
    'node', [CSS_QUERY, ...args, `--session=${SESSION}`], EXEC_OPTS
  ).trim();
  return result;
}

function query(selector, properties) {
  try {
    const raw = cssQuery('query', selector, properties);
    const parsed = JSON.parse(raw);
    return parsed.properties || {};
  } catch {
    return {};
  }
}

function queryVars() {
  try {
    const raw = cssQuery('vars');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function openSession(url, browserRecipe) {
  const args = ['open', url];
  if (browserRecipe) {
    args.push(`--browser-recipe=${browserRecipe}`);
  }
  cssQuery(...args);
}

function closeSession() {
  try {
    cssQuery('close');
  } catch {
    // session may not be open
  }
}

function computeNavSpacing(snapshot) {
  const navItems = snapshot.navItems || [];
  const level1 = navItems.filter((n) => n.level === 1);
  if (level1.length < 2) return null;

  // Find nav link nodes in the DOM tree by matching text content
  const links = [];
  function walkTree(node) {
    if (!node) return;
    if (node.tag === 'A' && node.textContent) {
      const text = node.textContent.trim();
      if (level1.some((l) => l.text === text)) {
        links.push(node);
      }
    }
    for (const child of node.children || []) {
      walkTree(child);
    }
  }
  walkTree(snapshot.header);

  if (links.length < 2) return null;

  // Compute spacing from bounding rects of consecutive links
  const gaps = [];
  for (let i = 1; i < links.length && i < 6; i++) {
    const prev = links[i - 1].boundingRect;
    const curr = links[i].boundingRect;
    if (prev && curr) {
      const gap = curr.x - prev.x - prev.width;
      if (gap > 0) gaps.push(gap);
    }
  }

  if (gaps.length === 0) return null;
  const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  return {
    method: 'spatial',
    value: `${Math.round(median)}px`,
    note: 'measured from bounding rects, not CSS gap',
  };
}

function findRowSelectors(snapshot) {
  const header = snapshot.header;
  if (!header || !header.children) return [];

  // Direct children with significant height are rows
  const rows = header.children.filter(
    (c) => c.boundingRect && c.boundingRect.height > 15
  );

  return rows.map((row) => {
    // Build a selector from the row's tag, id, and classes
    const tag = row.tag?.toLowerCase() || 'div';
    if (row.id) return `#${row.id}`;
    const cls = (row.classes || []).filter((c) => c.length > 0);
    if (cls.length > 0) return `${tag}.${cls[0]}`;
    return null;
  }).filter(Boolean);
}

function findNavLinkSelector(snapshot) {
  const navItems = snapshot.navItems || [];
  if (navItems.length === 0) return null;

  // Walk the DOM tree to find the first nav link
  function walk(node) {
    if (!node) return null;
    if (node.tag === 'A' && node.textContent) {
      const text = node.textContent.trim();
      if (navItems.some((n) => n.level === 1 && n.text === text)) {
        // Build selector from context
        const cls = (node.classes || []).filter((c) => c.length > 0);
        if (cls.length > 0) return `a.${cls[0]}`;
        return null;
      }
    }
    for (const child of node.children || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }

  return walk(snapshot.header);
}

function findCtaSelector(snapshot) {
  function walk(node) {
    if (!node) return null;
    const cls = (node.classes || []).join(' ').toLowerCase();
    if (['A', 'BUTTON'].includes(node.tag)) {
      if (cls.includes('cta') || cls.includes('btn') || cls.includes('button')) {
        const firstCls = (node.classes || [])[0];
        if (firstCls) return `${node.tag.toLowerCase()}.${firstCls}`;
      }
    }
    for (const child of node.children || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }

  return walk(snapshot.header);
}

function findLogoSelector(snapshot) {
  function walk(node) {
    if (!node) return null;
    const cls = (node.classes || []).join(' ').toLowerCase();
    if (cls.includes('logo') && ['A', 'IMG', 'DIV'].includes(node.tag)) {
      const firstCls = (node.classes || [])[0];
      if (firstCls) return `${node.tag.toLowerCase()}.${firstCls}`;
    }
    for (const child of node.children || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }

  return walk(snapshot.header);
}

function waitForFonts(url) {
  // Re-query font-family after async fonts load
  // Uses run-code to wait for document.fonts.ready
  try {
    const raw = execFileSync('playwright-cli', [
      `-s=${SESSION}`, 'run-code',
      `async page => {
        await page.evaluate(() => document.fonts.ready);
        return 'fonts-ready';
      }`,
    ], EXEC_OPTS).trim();
    return parseRunCodeOutput(raw) === 'fonts-ready';
  } catch {
    return false;
  }
}

function main() {
  const { snapshotPath, url, browserRecipe } = parseArgs(process.argv);

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read snapshot: ${err.message}`);
    process.exit(1);
  }

  const headerSelector = snapshot.headerSelector || 'header';

  log('Opening CSS query session...');
  openSession(url, browserRecipe);

  try {
    const styles = {
      header: {},
      rows: [],
      navLinks: {},
      navLinksHover: {},
      navSpacing: null,
      cta: null,
      logo: null,
      utility: null,
      customProperties: {},
    };

    // 1. Header container
    log('  Querying header styles...');
    styles.header = query(
      headerSelector,
      'background-color,height,padding,font-family'
    );

    // 2. Row backgrounds
    const rowSelectors = findRowSelectors(snapshot);
    log(`  Querying ${rowSelectors.length} rows...`);
    for (const sel of rowSelectors) {
      const rowStyles = query(sel, 'background-color,height,border-bottom');
      styles.rows.push(rowStyles);
    }

    // 3. Wait for async fonts
    log('  Waiting for web fonts...');
    waitForFonts(url);

    // 4. Nav link styles
    const navSelector = findNavLinkSelector(snapshot)
      || `${headerSelector} a`;
    log(`  Querying nav links (${navSelector})...`);
    styles.navLinks = query(
      navSelector,
      'font-size,font-weight,color,letter-spacing,font-family,text-transform'
    );

    // 5. Nav link hover state
    log('  Querying nav link :hover state...');
    try {
      const hoverCode = `async page => {
        const cdp = await page.context().newCDPSession(page);
        try {
          await cdp.send('DOM.enable');
          await cdp.send('CSS.enable');
          const {root} = await cdp.send('DOM.getDocument');
          const {nodeId} = await cdp.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: ${JSON.stringify(navSelector)},
          });
          if (!nodeId) return JSON.stringify({});
          await cdp.send('CSS.forcePseudoState', {
            nodeId,
            forcedPseudoClasses: ['hover'],
          });
          await new Promise(r => setTimeout(r, 500));
          const [computed, matched] = await Promise.all([
            cdp.send('CSS.getComputedStyleForNode', {nodeId}),
            cdp.send('CSS.getMatchedStylesForNode', {nodeId}),
          ]);
          // Reset pseudo state
          await cdp.send('CSS.forcePseudoState', {
            nodeId,
            forcedPseudoClasses: [],
          });
          return JSON.stringify({computed: computed.computedStyle, matched});
        } finally {
          await cdp.detach();
        }
      }`;

      const raw = execFileSync('playwright-cli', [
        `-s=${SESSION}`, 'run-code', hoverCode,
      ], EXEC_OPTS).trim();
      const parsed = JSON.parse(parseRunCodeOutput(raw));

      if (parsed.computed) {
        const hoverProps = [
          'color', 'border-bottom', 'text-decoration',
          'background-color', 'background',
        ];
        const computedMap = new Map(
          parsed.computed.map((p) => [p.name, p.value])
        );
        for (const prop of hoverProps) {
          const val = computedMap.get(prop);
          if (val && val !== styles.navLinks[prop]?.value) {
            styles.navLinksHover[prop] = { value: val, source: 'hover' };
          }
        }
      }
    } catch {
      log('    WARNING: hover query failed');
    }

    // 6. Nav spacing (spatial measurement)
    styles.navSpacing = computeNavSpacing(snapshot);

    // 7. CTA styles
    const ctaSelector = findCtaSelector(snapshot);
    if (ctaSelector) {
      log(`  Querying CTA (${ctaSelector})...`);
      styles.cta = query(
        ctaSelector,
        'background-color,color,border-radius,padding,font-weight'
      );
    }

    // 8. Logo styles
    const logoSelector = findLogoSelector(snapshot);
    if (logoSelector) {
      log(`  Querying logo (${logoSelector})...`);
      styles.logo = query(logoSelector, 'max-height,width,padding');
    }

    // 9. CSS custom properties
    log('  Querying CSS custom properties...');
    styles.customProperties = queryVars();

    console.log(JSON.stringify(styles, null, 2));
  } finally {
    closeSession();
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();

#!/usr/bin/env node

/**
 * css-overview — Extract compact CSS summary via CDP during capture.
 *
 * Usage (standalone, for testing):
 *   node css-overview.js <session> <header-selector> <output-dir>
 *
 * The script uses an existing playwright-cli session to run CDP queries.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCustomProperties,
  rgbToHex,
  categorizeColor,
  parseRunCodeOutput,
} from './cdp-helpers.js';

const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
};

const KEY_ELEMENTS = [
  { selector: 'header, nav, [role=banner]', role: 'header' },
  { selector: 'header a, nav a', role: 'nav-link' },
  {
    selector:
      'header button, nav button, header [class*=cta], nav [class*=cta]',
    role: 'cta',
  },
];

function cli(session, ...args) {
  return execFileSync(
    'playwright-cli', [`-s=${session}`, ...args], EXEC_OPTS
  ).trim();
}

function queryElement(session, selector) {
  const code = `
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const {root} = await cdp.send('DOM.getDocument');
      const {nodeId} = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: ${JSON.stringify(selector)},
      });
      if (!nodeId) return JSON.stringify(null);
      const [computed, matched] = await Promise.all([
        cdp.send('CSS.getComputedStyleForNode', {nodeId}),
        cdp.send('CSS.getMatchedStylesForNode', {nodeId}),
      ]);
      return JSON.stringify({
        computed: computed.computedStyle,
        matched: {
          matchedCSSRules: matched.matchedCSSRules,
          inherited: matched.inherited,
          inlineStyle: matched.inlineStyle,
        },
      });
    } finally {
      await cdp.detach();
    }
  `;

  const raw = cli(session, 'run-code', `async page => { ${code} }`);
  const parsed = parseRunCodeOutput(raw);
  try {
    return JSON.parse(parsed);
  } catch {
    return null;
  }
}

export function buildOverview(elements) {
  const customProperties = {};
  const fontStacks = new Set();
  const colorPalette = {
    backgrounds: new Set(),
    text: new Set(),
    accent: new Set(),
    borders: new Set(),
  };
  const spacing = {};

  for (const el of elements) {
    // Extract custom properties from matched rules
    const vars = extractCustomProperties(el.matched?.matchedCSSRules);
    Object.assign(customProperties, vars);

    // Extract from computed styles
    for (const prop of el.computed || []) {
      // Font stacks
      if (prop.name === 'font-family' && prop.value) {
        fontStacks.add(prop.value);
      }

      // Colors
      if (
        ['color', 'background-color', 'border-color',
          'border-top-color', 'border-bottom-color'].includes(prop.name)
      ) {
        const hex = rgbToHex(prop.value);
        if (hex && hex !== '#000000') {
          const category = categorizeColor(hex, prop.name);
          if (category && colorPalette[category]) {
            colorPalette[category].add(hex);
          }
        }
      }

      // Key spacing (from header element)
      if (el.role === 'header') {
        if (
          prop.name === 'padding-left'
          || prop.name === 'padding-right'
        ) {
          const px = parseFloat(prop.value);
          if (px > 0) spacing.headerPaddingX = prop.value;
        }
        if (prop.name === 'gap') {
          const px = parseFloat(prop.value);
          if (px > 0) spacing.navGap = prop.value;
        }
        if (prop.name === 'height') {
          const px = parseFloat(prop.value);
          if (px > 0) {
            if (!spacing.rowHeights) spacing.rowHeights = [];
            spacing.rowHeights.push(Math.round(px));
          }
        }
      }
    }
  }

  return {
    customProperties,
    fontStacks: [...fontStacks],
    colorPalette: {
      backgrounds: [...colorPalette.backgrounds],
      text: [...colorPalette.text],
      accent: [...colorPalette.accent],
      borders: [...colorPalette.borders],
    },
    keySpacing: spacing,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(
      'Usage: node css-overview.js <session> <header-selector> <output-dir>'
    );
    process.exit(1);
  }

  const [session, , outputDir] = args;

  console.error('Extracting CSS overview via CDP...');

  const elements = [];
  for (const { selector, role } of KEY_ELEMENTS) {
    const result = queryElement(session, selector);
    if (result) {
      elements.push({ ...result, role });
    }
  }

  const overview = buildOverview(elements);
  const outputPath = join(resolve(outputDir), 'css-overview.json');
  writeFileSync(outputPath, JSON.stringify(overview, null, 2));
  console.error(`  Wrote ${outputPath}`);
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();

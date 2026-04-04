#!/usr/bin/env node

/**
 * Shared CDP utilities for CSS inspection.
 * Pure functions that parse CDP and playwright-cli responses.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// CSS properties that are inherited by default
// (subset — covers the ones relevant to header migration)
const INHERITED_PROPERTIES = new Set([
  'color', 'cursor', 'direction',
  'font', 'font-family', 'font-feature-settings',
  'font-kerning', 'font-size', 'font-size-adjust',
  'font-stretch', 'font-style', 'font-variant', 'font-weight',
  'letter-spacing', 'line-height',
  'list-style', 'list-style-image',
  'list-style-position', 'list-style-type',
  'orphans', 'quotes', 'tab-size',
  'text-align', 'text-align-last', 'text-indent',
  'text-justify', 'text-shadow', 'text-transform',
  'visibility', 'white-space', 'widows',
  'word-break', 'word-spacing', 'word-wrap',
]);

export function parseRuleOrigin(origin) {
  const map = {
    regular: 'author',
    'user-agent': 'user-agent',
    injected: 'extension',
    inspector: 'inspector',
  };
  return map[origin] || 'unknown';
}

export function extractFileFromURL(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    return path.split('/').pop() || path;
  } catch {
    return url;
  }
}

export function extractPropertiesFromMatched(
  matched, sheets = {}, authorOnly = false
) {
  const result = new Map();

  const addProp = (name, value, origin, selector, sheetId, inherited) => {
    if (authorOnly && origin !== 'regular') return;
    if (inherited && !INHERITED_PROPERTIES.has(name)) return;
    if (result.has(name)) return; // first match wins (highest specificity)

    const file = sheetId && sheets[sheetId]
      ? extractFileFromURL(sheets[sheetId].sourceURL)
      : null;

    result.set(name, {
      value,
      source: parseRuleOrigin(origin),
      selector: selector || null,
      file,
      inherited,
    });
  };

  // Inline styles (highest specificity)
  for (const prop of matched.inlineStyle?.cssProperties || []) {
    if (prop.name && !prop.disabled) {
      addProp(
        prop.name, prop.value,
        'regular', 'element.style', null, false
      );
    }
  }

  // Matched CSS rules
  for (const match of matched.matchedCSSRules || []) {
    const { rule } = match;
    const selector = rule.selectorList?.text || '';
    for (const prop of rule.style?.cssProperties || []) {
      if (prop.name && !prop.disabled) {
        addProp(
          prop.name, prop.value, rule.origin,
          selector, rule.styleSheetId, false
        );
      }
    }
  }

  // Inherited styles
  for (const entry of matched.inherited || []) {
    for (const prop of entry.inlineStyle?.cssProperties || []) {
      if (prop.name && !prop.disabled) {
        addProp(
          prop.name, prop.value,
          'regular', 'parent.style', null, true
        );
      }
    }
    for (const match of entry.matchedCSSRules || []) {
      const { rule } = match;
      const selector = rule.selectorList?.text || '';
      for (const prop of rule.style?.cssProperties || []) {
        if (prop.name && !prop.disabled) {
          addProp(
            prop.name, prop.value, rule.origin,
            selector, rule.styleSheetId, true
          );
        }
      }
    }
  }

  return result;
}

export function rgbToHex(rgb) {
  if (!rgb) return null;
  const m = rgb.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const [, r, g, b] = m.map(Number);
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

export function colorSaturation(hex) {
  if (!hex || hex.length !== 7) return 0;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

export function categorizeColor(hex, propertyName) {
  if (!hex) return null;
  if (propertyName.includes('border')) return 'borders';
  if (propertyName.includes('background')) return 'backgrounds';

  const sat = colorSaturation(hex);
  if (sat > 0.3) return 'accent';
  return 'text';
}

export function extractCustomProperties(matchedRules) {
  const vars = {};
  for (const match of matchedRules || []) {
    const { rule } = match;
    if (rule.origin !== 'regular') continue;
    for (const prop of rule.style?.cssProperties || []) {
      if (prop.name?.startsWith('--') && !prop.disabled) {
        vars[prop.name] = prop.value;
      }
    }
  }
  return vars;
}

export function parseRunCodeOutput(raw) {
  const resultIdx = raw.indexOf('### Result');
  const codeIdx = raw.indexOf('### Ran Playwright code');
  if (resultIdx === -1) return raw;
  const start = resultIdx + '### Result'.length;
  const end = codeIdx !== -1 ? codeIdx : raw.length;
  let value = raw.slice(start, end).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      value = typeof parsed === 'string' ? parsed : value.slice(1, -1);
    } catch {
      value = value.slice(1, -1);
    }
  }
  return value;
}

export { parseRunCodeOutput as parseEvalOutput };

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  console.log('cdp-helpers: no standalone mode — import as a module');
}

#!/usr/bin/env node

/**
 * brand-extract-dom — Extract colors, spacing, and favicons from a page.
 *
 * Font detection is handled by font-detect.js (4-layer approach).
 * This script focuses on visual brand data only.
 *
 * Usage:
 *   node brand-extract-dom.js [--session=name]
 *
 * Requires an active playwright-cli session. Outputs JSON to stdout.
 */

import { execFileSync } from 'node:child_process';

const DEFAULT_SESSION = 'brand-setup';
const EXEC_OPTS = { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 };

/* ── Browser IIFE ─────────────────────────────────────────────────── */

const BROWSER_IIFE = String.raw`(function() {
  function extractBaseColors() {
    var bg = '';
    var text = '';
    var bodyStyle = window.getComputedStyle(document.body);
    bg = bodyStyle.backgroundColor || '';
    text = bodyStyle.color || '';
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
      bg = window.getComputedStyle(document.documentElement).backgroundColor || '';
    }
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
      var main = document.querySelector('main');
      if (main) bg = window.getComputedStyle(main).backgroundColor || '';
    }
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = '#ffffff';
    var mainEl = document.querySelector('main');
    if (mainEl) {
      var mainText = window.getComputedStyle(mainEl).color;
      if (mainText && mainText !== 'rgb(0, 0, 0)') text = mainText;
    }
    return { background: bg, text: text };
  }

  function extractLinkColor() {
    var links = document.querySelectorAll('main a');
    if (links.length === 0) links = document.querySelectorAll('a');
    var counts = {};
    for (var i = 0; i < links.length && i < 30; i++) {
      var color = window.getComputedStyle(links[i]).color || '';
      if (!color || color === 'rgb(255, 255, 255)' || color === 'rgb(0, 0, 0)') continue;
      counts[color] = (counts[color] || 0) + 1;
    }
    var best = '';
    var bestCount = 0;
    var keys = Object.keys(counts);
    for (var j = 0; j < keys.length; j++) {
      if (counts[keys[j]] > bestCount) { bestCount = counts[keys[j]]; best = keys[j]; }
    }
    return best || (links.length > 0 ? window.getComputedStyle(links[0]).color : '');
  }

  function extractLinkHoverColor() {
    var last = null;
    try {
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++) {
        var rules;
        try { rules = sheets[i].cssRules; } catch(e) { continue; }
        for (var j = 0; j < rules.length; j++) {
          var rule = rules[j];
          if (rule.selectorText) {
            var selectors = rule.selectorText.split(',');
            for (var k = 0; k < selectors.length; k++) {
              if (/a:hover/i.test(selectors[k].trim())) {
                var color = rule.style.color;
                if (color) last = color;
              }
            }
          }
        }
      }
    } catch(e) { /* cross-origin stylesheet */ }
    return last;
  }

  function extractSpacing() {
    var section = document.querySelector('section') || document.querySelector('main');
    var sectionPadding = section ? window.getComputedStyle(section).paddingTop : '';
    var navEl = document.querySelector('nav') || document.querySelector('header');
    var navHeight = navEl ? window.getComputedStyle(navEl).height : '';
    var containerSelectors = [
      'main > .container', 'main > .wrapper', 'main > [class*="container"]',
      'main > div', '.container', '.wrapper',
      '[class*="container"]', '[class*="wrapper"]'
    ];
    var contentMaxWidth = '';
    for (var i = 0; i < containerSelectors.length; i++) {
      var el = document.querySelector(containerSelectors[i]);
      if (!el) continue;
      var mw = window.getComputedStyle(el).maxWidth;
      if (mw && mw !== 'none' && mw !== '0px') { contentMaxWidth = mw; break; }
    }
    return { sectionPadding: sectionPadding, contentMaxWidth: contentMaxWidth, navHeight: navHeight };
  }

  function extractFavicons() {
    var links = document.querySelectorAll('link[rel*="icon"]');
    var seen = {};
    var favicons = [];
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var href = link.getAttribute('href');
      if (!href) continue;
      var url = new URL(href, window.location.href).href;
      if (seen[url]) continue;
      seen[url] = true;
      var entry = { url: url, rel: link.getAttribute('rel') || 'icon' };
      var sizes = link.getAttribute('sizes');
      if (sizes) entry.sizes = sizes;
      var type = link.getAttribute('type');
      if (type) entry.type = type;
      favicons.push(entry);
    }
    if (favicons.length === 0) {
      favicons.push({
        url: new URL('/favicon.ico', window.location.href).href,
        rel: 'icon'
      });
    }
    return favicons;
  }

  function extractHeadingSizes() {
    var map = { H1: 'xxl', H2: 'xl', H3: 'l', H4: 'm', H5: 's', H6: 'xs' };
    var sizes = {};
    var tags = Object.keys(map);
    for (var i = 0; i < tags.length; i++) {
      var el = document.querySelector(tags[i].toLowerCase());
      if (el) {
        sizes[map[tags[i]]] = { desktop: window.getComputedStyle(el).fontSize };
      }
    }
    return sizes;
  }

  var baseColors = extractBaseColors();

  return {
    colors: {
      background: baseColors.background,
      text: baseColors.text,
      link: extractLinkColor(),
      linkHover: extractLinkHoverColor()
    },
    spacing: extractSpacing(),
    headingSizes: extractHeadingSizes(),
    favicons: extractFavicons()
  };
})()`;

/* ── Helpers ──────────────────────────────────────────────────────── */

function parseArgs(argv) {
  let session = DEFAULT_SESSION;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--session=')) {
      session = arg.split('=')[1] || DEFAULT_SESSION;
    }
  }
  return { session };
}

function parseRunCodeOutput(raw) {
  const marker = '### Result';
  const idx = raw.indexOf(marker);
  if (idx === -1) return raw.trim();
  const after = raw.slice(idx + marker.length).trim();
  const endIdx = after.indexOf('\n###');
  let value = endIdx === -1 ? after : after.slice(0, endIdx).trim();
  // playwright-cli wraps string return values in quotes — unwrap
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

/* ── Main ─────────────────────────────────────────────────────────── */

function main() {
  const { session } = parseArgs(process.argv);

  const code = [
    'async page => {',
    `  const data = await page.evaluate(() => ${BROWSER_IIFE});`,
    '  return JSON.stringify(data);',
    '}',
  ].join('\n');

  let raw;
  try {
    raw = execFileSync(
      'playwright-cli',
      [`-s=${session}`, 'run-code', code],
      EXEC_OPTS,
    ).trim();
  } catch (err) {
    process.stderr.write(`DOM extraction failed: ${err.message}\n`);
    process.exit(1);
  }

  const json = parseRunCodeOutput(raw);
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    process.stderr.write('Failed to parse DOM extraction output\n');
    process.stderr.write(`${json}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

main();

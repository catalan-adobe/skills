#!/usr/bin/env node

/**
 * font-detect — Detect all fonts used on a page via 4 browser API layers.
 *
 * Layers:
 *   1. document.fonts (FontFaceSet) — registered font faces + load status
 *   2. CSSImportRule walk — Typekit kit IDs, Google Fonts URLs from @import
 *   3. Performance API — all font resource URLs regardless of load method
 *   4. Computed style voting — body/heading fonts by element frequency
 *
 * Usage:
 *   node font-detect.js --session=<name> [--output=<path>]
 *
 * Requires an active playwright-cli session with document.fonts.ready
 * already awaited. Outputs JSON to stdout (or file if --output given).
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const DEFAULT_SESSION = 'brand-setup';
const EXEC_OPTS = { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 };

/* ── Browser IIFE ─────────────────────────────────────────────────── */

const BROWSER_IIFE = String.raw`(function() {

  /* Layer 1: document.fonts — all registered FontFace objects */
  function detectFontFaces() {
    var families = {};
    document.fonts.forEach(function(f) {
      var name = f.family.replace(/^["']|["']$/g, '');
      if (!families[name]) {
        families[name] = { family: name, weights: [], styles: [], loaded: false };
      }
      var entry = families[name];
      if (entry.weights.indexOf(f.weight) === -1) entry.weights.push(f.weight);
      if (entry.styles.indexOf(f.style) === -1) entry.styles.push(f.style);
      if (f.status === 'loaded') entry.loaded = true;
    });
    var result = [];
    var keys = Object.keys(families);
    for (var i = 0; i < keys.length; i++) result.push(families[keys[i]]);
    return result;
  }

  /* Layer 2: CSS @import chain walk */
  function detectImportSources() {
    var sources = { typekit: null, googleFonts: [] };
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      try {
        for (var j = 0; j < sheet.cssRules.length; j++) {
          var rule = sheet.cssRules[j];
          if (rule instanceof CSSImportRule) {
            var href = rule.href || '';
            var tkMatch = href.match(/use\.typekit\.net\/([a-z0-9]+)\.css/);
            if (tkMatch && !sources.typekit) {
              sources.typekit = { kitId: tkMatch[1], method: 'css-import' };
            }
            if (href.indexOf('fonts.googleapis.com') !== -1) {
              sources.googleFonts.push(href);
            }
          }
        }
      } catch(e) { /* cross-origin sheet — cssRules throws */ }
    }
    // Also check <link> tags (standard Typekit embed)
    if (!sources.typekit) {
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (var k = 0; k < links.length; k++) {
        var lhref = links[k].getAttribute('href') || '';
        var ltkMatch = lhref.match(/use\.typekit\.net\/([a-z0-9]+)\.css/);
        if (ltkMatch) {
          sources.typekit = { kitId: ltkMatch[1], method: 'link-tag' };
          break;
        }
        if (lhref.indexOf('fonts.googleapis.com') !== -1) {
          if (sources.googleFonts.indexOf(lhref) === -1) {
            sources.googleFonts.push(lhref);
          }
        }
      }
    }
    // Also check <script> tags (Typekit JS loader)
    if (!sources.typekit) {
      var scripts = document.querySelectorAll('script[src]');
      for (var m = 0; m < scripts.length; m++) {
        var src = scripts[m].getAttribute('src') || '';
        var stkMatch = src.match(/use\.typekit\.net\/([a-z0-9]+)\.js/);
        if (stkMatch) {
          sources.typekit = { kitId: stkMatch[1], method: 'script-tag' };
          break;
        }
      }
    }
    return sources;
  }

  /* Layer 3: Performance API — font resource URLs */
  function detectPerformanceResources() {
    var entries = performance.getEntriesByType('resource');
    var fonts = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var name = e.name;
      if (name.indexOf('typekit') !== -1 ||
          name.indexOf('fonts.googleapis') !== -1 ||
          name.indexOf('fonts.gstatic') !== -1 ||
          /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(name)) {
        fonts.push({
          url: name.length > 200 ? name.slice(0, 200) : name,
          initiator: e.initiatorType,
          size: e.transferSize || 0
        });
      }
    }
    return fonts;
  }

  /* Layer 4: Computed style voting */
  function detectByVoting(selector) {
    var els = document.querySelectorAll(selector);
    if (els.length === 0) return { family: '', stack: '' };
    var counts = {};
    for (var i = 0; i < els.length; i++) {
      var ff = window.getComputedStyle(els[i]).fontFamily;
      counts[ff] = (counts[ff] || 0) + 1;
    }
    var best = '';
    var bestCount = 0;
    var keys = Object.keys(counts);
    for (var j = 0; j < keys.length; j++) {
      if (counts[keys[j]] > bestCount) {
        bestCount = counts[keys[j]];
        best = keys[j];
      }
    }
    var primary = (best.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
    return { family: primary, stack: best };
  }

  /* Also extract Typekit kit ID from performance entries as fallback */
  function detectTypekitFromPerf(perfEntries, existing) {
    if (existing) return existing;
    for (var i = 0; i < perfEntries.length; i++) {
      var m = perfEntries[i].url.match(/use\.typekit\.net\/([a-z0-9]+)\.css/);
      if (m) return { kitId: m[1], method: 'performance-api' };
    }
    return null;
  }

  /* ── Combine all layers ── */
  var loadedFonts = detectFontFaces();
  var sources = detectImportSources();
  var perfResources = detectPerformanceResources();
  var bodyFont = detectByVoting('p');
  var headingFont = detectByVoting('h1, h2, h3');

  // Fallback: detect Typekit from performance API if @import/link missed it
  if (!sources.typekit) {
    sources.typekit = detectTypekitFromPerf(perfResources, sources.typekit);
  }

  return {
    url: window.location.href,
    fonts: {
      body: bodyFont,
      heading: headingFont
    },
    loadedFonts: loadedFonts,
    sources: sources,
    fontResources: perfResources
  };
})()`;

/* ── Helpers ──────────────────────────────────────────────────────── */

function parseArgs(argv) {
  let session = DEFAULT_SESSION;
  let output = null;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--session=')) {
      session = arg.split('=')[1] || DEFAULT_SESSION;
    }
    if (arg.startsWith('--output=')) {
      output = arg.split('=').slice(1).join('=');
    }
  }
  return { session, output };
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
  const { session, output } = parseArgs(process.argv);

  const code = [
    'async page => {',
    '  await page.evaluate(() => document.fonts.ready);',
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
    process.stderr.write(`Font detection failed: ${err.message}\n`);
    process.exit(1);
  }

  const json = parseRunCodeOutput(raw);
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    process.stderr.write('Failed to parse font detection output\n');
    process.stderr.write(`${json}\n`);
    process.exit(1);
  }

  const formatted = JSON.stringify(data, null, 2);
  if (output) {
    writeFileSync(output, `${formatted}\n`);
    process.stderr.write(`Wrote ${output}\n`);
  }
  process.stdout.write(`${formatted}\n`);

  // Summary to stderr
  const body = data.fonts?.body?.family || '(none)';
  const heading = data.fonts?.heading?.family || '(none)';
  const tk = data.sources?.typekit?.kitId || 'none';
  const gf = data.sources?.googleFonts?.length || 0;
  const loaded = (data.loadedFonts || []).filter(f => f.loaded).length;
  process.stderr.write(
    `Detected: body="${body}" heading="${heading}" ` +
    `typekit=${tk} googleFonts=${gf} loadedFamilies=${loaded}\n`
  );
}

main();

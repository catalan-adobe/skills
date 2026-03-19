// overlay-detect.js — Browser-injectable overlay detection script.
// In browser context: PATTERNS is prepended by overlay-db.js bundle.
// In Node context (tests): exports internal functions.
'use strict';

function matchKnownPatterns(cmps, doc) {
  const results = [];
  for (const [name, rule] of Object.entries(cmps)) {
    for (const selector of rule.detect) {
      let el;
      try { el = doc.querySelector(selector); } catch { continue; }
      if (!el) continue;

      if (rule.detect_requires_visible) {
        const visible = el.offsetParent !== null ||
          (typeof getComputedStyle === 'function' &&
           getComputedStyle(el).display !== 'none');
        if (!visible) continue;
      }

      results.push({
        id: `overlay-${results.length}`,
        type: 'cookie-consent',
        source: 'cmp-match',
        cmp: name,
        selector,
        confidence: 1.0,
        hide: rule.hide,
        dismiss: rule.dismiss.length > 0 ? rule.dismiss : null,
      });
      break; // one match per CMP is enough
    }
  }
  return results;
}

function detectScrollLock(doc) {
  const html = doc.documentElement;
  const body = doc.body;
  if (!html || !body) return { scroll_locked: false, scroll_fix: null };
  const htmlStyle = typeof getComputedStyle === 'function'
    ? getComputedStyle(html) : html.style;
  const bodyStyle = typeof getComputedStyle === 'function'
    ? getComputedStyle(body) : body.style;
  const locked =
    htmlStyle?.overflow === 'hidden' || bodyStyle?.overflow === 'hidden';
  return {
    scroll_locked: locked,
    scroll_fix: locked
      ? 'html,body { overflow:auto!important; height:auto!important }'
      : null,
  };
}

// --- Heuristic scoring (placeholder for Task 6) ---

function heuristicScan(/* doc, genericSelectors, knownSelectors */) {
  return [];
}

// --- Main detection entry point ---

function detect(patterns, doc) {
  const known = matchKnownPatterns(patterns.cmps || {}, doc);
  const knownSelectors = new Set(known.map((o) => o.selector));
  const heuristic = heuristicScan(doc, patterns.generic_selectors || [], knownSelectors);
  const scrollLock = detectScrollLock(doc);

  const all = [...known, ...heuristic];
  all.forEach((o, i) => { o.id = `overlay-${i}`; });

  return {
    overlays: all,
    ...scrollLock,
  };
}

// --- Module boundary ---
// In Node (tests): export internals for unit testing.
// In browser (bundled): PATTERNS is defined by the IIFE wrapper from buildBundle.
// The `return` statement returns from the IIFE, which evaluate() picks up.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matchKnownPatterns, heuristicScan, detectScrollLock, detect };
} else {
  return detect(PATTERNS, document);
}

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

// --- Heuristic scoring ---

const SIGNAL_WEIGHTS = {
  'high-z-index': 0.15,
  'viewport-cover': 0.25,
  'aria-modal': 0.20,
  'has-backdrop': 0.15,
  'keyword-match': 0.15,
  'generic-selector-match': 0.10,
};

const OVERLAY_KEYWORDS = /cookie|consent|gdpr|modal|popup|newsletter|subscribe|paywall/i;
const CONFIDENCE_THRESHOLD = 0.30;

function scoreElement(el, computedStyle, viewport, genericSelectors) {
  const signals = [];
  let confidence = 0;

  const zIndex = parseInt(computedStyle.zIndex, 10);
  if (zIndex > 999) {
    signals.push('high-z-index');
    confidence += SIGNAL_WEIGHTS['high-z-index'];
  }

  const rect = el.getBoundingClientRect();
  const coverage = (rect.width * rect.height) / (viewport.width * viewport.height);
  if (coverage > 0.5) {
    signals.push('viewport-cover');
    confidence += SIGNAL_WEIGHTS['viewport-cover'];
  }

  const ariaModal = el.getAttribute('aria-modal');
  const role = el.getAttribute('role');
  if (ariaModal === 'true' || role === 'dialog') {
    signals.push('aria-modal');
    confidence += SIGNAL_WEIGHTS['aria-modal'];
  }

  const text = `${el.id} ${el.className}`;
  if (OVERLAY_KEYWORDS.test(text)) {
    signals.push('keyword-match');
    confidence += SIGNAL_WEIGHTS['keyword-match'];
  }

  const BATCH = 50;
  for (let i = 0; i < genericSelectors.length; i += BATCH) {
    const group = genericSelectors.slice(i, i + BATCH).join(',');
    try {
      if (el.matches(group)) {
        signals.push('generic-selector-match');
        confidence += SIGNAL_WEIGHTS['generic-selector-match'];
        break;
      }
    } catch { /* invalid selector, skip */ }
  }

  return { confidence: Math.round(confidence * 100) / 100, signals };
}

function buildSelector(el) {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const cls = el.className?.split?.(' ')?.filter(Boolean)?.[0];
  return cls ? `${tag}.${cls}` : tag;
}

function heuristicScan(doc, genericSelectors, knownSelectors) {
  const results = [];
  if (typeof doc.querySelectorAll !== 'function') return results;

  const all = doc.querySelectorAll('*');
  const viewport = {
    width: doc.documentElement?.clientWidth || 1024,
    height: doc.documentElement?.clientHeight || 768,
  };

  for (const el of all) {
    let style;
    try {
      style = typeof getComputedStyle === 'function'
        ? getComputedStyle(el) : el.style || {};
    } catch { continue; }

    if (style.position !== 'fixed' && style.position !== 'sticky') continue;

    const sel = buildSelector(el);
    if (knownSelectors.has(sel)) continue;

    const { confidence, signals } = scoreElement(el, style, viewport, genericSelectors);
    if (confidence < CONFIDENCE_THRESHOLD) continue;

    results.push({
      id: '',
      type: 'unknown-modal',
      source: 'heuristic',
      selector: sel,
      confidence,
      signals,
      hide: [`${sel} { display:none!important }`],
      dismiss: null,
    });
  }

  return results;
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
  module.exports = { matchKnownPatterns, scoreElement, heuristicScan, detectScrollLock, detect };
} else {
  return detect(PATTERNS, document);
}

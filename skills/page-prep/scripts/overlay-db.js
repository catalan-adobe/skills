#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CACHE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.cache',
  'page-prep'
);
const PATTERNS_FILE = path.join(CACHE_DIR, 'patterns.json');
const LAST_FETCH_FILE = path.join(CACHE_DIR, 'last-fetch');
const STALENESS_DAYS = 7;

// --- ABP Filter Parsing ---

function parseAbpHideRules(text) {
  const seen = new Set();
  const selectors = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('!')) continue;
    // Generic cosmetic rules start with ## (no domain prefix)
    if (!trimmed.startsWith('##')) continue;
    const selector = trimmed.slice(2);
    if (selector && !seen.has(selector)) {
      seen.add(selector);
      selectors.push(selector);
    }
  }
  return selectors;
}

// --- Consent-O-Matic Normalization ---

function extractSelectors(matchers) {
  const selectors = [];
  let requiresVisible = false;
  for (const matcher of matchers ?? []) {
    if (matcher.type === 'css' && matcher.target?.selector) {
      selectors.push(matcher.target.selector);
      if (matcher.displayFilter) requiresVisible = true;
    }
  }
  return { selectors, requiresVisible };
}

function extractHideSelectors(hideActions) {
  const rules = [];
  for (const action of hideActions ?? []) {
    if (action.type === 'hide' && action.target?.selector) {
      rules.push(`${action.target.selector} { display:none!important }`);
    }
  }
  return rules;
}

function extractDismissActions(doConsent, saveConsent) {
  const actions = [];
  for (const action of doConsent ?? []) {
    if (action.type === 'click' && action.target?.selector) {
      actions.push({ action: 'click', selector: action.target.selector });
    }
  }
  for (const action of saveConsent ?? []) {
    if (action.type === 'wait' && action.waitTime) {
      actions.push({ action: 'wait', ms: action.waitTime });
    }
    if (action.type === 'click' && action.target?.selector) {
      actions.push({ action: 'click', selector: action.target.selector });
    }
  }
  return actions;
}

function hasDroppedFilters(matchers) {
  return (matchers ?? []).some(
    (m) => (m.textFilter && m.textFilter.length > 0) || m.childFilter
  );
}

function normalizeCmpRules(rawRules) {
  const cmps = {};
  const partialCoverage = [];

  for (const [name, rule] of Object.entries(rawRules)) {
    const detector = rule.detectors?.[0];
    const method = rule.methods?.[0];
    if (!detector) continue;

    const present = extractSelectors(detector.presentMatcher);
    const showing = extractSelectors(detector.showingMatcher);
    const allSelectors = [...new Set([...present.selectors, ...showing.selectors])];

    if (allSelectors.length === 0) continue;

    const hasPartialCoverage =
      hasDroppedFilters(detector.presentMatcher) ||
      hasDroppedFilters(detector.showingMatcher);
    if (hasPartialCoverage) partialCoverage.push(name);

    cmps[name] = {
      detect: allSelectors,
      detect_requires_visible: present.requiresVisible || showing.requiresVisible,
      hide: extractHideSelectors(method?.HIDE_CMP),
      dismiss: extractDismissActions(method?.DO_CONSENT, method?.SAVE_CONSENT),
    };
  }

  return { cmps, partial_coverage_cmps: partialCoverage };
}

module.exports = { parseAbpHideRules, normalizeCmpRules };

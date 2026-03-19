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

module.exports = { parseAbpHideRules };

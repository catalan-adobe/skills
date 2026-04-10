#!/usr/bin/env node

/**
 * Deterministic row content extraction via playwright-cli --raw run-code.
 *
 * Extracts complete DOM content for each direct child of a header row,
 * bypassing LLM truncation. Produces a JSON file per row with cleaned
 * innerHTML and structured link trees for every element.
 *
 * Usage:
 *   node extract-row-content.js <session> <row-selector> <output-path>
 *
 * Requires an open playwright-cli session on the target page.
 * Output: JSON array of extracted elements written to <output-path>.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 30000,
};

function usage() {
  console.error(
    'Usage: node extract-row-content.js <session> <row-selector> <output-path>',
  );
  process.exit(1);
}

const session = process.argv[2];
const rowSelector = process.argv[3];
const outputPath = process.argv[4];

if (!session || !rowSelector || !outputPath) usage();

// The extraction code runs inside page.evaluate — no Node APIs, pure browser JS.
// We pass rowSelector as a parameter to avoid shell quoting issues.
const extractCode = `async page => {
  return await page.evaluate((rowSel) => {
    const row = document.querySelector(rowSel);
    if (!row) return JSON.stringify({ error: 'Row not found: ' + rowSel });

    // Find direct children that are actual content elements
    const children = Array.from(row.children).filter(el => {
      const tag = el.tagName.toLowerCase();
      return tag !== 'script' && tag !== 'style' && tag !== 'noscript';
    });

    return JSON.stringify(children.map((child, i) => {
      // Clone to avoid mutating the page
      const clone = child.cloneNode(true);
      clone.querySelectorAll('script,style,noscript').forEach(n => n.remove());

      // Extract all links (including hidden dropdown content)
      const links = Array.from(child.querySelectorAll('a[href]')).map(a => ({
        text: a.textContent.replace(/\\s+/g, ' ').trim(),
        href: a.getAttribute('href'),
        hasImage: !!a.querySelector('img'),
        imgSrc: a.querySelector('img')?.getAttribute('src') || null,
        imgAlt: a.querySelector('img')?.getAttribute('alt') || null,
      })).filter(l => l.text.length > 0 || l.hasImage);

      // Top-level link or text
      const topLink = child.querySelector(':scope > a');
      const topText = topLink
        ? topLink.textContent.replace(/\\s+/g, ' ').trim()
        : child.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200);

      return {
        index: i,
        tag: child.tagName.toLowerCase(),
        topText,
        topHref: topLink?.getAttribute('href') || null,
        linkCount: links.length,
        links,
        cleanHtml: clone.innerHTML.replace(/\\s+/g, ' ').trim(),
      };
    }));
  }, '${rowSelector.replace(/'/g, "\\'")}');
}`;

try {
  const raw = execFileSync('playwright-cli', [
    `-s=${session}`, '--raw', 'run-code', extractCode,
  ], EXEC_OPTS);

  // run-code with --raw returns the value directly (string-encoded JSON)
  const parsed = JSON.parse(raw);

  // parsed is either the JSON string from page.evaluate or an error object
  const items = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;

  if (items.error) {
    console.error(`Extraction failed: ${items.error}`);
    process.exit(1);
  }

  writeFileSync(outputPath, JSON.stringify(items, null, 2));

  const totalLinks = items.reduce((s, it) => s + it.linkCount, 0);
  console.error(
    `Extracted ${items.length} elements (${totalLinks} links) → ${outputPath}`,
  );
} catch (err) {
  console.error(`extract-row-content failed: ${err.message}`);
  process.exit(1);
}

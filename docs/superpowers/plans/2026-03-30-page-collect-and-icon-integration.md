# page-collect Skill & migrate-header Icon Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a `page-collect` skill that extracts structured resources (icons, metadata, text, forms, videos, socials) from any webpage via Playwright, then update migrate-header to consume its icon output through the standard EDS icon system.

**Architecture:** A single skill with a CLI entry point (`page-collect.js`) that routes subcommands to per-collector modules (`collect-icons.js`, `collect-metadata.js`, etc.). Each collector receives a Playwright `page` object and returns structured data. The icon collector classifies SVGs as icon/logo/image based on rendered size and DOM context. migrate-header gains a new pipeline stage between extraction and scaffold that runs `page-collect icons`, and the scaffold subagent wires extracted icons into `/icons/` + `:iconname:` notation.

**Tech Stack:** Node.js 22 (ESM), Playwright (via `npx playwright` or `browser-universal` detection), no external dependencies beyond Playwright.

**Spec:** `docs/superpowers/specs/2026-03-30-page-collect-and-icon-integration-design.md`

---

## File Structure

### New files (page-collect skill)

| File | Responsibility |
|------|---------------|
| `skills/page-collect/SKILL.md` | Orchestration prompt — subcommand routing, output interpretation, naming review |
| `skills/page-collect/scripts/page-collect.js` | CLI entry — arg parsing, Playwright session lifecycle, subcommand dispatch |
| `skills/page-collect/scripts/collect-icons.js` | Icon extraction, classification (icon/logo/image), SVG optimization, manifest generation |
| `skills/page-collect/scripts/collect-metadata.js` | Meta tags, OG, structured data, canonical, favicon extraction |
| `skills/page-collect/scripts/collect-text.js` | Visible body text, heading hierarchy, word count, language |
| `skills/page-collect/scripts/collect-forms.js` | Form structures, fields, actions |
| `skills/page-collect/scripts/collect-videos.js` | Video embeds, iframes matching known hosts |
| `skills/page-collect/scripts/collect-socials.js` | Social media links, share buttons |
| `skills/page-collect/references/collectors.md` | Collector details for progressive disclosure |
| `skills/page-collect/references/icon-font-maps.md` | Placeholder for future icon font codepoint → SVG tables |
| `tests/page-collect/fixtures/inline-svgs.html` | Test fixture: page with inline SVG icons |
| `tests/page-collect/fixtures/img-svgs.html` | Test fixture: page with `<img src="*.svg">` icons |
| `tests/page-collect/fixtures/mixed-icons.html` | Test fixture: page with mixed icon formats + logo + large SVG image |
| `tests/page-collect/test-icons.sh` | Integration test: runs icon collector against fixtures, validates output |
| `tests/page-collect/test-all.sh` | Integration test: runs `all` subcommand, validates collection.json schema |

### Modified files (migrate-header integration)

| File | Change |
|------|--------|
| `skills/migrate-header/SKILL.md` | Add icon collection stage between extraction and scaffold; update scaffold subagent prompt to handle icons |
| `skills/migrate-header/templates/program.md.tmpl` | Add "Available Icons" section so polish loop doesn't recreate icons |
| `skills/migrate-header/scripts/setup-polish-loop.js` | Pass icon manifest data to template replacements |

---

## Task 1: page-collect CLI entry point

**Files:**
- Create: `skills/page-collect/scripts/page-collect.js`

This is the shared entry point that all subcommands route through. It owns the Playwright lifecycle.

- [ ] **Step 1: Create the skill directory structure**

```bash
mkdir -p skills/page-collect/scripts
mkdir -p skills/page-collect/references
mkdir -p tests/page-collect/fixtures
```

- [ ] **Step 2: Write page-collect.js**

```js
#!/usr/bin/env node

/**
 * page-collect — Extract structured resources from a webpage.
 *
 * Usage:
 *   node page-collect.js <subcommand> <url> [--output <dir>]
 *
 * Subcommands:
 *   all       Run all collectors
 *   icons     Extract and classify SVG icons
 *   metadata  Extract meta tags, OG, structured data
 *   text      Extract visible body text and headings
 *   forms     Extract form structures
 *   videos    Extract video embeds
 *   socials   Extract social media links
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { collectIcons } from './collect-icons.js';
import { collectMetadata } from './collect-metadata.js';
import { collectText } from './collect-text.js';
import { collectForms } from './collect-forms.js';
import { collectVideos } from './collect-videos.js';
import { collectSocials } from './collect-socials.js';

const COLLECTORS = {
  icons: collectIcons,
  metadata: collectMetadata,
  text: collectText,
  forms: collectForms,
  videos: collectVideos,
  socials: collectSocials,
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const subcommand = args[0];
  const url = args.find((a) => a.startsWith('http'));
  let output = './page-collect-output';

  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    output = args[outputIdx + 1];
  }

  if (!subcommand || !url) {
    console.error(
      'Usage: node page-collect.js <subcommand> <url> [--output <dir>]'
    );
    console.error(
      'Subcommands: all, icons, metadata, text, forms, videos, socials'
    );
    process.exit(1);
  }

  if (subcommand !== 'all' && !COLLECTORS[subcommand]) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error(
      'Valid subcommands: all, icons, metadata, text, forms, videos, socials'
    );
    process.exit(1);
  }

  return { subcommand, url, output: resolve(output) };
}

function detectPlaywright() {
  try {
    execSync('npx playwright --version', { stdio: 'pipe' });
    return 'npx';
  } catch {
    console.error(
      'Playwright not found. Install with: npx playwright install chromium'
    );
    process.exit(1);
  }
}

async function launchBrowser(url) {
  detectPlaywright();

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.error(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  return { browser, page };
}

async function takeScreenshot(page, outputDir) {
  const screenshotPath = join(outputDir, 'screenshot.jpg');
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    type: 'jpeg',
    quality: 80,
  });
  return 'screenshot.jpg';
}

async function main() {
  const { subcommand, url, output } = parseArgs(process.argv);
  await mkdir(output, { recursive: true });

  const { browser, page } = await launchBrowser(url);

  try {
    if (subcommand === 'all') {
      const screenshot = await takeScreenshot(page, output);
      const results = {};

      for (const [name, collector] of Object.entries(COLLECTORS)) {
        console.error(`Running ${name} collector...`);
        results[name] = await collector(page, output);
      }

      const collection = {
        url,
        collectedAt: new Date().toISOString(),
        screenshot,
        collectors: results,
      };

      await writeFile(
        join(output, 'collection.json'),
        JSON.stringify(collection, null, 2)
      );
      console.error(`Done. Output: ${output}/collection.json`);
    } else {
      console.error(`Running ${subcommand} collector...`);
      const result = await COLLECTORS[subcommand](page, output);

      const outputFile = `${subcommand}.json`;
      await writeFile(
        join(output, outputFile),
        JSON.stringify(result, null, 2)
      );
      console.error(`Done. Output: ${output}/${outputFile}`);
    }
  } finally {
    await browser.close();
  }
}

main();
```

- [ ] **Step 3: Verify the script parses args correctly**

Run: `node skills/page-collect/scripts/page-collect.js`
Expected: Error message with usage instructions, exit code 1.

Run: `node skills/page-collect/scripts/page-collect.js badcmd https://example.com`
Expected: Error "Unknown subcommand: badcmd", exit code 1.

- [ ] **Step 4: Commit**

```bash
git add skills/page-collect/scripts/page-collect.js
git commit -m "feat(page-collect): CLI entry point with Playwright session and subcommand routing"
```

---

## Task 2: Icon collector — extraction

**Files:**
- Create: `skills/page-collect/scripts/collect-icons.js`
- Create: `tests/page-collect/fixtures/inline-svgs.html`
- Create: `tests/page-collect/fixtures/img-svgs.html`

The icon collector is the most complex collector. This task handles extraction from multiple sources. Classification and optimization come in Task 3.

- [ ] **Step 1: Create the inline SVG test fixture**

```html
<!-- tests/page-collect/fixtures/inline-svgs.html -->
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Inline SVG Test</title></head>
<body>
<header>
  <a href="/" class="logo">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 40'%3E%3Crect fill='%23e00' width='120' height='40'/%3E%3Ctext x='10' y='28' fill='white' font-size='20'%3ELogo%3C/text%3E%3C/svg%3E" alt="Company Logo" width="120" height="40">
  </a>
  <nav>
    <a href="/products">Products</a>
    <a href="/solutions">Solutions</a>
  </nav>
  <div class="tools">
    <button class="search-icon" aria-label="Search">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
        <circle cx="10" cy="10" r="7" fill="none" stroke="#333" stroke-width="2"/>
        <line x1="15" y1="15" x2="21" y2="21" stroke="#333" stroke-width="2"/>
      </svg>
    </button>
    <a href="/cart" class="cart-icon" aria-label="Cart">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
        <path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7.2 14.8l.1-.2 1.1-2h7.5c.7 0 1.4-.4 1.7-1l3.9-7-1.7-1H5.2l-.9-2H1v2h2l3.6 7.6L5.2 14c-.1.3-.2.6-.2 1 0 1.1.9 2 2 2h12v-2H7.4c-.1 0-.2-.1-.2-.2z" fill="#333"/>
      </svg>
    </a>
  </div>
  <!-- Large decorative SVG — should be classified as image, not icon -->
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200" width="800" height="200">
    <rect fill="#f0f0f0" width="800" height="200"/>
    <text x="400" y="100" text-anchor="middle" fill="#999" font-size="40">Hero Banner</text>
  </svg>
</header>
</body>
</html>
```

- [ ] **Step 2: Create the img-SVG test fixture**

```html
<!-- tests/page-collect/fixtures/img-svgs.html -->
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>IMG SVG Test</title></head>
<body>
<header>
  <a href="/" class="brand">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 30'%3E%3Ctext x='5' y='22' fill='%23333' font-size='18'%3EBrand%3C/text%3E%3C/svg%3E" alt="Brand Logo" width="100" height="30">
  </a>
  <nav>
    <a href="/about">About</a>
  </nav>
  <div class="utility">
    <a href="/account" aria-label="Account">
      <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='8' r='4' fill='%23333'/%3E%3Cpath d='M12 14c-6 0-8 3-8 3v1h16v-1s-2-3-8-3z' fill='%23333'/%3E%3C/svg%3E" alt="Account" width="24" height="24">
    </a>
  </div>
</header>
</body>
</html>
```

- [ ] **Step 3: Write collect-icons.js — extraction logic**

```js
#!/usr/bin/env node

/**
 * Icon collector — extracts, classifies, and optimizes SVG icons
 * from a webpage.
 *
 * Extraction sources:
 * - Inline <svg> elements
 * - <img> tags pointing to SVG files or data URIs
 * - CSS background-image SVG data URIs
 * - SVG <use> sprites (resolved to standalone SVGs)
 *
 * Classification:
 * - icon:  rendered ≤ 48px, inside interactive element
 * - logo:  in brand area, "logo" in alt/class/src
 * - image: rendered > 48px, standalone
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ICON_MAX_SIZE = 48;

/**
 * Extract all SVG-bearing elements from the page.
 * Runs in the browser context via page.evaluate().
 */
async function extractRawSvgs(page) {
  return page.evaluate((maxSize) => {
    const results = [];

    // 1. Inline <svg> elements
    for (const svg of document.querySelectorAll('svg')) {
      const rect = svg.getBoundingClientRect();
      const parent = svg.closest('a, button');
      const container = svg.closest('header, nav, [class*="brand"]');
      results.push({
        source: 'inline-svg',
        svg: svg.outerHTML,
        width: rect.width,
        height: rect.height,
        parentTag: parent?.tagName || null,
        parentClass: parent?.className || '',
        parentAriaLabel: parent?.getAttribute('aria-label') || '',
        parentHref: parent?.getAttribute('href') || '',
        containerTag: container?.tagName || null,
        containerClass: container?.className || '',
        id: svg.id || '',
        svgClass: svg.getAttribute('class') || '',
      });
    }

    // 2. <img> tags with SVG src (file or data URI)
    for (const img of document.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (!src.includes('.svg') && !src.includes('image/svg+xml')) continue;

      const rect = img.getBoundingClientRect();
      const parent = img.closest('a, button');
      const container = img.closest('header, nav, [class*="brand"]');
      results.push({
        source: 'img-svg',
        src,
        alt: img.alt || '',
        width: rect.width,
        height: rect.height,
        parentTag: parent?.tagName || null,
        parentClass: parent?.className || '',
        parentAriaLabel: parent?.getAttribute('aria-label') || '',
        parentHref: parent?.getAttribute('href') || '',
        containerTag: container?.tagName || null,
        containerClass: container?.className || '',
        imgClass: img.className || '',
      });
    }

    // 3. CSS background-image SVG data URIs
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      if (!bg.includes('image/svg+xml') && !bg.includes('.svg')) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      results.push({
        source: 'css-bg-svg',
        backgroundImage: bg,
        width: rect.width,
        height: rect.height,
        tag: el.tagName,
        className: el.className || '',
        id: el.id || '',
      });
    }

    // 4. SVG <use> sprite references
    for (const use of document.querySelectorAll('use')) {
      const href =
        use.getAttribute('href') ||
        use.getAttribute('xlink:href') ||
        '';
      if (!href) continue;

      const svg = use.closest('svg');
      if (!svg) continue;

      const rect = svg.getBoundingClientRect();
      const parent = svg.closest('a, button');

      // Try to resolve the referenced symbol
      const symbolId = href.startsWith('#') ? href.slice(1) : '';
      const symbol = symbolId
        ? document.getElementById(symbolId)
        : null;

      results.push({
        source: 'svg-sprite',
        href,
        symbolSvg: symbol ? symbol.outerHTML : null,
        fallbackSvg: svg.outerHTML,
        width: rect.width,
        height: rect.height,
        parentTag: parent?.tagName || null,
        parentClass: parent?.className || '',
        parentAriaLabel: parent?.getAttribute('aria-label') || '',
      });
    }

    return results;
  }, ICON_MAX_SIZE);
}

/**
 * Resolve an img-svg source to its actual SVG content.
 * Handles both data URIs and remote .svg URLs.
 */
async function resolveImgSvg(page, src) {
  if (src.startsWith('data:image/svg+xml,')) {
    return decodeURIComponent(src.replace('data:image/svg+xml,', ''));
  }
  if (src.startsWith('data:image/svg+xml;base64,')) {
    const b64 = src.replace('data:image/svg+xml;base64,', '');
    return Buffer.from(b64, 'base64').toString('utf-8');
  }
  // Remote SVG file — fetch via page context to handle relative URLs
  try {
    return await page.evaluate(async (url) => {
      const res = await fetch(url);
      if (!res.ok) return null;
      return res.text();
    }, src);
  } catch {
    return null;
  }
}

/**
 * Resolve a CSS background-image to SVG content.
 */
function resolveCssBgSvg(backgroundImage) {
  const dataMatch = backgroundImage.match(
    /url\(["']?data:image\/svg\+xml,([^"')]+)["']?\)/
  );
  if (dataMatch) return decodeURIComponent(dataMatch[1]);

  const b64Match = backgroundImage.match(
    /url\(["']?data:image\/svg\+xml;base64,([^"')]+)["']?\)/
  );
  if (b64Match) return Buffer.from(b64Match[1], 'base64').toString('utf-8');

  return null;
}

/**
 * Classify a raw SVG entry as icon, logo, or image.
 */
function classify(entry) {
  const maxDim = Math.max(entry.width, entry.height);
  const allClasses = [
    entry.parentClass,
    entry.containerClass,
    entry.imgClass,
    entry.svgClass,
    entry.className,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const alt = (entry.alt || entry.parentAriaLabel || '').toLowerCase();

  // Logo detection
  if (
    allClasses.includes('logo') ||
    allClasses.includes('brand') ||
    alt.includes('logo')
  ) {
    return 'logo';
  }

  // Image detection — large SVGs not inside interactive elements
  if (maxDim > ICON_MAX_SIZE && !entry.parentTag) {
    return 'image';
  }

  // Icon — small or inside interactive element
  return 'icon';
}

/**
 * Derive a meaningful name for the icon from DOM context.
 */
function deriveName(entry, index) {
  const candidates = [
    entry.parentAriaLabel,
    entry.alt,
    entry.id,
  ].filter(Boolean);

  // Check class names for known icon patterns
  const allClasses = [
    entry.parentClass,
    entry.imgClass,
    entry.svgClass,
    entry.className,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const knownPatterns = [
    'search', 'cart', 'account', 'user', 'menu', 'hamburger',
    'close', 'globe', 'language', 'phone', 'mail', 'email',
    'heart', 'star', 'share', 'download', 'arrow', 'chevron',
    'caret', 'plus', 'minus', 'check', 'info', 'warning',
    'home', 'settings', 'notification', 'bell', 'lock',
  ];

  for (const pattern of knownPatterns) {
    if (allClasses.includes(pattern)) {
      return { name: pattern, confidence: 'high' };
    }
  }

  for (const candidate of candidates) {
    const clean = candidate
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (clean.length > 0 && clean.length < 30) {
      return { name: clean, confidence: 'high' };
    }
  }

  return { name: `icon-${index}`, confidence: 'low' };
}

/**
 * Clean and optimize an SVG string for use as an EDS icon.
 */
function optimizeSvg(svgString, classification) {
  let svg = svgString;

  // Strip XML declaration
  svg = svg.replace(/<\?xml[^?]*\?>\s*/g, '');

  // Strip comments
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');

  // Strip metadata, title, desc elements
  svg = svg.replace(/<metadata[\s\S]*?<\/metadata>/gi, '');
  svg = svg.replace(/<title[\s\S]*?<\/title>/gi, '');
  svg = svg.replace(/<desc[\s\S]*?<\/desc>/gi, '');

  // Strip editor-specific attributes
  svg = svg.replace(/\s*(xmlns:xlink|xmlns:sketch|xmlns:dc|xmlns:cc|xmlns:rdf|xmlns:sodipodi|xmlns:inkscape)="[^"]*"/g, '');
  svg = svg.replace(/\s*(sketch:|sodipodi:|inkscape:)[a-z-]+="[^"]*"/gi, '');
  svg = svg.replace(/\s*data-name="[^"]*"/g, '');

  // Ensure viewBox exists — extract from width/height if missing
  if (!svg.includes('viewBox')) {
    const wMatch = svg.match(/\bwidth="(\d+(?:\.\d+)?)"/);
    const hMatch = svg.match(/\bheight="(\d+(?:\.\d+)?)"/);
    if (wMatch && hMatch) {
      svg = svg.replace(
        '<svg',
        `<svg viewBox="0 0 ${wMatch[1]} ${hMatch[1]}"`
      );
    }
  }

  // Remove hardcoded width/height (viewBox handles sizing)
  svg = svg.replace(/\s*\bwidth="[^"]*"/g, '');
  svg = svg.replace(/\s*\bheight="[^"]*"/g, '');

  // Replace colors with currentColor (icons only, not logos)
  if (classification === 'icon') {
    svg = svg.replace(
      /\b(fill|stroke)="(?!none|currentColor|transparent)[^"]+"/g,
      '$1="currentColor"'
    );
  }

  // Collapse whitespace
  svg = svg.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><').trim();

  return svg;
}

/**
 * Main collector entry point.
 */
export async function collectIcons(page, outputDir) {
  const iconsDir = join(outputDir, 'icons');
  await mkdir(iconsDir, { recursive: true });

  const rawEntries = await extractRawSvgs(page);
  const icons = [];

  let unnamedIndex = 1;
  const usedNames = new Set();

  for (const entry of rawEntries) {
    const classification = classify(entry);

    // Skip images — not icons
    if (classification === 'image') continue;

    // Resolve SVG content based on source type
    let svgContent = null;

    if (entry.source === 'inline-svg') {
      svgContent = entry.svg;
    } else if (entry.source === 'img-svg') {
      svgContent = await resolveImgSvg(page, entry.src);
    } else if (entry.source === 'css-bg-svg') {
      svgContent = resolveCssBgSvg(entry.backgroundImage);
    } else if (entry.source === 'svg-sprite') {
      if (entry.symbolSvg) {
        // Convert <symbol> to standalone <svg>
        svgContent = entry.symbolSvg
          .replace(/^<symbol/, '<svg xmlns="http://www.w3.org/2000/svg"')
          .replace(/<\/symbol>$/, '</svg>');
      } else {
        svgContent = entry.fallbackSvg;
      }
    }

    if (!svgContent) continue;

    // Derive name
    const { name: rawName, confidence } = deriveName(entry, unnamedIndex);
    let name = rawName;
    if (usedNames.has(name)) {
      name = `${name}-${unnamedIndex}`;
    }
    if (confidence === 'low') unnamedIndex++;
    usedNames.add(name);

    // Optimize SVG
    const optimized = optimizeSvg(svgContent, classification);

    // Write SVG file
    const filename = `${name}.svg`;
    await writeFile(join(iconsDir, filename), optimized);

    // Build context description
    const context = [
      entry.containerTag ? entry.containerTag.toLowerCase() : '',
      entry.parentTag ? entry.parentTag.toLowerCase() : '',
      entry.parentAriaLabel || '',
    ]
      .filter(Boolean)
      .join(' ');

    icons.push({
      name,
      class: classification,
      source: entry.source,
      file: `icons/${filename}`,
      nameConfidence: confidence,
      context: context || 'unknown',
    });
  }

  const manifest = {
    url: page.url(),
    icons,
  };

  // Also write manifest to icons.json in output dir
  await writeFile(
    join(outputDir, 'icons.json'),
    JSON.stringify(manifest, null, 2)
  );

  return manifest;
}
```

- [ ] **Step 4: Run the icon collector against the inline SVG fixture**

```bash
npx playwright install chromium 2>/dev/null
node skills/page-collect/scripts/page-collect.js icons \
  "file://$(pwd)/tests/page-collect/fixtures/inline-svgs.html" \
  --output /tmp/page-collect-test-inline
```

Expected: `/tmp/page-collect-test-inline/icons/` contains `search.svg`, `cart.svg`, `logo.svg` (3 files — the large hero SVG should be excluded as `image`). `icons.json` should have 3 entries with correct classifications.

- [ ] **Step 5: Verify classifications and SVG cleanup**

```bash
cat /tmp/page-collect-test-inline/icons.json
```

Expected manifest:
- `search`: class `icon`, source `inline-svg`, nameConfidence `high`
- `cart`: class `icon`, source `inline-svg`, nameConfidence `high`
- `logo` (or `company-logo`): class `logo`, source `img-svg`, nameConfidence `high`
- NO entry for the 800x200 hero banner SVG

Check SVG optimization on the search icon:
```bash
cat /tmp/page-collect-test-inline/icons/search.svg
```

Expected: no width/height attributes, has viewBox, fill/stroke replaced with `currentColor`, no comments.

- [ ] **Step 6: Run against the img-SVG fixture**

```bash
node skills/page-collect/scripts/page-collect.js icons \
  "file://$(pwd)/tests/page-collect/fixtures/img-svgs.html" \
  --output /tmp/page-collect-test-img
cat /tmp/page-collect-test-img/icons.json
```

Expected: 2 icons — a logo and an account icon, both resolved from data URIs.

- [ ] **Step 7: Commit**

```bash
git add skills/page-collect/scripts/collect-icons.js \
  tests/page-collect/fixtures/inline-svgs.html \
  tests/page-collect/fixtures/img-svgs.html
git commit -m "feat(page-collect): icon collector with extraction, classification, and SVG optimization"
```

---

## Task 3: Mixed icon fixture and integration test

**Files:**
- Create: `tests/page-collect/fixtures/mixed-icons.html`
- Create: `tests/page-collect/test-icons.sh`

This task validates the collector against a realistic page with multiple icon formats and edge cases.

- [ ] **Step 1: Create the mixed icons fixture**

```html
<!-- tests/page-collect/fixtures/mixed-icons.html -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Mixed Icons Test</title>
<style>
  .bg-icon {
    display: inline-block;
    width: 24px;
    height: 24px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93z' fill='%23666'/%3E%3C/svg%3E");
  }
</style>
</head>
<body>
<header>
  <!-- Logo as img-svg -->
  <a href="/" class="logo-link">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 150 40'%3E%3Crect fill='%230066cc' width='150' height='40' rx='4'/%3E%3Ctext x='75' y='26' text-anchor='middle' fill='white' font-size='16'%3EAcme Corp%3C/text%3E%3C/svg%3E" alt="Acme Corp Logo" width="150" height="40">
  </a>

  <nav>
    <a href="/products">Products</a>
    <a href="/solutions">Solutions</a>
    <a href="/pricing">Pricing</a>
  </nav>

  <div class="tools">
    <!-- Inline SVG search icon -->
    <button class="search-toggle" aria-label="Search">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
        <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 5 1.49-1.49-5-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" fill="#333"/>
      </svg>
    </button>

    <!-- CSS background SVG globe icon -->
    <a href="/language" aria-label="Language">
      <span class="bg-icon"></span>
    </a>

    <!-- SVG sprite reference -->
    <svg style="display:none">
      <symbol id="icon-cart" viewBox="0 0 24 24">
        <path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7.2 14.8V14l1.1-2h7.5c.7 0 1.4-.4 1.7-1l3.9-7-1.7-1H5.2l-.9-2H1v2h2l3.6 7.6L5.2 14c-.1.3-.2.6-.2 1 0 1.1.9 2 2 2h12v-2H7.4c-.1 0-.2-.1-.2-.2z" fill="#333"/>
      </symbol>
    </svg>
    <a href="/cart" aria-label="Cart">
      <svg width="20" height="20"><use href="#icon-cart"/></svg>
    </a>
  </div>
</header>

<!-- Large decorative SVG — should be classified as image -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400" width="1200" height="400">
  <rect fill="#f5f5f5" width="1200" height="400"/>
</svg>
</body>
</html>
```

- [ ] **Step 2: Write the integration test script**

```bash
#!/usr/bin/env bash
set -euo pipefail

# tests/page-collect/test-icons.sh
# Integration test for the icon collector.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COLLECT="$REPO_ROOT/skills/page-collect/scripts/page-collect.js"
FIXTURES="$SCRIPT_DIR/fixtures"
OUTPUT="/tmp/page-collect-test-$$"
PASS=0
FAIL=0

cleanup() { rm -rf "$OUTPUT"; }
trap cleanup EXIT

assert_file_exists() {
  if [[ -f "$1" ]]; then
    ((++PASS))
  else
    echo "FAIL: expected file $1"
    ((++FAIL))
  fi
}

assert_file_missing() {
  if [[ ! -f "$1" ]]; then
    ((++PASS))
  else
    echo "FAIL: unexpected file $1"
    ((++FAIL))
  fi
}

assert_json_count() {
  local file="$1" path="$2" expected="$3"
  local actual
  actual=$(node -e "
    import {readFileSync} from 'fs';
    const d = JSON.parse(readFileSync('$file','utf-8'));
    const v = $path;
    console.log(Array.isArray(v) ? v.length : 0);
  ")
  if [[ "$actual" == "$expected" ]]; then
    ((++PASS))
  else
    echo "FAIL: $path count expected $expected, got $actual"
    ((++FAIL))
  fi
}

assert_json_value() {
  local file="$1" path="$2" expected="$3"
  local actual
  actual=$(node -e "
    import {readFileSync} from 'fs';
    const d = JSON.parse(readFileSync('$file','utf-8'));
    console.log($path);
  ")
  if [[ "$actual" == "$expected" ]]; then
    ((++PASS))
  else
    echo "FAIL: $path expected '$expected', got '$actual'"
    ((++FAIL))
  fi
}

echo "=== Test: inline-svgs.html ==="
OUT1="$OUTPUT/inline"
node "$COLLECT" icons "file://$FIXTURES/inline-svgs.html" --output "$OUT1"
assert_file_exists "$OUT1/icons.json"
assert_file_exists "$OUT1/icons/search.svg"
assert_file_exists "$OUT1/icons/cart.svg"
assert_json_count "$OUT1/icons.json" "d.icons.filter(i => i.class !== 'image')" "3"
assert_json_value "$OUT1/icons.json" "d.icons.find(i => i.name === 'search')?.class" "icon"

echo ""
echo "=== Test: img-svgs.html ==="
OUT2="$OUTPUT/img"
node "$COLLECT" icons "file://$FIXTURES/img-svgs.html" --output "$OUT2"
assert_file_exists "$OUT2/icons.json"
assert_json_count "$OUT2/icons.json" "d.icons" "2"

echo ""
echo "=== Test: mixed-icons.html ==="
OUT3="$OUTPUT/mixed"
node "$COLLECT" icons "file://$FIXTURES/mixed-icons.html" --output "$OUT3"
assert_file_exists "$OUT3/icons.json"
assert_file_exists "$OUT3/icons/search.svg"
assert_json_count "$OUT3/icons.json" "d.icons.filter(i => i.class === 'icon')" "3"
assert_json_count "$OUT3/icons.json" "d.icons.filter(i => i.class === 'logo')" "1"

# Verify large decorative SVG was excluded
assert_json_count "$OUT3/icons.json" "d.icons.filter(i => i.class === 'image')" "0"

# Verify SVG optimization — no hardcoded width/height, has viewBox
SEARCH_SVG="$OUT3/icons/search.svg"
if grep -q 'width=' "$SEARCH_SVG"; then
  echo "FAIL: search.svg still has width attribute"
  ((++FAIL))
else
  ((++PASS))
fi
if grep -q 'viewBox' "$SEARCH_SVG"; then
  ((++PASS))
else
  echo "FAIL: search.svg missing viewBox"
  ((++FAIL))
fi
if grep -q 'currentColor' "$SEARCH_SVG"; then
  ((++PASS))
else
  echo "FAIL: search.svg missing currentColor"
  ((++FAIL))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
```

- [ ] **Step 3: Run the integration tests**

```bash
chmod +x tests/page-collect/test-icons.sh
bash tests/page-collect/test-icons.sh
```

Expected: All assertions pass. Fix any failures before proceeding.

- [ ] **Step 4: Commit**

```bash
git add tests/page-collect/fixtures/mixed-icons.html \
  tests/page-collect/test-icons.sh
git commit -m "test(page-collect): icon collector integration tests with mixed fixture"
```

---

## Task 4: Metadata collector

**Files:**
- Create: `skills/page-collect/scripts/collect-metadata.js`

- [ ] **Step 1: Write collect-metadata.js**

```js
/**
 * Metadata collector — extracts meta tags, Open Graph, structured
 * data, canonical URL, and favicon from a webpage.
 */

export async function collectMetadata(page) {
  return page.evaluate(() => {
    const meta = {};

    // Title
    meta.title = document.title || null;

    // Meta tags
    meta.tags = {};
    for (const el of document.querySelectorAll('meta[name], meta[property]')) {
      const key = el.getAttribute('name') || el.getAttribute('property');
      const content = el.getAttribute('content');
      if (key && content) meta.tags[key] = content;
    }

    // Canonical
    const canonical = document.querySelector('link[rel="canonical"]');
    meta.canonical = canonical ? canonical.getAttribute('href') : null;

    // Structured data
    meta.structuredData = [];
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        meta.structuredData.push(JSON.parse(script.textContent));
      } catch {
        // skip malformed JSON-LD
      }
    }

    // Favicon
    const favicon =
      document.querySelector('link[rel="icon"]') ||
      document.querySelector('link[rel="shortcut icon"]');
    meta.favicon = favicon ? favicon.getAttribute('href') : null;

    return meta;
  });
}
```

- [ ] **Step 2: Test against a live URL**

```bash
node skills/page-collect/scripts/page-collect.js metadata \
  https://www.adobe.com --output /tmp/page-collect-meta
cat /tmp/page-collect-meta/metadata.json | head -30
```

Expected: JSON with title, og:* tags, canonical URL, structured data array.

- [ ] **Step 3: Commit**

```bash
git add skills/page-collect/scripts/collect-metadata.js
git commit -m "feat(page-collect): metadata collector"
```

---

## Task 5: Text collector

**Files:**
- Create: `skills/page-collect/scripts/collect-text.js`

- [ ] **Step 1: Write collect-text.js**

```js
/**
 * Text collector — extracts visible body text, heading hierarchy,
 * word count, and language from a webpage.
 */

export async function collectText(page) {
  return page.evaluate(() => {
    // Language from html tag
    const lang =
      document.documentElement.getAttribute('lang') || 'und';

    // Extract headings
    const headings = [];
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const text = h.textContent.trim();
      if (text) {
        headings.push({
          level: parseInt(h.tagName.substring(1), 10),
          text,
        });
      }
    }

    // Extract visible body text (exclude nav, footer, script, style)
    const exclude = 'nav, footer, script, style, noscript, svg, [hidden]';
    const clone = document.body.cloneNode(true);
    for (const el of clone.querySelectorAll(exclude)) {
      el.remove();
    }
    const text = clone.textContent
      .replace(/\s+/g, ' ')
      .trim();

    const wordCount = text
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    return { language: lang, headings, text, wordCount };
  });
}
```

- [ ] **Step 2: Test**

```bash
node skills/page-collect/scripts/page-collect.js text \
  https://www.adobe.com --output /tmp/page-collect-text
node -e "import {readFileSync} from 'fs'; const d=JSON.parse(readFileSync('/tmp/page-collect-text/text.json','utf-8')); console.log('lang:', d.language, 'words:', d.wordCount, 'headings:', d.headings.length)"
```

Expected: Language code, word count > 0, headings array with levels.

- [ ] **Step 3: Commit**

```bash
git add skills/page-collect/scripts/collect-text.js
git commit -m "feat(page-collect): text collector"
```

---

## Task 6: Forms, videos, and socials collectors

**Files:**
- Create: `skills/page-collect/scripts/collect-forms.js`
- Create: `skills/page-collect/scripts/collect-videos.js`
- Create: `skills/page-collect/scripts/collect-socials.js`

These three are simpler collectors. Grouped into one task.

- [ ] **Step 1: Write collect-forms.js**

```js
/**
 * Forms collector — extracts form structures, fields, and actions.
 */

export async function collectForms(page) {
  return page.evaluate(() => {
    const forms = [];
    for (const form of document.querySelectorAll('form')) {
      const fields = [];
      const inputs = form.querySelectorAll(
        'input, select, textarea, button[type="submit"]'
      );
      for (const input of inputs) {
        const label =
          input.getAttribute('aria-label') ||
          input.getAttribute('placeholder') ||
          form.querySelector(`label[for="${input.id}"]`)?.textContent?.trim() ||
          null;
        fields.push({
          tag: input.tagName.toLowerCase(),
          type: input.getAttribute('type') || null,
          name: input.getAttribute('name') || null,
          required: input.hasAttribute('required'),
          label,
        });
      }
      forms.push({
        action: form.getAttribute('action') || null,
        method: (form.getAttribute('method') || 'get').toLowerCase(),
        id: form.id || null,
        className: form.className || null,
        fields,
      });
    }
    return { forms };
  });
}
```

- [ ] **Step 2: Write collect-videos.js**

```js
/**
 * Videos collector — extracts video embeds and sources.
 */

const VIDEO_HOSTS = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'wistia.com',
  'wistia.net',
  'dailymotion.com',
  'twitch.tv',
];

export async function collectVideos(page) {
  return page.evaluate((hosts) => {
    const videos = [];

    // <video> elements
    for (const video of document.querySelectorAll('video')) {
      const sources = [];
      const src = video.getAttribute('src');
      if (src) sources.push({ src, type: null });
      for (const source of video.querySelectorAll('source')) {
        sources.push({
          src: source.getAttribute('src'),
          type: source.getAttribute('type'),
        });
      }
      videos.push({
        type: 'native',
        poster: video.getAttribute('poster') || null,
        sources,
      });
    }

    // <iframe> embeds matching video hosts
    for (const iframe of document.querySelectorAll('iframe[src]')) {
      const src = iframe.getAttribute('src');
      const isVideo = hosts.some(
        (h) => src.includes(h)
      );
      if (isVideo) {
        videos.push({
          type: 'embed',
          src,
          width: iframe.getAttribute('width') || null,
          height: iframe.getAttribute('height') || null,
        });
      }
    }

    return { videos };
  }, VIDEO_HOSTS);
}
```

- [ ] **Step 3: Write collect-socials.js**

```js
/**
 * Socials collector — extracts social media links and share buttons.
 */

const SOCIAL_DOMAINS = {
  'facebook.com': 'facebook',
  'fb.com': 'facebook',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'linkedin.com': 'linkedin',
  'instagram.com': 'instagram',
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'tiktok.com': 'tiktok',
  'pinterest.com': 'pinterest',
  'github.com': 'github',
  'reddit.com': 'reddit',
  'threads.net': 'threads',
  'mastodon.social': 'mastodon',
  'bsky.app': 'bluesky',
};

export async function collectSocials(page) {
  return page.evaluate((domains) => {
    const socials = [];
    const seen = new Set();

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href || seen.has(href)) continue;

      for (const [domain, platform] of Object.entries(domains)) {
        if (href.includes(domain)) {
          seen.add(href);
          const isShare =
            href.includes('share') ||
            href.includes('sharer') ||
            href.includes('intent/tweet');
          socials.push({
            platform,
            url: href,
            type: isShare ? 'share' : 'profile',
            text: a.textContent.trim().substring(0, 100) || null,
          });
          break;
        }
      }
    }

    return { socials };
  }, SOCIAL_DOMAINS);
}
```

- [ ] **Step 4: Test the `all` subcommand end-to-end**

```bash
node skills/page-collect/scripts/page-collect.js all \
  https://www.adobe.com --output /tmp/page-collect-all
ls /tmp/page-collect-all/
cat /tmp/page-collect-all/collection.json | node -e "
  import {readFileSync} from 'fs';
  const d = JSON.parse(readFileSync('/dev/stdin','utf-8'));
  console.log('Collectors:', Object.keys(d.collectors).join(', '));
  console.log('Screenshot:', d.screenshot);
  console.log('Icons:', d.collectors.icons.icons.length);
  console.log('Socials:', d.collectors.socials.socials.length);
"
```

Expected: `collection.json` with all 6 collector results, `screenshot.jpg`, and `icons/` directory.

- [ ] **Step 5: Commit**

```bash
git add skills/page-collect/scripts/collect-forms.js \
  skills/page-collect/scripts/collect-videos.js \
  skills/page-collect/scripts/collect-socials.js
git commit -m "feat(page-collect): forms, videos, and socials collectors"
```

---

## Task 7: `all` subcommand integration test

**Files:**
- Create: `tests/page-collect/test-all.sh`

- [ ] **Step 1: Write the integration test**

```bash
#!/usr/bin/env bash
set -euo pipefail

# tests/page-collect/test-all.sh
# Integration test for the `all` subcommand.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COLLECT="$REPO_ROOT/skills/page-collect/scripts/page-collect.js"
FIXTURES="$SCRIPT_DIR/fixtures"
OUTPUT="/tmp/page-collect-all-test-$$"
PASS=0
FAIL=0

cleanup() { rm -rf "$OUTPUT"; }
trap cleanup EXIT

assert() {
  local desc="$1" cond="$2"
  if eval "$cond"; then
    ((++PASS))
  else
    echo "FAIL: $desc"
    ((++FAIL))
  fi
}

echo "=== Test: all subcommand against mixed-icons fixture ==="
node "$COLLECT" all "file://$FIXTURES/mixed-icons.html" --output "$OUTPUT"

# collection.json exists and has expected structure
assert "collection.json exists" "[[ -f '$OUTPUT/collection.json' ]]"
assert "screenshot.jpg exists" "[[ -f '$OUTPUT/screenshot.jpg' ]]"
assert "icons directory exists" "[[ -d '$OUTPUT/icons' ]]"
assert "icons.json exists" "[[ -f '$OUTPUT/icons.json' ]]"

# Validate collection.json has all collector keys
node -e "
  import {readFileSync} from 'fs';
  const d = JSON.parse(readFileSync('$OUTPUT/collection.json','utf-8'));
  const expected = ['icons','metadata','text','forms','videos','socials'];
  const missing = expected.filter(k => !(k in d.collectors));
  if (missing.length) { console.error('Missing:', missing); process.exit(1); }
  if (!d.url) { console.error('Missing url'); process.exit(1); }
  if (!d.collectedAt) { console.error('Missing collectedAt'); process.exit(1); }
" && ((++PASS)) || { echo "FAIL: collection.json schema"; ((++FAIL)); }

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
```

- [ ] **Step 2: Run it**

```bash
chmod +x tests/page-collect/test-all.sh
bash tests/page-collect/test-all.sh
```

Expected: All assertions pass.

- [ ] **Step 3: Commit**

```bash
git add tests/page-collect/test-all.sh
git commit -m "test(page-collect): all subcommand integration test"
```

---

## Task 8: SKILL.md and reference files

**Files:**
- Create: `skills/page-collect/SKILL.md`
- Create: `skills/page-collect/references/collectors.md`
- Create: `skills/page-collect/references/icon-font-maps.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: page-collect
description: Extract structured resources (icons, metadata, text, forms, videos, social links) from any webpage using Playwright. Supports individual collectors via subcommands (icons, metadata, text, forms, videos, socials) or all at once. The icon collector classifies SVGs as icon/logo/image based on size and DOM context, optimizes them for EDS, and outputs to /icons/ for use with decorateIcons(). Use when migrating pages, auditing sites, or extracting assets.
---

# page-collect

Extract structured resources from any webpage via Playwright.

## Subcommands

| Subcommand | Purpose | Output |
|------------|---------|--------|
| `all` | Run all collectors | `collection.json` + assets |
| `icons` | SVGs, icon fonts, CSS icons → classified SVGs | `icons/` + `icons.json` |
| `metadata` | Meta tags, OG, structured data | `metadata.json` |
| `text` | Body text, headings, word count | `text.json` |
| `forms` | Form structures, fields, actions | `forms.json` |
| `videos` | Video embeds, sources | `videos.json` |
| `socials` | Social media links | `socials.json` |

## How to Run

### Script Location

If `CLAUDE_SKILL_DIR` is set:
```bash
SCRIPT="${CLAUDE_SKILL_DIR}/scripts/page-collect.js"
```

Otherwise, find it:
```bash
SCRIPT="$(find ~/.claude -path "*/page-collect/scripts/page-collect.js" -type f 2>/dev/null | head -1)"
```

### Invocation

```bash
node "$SCRIPT" <subcommand> <url> [--output <dir>]
```

Default output: `./page-collect-output/`

### Prerequisites

Playwright must be installed: `npx playwright install chromium`

## Icon Collector Details

The icon collector extracts SVGs from multiple sources:
- Inline `<svg>` elements
- `<img>` tags with `.svg` src or `data:image/svg+xml` URIs
- CSS `background-image` SVG data URIs
- SVG `<use>` sprite references (resolved to standalone SVGs)

### Classification

| Class | Criteria | Output |
|-------|----------|--------|
| `icon` | ≤ 48px, inside button/link/nav | `/icons/{name}.svg` |
| `logo` | Brand area, "logo" in class/alt/src | `/icons/logo.svg` |
| `image` | > 48px, standalone | Excluded |

### Naming

Icons are named from DOM context (aria-label, class, ID). When no
meaningful name can be derived, they get `icon-{n}` with
`nameConfidence: "low"` in the manifest — review these and rename.

### SVG Optimization

Each icon SVG is cleaned:
1. Strip XML declarations, comments, metadata
2. Ensure viewBox, remove hardcoded width/height
3. Replace fill/stroke with `currentColor` (icons only, not logos)
4. Collapse whitespace

For more details, read [the collectors reference](references/collectors.md).

### icons.json Manifest

```json
{
  "url": "https://example.com",
  "icons": [
    {
      "name": "search",
      "class": "icon",
      "source": "inline-svg",
      "file": "icons/search.svg",
      "nameConfidence": "high",
      "context": "header button Search"
    }
  ]
}
```

## After Running

### For icon results:
1. Review `icons.json` — rename any `nameConfidence: "low"` icons
2. Copy `/icons/*.svg` to the EDS project's `/icons/` directory
3. Reference in content with `:iconname:` notation
4. `decorateIcons()` in `aem.js` handles rendering

### For `all` results:
Review `collection.json` for a full resource inventory of the page.

## Integration with migrate-header

When used as part of a header migration:
1. Run `node "$SCRIPT" icons <source-url> --output <extraction-dir>`
2. The scaffold stage reads `icons.json` and copies SVGs to `/icons/`
3. `nav.plain.html` uses `:iconname:` for tools/utility icons
4. The polish loop's `program.md` notes available icons
```

- [ ] **Step 2: Write references/collectors.md**

This file provides progressive disclosure details for each collector.
Write it with sections for each collector describing its extraction
sources, output schema, and known limitations. Keep it factual and
concise — under 200 lines. Include the SVGO future improvement note:

> **Future improvement:** If hand-rolled SVG cleanup proves insufficient
> for edge cases (complex gradients, nested groups, editor bloat from
> Illustrator or Figma exports), SVGO (`svgo` npm package) is the
> standard tool for SVG optimization and could replace the hand-rolled
> approach.

- [ ] **Step 3: Write references/icon-font-maps.md**

```markdown
# Icon Font Maps

Placeholder for future icon font codepoint → SVG mapping tables.

When the icon collector detects an icon font (element with
pseudo-content rendered in a known icon font family), it currently
flags the entry in the manifest with `source: "icon-font"` and
`nameConfidence: "low"` without extracting an SVG.

## Future: Auto-conversion

To enable automatic icon font → SVG conversion, populate this file
with lookup tables mapping Unicode codepoints to SVG path data for
common icon font families:

- Font Awesome (free set)
- Material Icons / Material Symbols
- Phosphor Icons
- Heroicons

Each table maps `{ codepoint: string, name: string, svg: string }`.
The collector would detect the font family, look up the rendered
codepoint, and emit the corresponding SVG.
```

- [ ] **Step 4: Lint the skill**

```bash
tessl skill import --workspace catalan-adobe --public skills/page-collect 2>/dev/null || true
tessl skill lint skills/page-collect
```

Expected: Zero warnings. If orphaned file warnings appear, fix markdown
link syntax in SKILL.md (use `[label](references/FILE.md)` not backticks).

- [ ] **Step 5: Commit**

```bash
git add skills/page-collect/SKILL.md \
  skills/page-collect/references/collectors.md \
  skills/page-collect/references/icon-font-maps.md
git commit -m "feat(page-collect): SKILL.md and reference files"
```

---

## Task 9: migrate-header — add icon collection stage

**Files:**
- Modify: `skills/migrate-header/SKILL.md` (between extraction and scaffold stages)

This task adds the icon collection stage to the migration pipeline and updates the scaffold subagent prompt to wire icons into EDS.

- [ ] **Step 1: Add icon collection stage to SKILL.md**

After Stage 6 (extraction verification) and before Stage 7 (scaffold),
insert a new stage. Find the line that says `### Stage 7: Scaffold Generation`
(currently line 254) and insert before it:

```markdown
### Stage 6b: Icon Collection

Extract and classify icons from the source header using page-collect:

```bash
# Find the page-collect script
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  PAGE_COLLECT="$(dirname "$CLAUDE_SKILL_DIR")/../page-collect/scripts/page-collect.js"
else
  PAGE_COLLECT="$(find ~/.claude -path "*/page-collect/scripts/page-collect.js" -type f 2>/dev/null | head -1)"
fi

if [[ -z "$PAGE_COLLECT" || ! -f "$PAGE_COLLECT" ]]; then
  echo "WARNING: page-collect skill not found. Skipping icon extraction."
  echo "Install: sync page-collect skill to ~/.claude/skills/"
else
  ICON_OUTPUT="$PROJECT_ROOT/autoresearch/extraction/icons"
  node "$PAGE_COLLECT" icons "$SOURCE_URL" --output "$ICON_OUTPUT"

  if [[ -f "$ICON_OUTPUT/icons.json" ]]; then
    ICON_COUNT=$(node -e "import {readFileSync} from 'fs'; const d=JSON.parse(readFileSync('$ICON_OUTPUT/icons.json','utf-8')); console.log(d.icons.length)")
    echo "Extracted $ICON_COUNT icons to $ICON_OUTPUT/"
  else
    echo "WARNING: Icon extraction produced no output."
  fi
fi
```

If icon extraction succeeds, the scaffold stage will use the output.
If it fails or page-collect is not installed, the migration continues
without pre-extracted icons (the polish loop handles icons manually).
```

- [ ] **Step 2: Update the scaffold subagent prompt**

In the Stage 7 scaffold subagent prompt (the section starting with
`You are customizing an EDS header block`), add a new Task 3 after
Task 2 (Generate nav.plain.html). Find the line `## After Generating`
and insert before it:

```markdown
## Task 3: Wire extracted icons into EDS

If `<PROJECT_ROOT>/autoresearch/extraction/icons/icons.json` exists:

1. Read the icon manifest
2. Copy all SVG files from `<PROJECT_ROOT>/autoresearch/extraction/icons/icons/`
   to `<PROJECT_ROOT>/icons/`
3. In nav.plain.html, use `:iconname:` notation for icons that appear
   in the tools/utility section. For example, if the manifest has a
   "search" icon, use `:search:` where a search button appears.
4. For the logo, if the manifest has a "logo" class icon, use `:logo:`
   in the brand section instead of an `<img>` tag.

The EDS `decorateIcons()` function in `aem.js` automatically converts
`:iconname:` to `<span class="icon icon-{name}"><img src="/icons/{name}.svg">`
at runtime. Do NOT create inline SVGs for icons in the manifest.

If the icon manifest does not exist, skip this task — icons will be
handled by the polish loop instead.
```

- [ ] **Step 3: Update the `git add` line in the scaffold prompt**

Find the line:
```
  git add blocks/header/header.css nav.plain.html images/
```

Replace with:
```
  git add blocks/header/header.css nav.plain.html images/ icons/
```

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): add icon collection stage and scaffold icon wiring"
```

---

## Task 10: migrate-header — update program.md template

**Files:**
- Modify: `skills/migrate-header/templates/program.md.tmpl`
- Modify: `skills/migrate-header/scripts/setup-polish-loop.js`

- [ ] **Step 1: Add icon guidance to program.md.tmpl**

In `program.md.tmpl`, find the line (currently line 62):
```
## EDS Header Block Conventions
```

Insert before it:

```markdown
## Available Icons

{{ICON_GUIDANCE}}

```

- [ ] **Step 2: Update setup-polish-loop.js to generate icon guidance**

In `setup-polish-loop.js`, add icon manifest reading after the
`buildNavStructure` function (around line 116). Add this function:

```js
function buildIconGuidance(targetDir) {
  const manifestPath = join(
    targetDir, 'autoresearch', 'extraction', 'icons', 'icons.json'
  );
  if (!existsSync(manifestPath)) {
    return 'No pre-extracted icons available. Create icons as needed using inline SVGs or CSS.';
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (!manifest.icons || manifest.icons.length === 0) {
    return 'No pre-extracted icons available. Create icons as needed using inline SVGs or CSS.';
  }

  const iconList = manifest.icons
    .map((i) => `- \`:${i.name}:\` (${i.class}) — ${i.context}`)
    .join('\n');

  return `Pre-extracted SVG icons are in \`/icons/\`. These are referenced via
\`:iconname:\` notation in nav.plain.html and rendered by decorateIcons().
Do NOT recreate these as inline SVGs or CSS. Adjust size via CSS
\`width\`/\`height\` on \`.icon-{name} img\`, color is inherited via
the SVG's currentColor fill.

Available icons:
${iconList}`;
}
```

Then in the `replacements` object (around line 152), add:

```js
'{{ICON_GUIDANCE}}': buildIconGuidance(args.targetDir),
```

- [ ] **Step 3: Test template generation**

Create a mock icons.json and run setup-polish-loop.js to verify the
template replacement works:

```bash
mkdir -p /tmp/test-setup/autoresearch/extraction/icons
echo '{"url":"https://test.com","icons":[{"name":"search","class":"icon","source":"inline-svg","file":"icons/search.svg","nameConfidence":"high","context":"nav tools button"}]}' > /tmp/test-setup/autoresearch/extraction/icons/icons.json
```

Then run setup-polish-loop.js with mock inputs (requires layout.json,
branding.json, and snapshot.json to exist). Verify the output
`program.md` contains the "Available Icons" section with the search
icon listed.

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/templates/program.md.tmpl \
  skills/migrate-header/scripts/setup-polish-loop.js
git commit -m "feat(migrate-header): icon guidance in program.md template"
```

---

## Task 11: Plugin manifests, docs, and local sync

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update plugin.json**

Add `page-collect` to the description and keywords.

- [ ] **Step 2: Update marketplace.json**

Add `page-collect` to both description fields.

- [ ] **Step 3: Update .claude/CLAUDE.md skills table**

Add row:
```
| `page-collect` | Extract structured resources (icons, metadata, text, forms, videos, socials) from any webpage |
```

- [ ] **Step 4: Update README.md**

Add a `### page-collect` section under "Available Skills" with a
description, subcommands list, and link to SKILL.md.

- [ ] **Step 5: Sync locally**

```bash
./scripts/sync-skills.sh
```

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json \
  .claude/CLAUDE.md README.md
git commit -m "feat(page-collect): update plugin manifests and docs"
```

---

## Task 12: Live test against a real site

This task is manual verification — no new code, just running the skill
against a real header migration target to validate end-to-end.

- [ ] **Step 1: Run icon extraction against a real site**

Pick a site with a variety of header icons (e.g., a commerce site with
search, cart, account icons):

```bash
node skills/page-collect/scripts/page-collect.js icons \
  https://www.astrazeneca.com --output /tmp/az-icons
cat /tmp/az-icons/icons.json
ls /tmp/az-icons/icons/
```

Review: Are icons correctly classified? Are names meaningful? Is the
large decorative content excluded? Do the SVGs look clean?

- [ ] **Step 2: Run `all` subcommand**

```bash
node skills/page-collect/scripts/page-collect.js all \
  https://www.astrazeneca.com --output /tmp/az-all
cat /tmp/az-all/collection.json | node -e "
  import {readFileSync} from 'fs';
  const d=JSON.parse(readFileSync('/dev/stdin','utf-8'));
  for (const [k,v] of Object.entries(d.collectors)) {
    const count = Array.isArray(v) ? v.length :
      v.icons?.length || v.forms?.length || v.videos?.length ||
      v.socials?.length || Object.keys(v).length;
    console.log(k + ':', count, 'items');
  }
"
```

- [ ] **Step 3: Verify SVG quality**

Open a few extracted SVGs in a browser to verify they render correctly:

```bash
open /tmp/az-icons/icons/search.svg  # macOS
```

Check: viewBox present, renders at different sizes, currentColor works
(should be black by default, inherits parent color).

- [ ] **Step 4: Fix any issues found**

If extraction misclassifies icons, misses sources, or produces broken
SVGs, fix the collector code and re-run. Commit fixes.

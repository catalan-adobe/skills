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
  const url = args.find(
    (a) => a.startsWith('http') || a.startsWith('file://')
  );
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

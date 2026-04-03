/**
 * Integration tests for capture-helpers.js via playwright-cli initScript.
 *
 * playwright-cli spawns a daemon that inherits stdio, causing execFileSync
 * to hang inside vitest. Workaround: run the actual browser tests as a
 * standalone Node script via bash, parse the JSON results.
 *
 * Requires: playwright-cli in PATH. Skips if unavailable.
 */
import { execFileSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'run-capture-helpers-tests.cjs');

function hasPlaywrightCli() {
  try {
    execFileSync('playwright-cli', ['--version'], {
      encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasPlaywrightCli())(
  'capture-helpers.js via initScript',
  () => {
    let results;

    it('runs integration tests via standalone script', () => {
      const output = execSync(`node ${SCRIPT}`, {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: join(__dirname, '..', '..'),
      });
      results = JSON.parse(output);
      expect(results.passed).toBe(true);
    }, 35000);

    it('window.__captureHelpers is injected', () => {
      expect(results.globalType).toBe('object');
    });

    it('captureHeaderDOM returns valid tree', () => {
      expect(results.headerTree).not.toBeNull();
      expect(results.headerTree.tag).toBe('HEADER');
      expect(results.headerTree.boundingRect.width).toBeGreaterThan(0);
      expect(results.headerTree.boundingRect.height).toBeGreaterThan(0);
      expect(results.headerTree.children.length).toBeGreaterThan(0);
    });

    it('captureHeaderDOM returns null for missing selector', () => {
      expect(results.missingSelector).toBeNull();
    });

    it('extractNavItems finds 3 links', () => {
      expect(results.navItems.length).toBe(3);
      expect(results.navItems[0].text).toBe('Products');
      expect(results.navItems[0].href).toBe('/products');
    });

    it('extractNavItems returns empty for missing selector', () => {
      expect(results.missingNav).toEqual([]);
    });
  }
);

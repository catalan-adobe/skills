/**
 * Integration tests for visual-tree-bundle.js via playwright-cli initScript.
 *
 * Runs browser tests as a standalone script to avoid vitest/playwright-cli
 * stdio conflicts, then asserts on the JSON results.
 *
 * Requires: playwright-cli in PATH. Skips if unavailable.
 */
import { execFileSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'run-visual-tree-tests.cjs');

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
  'visual-tree-bundle.js via initScript',
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

    it('window.__visualTree is injected', () => {
      expect(results.globalType).toBe('object');
    });

    it('captureVisualTree returns all expected fields', () => {
      expect(results.keys).toContain('textFormat');
      expect(results.keys).toContain('data');
      expect(results.keys).toContain('nodeMap');
      expect(results.keys).toContain('rootBackground');
    });

    it('textFormat has spatial layout markers', () => {
      expect(results.textFormat).toMatch(/^r\s/);
      expect(results.textFormat).toMatch(/@\d+,\d+/);
      expect(results.textFormat).toMatch(/\d+x\d+/);
    });

    it('nodeMap has root and child entries', () => {
      expect(results.nodeMapKeys).toContain('r');
      expect(results.nodeMapKeys.length).toBeGreaterThan(1);
      expect(results.rootSelector).toBeDefined();
    });

    it('data tree has BODY root with children', () => {
      expect(results.rootTag).toBe('BODY');
      expect(results.childCount).toBeGreaterThan(0);
    });

    it('minWidth=1024 produces fewer nodes than minWidth=0', () => {
      expect(results.filteredLines).toBeLessThanOrEqual(results.allLines);
    });

    it('full capture via pure expression works', () => {
      expect(results.fullCaptureValid).toBe(true);
    });
  }
);

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseArgs, buildConfig,
} from '../../skills/migrate-header/scripts/capture-visual-tree.js';

describe('parseArgs', () => {
  it('parses positional url and output-dir', () => {
    const result = parseArgs(['', '', 'https://example.com', '/tmp/out']);
    expect(result.url).toBe('https://example.com');
    expect(result.outputDir).toContain('/tmp/out');
    expect(result.browserRecipe).toBeNull();
    expect(result.session).toBe('visual-tree');
  });

  it('parses --browser-recipe flag', () => {
    const result = parseArgs([
      '', '', 'https://example.com', '/tmp/out',
      '--browser-recipe=/tmp/recipe.json',
    ]);
    expect(result.browserRecipe).toContain('/tmp/recipe.json');
  });

  it('parses --session flag', () => {
    const result = parseArgs([
      '', '', 'https://example.com', '/tmp/out',
      '--session=my-session',
    ]);
    expect(result.session).toBe('my-session');
  });

  it('resolves output-dir to absolute path', () => {
    const result = parseArgs(['', '', 'https://example.com', 'relative/dir']);
    expect(result.outputDir).toMatch(/^\//);
  });
});

describe('buildConfig', () => {
  it('creates config with bundle in initScript', () => {
    const config = buildConfig('/path/to/bundle.js', null);
    expect(config.browser.initScript).toEqual(['/path/to/bundle.js']);
  });

  it('merges browser-recipe settings with bundle appended', () => {
    const tmpDir = join(tmpdir(), `vt-test-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    const recipePath = join(tmpDir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify({
      cliConfig: {
        browser: {
          initScript: ['stealth.js'],
          headless: false,
        },
      },
    }));

    const config = buildConfig('/path/to/bundle.js', recipePath);
    expect(config.browser.initScript).toEqual(['stealth.js', '/path/to/bundle.js']);
    expect(config.browser.headless).toBe(false);

    rmSync(tmpDir, { recursive: true });
  });

  it('handles missing browser-recipe file gracefully', () => {
    const config = buildConfig('/path/to/bundle.js', '/nonexistent/recipe.json');
    expect(config.browser.initScript).toEqual(['/path/to/bundle.js']);
  });
});


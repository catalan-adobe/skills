import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('parseArgs', () => {
  it('parses --browser-recipe flag', async () => {
    const { parseArgs } = await import(
      '../../skills/page-collect/scripts/page-collect.js'
    );
    const result = parseArgs([
      '', '',
      'icons', 'https://example.com',
      '--browser-recipe', '/tmp/recipe.json',
    ]);
    expect(result.browserRecipe).toBe('/tmp/recipe.json');
  });

  it('defaults browserRecipe to null', async () => {
    const { parseArgs } = await import(
      '../../skills/page-collect/scripts/page-collect.js'
    );
    const result = parseArgs([
      '', '',
      'icons', 'https://example.com',
    ]);
    expect(result.browserRecipe).toBeNull();
  });
});

describe('applyBrowserRecipe', () => {
  it('returns default options when no recipe path', async () => {
    const { applyBrowserRecipe } = await import(
      '../../skills/page-collect/scripts/page-collect.js'
    );
    const result = applyBrowserRecipe(null);
    expect(result.launchOptions).toEqual({ headless: true });
    expect(result.userAgent).toBeNull();
    expect(result.stealthScript).toBeNull();
  });

  it('extracts channel from recipe', async () => {
    const { applyBrowserRecipe } = await import(
      '../../skills/page-collect/scripts/page-collect.js'
    );
    const recipe = {
      cliConfig: {
        browser: {
          browserName: 'chromium',
          launchOptions: {
            channel: 'chrome',
            args: [
              '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
            ],
          },
        },
      },
      stealthInitScript: '(function(){ /* stealth */ })()',
    };
    const dir = join(tmpdir(), `test-pc-recipe-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recipePath = join(dir, 'browser-recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));

    const result = applyBrowserRecipe(recipePath);
    expect(result.launchOptions.channel).toBe('chrome');
    expect(result.userAgent).toContain('Chrome/120');
    expect(result.stealthScript).toBe('(function(){ /* stealth */ })()');
  });
});

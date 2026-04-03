import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseArgs, buildRecipeArgs,
} from '../../skills/migrate-header/scripts/capture-snapshot.js';

describe('parseArgs', () => {
  it('parses --browser-recipe flag', () => {
    const result = parseArgs([
      '', '',
      'https://example.com', '/tmp/out',
      '--browser-recipe=/tmp/recipe.json',
    ]);
    expect(result.browserRecipe).toBe('/tmp/recipe.json');
  });

  it('defaults browserRecipe to null when not provided', () => {
    const result = parseArgs([
      '', '',
      'https://example.com', '/tmp/out',
    ]);
    expect(result.browserRecipe).toBeNull();
  });

  it('ignores empty browser-recipe value', () => {
    const result = parseArgs([
      '', '',
      'https://example.com', '/tmp/out',
      '--browser-recipe=',
    ]);
    expect(result.browserRecipe).toBeNull();
  });
});

describe('buildRecipeArgs', () => {
  it('injects capture-helpers.js via initScript even without recipe', () => {
    const result = buildRecipeArgs(null);
    expect(result.extraArgs).toHaveLength(1);
    expect(result.extraArgs[0]).toMatch(/--config=/);
    expect(result.configPath).toBeTruthy();
    expect(result.tempFiles).toHaveLength(1);

    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(written.browser.initScript).toHaveLength(1);
    expect(written.browser.initScript[0]).toMatch(/capture-helpers\.js$/);
  });

  it('writes config with initScript for stealth', () => {
    const recipe = {
      cliConfig: {
        browser: {
          browserName: 'chromium',
          launchOptions: { channel: 'chrome' },
        },
      },
      stealthInitScript: '(function(){ /* stealth */ })()',
    };
    const dir = join(tmpdir(), `test-recipe-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recipePath = join(dir, 'browser-recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));

    const result = buildRecipeArgs(recipePath);
    expect(result.extraArgs).toContain(`--config=${result.configPath}`);
    expect(result.tempFiles.length).toBe(2);

    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(written.browser.launchOptions.channel).toBe('chrome');
    // capture-helpers.js + stealth script
    expect(written.browser.initScript).toHaveLength(2);
    expect(written.browser.initScript[1]).toMatch(/capture-helpers\.js$/);

    // Stealth script prepended before capture-helpers
    const stealthPath = written.browser.initScript[0];
    expect(existsSync(stealthPath)).toBe(true);
    expect(readFileSync(stealthPath, 'utf-8')).toBe(
      '(function(){ /* stealth */ })()'
    );
  });

  it('includes only capture-helpers.js when no stealth script', () => {
    const recipe = {
      cliConfig: {
        browser: {
          browserName: 'chromium',
          launchOptions: { channel: 'chrome' },
        },
      },
      stealthInitScript: null,
    };
    const dir = join(tmpdir(), `test-recipe-no-stealth-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recipePath = join(dir, 'browser-recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));

    const result = buildRecipeArgs(recipePath);
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(written.browser.initScript).toHaveLength(1);
    expect(written.browser.initScript[0]).toMatch(/capture-helpers\.js$/);
    expect(result.tempFiles.length).toBe(1);
  });

  it('adds --persistent flag when recipe has persistent: true', () => {
    const recipe = {
      cliConfig: {
        browser: {
          browserName: 'chromium',
          launchOptions: {},
        },
      },
      stealthInitScript: null,
      persistent: true,
    };
    const dir = join(tmpdir(), `test-recipe-persist-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recipePath = join(dir, 'browser-recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));

    const result = buildRecipeArgs(recipePath);
    expect(result.extraArgs).toContain('--persistent');
  });
});

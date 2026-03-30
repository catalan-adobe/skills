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
  it('returns empty args when no recipe', () => {
    const result = buildRecipeArgs(null);
    expect(result).toEqual({
      extraArgs: [],
      configPath: null,
      tempFiles: [],
    });
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
    expect(written.browser.initScript).toHaveLength(1);

    // Stealth script written to temp file referenced by initScript
    const stealthPath = written.browser.initScript[0];
    expect(existsSync(stealthPath)).toBe(true);
    expect(readFileSync(stealthPath, 'utf-8')).toBe(
      '(function(){ /* stealth */ })()'
    );
  });

  it('skips initScript when no stealth script', () => {
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
    expect(written.browser.initScript).toBeUndefined();
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

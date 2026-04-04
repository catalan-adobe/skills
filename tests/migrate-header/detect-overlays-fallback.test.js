import { describe, it, expect } from 'vitest';
import {
  parseArgs,
} from '../../skills/migrate-header/scripts/detect-overlays-fallback.js';

describe('parseArgs', () => {
  it('parses positional url and output-dir', () => {
    const result = parseArgs(['', '', 'https://example.com', '/tmp/out']);
    expect(result.url).toBe('https://example.com');
    expect(result.outputDir).toContain('/tmp/out');
    expect(result.browserRecipe).toBeNull();
    expect(result.pagePrepDir).toBeNull();
  });

  it('parses --browser-recipe flag', () => {
    const result = parseArgs([
      '', '', 'https://example.com', '/tmp/out',
      '--browser-recipe=/tmp/recipe.json',
    ]);
    expect(result.browserRecipe).toContain('/tmp/recipe.json');
  });

  it('parses --page-prep-dir flag', () => {
    const result = parseArgs([
      '', '', 'https://example.com', '/tmp/out',
      '--page-prep-dir=/path/to/page-prep/scripts',
    ]);
    expect(result.pagePrepDir).toContain('/path/to/page-prep/scripts');
  });

  it('resolves paths to absolute', () => {
    const result = parseArgs([
      '', '', 'https://example.com', 'relative/out',
      '--browser-recipe=relative/recipe.json',
    ]);
    expect(result.outputDir).toMatch(/^\//);
    expect(result.browserRecipe).toMatch(/^\//);
  });
});


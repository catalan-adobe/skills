import { describe, it, expect } from 'vitest';
import { parseArgs, parseTarget } from
  '../../skills/migrate-header/scripts/css-query.js';

describe('parseArgs', () => {
  it('parses open subcommand with URL', () => {
    const result = parseArgs(['', '', 'open', 'https://example.com']);
    expect(result.command).toBe('open');
    expect(result.url).toBe('https://example.com');
  });

  it('parses open with browser-recipe', () => {
    const result = parseArgs([
      '', '', 'open', 'https://example.com',
      '--browser-recipe=/tmp/recipe.json',
    ]);
    expect(result.browserRecipe).toBe('/tmp/recipe.json');
  });

  it('parses query with selector and properties', () => {
    const result = parseArgs([
      '', '', 'query', 'nav > a', 'font-size,color',
    ]);
    expect(result.command).toBe('query');
    expect(result.target).toBe('nav > a');
    expect(result.properties).toEqual(['font-size', 'color']);
  });

  it('parses query with node reference', () => {
    const result = parseArgs([
      '', '', 'query', 'node:42', 'font-size',
    ]);
    expect(result.target).toBe('node:42');
    expect(result.properties).toEqual(['font-size']);
  });

  it('parses cascade subcommand', () => {
    const result = parseArgs(['', '', 'cascade', '.nav-link']);
    expect(result.command).toBe('cascade');
    expect(result.target).toBe('.nav-link');
  });

  it('parses vars subcommand', () => {
    const result = parseArgs(['', '', 'vars']);
    expect(result.command).toBe('vars');
  });

  it('parses close subcommand', () => {
    const result = parseArgs(['', '', 'close']);
    expect(result.command).toBe('close');
  });

  it('parses custom session name', () => {
    const result = parseArgs([
      '', '', 'open', 'https://example.com', '--session=my-session',
    ]);
    expect(result.session).toBe('my-session');
  });
});

describe('parseTarget', () => {
  it('returns selector type for CSS selectors', () => {
    expect(parseTarget('nav > a')).toEqual({
      type: 'selector', value: 'nav > a',
    });
  });

  it('returns node type for node: references', () => {
    expect(parseTarget('node:42')).toEqual({
      type: 'node', value: 42,
    });
  });
});

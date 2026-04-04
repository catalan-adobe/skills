import { describe, it, expect } from 'vitest';
import {
  parseRuleOrigin,
  extractPropertiesFromMatched,
  extractFileFromURL,
  rgbToHex,
  colorSaturation,
  categorizeColor,
  extractCustomProperties,
  parseRunCodeOutput,
  parseEvalOutput,
} from '../../skills/migrate-header/scripts/cdp-helpers.js';

describe('parseRuleOrigin', () => {
  it('maps regular to author', () => {
    expect(parseRuleOrigin('regular')).toBe('author');
  });

  it('maps user-agent to user-agent', () => {
    expect(parseRuleOrigin('user-agent')).toBe('user-agent');
  });

  it('maps injected to extension', () => {
    expect(parseRuleOrigin('injected')).toBe('extension');
  });

  it('defaults unknown origins to unknown', () => {
    expect(parseRuleOrigin('something')).toBe('unknown');
  });
});

describe('extractFileFromURL', () => {
  it('extracts filename from full URL', () => {
    expect(extractFileFromURL('https://example.com/css/styles.css'))
      .toBe('styles.css');
  });

  it('returns null for empty input', () => {
    expect(extractFileFromURL('')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractFileFromURL(null)).toBeNull();
  });

  it('handles URL with query params', () => {
    expect(extractFileFromURL('https://cdn.com/main.css?v=123'))
      .toBe('main.css');
  });

  it('returns raw string for invalid URL', () => {
    expect(extractFileFromURL('not-a-url')).toBe('not-a-url');
  });
});

describe('rgbToHex', () => {
  it('converts rgb string to hex', () => {
    expect(rgbToHex('rgb(255, 255, 255)')).toBe('#ffffff');
  });

  it('converts rgb with no spaces', () => {
    expect(rgbToHex('rgb(42,42,42)')).toBe('#2a2a2a');
  });

  it('handles rgba', () => {
    expect(rgbToHex('rgba(0, 102, 204, 1)')).toBe('#0066cc');
  });

  it('returns null for non-rgb string', () => {
    expect(rgbToHex('#ff0000')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(rgbToHex(null)).toBeNull();
  });
});

describe('colorSaturation', () => {
  it('returns 0 for pure white', () => {
    expect(colorSaturation('#ffffff')).toBe(0);
  });

  it('returns 0 for pure black', () => {
    expect(colorSaturation('#000000')).toBe(0);
  });

  it('returns high saturation for pure red', () => {
    expect(colorSaturation('#ff0000')).toBe(1);
  });

  it('returns moderate saturation for muted blue', () => {
    const sat = colorSaturation('#4488aa');
    expect(sat).toBeGreaterThan(0.3);
    expect(sat).toBeLessThan(1);
  });

  it('returns saturation of 1 when min channel is 0', () => {
    expect(colorSaturation('#0066cc')).toBe(1);
  });

  it('returns 0 for invalid hex', () => {
    expect(colorSaturation(null)).toBe(0);
  });

  it('returns 0 for wrong-length hex', () => {
    expect(colorSaturation('#fff')).toBe(0);
  });
});

describe('categorizeColor', () => {
  it('categorizes white as background', () => {
    expect(categorizeColor('#ffffff', 'background-color')).toBe('backgrounds');
  });

  it('categorizes dark text color as text', () => {
    expect(categorizeColor('#2a2a2a', 'color')).toBe('text');
  });

  it('categorizes saturated color as accent', () => {
    expect(categorizeColor('#0066cc', 'color')).toBe('accent');
  });

  it('categorizes border colors as borders', () => {
    expect(categorizeColor('#e0e0e0', 'border-color')).toBe('borders');
  });

  it('returns null for null hex', () => {
    expect(categorizeColor(null, 'color')).toBeNull();
  });
});

describe('extractCustomProperties', () => {
  it('extracts custom properties from matched rules', () => {
    const rules = [{
      rule: {
        origin: 'regular',
        style: {
          cssProperties: [
            { name: '--brand-color', value: '#830051' },
            { name: '--nav-height', value: '64px' },
            { name: 'color', value: 'red' },
          ],
        },
      },
    }];

    const result = extractCustomProperties(rules);
    expect(result).toEqual({
      '--brand-color': '#830051',
      '--nav-height': '64px',
    });
  });

  it('skips user-agent rules', () => {
    const rules = [{
      rule: {
        origin: 'user-agent',
        style: {
          cssProperties: [
            { name: '--internal', value: '1' },
          ],
        },
      },
    }];

    expect(extractCustomProperties(rules)).toEqual({});
  });

  it('skips disabled properties', () => {
    const rules = [{
      rule: {
        origin: 'regular',
        style: {
          cssProperties: [
            { name: '--old', value: 'x', disabled: true },
          ],
        },
      },
    }];

    expect(extractCustomProperties(rules)).toEqual({});
  });

  it('returns empty object for null input', () => {
    expect(extractCustomProperties(null)).toEqual({});
  });
});

describe('extractPropertiesFromMatched', () => {
  it('extracts author properties with rule and file info', () => {
    const matched = {
      inlineStyle: { cssProperties: [] },
      matchedCSSRules: [{
        rule: {
          selectorList: { text: '.nav-link' },
          origin: 'regular',
          style: {
            cssProperties: [
              { name: 'font-size', value: '16px' },
              { name: 'color', value: '#2a2a2a' },
            ],
          },
          styleSheetId: 'sheet1',
        },
        matchingSelectors: [0],
      }],
      inherited: [],
    };
    const sheets = {
      sheet1: { sourceURL: 'https://example.com/styles.css' },
    };

    const result = extractPropertiesFromMatched(matched, sheets);
    expect(result.get('font-size')).toEqual({
      value: '16px',
      source: 'author',
      selector: '.nav-link',
      file: 'styles.css',
      inherited: false,
    });
  });

  it('skips user-agent properties in author-only mode', () => {
    const matched = {
      inlineStyle: { cssProperties: [] },
      matchedCSSRules: [{
        rule: {
          selectorList: { text: 'a' },
          origin: 'user-agent',
          style: {
            cssProperties: [
              { name: 'color', value: '-webkit-link' },
            ],
          },
        },
        matchingSelectors: [0],
      }],
      inherited: [],
    };

    const result = extractPropertiesFromMatched(matched, {}, true);
    expect(result.has('color')).toBe(false);
  });

  it('marks inherited properties', () => {
    const matched = {
      inlineStyle: { cssProperties: [] },
      matchedCSSRules: [],
      inherited: [{
        inlineStyle: { cssProperties: [] },
        matchedCSSRules: [{
          rule: {
            selectorList: { text: 'body' },
            origin: 'regular',
            style: {
              cssProperties: [
                { name: 'font-family', value: 'Helvetica, sans-serif' },
              ],
            },
          },
          matchingSelectors: [0],
        }],
      }],
    };

    const result = extractPropertiesFromMatched(matched, {});
    expect(result.get('font-family')?.inherited).toBe(true);
  });

  it('inline styles win over matched rules (first-match-wins)', () => {
    const matched = {
      inlineStyle: {
        cssProperties: [
          { name: 'color', value: 'red' },
        ],
      },
      matchedCSSRules: [{
        rule: {
          selectorList: { text: '.link' },
          origin: 'regular',
          style: {
            cssProperties: [
              { name: 'color', value: 'blue' },
            ],
          },
        },
        matchingSelectors: [0],
      }],
      inherited: [],
    };

    const result = extractPropertiesFromMatched(matched, {});
    expect(result.get('color').value).toBe('red');
    expect(result.get('color').selector).toBe('element.style');
  });

  it('filters non-inherited properties from inherited entries', () => {
    const matched = {
      inlineStyle: { cssProperties: [] },
      matchedCSSRules: [],
      inherited: [{
        inlineStyle: { cssProperties: [] },
        matchedCSSRules: [{
          rule: {
            selectorList: { text: 'body' },
            origin: 'regular',
            style: {
              cssProperties: [
                { name: 'margin', value: '0' },
                { name: 'color', value: 'black' },
              ],
            },
          },
          matchingSelectors: [0],
        }],
      }],
    };

    const result = extractPropertiesFromMatched(matched, {});
    expect(result.has('margin')).toBe(false);
    expect(result.has('color')).toBe(true);
  });

  it('skips disabled properties', () => {
    const matched = {
      inlineStyle: { cssProperties: [] },
      matchedCSSRules: [{
        rule: {
          selectorList: { text: '.x' },
          origin: 'regular',
          style: {
            cssProperties: [
              { name: 'color', value: 'red', disabled: true },
            ],
          },
        },
        matchingSelectors: [0],
      }],
      inherited: [],
    };

    const result = extractPropertiesFromMatched(matched, {});
    expect(result.has('color')).toBe(false);
  });
});

describe('parseRunCodeOutput', () => {
  it('strips ### Result envelope and returns object JSON as-is', () => {
    const raw = '### Result\n{"x":0,"width":1440}\n### Ran Playwright code\nin 0.5s';
    expect(parseRunCodeOutput(raw)).toBe('{"x":0,"width":1440}');
  });

  it('returns raw content when no envelope present', () => {
    expect(parseRunCodeOutput('{"foo":"bar"}')).toBe('{"foo":"bar"}');
  });

  it('handles envelope without trailing code section', () => {
    expect(parseRunCodeOutput('### Result\n42')).toBe('42');
  });

  it('properly unescapes quoted strings with escaped quotes', () => {
    const raw = '### Result\n"<div class=\\"header\\">content</div>"\n### Ran Playwright code';
    expect(parseRunCodeOutput(raw)).toBe('<div class="header">content</div>');
  });

  it('unescapes escaped newlines in quoted strings', () => {
    const raw = '### Result\n"line1\\nline2"\n### Ran Playwright code';
    expect(parseRunCodeOutput(raw)).toBe('line1\nline2');
  });

  it('falls back to slice for malformed quoted strings', () => {
    const raw = '### Result\n"value with unescaped "quotes" inside"\n### Ran Playwright code';
    const result = parseRunCodeOutput(raw);
    expect(result).toContain('value with unescaped');
  });

  it('does not deserialize quoted JSON into an object', () => {
    const raw = '### Result\n"{\\\"x\\\":0}"\n### Ran Playwright code';
    const result = parseRunCodeOutput(raw);
    expect(typeof result).toBe('string');
    expect(result).toBe('{"x":0}');
  });

  it('does not unwrap non-quoted values', () => {
    const raw = '### Result\nnull\n### Ran Playwright code';
    expect(parseRunCodeOutput(raw)).toBe('null');
  });

  it('handles simple quoted string without escapes', () => {
    const raw = '### Result\n"hello world"\n### Ran Playwright code';
    expect(parseRunCodeOutput(raw)).toBe('hello world');
  });

  it('trims whitespace around the result', () => {
    const raw = '### Result\n  {"a":1}  \n### Ran Playwright code';
    expect(parseRunCodeOutput(raw)).toBe('{"a":1}');
  });
});

describe('parseEvalOutput alias', () => {
  it('behaves identically to parseRunCodeOutput', () => {
    const raw = '### Result\n"hello"\n### Ran Playwright code';
    expect(parseEvalOutput(raw)).toBe(parseRunCodeOutput(raw));
  });
});

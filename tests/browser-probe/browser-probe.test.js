import { describe, it, expect } from 'vitest';
import {
  parseEvalOutput,
  checkHealth,
  detectSignals,
} from '../../skills/browser-probe/scripts/browser-probe.js';

describe('parseEvalOutput', () => {
  it('extracts JSON from playwright-cli eval result block', () => {
    const raw = `### Result\n{"title":"Test"}\n### Ran Playwright code`;
    expect(parseEvalOutput(raw)).toBe('{"title":"Test"}');
  });

  it('extracts quoted string from result block', () => {
    const raw = `### Result\n"hello world"\n### Ran Playwright code`;
    expect(parseEvalOutput(raw)).toBe('hello world');
  });

  it('returns raw input when no result block found', () => {
    expect(parseEvalOutput('plain text')).toBe('plain text');
  });
});

describe('checkHealth', () => {
  it('returns success for a normal page', () => {
    const health = {
      title: 'AstraZeneca | Home',
      url: 'https://www.astrazeneca.com/',
      bodyLength: 12000,
      status: 200,
      hasMainContent: true,
    };
    expect(checkHealth(health)).toBe('success');
  });

  it('returns blocked for error page title', () => {
    const health = {
      title: 'ERROR: The request could not be satisfied',
      url: 'https://www.astrazeneca.com/',
      bodyLength: 42,
      status: 403,
      hasMainContent: false,
    };
    expect(checkHealth(health)).toBe('blocked');
  });

  it('returns blocked for captcha challenge', () => {
    const health = {
      title: 'Just a moment...',
      url: 'https://example.com/',
      bodyLength: 800,
      status: 200,
      hasMainContent: false,
    };
    expect(checkHealth(health)).toBe('blocked');
  });

  it('returns blocked for very short body with no main content', () => {
    const health = {
      title: 'Example',
      url: 'https://example.com/',
      bodyLength: 30,
      status: 200,
      hasMainContent: false,
    };
    expect(checkHealth(health)).toBe('blocked');
  });

  it('returns success for short body if main content exists', () => {
    const health = {
      title: 'Minimal Site',
      url: 'https://example.com/',
      bodyLength: 30,
      status: 200,
      hasMainContent: true,
    };
    expect(checkHealth(health)).toBe('success');
  });
});

describe('detectSignals', () => {
  it('detects Akamai from server header', () => {
    const networkLines = [
      'GET https://www.example.com/ 403 server: AkamaiGHost',
    ];
    const signals = detectSignals(networkLines, {
      title: 'Access Denied', status: 403,
    });
    expect(signals).toContain('akamai-server');
  });

  it('detects Cloudflare from cf-ray header', () => {
    const networkLines = [
      'GET https://www.example.com/ 200 cf-ray: abc123',
    ];
    const signals = detectSignals(networkLines, {
      title: 'Example', status: 200,
    });
    expect(signals).toContain('cloudflare-ray');
  });

  it('detects Cloudflare challenge from page title', () => {
    const signals = detectSignals([], {
      title: 'Just a moment...', status: 200,
    });
    expect(signals).toContain('cloudflare-challenge');
  });

  it('returns empty array for clean site', () => {
    const signals = detectSignals([], {
      title: 'Adobe', status: 200,
    });
    expect(signals).toEqual([]);
  });
});

describe('buildStepResult', () => {
  it('builds a well-formed step result', async () => {
    // Dynamic import — buildStepResult not in the static import yet
    const { buildStepResult } = await import(
      '../../skills/browser-probe/scripts/browser-probe.js'
    );
    const result = buildStepResult('default', {
      browser: 'chromium', stealth: false, persistent: false,
    }, 'blocked', {
      title: 'ERROR', url: 'https://x.com/', bodyLength: 10,
      status: 403, hasMainContent: false,
    }, 1234);
    expect(result).toEqual({
      name: 'default',
      config: { browser: 'chromium', stealth: false, persistent: false },
      result: 'blocked',
      health: {
        title: 'ERROR', url: 'https://x.com/', bodyLength: 10,
        status: 403, hasMainContent: false,
      },
      durationMs: 1234,
    });
  });
});

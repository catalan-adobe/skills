#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 30_000,
};

const ERROR_TITLE_PATTERN =
  /error|denied|blocked|not satisfied|403|captcha|challenge|attention required|just a moment/i;

const MIN_BODY_LENGTH = 100;

// --- Exported helpers (used by tests and main) ---

export function parseEvalOutput(raw) {
  const resultIdx = raw.indexOf('### Result');
  const codeIdx = raw.indexOf('### Ran Playwright code');
  if (resultIdx === -1) return raw;
  const start = resultIdx + '### Result'.length;
  const end = codeIdx !== -1 ? codeIdx : raw.length;
  let value = raw.slice(start, end).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = JSON.parse(value);
  }
  return value;
}

export function checkHealth(health) {
  if (health.status >= 400) return 'blocked';
  if (ERROR_TITLE_PATTERN.test(health.title)) return 'blocked';
  if (health.bodyLength < MIN_BODY_LENGTH && !health.hasMainContent) {
    return 'blocked';
  }
  return 'success';
}

export function detectSignals(networkLines, health) {
  const signals = [];
  const joined = networkLines.join('\n').toLowerCase();

  if (joined.includes('server: akamaighost')
      || joined.includes('server: akamainetstorage')) {
    signals.push('akamai-server');
  }
  if (joined.includes('bm_sz') || joined.includes('_abck')) {
    signals.push('akamai-bot-manager');
  }
  if (joined.includes('cf-ray')) {
    signals.push('cloudflare-ray');
  }
  if (joined.includes('x-datadome')) {
    signals.push('datadome');
  }
  if (joined.includes('x-amzn-waf-action')) {
    signals.push('aws-waf');
  }
  if (joined.includes('x-cdn: imperva') || joined.includes('x-iinfo')) {
    signals.push('incapsula');
  }

  const title = (health.title || '').toLowerCase();
  if (title.includes('just a moment')
      || title.includes('checking your browser')) {
    signals.push('cloudflare-challenge');
  }

  return signals;
}

// --- CLI plumbing ---

function cli(session, ...args) {
  return execFileSync(
    'playwright-cli', [`-s=${session}`, ...args], EXEC_OPTS,
  ).trim();
}

function cliEval(session, js) {
  const raw = cli(session, 'eval', js);
  return parseEvalOutput(raw);
}

function closeSession(session) {
  try {
    execFileSync(
      'playwright-cli', [`-s=${session}`, 'close'], EXEC_OPTS,
    );
  } catch {
    // Session may already be closed
  }
}

// --- Step execution ---

export function buildStepResult(name, config, result, health, durationMs) {
  return { name, config, result, health, durationMs };
}

const HEALTH_CHECK_JS = `(function() {
  var perf = performance.getEntriesByType('navigation');
  var status = perf.length > 0 ? perf[0].responseStatus : 0;
  return JSON.stringify({
    title: document.title || '',
    url: location.href,
    bodyLength: (document.body ? document.body.innerText.length : 0),
    status: status,
    hasMainContent: !!document.querySelector(
      'main, [role="main"], article, #content'
    )
  });
})()`;

const STEALTH_INIT_SCRIPT = `(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  window.chrome = { runtime: {} };
})()`;

function waitForStable(session) {
  for (let i = 0; i < 10; ++i) {
    const state = cliEval(session, 'document.readyState');
    if (state === 'complete') return;
  }
}

function getNetworkLines(session) {
  try {
    const raw = cli(session, 'network');
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function runStep(url, stepDef) {
  const session = `probe-${stepDef.name}`;
  const start = Date.now();

  try {
    if (stepDef.stealth) {
      // Open browser without URL, inject stealth, then navigate
      const openArgs = ['open'];
      if (stepDef.browser !== 'chromium') {
        openArgs.push(`--browser=${stepDef.browser}`);
      }
      if (stepDef.persistent) openArgs.push('--persistent');
      cli(session, ...openArgs);
      cliEval(session, STEALTH_INIT_SCRIPT);
      cli(session, 'goto', url);
    } else {
      // Open directly with URL
      const openArgs = ['open', url];
      if (stepDef.browser !== 'chromium') {
        openArgs.push(`--browser=${stepDef.browser}`);
      }
      if (stepDef.persistent) openArgs.push('--persistent');
      cli(session, ...openArgs);
    }

    waitForStable(session);
    const healthRaw = cliEval(session, HEALTH_CHECK_JS);
    const health = JSON.parse(healthRaw);
    const networkLines = getNetworkLines(session);
    const result = checkHealth(health);
    const durationMs = Date.now() - start;

    return {
      step: buildStepResult(
        stepDef.name, stepDef.config, result, health, durationMs,
      ),
      networkLines,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      step: buildStepResult(stepDef.name, stepDef.config, 'error', {
        title: '', url: '', bodyLength: 0,
        status: 0, hasMainContent: false,
        error: err.message,
      }, durationMs),
      networkLines: [],
    };
  } finally {
    closeSession(session);
  }
}

const STEPS = [
  {
    name: 'default',
    browser: 'chromium', stealth: false, persistent: false,
    config: { browser: 'chromium', stealth: false, persistent: false },
  },
  {
    name: 'stealth',
    browser: 'chromium', stealth: true, persistent: false,
    config: { browser: 'chromium', stealth: true, persistent: false },
  },
  {
    name: 'chrome',
    browser: 'chrome', stealth: true, persistent: false,
    config: { browser: 'chrome', stealth: true, persistent: false },
  },
  {
    name: 'persistent',
    browser: 'chrome', stealth: true, persistent: true,
    config: { browser: 'chrome', stealth: true, persistent: true },
  },
];

function log(msg) {
  console.error(msg);
}

function parseArgs(argv) {
  const positional = argv.slice(2).filter(a => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error(
      'Usage: node browser-probe.js <url> <output-dir>',
    );
    process.exit(1);
  }
  return { url: positional[0], outputDir: resolve(positional[1]) };
}

function main() {
  const { url, outputDir } = parseArgs(process.argv);

  try {
    execFileSync('playwright-cli', ['--version'], EXEC_OPTS);
  } catch {
    console.error(
      'playwright-cli not found.'
      + ' Install with: npm install -g @playwright/cli@latest',
    );
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  const steps = [];
  const allNetworkLines = [];
  let firstSuccess = null;

  for (const stepDef of STEPS) {
    log(`Probing with ${stepDef.name} config...`);
    const { step, networkLines } = runStep(url, stepDef);
    steps.push(step);
    allNetworkLines.push(...networkLines);

    log(
      `  ${stepDef.name}: ${step.result}`
      + ` (${step.health.title || 'no title'}, ${step.durationMs}ms)`,
    );

    if (step.result === 'success') {
      firstSuccess = stepDef.name;
      break;
    }
  }

  const lastHealth = steps[steps.length - 1].health;
  const detectedSignals = detectSignals(allNetworkLines, lastHealth);

  const report = {
    url,
    timestamp: new Date().toISOString(),
    steps,
    firstSuccess,
    detectedSignals,
  };

  const reportPath = `${outputDir}/probe-report.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`Wrote ${reportPath}`);
}

// Only run main when executed directly (not imported by tests)
const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(
    new URL(import.meta.url).pathname,
  );
if (isMain) main();

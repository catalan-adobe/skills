#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

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

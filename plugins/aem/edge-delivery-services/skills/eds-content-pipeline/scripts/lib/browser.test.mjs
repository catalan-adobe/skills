import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createBrowser, parseEvalOutput } from './browser.mjs';

test('parseEvalOutput handles raw JSON, double-encoded JSON and empty output', () => {
  assert.deepEqual(parseEvalOutput('{"a":1}\n'), { a: 1 });
  assert.deepEqual(parseEvalOutput('"{\\"a\\":2}"'), { a: 2 });
  assert.equal(parseEvalOutput('null'), null);
  assert.equal(parseEvalOutput(''), null);
  assert.equal(parseEvalOutput('plain text'), 'plain text');
});

function fakeExec(responses) {
  const calls = [];
  const exec = async (cli, args) => {
    calls.push([cli, ...args]);
    const cmd = args.find((a) => !a.startsWith('-'));
    const next = responses[cmd]?.shift();
    return { stdout: next ?? '' };
  };
  return { exec, calls };
}

test('open writes an initScript config and passes it to playwright-cli', async () => {
  const { exec, calls } = fakeExec({});
  const browser = createBrowser({ session: 's1', exec });
  await browser.open('https://x.test/', { initScripts: ['/tmp/bundle.js', '/tmp/boot.js'] });
  const [cli, session, cmd, url, configArg] = calls[0];
  assert.equal(cli, 'playwright-cli');
  assert.equal(session, '-s=s1');
  assert.equal(cmd, 'open');
  assert.equal(url, 'https://x.test/');
  const config = JSON.parse(await readFile(configArg.replace('--config=', ''), 'utf8'));
  assert.deepEqual(config, { browser: { initScript: ['/tmp/bundle.js', '/tmp/boot.js'] } });
  await browser.close();
  assert.deepEqual(calls.at(-1), ['playwright-cli', '-s=s1', 'close']);
});

test('pollJson retries until a non-null value arrives and times out otherwise', async () => {
  const { exec, calls } = fakeExec({ eval: ['null', 'null', '{"ok":true}'] });
  const browser = createBrowser({ exec, sleep: async () => {} });
  const expr = '() => JSON.stringify(window.__r || null)';
  const value = await browser.pollJson(expr, { intervalMs: 1 });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls.length, 3);
  const stuck = createBrowser({ exec: async () => ({ stdout: 'null' }), sleep: async () => {} });
  await assert.rejects(
    () => stuck.pollJson('() => null', { timeoutMs: 1, intervalMs: 1 }),
    /Timed out after 1ms/,
  );
});

test('screenshot and goto build the expected commands', async () => {
  const { exec, calls } = fakeExec({});
  const browser = createBrowser({ exec });
  await browser.goto('https://x.test/a');
  await browser.screenshot('/tmp/a.png', { fullPage: true });
  assert.deepEqual(calls[0], ['playwright-cli', '-s=migration', 'goto', 'https://x.test/a']);
  assert.deepEqual(calls[1], [
    'playwright-cli', '-s=migration', 'screenshot', '--filename=/tmp/a.png', '--full-page',
  ]);
});

test('goto propagates the failure of the underlying command', async () => {
  const boom = new Error('playwright-cli not found');
  const browser = createBrowser({ exec: async () => { throw boom; } });
  await assert.rejects(() => browser.goto('https://x.test/a'), (err) => err === boom);
});

test('close removes the temp config directory written by open', async () => {
  const { exec, calls } = fakeExec({});
  const browser = createBrowser({ session: 's2', exec });
  await browser.open('https://x.test/', { initScripts: [] });
  const configArg = calls[0].find((a) => a.startsWith('--config='));
  const dir = path.dirname(configArg.replace('--config=', ''));
  assert.equal(existsSync(dir), true);
  await browser.close();
  assert.equal(existsSync(dir), false);
});

test('open forwards context options and screenshot targets one element in hires', async () => {
  const { exec, calls } = fakeExec({});
  const browser = createBrowser({ session: 's3', exec });
  await browser.open('https://x.test/a.svg', { contextOptions: { deviceScaleFactor: 2 } });
  const configArg = calls[0].find((a) => a.startsWith('--config='));
  const config = JSON.parse(await readFile(configArg.replace('--config=', ''), 'utf8'));
  assert.deepEqual(config, {
    browser: { initScript: [], contextOptions: { deviceScaleFactor: 2 } },
  });
  await browser.screenshot('/tmp/b.png', { target: 'svg', hires: true });
  assert.deepEqual(calls.at(-1), [
    'playwright-cli', '-s=s3', 'screenshot', 'svg', '--filename=/tmp/b.png', '--hires',
  ]);
  await browser.close();
});

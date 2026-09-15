// Contract with the real playwright-cli: output format, eval encoding, session isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEval } from '../lib/warm.mjs';
import { cliError, evalResult } from '../lib/warm-cli.mjs';
import {
  execFileP, need, onPath, startSite,
} from './helpers.mjs';

const A = 'cpv2-test-a';
const B = 'cpv2-test-b';
const run = (cli, session, ...args) => execFileP(cli, [`-s=${session}`, ...args]);

test('playwright-cli: eval is JSON-encoded once more, goto failures report on stdout',
  async (t) => {
    const cli = await need(t, 'playwright-cli', () => onPath('playwright-cli'));
    const site = await startSite();
    try {
      await run(cli, A, 'open', `${site.origin}/a.html`);
      const { stdout } = await run(cli, A, 'eval', 'JSON.stringify(location.href)');
      assert.equal(parseEval(evalResult(stdout)), `${site.origin}/a.html`,
        'parseEval unwraps the CLI encoding and our own');
      const err = await run(cli, A, 'goto', 'http://127.0.0.1:1/x.html').then(
        () => null, (e) => e,
      );
      assert.ok(err, 'navigating to an unsafe port fails');
      assert.match(err.stdout, /### Error/);
      assert.match(cliError(err, 'goto').message, /net::ERR_UNSAFE_PORT/);
      assert.doesNotMatch(cliError(err, 'goto').message, /Update available/);
    } finally {
      await run(cli, A, 'close').catch(() => {});
      await site.close();
    }
  });

test('playwright-cli: opening and closing another session leaves ours untouched', async (t) => {
  const cli = await need(t, 'playwright-cli', () => onPath('playwright-cli'));
  const site = await startSite();
  try {
    await run(cli, A, 'open', `${site.origin}/a.html`);
    await run(cli, B, 'open', `${site.origin}/b.html`);
    await run(cli, B, 'close');
    const { stdout } = await run(cli, A, 'eval', 'JSON.stringify(document.title)');
    assert.equal(parseEval(evalResult(stdout)), 'Page A');
  } finally {
    await run(cli, A, 'close').catch(() => {});
    await run(cli, B, 'close').catch(() => {});
    await site.close();
  }
});

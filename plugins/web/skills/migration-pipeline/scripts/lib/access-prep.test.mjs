import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RESIDUAL, WORK, merge, prepPages } from './access-prep.mjs';

const cmp = { selector: '#onetrust', type: 'cookie-consent', source: 'cmp-match',
  cmp: 'onetrust', hide: ['#onetrust { display:none!important }'], dismiss: [] };
const guess = { selector: '#side-cart', type: 'unknown-modal', source: 'heuristic',
  hide: ['#side-cart { display:none!important }'], dismiss: null };

test('merge: a consent manager\'s rule added once, a heuristic left to judge, the scroll fix',
  () => {
    const a = merge(null, 'https://x.test/', { overlays: [cmp, guess], scroll_locked: true,
      scroll_fix: 'html { overflow: auto }' });
    assert.deepEqual(a.checked, ['https://x.test/']);
    assert.deepEqual(a.overlays.map((o) => [o.selector, o.type]),
      [['#onetrust', 'cookie-consent (onetrust)']], 'the heuristic is not a rule yet');
    assert.equal(a.scroll_fix, 'html { overflow: auto }');
    const b = merge({ ...a, overlays: [...a.overlays, { selector: '#gate', hide: ['x'] }] },
      'https://x.test/a', { overlays: [cmp], scroll_locked: false });
    assert.deepEqual(b.overlays.map((o) => o.selector), ['#onetrust', '#gate'],
      'known selectors once; what the agent added kept');
    assert.deepEqual(b.checked, ['https://x.test/', 'https://x.test/a']);
  });

test('prepPages: each page opened, looked at, shot; the prep merged, findings written',
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'mpipe-prep-'));
    const dir = path.join(cwd, WORK);
    await mkdir(dir, { recursive: true });
    await assert.rejects(prepPages(cwd, ['https://x.test/'], { io: {} }), /browser-probe first/);
    await writeFile(path.join(dir, 'browser-recipe.json'), JSON.stringify({
      cliConfig: { browser: { browserName: 'chromium' } }, stealthInitScript: '1;' }));
    const calls = [];
    const browser = {
      open: async (url, { config }) => calls.push(['open', url, path.basename(config)]),
      goto: async (url) => calls.push(['goto', url]),
      resize: async (w, h) => calls.push(['resize', w, h]),
      eval: async (expr) => (expr.includes('createElement(\'style\')') ? calls.push(['style'])
        : expr === RESIDUAL
        ? [{ tag: 'DIV', id: 'chat', position: 'fixed', z: '9999' }]
        : { overlays: [cmp, guess], scroll_locked: false }),
      screenshot: async (file, target, opts) => calls.push(['shot', path.basename(file),
        opts.viewport]),
      close: async () => calls.push(['close']),
    };
    const out = await prepPages(cwd, ['https://x.test/', 'https://x.test/a'],
      { io: { browser, bundle: 'BUNDLE', sleep: async () => {} } });
    assert.deepEqual(calls.filter((c) => c[0] !== 'resize'), [
      ['open', 'https://x.test/', 'browser-config.json'], ['shot', 'prep-1.png', true],
      ['goto', 'https://x.test/a'], ['style'], ['shot', 'prep-2.png', true], ['close']],
    'from the second page on, the rules found are applied before the look');
    assert.deepEqual(out.rules, ['#onetrust']);
    assert.ok(out.toJudge.includes('#side-cart (unknown-modal)'));
    assert.ok(out.toJudge.includes('DIV#chat fixed z9999'), 'the residual check, to judge');
    const prep = JSON.parse(await readFile(path.join(dir, 'page-prep.json'), 'utf8'));
    assert.deepEqual(prep.checked, ['https://x.test/', 'https://x.test/a']);
    const config = JSON.parse(await readFile(path.join(dir, 'browser-config.json'), 'utf8'));
    assert.equal(config.browser.initScript.length, 1, 'the recipe\'s stealth script injected');
    const findings = JSON.parse(await readFile(path.join(dir, 'prep-findings.json'), 'utf8'));
    assert.equal(findings.length, 2);
  });

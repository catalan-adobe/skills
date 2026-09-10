import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HIDDEN_SELECTOR, REVEAL_SELECTOR, capturePage, isRevealHidden, missingOutputs, outputPaths,
  prepScript, readinessPredicate, revealScript, viewportList,
} from './capture.mjs';

const viewports = { desktop: [1440, 900], mobile: [375, 812], tablet: [768, 1024] };

test('viewportList sorts by width and rejects malformed pairs', () => {
  assert.deepEqual(viewportList(viewports).map((v) => v.width), [375, 768, 1440]);
  assert.deepEqual(viewportList(viewports)[0], { name: 'mobile', width: 375, height: 812 });
  assert.throws(() => viewportList({}), /at least one viewport/);
  assert.throws(() => viewportList({ mobile: [375] }), /viewport "mobile" must be/);
  assert.throws(() => viewportList({ mobile: [375, 0] }), /viewport "mobile" must be/);
});

test('outputPaths names the DOM, tree and one JPEG per viewport width', () => {
  const outputs = outputPaths('/tmp/cap', viewports);
  assert.equal(outputs.dom, '/tmp/cap/dom.html');
  assert.equal(outputs.tree, '/tmp/cap/tree.json');
  assert.deepEqual(Object.values(outputs.shots), [
    '/tmp/cap/375.jpg', '/tmp/cap/768.jpg', '/tmp/cap/1440.jpg',
  ]);
});

test('missingOutputs reports only the files that are absent', () => {
  const outputs = outputPaths('/tmp/cap', viewports);
  assert.deepEqual(missingOutputs(outputs, []).length, 5);
  const all = [outputs.dom, outputs.tree, ...Object.values(outputs.shots)];
  assert.deepEqual(missingOutputs(outputs, all), []);
  assert.deepEqual(missingOutputs(outputs, all.slice(1)), ['/tmp/cap/dom.html']);
});

test('readinessPredicate is valid JS and adds the EDS lifecycle only when asked', () => {
  const plain = readinessPredicate(false);
  const eds = readinessPredicate(true);
  assert.equal(plain, 'document.readyState === "complete"');
  assert.match(eds, /appear/);
  assert.match(eds, /data-section-status/);
  assert.match(eds, /sectionStatus === "loaded"/);
  assert.doesNotThrow(() => new vm.Script(`(${plain});`), 'plain predicate must compile');
  assert.doesNotThrow(() => new vm.Script(`(${eds});`), 'eds predicate must compile');
});

test('prepScript is valid JS and carries the overlay selectors and readiness', () => {
  const script = prepScript({ overlaySelectors: ['#cookieNotice-wrap'], edsReady: true });
  assert.doesNotThrow(() => new vm.Script(script), 'prep script must compile');
  assert.match(script, /\["#cookieNotice-wrap"\]/);
  assert.match(script, /data-section-status/);
  assert.match(script, /position', 'static', 'important'/);
  assert.match(script, /pos === 'fixed'/);
  assert.match(script, /STICKY_TOP_PX = 160/);
  assert.match(script, /pos === 'sticky' && Math\.abs\(el\.getBoundingClientRect\(\)\.top\)/);
  assert.match(script, /__reduceForSkill/);
  assert.match(script, /i\.loading = 'eager'/);
  assert.ok(!prepScript().includes('data-section-status'), 'no EDS waits by default');
});

test('prepScript reveals scroll-hidden content after the lazy-load scroll', () => {
  const script = prepScript();
  assert.match(script, /await lazyLoad\(\);\n {6}reveal\(\);/, 'reveal runs after the scroll');
  const list = JSON.stringify(REVEAL_SELECTOR.join(', '));
  assert.ok(script.includes(list), 'carries the exported selector list');
  assert.ok(script.includes(JSON.stringify(HIDDEN_SELECTOR)), 'carries the structural selector');
  assert.match(script, /'visibility', 'visible', 'important'/);
  assert.match(script, /'opacity', '1', 'important'/);
});

test('REVEAL_SELECTOR names the Elementor and WordPress reveal markers', () => {
  assert.deepEqual(REVEAL_SELECTOR, [
    '.elementor-invisible',
    '[data-settings*="_animation"]',
    '.animated',
    '.wow',
    '.aos-init',
    '.fade-in',
    '[class*="reveal"]',
  ]);
  assert.doesNotThrow(() => new vm.Script(`(${revealScript()})`), 'reveal step must compile');
});

const RECT = [{
  width: 900, height: 300, right: 900, bottom: 300,
}];
const revealEl = ({
  style, matches = true, rects = RECT, structural = false,
}) => ({
  matches: () => matches,
  getClientRects: () => rects,
  closest: (sel) => (structural && sel === HIDDEN_SELECTOR ? { tagName: 'DIV' } : null),
  style,
});
const computed = (over = {}) => ({
  visibility: 'visible', display: 'block', opacity: '1', ...over,
});
const REVEAL = REVEAL_SELECTOR.join(', ');
const revealed = (el, style) => isRevealHidden(el, () => style, REVEAL, HIDDEN_SELECTOR);

test('isRevealHidden takes animation-hidden elements and leaves structural ones alone', () => {
  const hidden = computed({ visibility: 'hidden' });
  assert.equal(revealed(revealEl({ style: {} }), hidden), true, 'visibility:hidden is revealed');
  const faded = computed({ opacity: '0' });
  assert.equal(revealed(revealEl({ style: {} }), faded), true, 'opacity:0 is revealed');
  assert.equal(revealed(revealEl({ style: {} }), computed()), false, 'a painted element is left');
  const none = computed({ display: 'none', visibility: 'hidden' });
  assert.equal(revealed(revealEl({ style: {} }), none), false, 'display:none is structural');
  assert.equal(revealed(revealEl({ rects: [], style: {} }), hidden), false, 'no box, no reveal');
  assert.equal(revealed(revealEl({ structural: true, style: {} }), hidden), false, 'aria-hidden');
  assert.equal(revealed(revealEl({ matches: false, style: {} }), hidden), false, 'no marker');
});

function fakeBrowserFactory(calls, result) {
  return () => ({
    async open(url, opts) { calls.push(['open', url, opts.initScripts.length]); },
    async resize(w, h) { calls.push(['resize', w, h]); },
    async goto(url) { calls.push(['goto', url]); },
    async pollJson() { return result; },
    async evalJson() { return '<html><body>hi</body></html>'; },
    async screenshot(file, opts) {
      calls.push(['shot', file, opts.fullPage]);
      await writeFile(file, '');
    },
    async close() { calls.push(['close']); },
  });
}

const good = { ready: true, settled: true, tree: { sections: [{ sectionType: 'hero' }] } };

async function tmpDir() {
  return mkdtemp(path.join(os.tmpdir(), 'migration-capture-test-'));
}

test('capturePage writes every output once and skips on the second run', async () => {
  const outDir = path.join(await tmpDir(), 'home');
  const calls = [];
  const out = await capturePage({
    url: 'https://x.test/',
    outDir,
    viewports,
    overlaySelectors: ['#cookie'],
    bundle: '/tmp/page-reduce-bundle.js',
    browserFactory: fakeBrowserFactory(calls, good),
  });
  assert.equal(out.skipped, false);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.dom, path.join(outDir, 'dom.html'));
  assert.deepEqual(calls.filter(([c]) => c === 'shot').map(([, f]) => path.basename(f)), [
    '375.jpg', '768.jpg', '1440.jpg',
  ]);
  assert.ok(calls.every(([c, , full]) => c !== 'shot' || full === true), 'full-page shots');
  assert.deepEqual(calls.at(-1), ['close']);
  assert.deepEqual(JSON.parse(await readFile(out.tree, 'utf8')), good.tree);
  assert.equal(await readFile(out.dom, 'utf8'), '<html><body>hi</body></html>');
  const again = [];
  const second = await capturePage({
    url: 'https://x.test/',
    outDir,
    viewports,
    bundle: '/tmp/page-reduce-bundle.js',
    browserFactory: fakeBrowserFactory(again, good),
  });
  assert.equal(second.skipped, true);
  assert.deepEqual(again, []);
});

test('capturePage recaptures with force and reports settle warnings', async () => {
  const outDir = path.join(await tmpDir(), 'home');
  const calls = [];
  const args = {
    url: 'https://x.test/',
    outDir,
    viewports: { mobile: [375, 812] },
    bundle: '/tmp/page-reduce-bundle.js',
    browserFactory: fakeBrowserFactory(calls, { ready: false, settled: false, tree: {} }),
  };
  await capturePage(args);
  const forced = await capturePage({ ...args, force: true });
  assert.equal(forced.skipped, false);
  assert.deepEqual(forced.warnings, [
    'readiness timed out at 375px',
    'images did not settle at 375px',
  ]);
  assert.equal(calls.filter(([c]) => c === 'open').length, 2);
});

test('capturePage throws with the URL and viewport when the page script fails', async () => {
  const outDir = path.join(await tmpDir(), 'home');
  const calls = [];
  await assert.rejects(() => capturePage({
    url: 'https://x.test/',
    outDir,
    viewports: { mobile: [375, 812] },
    bundle: '/tmp/page-reduce-bundle.js',
    browserFactory: fakeBrowserFactory(calls, { error: 'xp.detectSections is not a function' }),
  }), /capture of https:\/\/x.test\/ failed at 375px: xp.detectSections/);
  assert.deepEqual(calls.at(-1), ['close']);
});

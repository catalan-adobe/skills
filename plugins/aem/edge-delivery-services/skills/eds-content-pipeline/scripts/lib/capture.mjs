import {
  mkdir, mkdtemp, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flag } from './args.mjs';
import { createBrowser } from './browser.mjs';
import { loadConfig } from './config.mjs';
import { resolvePaths } from './paths.mjs';

const POLL = '() => JSON.stringify(window.__captureResult || null)';
const DOM = '() => document.documentElement.outerHTML';
const READY_TIMEOUT_MS = 45000;
const SETTLE_MS = 10000;
// A sticky element pinned this close to the viewport top is chrome (header, banner, cookie bar);
// anything pinned further down is a scroll-pinned content section and must keep its stickiness.
const STICKY_TOP_PX = 160;

/**
 * Content that is in the DOM but not offered to the reader. It is never revealed by the prep
 * script and never measured by the scorecard, so both sides ignore the same markup.
 */
export const HIDDEN_SELECTOR = [
  '[hidden]',
  '[aria-hidden="true"]',
  'details:not([open]) > :not(summary)',
  '.e-n-tabs-content > :not(.e-active)',
].join(', ');

/**
 * Markers of the Elementor and WordPress scroll-reveal animations that hold content at
 * `visibility: hidden` / `opacity: 0` until it enters the viewport — a state headless never
 * leaves, because the animation runs off an IntersectionObserver the capture never triggers.
 */
export const REVEAL_SELECTOR = [
  '.elementor-invisible',
  '[data-settings*="_animation"]',
  '.animated',
  '.wow',
  '.aos-init',
  '.fade-in',
  '[class*="reveal"]',
];

/**
 * Decides whether one element is held back only by a reveal animation, and may therefore be
 * forced to its final state. Serialised into the in-page prep script, so it stays
 * dependency-free.
 *
 * @param {Element} el The candidate element.
 * @param {(el: Element) => CSSStyleDeclaration} getStyle Computed-style reader.
 * @param {string} revealSelector Selector matching the reveal-animation markers.
 * @param {string} hiddenSelector Selector matching structurally hidden content.
 * @returns {boolean} True only for an element hidden by an animation, never for one hidden
 *   structurally (`display: none`, `[hidden]`, `aria-hidden`, closed details, inactive tabs).
 */
export function isRevealHidden(el, getStyle, revealSelector, hiddenSelector) {
  if (!el.matches(revealSelector)) return false;
  // A `display: none` subtree lays out no boxes; a reveal-animated one still does.
  if (!el.getClientRects().length) return false;
  const style = getStyle(el);
  if (style.display === 'none' || el.closest(hiddenSelector)) return false;
  return style.visibility === 'hidden' || Number(style.opacity) === 0;
}

/**
 * Builds the in-page reveal step: forces every element hidden only by a reveal animation to its
 * final state, so both sides of a scorecard measure the same content.
 *
 * @returns {string} A JavaScript expression evaluating to a zero-argument function.
 */
export function revealScript() {
  return `(() => {
    const REVEAL = ${JSON.stringify(REVEAL_SELECTOR.join(', '))};
    const STRUCTURAL = ${JSON.stringify(HIDDEN_SELECTOR)};
    document.querySelectorAll(REVEAL).forEach((el) => {
      if (!(${isRevealHidden})(el, getComputedStyle, REVEAL, STRUCTURAL)) return;
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('animation', 'none', 'important');
      el.style.setProperty('transition', 'none', 'important');
    });
  })`;
}

/**
 * Normalizes the configured viewports into an ascending list.
 *
 * @param {Record<string, [number, number]>} viewports Named `[width, height]` pairs.
 * @returns {{name: string, width: number, height: number}[]} Sorted by width.
 * @throws {Error} When the map is empty or a pair is not two positive integers.
 */
export function viewportList(viewports) {
  const entries = Object.entries(viewports ?? {});
  if (!entries.length) throw new Error('capture needs at least one viewport in site.config.json');
  return entries
    .map(([name, size]) => {
      const ok = Array.isArray(size) && size.length === 2
        && size.every((n) => Number.isInteger(n) && n > 0);
      if (!ok) {
        const got = JSON.stringify(size);
        throw new Error(`viewport "${name}" must be [width, height], got ${got}`);
      }
      return { name, width: size[0], height: size[1] };
    })
    .sort((a, b) => a.width - b.width);
}

/**
 * Builds every file path a capture produces.
 *
 * @param {string} outDir Directory the capture writes into.
 * @param {Record<string, [number, number]>} viewports Named `[width, height]` pairs.
 * @returns {{dom: string, tree: string, shots: Record<string, string>}} Output file paths.
 */
export function outputPaths(outDir, viewports) {
  const shots = {};
  viewportList(viewports).forEach((vp) => {
    shots[vp.width] = path.join(outDir, `${vp.width}.jpg`);
  });
  return { dom: path.join(outDir, 'dom.html'), tree: path.join(outDir, 'tree.json'), shots };
}

/**
 * Lists the outputs that are not on disk yet.
 *
 * @param {{dom: string, tree: string, shots: Record<string, string>}} outputs From `outputPaths`.
 * @param {string[]} present Files that exist.
 * @returns {string[]} Missing files, in output order.
 */
export function missingOutputs(outputs, present) {
  const have = new Set(present);
  return [outputs.dom, outputs.tree, ...Object.values(outputs.shots)].filter((f) => !have.has(f));
}

/**
 * Builds the in-page readiness expression used before screenshots.
 *
 * @param {boolean} [edsReady=false] Also wait for the EDS section lifecycle.
 * @returns {string} A JavaScript expression that evaluates to a boolean in the page.
 */
export function readinessPredicate(edsReady = false) {
  const base = 'document.readyState === "complete"';
  if (!edsReady) return base;
  return `${base} && document.body.classList.contains("appear")`
    + ' && Array.from(document.querySelectorAll("[data-section-status]"))'
    + '.every((s) => s.dataset.sectionStatus === "loaded")';
}

/**
 * Builds the init script that preps a page and produces the page-tree JSON.
 *
 * @param {object} [options]
 * @param {string[]} [options.overlaySelectors=[]] Selectors removed before anything else.
 * @param {boolean} [options.edsReady=false] Wait for the EDS section lifecycle.
 * @param {number} [options.settleMs=10000] Cap on the readiness and image-settle waits.
 * @returns {string} Source for `playwright-cli`'s `browser.initScript`.
 */
export function prepScript({ overlaySelectors = [], edsReady = false, settleMs = SETTLE_MS } = {}) {
  return `(() => {
  const OVERLAYS = ${JSON.stringify(overlaySelectors)};
  const CAP = ${settleMs};
  const STICKY_TOP_PX = ${STICKY_TOP_PX};
  const ready = () => ${readinessPredicate(edsReady)};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn) => {
    const deadline = Date.now() + CAP;
    while (!fn()) {
      if (Date.now() > deadline) return false;
      await wait(200);
    }
    return true;
  };
  // Runs at scroll top: fixed chrome always goes static, sticky only when it is pinned near the
  // top of the viewport, so scroll-pinned content (stacked cards) still lays out in document flow.
  const deSticky = () => {
    document.querySelectorAll('*').forEach((el) => {
      const pos = getComputedStyle(el).position;
      const sticky = pos === 'sticky' && Math.abs(el.getBoundingClientRect().top) <= STICKY_TOP_PX;
      if (pos === 'fixed' || sticky) {
        el.style.setProperty('position', 'static', 'important');
      }
    });
  };
  const reveal = ${revealScript()};
  const lazyLoad = async () => {
    const step = Math.max(400, window.innerHeight);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await wait(150);
    }
    window.scrollTo(0, 0);
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
    await wait(400);
  };
  const pending = () => Array.from(document.images).filter((i) => {
    if (i.complete) return false;
    const box = i.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  window.addEventListener('load', async () => {
    try {
      OVERLAYS.forEach((s) => document.querySelectorAll(s).forEach((el) => el.remove()));
      const isReady = await until(ready);
      await lazyLoad();
      reveal();
      deSticky();
      const settled = await until(() => pending().length === 0);
      await document.fonts.ready;
      await window.xp.detectSections(document.body, window, {
        autoDetect: true, highlightBoxes: false, highlightSections: false,
      });
      const tree = window.__reduceForSkill(document.body, window);
      window.__captureResult = { ready: isReady, settled, tree };
    } catch (err) {
      window.__captureResult = { error: String((err && err.stack) || err) };
    }
  });
})();`;
}

async function existingFiles(outputs) {
  const wanted = [outputs.dom, outputs.tree, ...Object.values(outputs.shots)];
  const checks = await Promise.all(wanted.map(
    (file) => stat(file).then(() => file, () => null),
  ));
  return checks.filter(Boolean);
}

async function writeInitScripts({ overlaySelectors, edsReady, bundle }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-capture-'));
  const prep = path.join(dir, 'prep.js');
  await writeFile(prep, prepScript({ overlaySelectors, edsReady }));
  return { dir, files: [bundle, prep] };
}

// One reload per viewport so the init script re-preps the page at that width; the DOM and the
// page tree come from the widest pass, which is the one the analysis agents read.
async function captureViewports({
  browser, url, outputs, list, log,
}) {
  const warnings = [];
  for (const vp of list) {
    await browser.resize(vp.width, vp.height);
    await browser.goto(url);
    const result = await browser.pollJson(POLL, { timeoutMs: READY_TIMEOUT_MS });
    if (result.error) throw new Error(`capture of ${url} failed at ${vp.width}px: ${result.error}`);
    if (!result.ready) warnings.push(`readiness timed out at ${vp.width}px`);
    if (!result.settled) warnings.push(`images did not settle at ${vp.width}px`);
    await browser.screenshot(outputs.shots[vp.width], { fullPage: true });
    log(`captured ${url} at ${vp.width}px`);
    if (vp === list[list.length - 1]) {
      await writeFile(outputs.tree, JSON.stringify(result.tree ?? null, null, 2));
      await writeFile(outputs.dom, String(await browser.evalJson(DOM)));
    }
  }
  return warnings;
}

/**
 * Captures one page: prep (overlays, lazy-load, reveal, de-sticky of pinned chrome, settle), DOM,
 * the page tree and a
 * full-page JPEG per viewport. Existing outputs are kept unless `force` is set.
 *
 * @param {object} options
 * @param {string} options.url Page to capture.
 * @param {string} options.outDir Directory for `dom.html`, `tree.json` and `<width>.jpg`.
 * @param {Record<string, [number, number]>} options.viewports Named `[width, height]` pairs.
 * @param {string[]} [options.overlaySelectors=[]] Removed before the capture (cookie banners).
 * @param {boolean} [options.edsReady=false] Wait for `body.appear`, loaded sections and fonts.
 * @param {string} options.bundle Absolute path to `page-reduce-bundle.js`.
 * @param {boolean} [options.force=false] Recapture even when every output exists.
 * @param {(opts: {session: string}) => ReturnType<typeof createBrowser>} [options.browserFactory]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{url: string, outDir: string, dom: string, tree: string,
 *   shots: Record<string, string>, skipped: boolean, warnings: string[]}>}
 */
export async function capturePage({
  url, outDir, viewports, overlaySelectors = [], edsReady = false,
  bundle, force = false, browserFactory = createBrowser, log = () => {},
}) {
  const outputs = outputPaths(outDir, viewports);
  const list = viewportList(viewports);
  const missing = missingOutputs(outputs, await existingFiles(outputs));
  const base = { url, outDir, ...outputs };
  if (!force && !missing.length) return { ...base, skipped: true, warnings: [] };
  await mkdir(outDir, { recursive: true });
  const scripts = await writeInitScripts({ overlaySelectors, edsReady, bundle });
  const browser = browserFactory({ session: 'migration-capture' });
  try {
    await browser.open(url, { initScripts: scripts.files });
    const warnings = await captureViewports({
      browser, url, outputs, list, log,
    });
    return { ...base, skipped: false, warnings };
  } finally {
    await browser.close();
    await rm(scripts.dir, { recursive: true, force: true });
  }
}

async function cli(argv) {
  const url = argv[0];
  const outDir = flag(argv, '--out');
  if (!url || url.startsWith('--') || !outDir) {
    throw new Error('usage: capture.mjs <url> --out <dir> [--eds] [--force]');
  }
  const paths = resolvePaths();
  const config = await loadConfig(paths.configPath);
  const summary = await capturePage({
    url,
    outDir: path.resolve(outDir),
    viewports: config.viewports,
    overlaySelectors: config.overlaySelectors,
    edsReady: argv.includes('--eds'),
    bundle: path.resolve(paths.repoRoot, config.bundles.pageReduce),
    force: argv.includes('--force'),
    log: (msg) => console.error(`[capture] ${msg}`),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

// The capture phase: every cached page still in the migration rendered from the cache,
// offline, with the page-tree bundle injected; its visual tree stored under the page with
// the page's height and, when the page is not too tall for one, its full-page screenshot.
// A rerun captures only what is missing or taken at another width.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { analyse } from './band-analysis.mjs';
import { DUMP } from './band-dump.mjs';
import { parseEval } from './browser.mjs';
import { pageExpression } from './cache.mjs';
import { data } from './data.mjs';

// A 1280 px viewport puts a four-up grid column and a quarter-width rail at ~290 px; 300
// missed both and left their content out of the store. 250 sees them; 200 saw nothing more.
export const MIN_WIDTH = 250;
export const MAX_CONSECUTIVE_FAILURES = 5;
/**
 * The capture method's version: what the prepare expression waits for and how the tree
 * is taken. Bumped when that changes; a tree taken by an older version is stale.
 *   2 — an empty header/footer landmark is a hole; the page is at the top, instantly,
 *       before the tree is read (sticky headers were measured mid-scroll).
 *   3 — page-tree walks through `display: contents` elements (a whole MDN page had been
 *       sixteen nodes).
 *   4 — the band dump and its analysis, from the site census, stored beside the tree.
 *   5 — the page is pinned to the top before each reading, and a dump taken scrolled fails
 *       the capture (a side navigation had scrolled the page after it was prepared).
 *   6 — a clip-path leaving no area hides an element, in the tree and in the dump (a mega
 *       menu's closed panel had put a band edge and a background where nothing is painted).
 */
export const CAPTURE_VERSION = 6;
/**
 * Back at the top, instantly, before anything is read: a script may scroll the page after
 * it was prepared (a side navigation bringing its active item into view), and a reading
 * taken scrolled puts every fixed element, and the picture, where the scroll happened.
 */
export const AT_TOP = '(() => { document.documentElement.style.scrollBehavior = "auto";'
  + ' window.scrollTo({ top: 0, left: 0, behavior: "instant" }); return window.scrollY; })()';
export const captureExpression = (minWidth = MIN_WIDTH) => (
  `(() => { ${AT_TOP}; return JSON.stringify(window.__visualTree.captureVisualTree(${minWidth}));`
  + ' })()');
export const HEIGHT_EXPRESSION = 'document.documentElement.scrollHeight';

/**
 * The page is settled when samples this far apart agree and no hole is left; give up after
 * this long. A hole: a block in the flow covering this share of the viewport, at opacity
 * 0, with children, and nothing visible drawn over it — content on its way in (a fade gated
 * on a script); or a `header`/`footer` landmark still empty — a site that loads its chrome
 * after the content, as Edge Delivery sites do. An inactive slide sits under a visible
 * sibling; a parked chat window or lightbox is positioned out of the flow; neither is a hole.
 */
export const SETTLE_SAMPLE_MS = 250;
export const SETTLE_MAX_MS = 8000;
export const PENDING_SHARE = 0.25;
export const COVERED_SHARE = 0.5;

/**
 * The prep expression, then a settled page, then its top. The expression scrolls through
 * the page (lazy content) and ends at the bottom, and it is asynchronous — a measurement
 * taken before it finishes, or with the page left at the bottom, records a sticky nav where
 * it stuck. Scripts still building the page after that are given time: the wait ends when
 * element count and height agree across two samples and no hole is left, or at the bound.
 * One expression for `playwright-cli eval`, awaited by the browser.
 */
export const preparedAtTop = (prepare) => (
  `(async () => { await (${prepare});`
  + ` const viewport = window.innerWidth * window.innerHeight * ${PENDING_SHARE};`
  + ' const rect = (e) => e.getBoundingClientRect();'
  + ' const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))'
  + ' * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));'
  + ' const all = () => [...document.querySelectorAll("*")];'
  + ' const holes = () => { const els = all();'
  + ' const dark = els.filter((e) => { const cs = getComputedStyle(e);'
  + ' return e.children.length && cs.opacity === "0"'
  + ' && cs.position !== "fixed" && cs.position !== "absolute"'
  + ' && rect(e).width * rect(e).height >= viewport; });'
  + ' const covered = dark.filter((e) => { const r = rect(e); const area = r.width * r.height;'
  + ' return !els.some((o) => o !== e && !e.contains(o) && !o.contains(e)'
  + ' && getComputedStyle(o).opacity !== "0"'
  + ` && overlap(r, rect(o)) >= area * ${COVERED_SHARE}); });`
  + ' const bare = [...document.querySelectorAll("body > header, body > footer")]'
  + ' .filter((e) => !e.children.length);'
  + ' return [...covered, ...bare]; };'
  + ' const sample = () => `${document.getElementsByTagName("*").length}:`'
  + ' + document.documentElement.scrollHeight;'
  + ` const until = Date.now() + ${SETTLE_MAX_MS}; let last = sample();`
  + ' while (Date.now() < until) {'
  + ` await new Promise((r) => setTimeout(r, ${SETTLE_SAMPLE_MS}));`
  + ' const now = sample(); if (now === last && holes().length === 0) break; last = now; }'
  + ' document.documentElement.style.scrollBehavior = "auto";'
  + ' window.scrollTo({ top: 0, left: 0, behavior: "instant" });'
  + ' for (let i = 0; i < 20 && window.scrollY > 0; i += 1) {'
  + ' await new Promise((r) => setTimeout(r, 50)); window.scrollTo(0, 0); }'
  + ' return window.scrollY === 0 ? "top" : `scrolled ${window.scrollY}`; })()');

/** The pages the chrome step reads: cached, a page, not out of the migration. */
export async function readablePages(cwd) {
  const { pages } = await data(cwd);
  return (await pages.read(cwd)).pages
    .filter((p) => p.kind === 'page' && p.cache && p.verdict.status !== 'out');
}

/**
 * When what a capture renders last changed: the access decision (an overlay rule added)
 * or the cache (a selection cached, a fill). A tree older than that is stale.
 */
export async function renderingChangedAt(cwd) {
  const { runs, website } = await data(cwd);
  const access = await website.readAccess(cwd);
  const cacheRuns = (await runs.list(cwd, { step: 'cache' })).filter((r) => r.state === 'done');
  return [access?.updatedAt, ...cacheRuns.map((r) => r.finished)].filter(Boolean).sort().at(-1)
    ?? null;
}

/**
 * Readable pages without a current tree: none, one at another width, one without the
 * page facts, or one older than the last change to what a capture renders.
 */
export async function pagesToCapture(cwd, { minWidth = MIN_WIDTH } = {}) {
  const { trees } = await data(cwd);
  const readable = await readablePages(cwd);
  const since = await renderingChangedAt(cwd);
  const heads = await Promise.all(readable.map((p) => trees.head(cwd, p.id)));
  return readable.filter((_, i) => {
    const h = heads[i];
    return !h || h.minWidth !== minWidth || !h.facts || h.version !== CAPTURE_VERSION
      || (since && h.capturedAt < since);
  });
}

const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim()) ?? '';

/**
 * The page's scroll height and its full-page screenshot — none above the height a browser
 * screenshots whole: past it the picture repeats the top and loses the bottom.
 */
async function screenshot(cwd, pageId, browser, trees) {
  await browser.eval(AT_TOP);
  const scrollHeight = Number(parseEval(await browser.eval(HEIGHT_EXPRESSION))) || 0;
  if (scrollHeight > trees.SCREENSHOT_LIMIT) return { scrollHeight, shot: null };
  const rel = trees.shotFile(pageId);
  const abs = path.join(cwd, 'migration', rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await browser.screenshot(abs, null, { type: 'jpeg' });
  return { scrollHeight, shot: rel };
}

/** Runs async steps one after another, whoever calls: the run file is read-modify-write. */
export function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

/**
 * One page: visit, prepare, tree, shot, then the band dump (last: it hides the floating
 * layers it set aside) — each phase timed, the times kept with the facts.
 */
async function captureOne(cwd, page, { browser, visit, prepare, minWidth, now, trees, bands }) {
  const timings = {};
  const timed = async (name, fn) => {
    const t0 = Date.now();
    const out = await fn();
    timings[name] = Date.now() - t0;
    return out;
  };
  await timed('goto', () => visit(browser, page));
  await timed('prepare', () => browser.eval(prepare));
  const captured = await timed('tree', async () => (
    parseEval(await browser.eval(captureExpression(minWidth)))));
  if (!captured?.data?.tag) {
    throw new Error('the page-tree bundle returned no tree (was it injected?)');
  }
  const facts = await timed('shot', () => screenshot(cwd, page.id, browser, trees));
  await browser.eval(AT_TOP);
  const dump = await timed('bands', async () => parseEval(await browser.eval(DUMP)));
  if (!dump?.leaves) throw new Error('the band dump returned no leaves');
  if (dump.sy) throw new Error(`the page scrolled ${dump.sy} px while it was read`);
  const { leaves: analysedLeaves, ...analysis } = analyse(dump);
  await bands.writeCapture(cwd, page.id, {
    url: page.url, ...dump, leaves: analysedLeaves,
    analysis: { ...analysis, bands: analysis.bands.map(({ inside, ...b }) => b) },
  });
  await trees.write(cwd, page.id, {
    minWidth, version: CAPTURE_VERSION, url: page.url, capturedAt: now().toISOString(),
    tree: captured.data, text: captured.textFormat, nodeMap: captured.nodeMap,
    rootBackground: captured.rootBackground ?? null, page: { ...facts, timings },
  });
}

/**
 * Renders each page offline and stores its tree. `io.browsers` are sessions open on the
 * offline proxy with the bundle injected, as many as the migration's `sessions` setting;
 * `visit(browser, page)` navigates one of them. The pages are dealt from one queue;
 * progress goes to the run after every page; five failures in a row end the phase.
 */
export async function captureTrees(cwd, targets, {
  io, run, access, visit, minWidth = MIN_WIDTH, now = () => new Date(),
}) {
  const { runs, trees, bands } = await data(cwd);
  const prepare = preparedAtTop(pageExpression(access));
  const browsers = io.browsers ?? [io.browser];
  const queue = [...targets];
  const failures = [];
  const busy = new Set();
  const update = serial();
  let streak = 0;
  let done = 0;
  let fatal = null;
  const session = async (browser) => {
    while (queue.length && !fatal) {
      const page = queue.shift();
      busy.add(page.id);
      // eslint-disable-next-line no-await-in-loop
      await update(() => runs.update(cwd, run.id, { current: [...busy].join(' ') }));
      try {
        // eslint-disable-next-line no-await-in-loop
        await captureOne(cwd, page, { browser, visit, prepare, minWidth, now, trees, bands });
        streak = 0;
      } catch (err) {
        failures.push({ id: page.id, error: firstLine(err.message) });
        streak += 1;
        // eslint-disable-next-line no-await-in-loop
        await update(() => runs.update(cwd, run.id, { fail: failures.at(-1) }));
        if (streak >= MAX_CONSECUTIVE_FAILURES) {
          fatal = new Error(`${streak} captures failed in a row; last: ${firstLine(err.message)}`);
        }
      }
      busy.delete(page.id);
      done += 1;
      // eslint-disable-next-line no-await-in-loop
      await update(() => runs.update(cwd, run.id, { done, current: [...busy].join(' ') || null }));
    }
  };
  await Promise.all(browsers.map(session));
  if (fatal) throw fatal;
  return { captured: targets.length - failures.length, failures };
}

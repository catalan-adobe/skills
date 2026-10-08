// The capture phase: every cached page still in the migration rendered from the cache,
// offline, with the page-tree bundle injected; its visual tree stored under the page with
// the page's height and, when the page is not too tall for one, its full-page screenshot.
// A rerun captures only what is missing or taken at another width.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseEval } from './browser.mjs';
import { pageExpression } from './cache.mjs';
import { data } from './data.mjs';

// A 1280 px viewport puts a four-up grid column and a quarter-width rail at ~290 px; 300
// missed both and left their content out of the store. 250 sees them; 200 saw nothing more.
export const MIN_WIDTH = 250;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const captureExpression = (minWidth = MIN_WIDTH) => (
  `JSON.stringify(window.__visualTree.captureVisualTree(${minWidth}))`);
export const HEIGHT_EXPRESSION = 'document.documentElement.scrollHeight';

/**
 * The page is settled when samples this far apart agree and no hole is left; give up after
 * this long. A hole: a block in the flow covering this share of the viewport, at opacity
 * 0, with children, and nothing visible drawn over it — content on its way in (a fade gated
 * on a script). An inactive slide sits under a visible sibling; a parked chat window or
 * lightbox is positioned out of the flow; neither is a hole.
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
  + ' return dark.filter((e) => { const r = rect(e); const area = r.width * r.height;'
  + ' return !els.some((o) => o !== e && !e.contains(o) && !o.contains(e)'
  + ' && getComputedStyle(o).opacity !== "0"'
  + ` && overlap(r, rect(o)) >= area * ${COVERED_SHARE}); });`
  + ' };'
  + ' const sample = () => `${document.getElementsByTagName("*").length}:`'
  + ' + document.documentElement.scrollHeight;'
  + ` const until = Date.now() + ${SETTLE_MAX_MS}; let last = sample();`
  + ' while (Date.now() < until) {'
  + ` await new Promise((r) => setTimeout(r, ${SETTLE_SAMPLE_MS}));`
  + ' const now = sample(); if (now === last && holes().length === 0) break; last = now; }'
  + ' window.scrollTo(0, 0); return "top"; })()');

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
    return !h || h.minWidth !== minWidth || !h.facts || (since && h.capturedAt < since);
  });
}

const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim()) ?? '';

/**
 * The page's scroll height and its full-page screenshot — none above the height a browser
 * screenshots whole: past it the picture repeats the top and loses the bottom.
 */
async function screenshot(cwd, pageId, io, trees) {
  const scrollHeight = Number(parseEval(await io.browser.eval(HEIGHT_EXPRESSION))) || 0;
  if (scrollHeight > trees.SCREENSHOT_LIMIT) return { scrollHeight, shot: null };
  const rel = trees.shotFile(pageId);
  const abs = path.join(cwd, 'migration', rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await io.browser.screenshot(abs, null, { type: 'jpeg' });
  return { scrollHeight, shot: rel };
}

/**
 * Renders each page offline and stores its tree. `browser` is open on the offline proxy
 * with the bundle injected; `visit(page)` navigates. Progress goes to the run after every
 * page; five failures in a row end the phase.
 */
export async function captureTrees(cwd, targets, {
  io, run, access, visit, minWidth = MIN_WIDTH, now = () => new Date(),
}) {
  const { runs, trees } = await data(cwd);
  const prepare = preparedAtTop(pageExpression(access));
  const failures = [];
  let streak = 0;
  let done = 0;
  for (const page of targets) {
    // eslint-disable-next-line no-await-in-loop
    await runs.update(cwd, run.id, { current: page.id });
    try {
      // eslint-disable-next-line no-await-in-loop
      await visit(page);
      // eslint-disable-next-line no-await-in-loop
      await io.browser.eval(prepare);
      // eslint-disable-next-line no-await-in-loop
      const captured = parseEval(await io.browser.eval(captureExpression(minWidth)));
      if (!captured?.data?.tag) {
        throw new Error('the page-tree bundle returned no tree (was it injected?)');
      }
      // eslint-disable-next-line no-await-in-loop
      const shot = await screenshot(cwd, page.id, io, trees);
      // eslint-disable-next-line no-await-in-loop
      await trees.write(cwd, page.id, {
        minWidth, url: page.url, capturedAt: now().toISOString(), tree: captured.data,
        text: captured.textFormat, nodeMap: captured.nodeMap,
        rootBackground: captured.rootBackground ?? null, page: shot,
      });
      streak = 0;
    } catch (err) {
      failures.push({ id: page.id, error: firstLine(err.message) });
      streak += 1;
      // eslint-disable-next-line no-await-in-loop
      await runs.update(cwd, run.id, { fail: failures.at(-1) });
      if (streak >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`${streak} captures failed in a row; last: ${firstLine(err.message)}`);
      }
    }
    done += 1;
    // eslint-disable-next-line no-await-in-loop
    await runs.update(cwd, run.id, { done, current: null });
  }
  return { captured: targets.length - failures.length, failures };
}

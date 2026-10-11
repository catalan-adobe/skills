// The access step's look at the overlays, as a command: each page opened with the probe's
// recipe, page-prep's detection and the residual check run, a viewport screenshot taken.
// What a consent-manager rule recognises is merged into the prep file as a hide rule; what
// a heuristic or the residual check found is listed for the agent to judge on the
// screenshot, taken with the rules found so far applied. The agent still decides — it reads
// every screenshot, adds what was missed, removes what is not an overlay, runs it again
// until the screenshots are clean — then `access --write`.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { browserOf } from './access.mjs';
import { writeBrowserConfig } from './browser.mjs';

export const WORK = path.join('migration', '.work', 'access');
export const VIEWPORT = [1280, 900];
export const SETTLE_MS = 5000; // a consent manager injects its banner after the load

// Fixed or sticky layers over the viewport, wide or tall enough to hide content: what the
// rules did not name is still here to be judged.
export const RESIDUAL = `[...document.querySelectorAll('body *')].filter((el) => {
  const s = getComputedStyle(el); const r = el.getBoundingClientRect();
  return (s.position === 'fixed' || s.position === 'sticky') && r.width > 200 && r.height > 30
    && r.bottom > 0 && r.top < innerHeight && s.display !== 'none' && s.visibility !== 'hidden';
}).map((el) => ({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60),
  position: getComputedStyle(el).position, z: getComputedStyle(el).zIndex,
  box: [el.getBoundingClientRect().top, el.getBoundingClientRect().width,
    el.getBoundingClientRect().height].map(Math.round),
  text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) })).slice(0, 12)`;

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
// An eval's value, once more parsed when the page handed back JSON text.
const value = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** An expression adding the prep's hide rules and scroll fix to the page, as one style. */
export const styleOf = (prep) => `(() => { const s = document.createElement('style');
  s.textContent = ${JSON.stringify([...prep.overlays.flatMap((o) => o.hide ?? []),
    prep.scroll_fix ?? ''].join('\n'))}; document.head.append(s); return 1; })()`;

/** The prep file with a page's findings folded in: checked, CMP rules, the scroll fix. */
export function merge(prep, url, detection) {
  const base = prep ?? { checked: [], overlays: [], scroll_fix: null, residual: [] };
  const known = new Set(base.overlays.map((o) => o.selector));
  const cmp = (detection.overlays ?? []).filter((o) => o.source === 'cmp-match'
    && o.hide?.length && !known.has(o.selector))
    .map((o) => ({ selector: o.selector, type: `${o.type} (${o.cmp})`, hide: o.hide,
      dismiss: [] }));
  return {
    ...base, checked: [...new Set([...base.checked, url])],
    overlays: [...base.overlays, ...cmp],
    scroll_fix: base.scroll_fix ?? (detection.scroll_locked ? detection.scroll_fix ?? null : null),
  };
}

/**
 * Opens each URL in turn, looks, and writes `page-prep.json` (merged) and
 * `prep-findings.json` (everything seen, per page, with its screenshot) under the access
 * work directory. `io`: `browser` (the playwright API), `bundle` (page-prep's script),
 * `sleep`.
 */
export async function prepPages(cwd, urls, { io }) {
  const dir = path.join(cwd, WORK);
  const recipe = await readJson(path.join(dir, 'browser-recipe.json'));
  if (!recipe) throw new Error(`no ${WORK}/browser-recipe.json: run the browser-probe first`);
  const config = await writeBrowserConfig(cwd, 'access', { browser: browserOf(recipe) }, 0);
  const prepFile = path.join(dir, 'page-prep.json');
  let prep = await readJson(prepFile);
  const findings = [];
  try {
    for (const [i, url] of urls.entries()) {
      // eslint-disable-next-line no-await-in-loop
      if (i === 0) await io.browser.open(url, { config }); else await io.browser.goto(url);
      // eslint-disable-next-line no-await-in-loop
      await io.browser.resize(...VIEWPORT);
      // eslint-disable-next-line no-await-in-loop
      await io.sleep(SETTLE_MS);
      // The rules found so far applied first: the screenshot shows what they leave.
      // eslint-disable-next-line no-await-in-loop
      if (prep) await io.browser.eval(styleOf(prep));
      // eslint-disable-next-line no-await-in-loop
      const detection = value(await io.browser.eval(io.bundle)) ?? {};
      // eslint-disable-next-line no-await-in-loop
      const residual = value(await io.browser.eval(RESIDUAL)) ?? [];
      const shot = path.join(dir, `prep-${i + 1}.png`);
      // eslint-disable-next-line no-await-in-loop
      await io.browser.screenshot(shot, null, { viewport: true });
      prep = merge(prep, url, detection);
      findings.push({ url, shot, scrollLocked: Boolean(detection.scroll_locked), residual,
        overlays: (detection.overlays ?? []).map(({ selector, type, source, cmp, hide }) => (
          { selector, type, source, ...(cmp ? { cmp } : {}), hide })) });
    }
  } finally {
    await io.browser.close().catch(() => {});
  }
  await writeFile(prepFile, `${JSON.stringify(prep, null, 2)}\n`);
  await writeFile(path.join(dir, 'prep-findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
  return {
    prep: path.relative(cwd, prepFile), shots: findings.map((f) => path.relative(cwd, f.shot)),
    rules: prep.overlays.map((o) => o.selector),
    toJudge: findings.flatMap((f) => [
      ...f.overlays.filter((o) => o.source !== 'cmp-match').map((o) => `${o.selector} (${o.type})`),
      ...f.residual.map((r) => `${r.tag}${r.id ? `#${r.id}` : ''}`
        + `${r.cls ? `.${r.cls.split(' ')[0]}` : ''} ${r.position} z${r.z}`
        + `${r.text ? ` "${r.text.slice(0, 30)}"` : ''}`),
    ]),
    next: 'read every screenshot; add to page-prep.json what still covers the page, remove what'
      + ' is not an overlay; run access prep again until the screenshots are clean; then'
      + ' pipeline access --write',
  };
}

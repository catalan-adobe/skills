// cache: the approved selections' pages fetched once, through the page-cache proxy, in one
// browser session with the access recipe applied — then verified offline and recorded on
// the page table (http, redirect, final URL, kind, cache), the verdicts following. One run
// per selection, heartbeating; a detached worker so the caller returns at once.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  cacheDir, defaultIo, parseEval, playwright, proxyStarter, sessionName, tools, viaProxy,
  writeBrowserConfig,
} from './browser.mjs';
import { data } from './data.mjs';

export const MAX_CONSECUTIVE_FAILURES = 5;
export const SCROLL_STEP_SHARE = 0.8;
export const IMAGE_SETTLE_MS = 4000;
const BINARY_EXT = /\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|mp3|docx?|xlsx?|pptx?|csv|xml|txt)$/i;

/**
 * The expression run on every page: the access rules' CSS injected, a scroll pass in
 * viewport steps (lazy loaders watch the viewport), lazy images made eager, a bounded
 * wait for them to decode. The proxy stores what the page fetched.
 */
/**
 * Animations and transitions end at once: a reveal that eases in over a second is read
 * where it ends, not midway; and smooth scrolling is instant, so a scroll is where it says.
 * A fixed background scrolls with its box: a full-page screenshot paints a fixed one
 * against the viewport, so a parallax banner came out blank behind its text. What overflows
 * the page across is clipped (`clip`: no scroll container, sticky still sticks): a slider's
 * track 40 000 px wide had made the screenshot as wide.
 */
export const FREEZE = '*, *::before, *::after { animation-duration: 0s !important;'
  + ' animation-delay: 0s !important; transition-duration: 0s !important;'
  + ' transition-delay: 0s !important; background-attachment: scroll !important }'
  + ' html, body { scroll-behavior: auto !important } body > * { overflow-x: clip !important }';

export function pageExpression(access) {
  const css = [
    FREEZE,
    ...access.overlays.filter((o) => o.action === 'hide').flatMap((o) => o.css ?? []),
    ...(access.scrollFix ? [access.scrollFix] : []),
    ...(access.rendering ?? []).map((r) => r.css),
  ].join('\n');
  return '(async () => { const s = document.createElement(\'style\');'
    + ` s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s);`
    + ` const step = Math.max(200, window.innerHeight * ${SCROLL_STEP_SHARE});`
    + ' for (let y = 0; y < document.body.scrollHeight; y += step) {'
    + ' window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }'
    + ' window.scrollTo(0, document.body.scrollHeight);'
    + ' document.querySelectorAll(\'img[loading="lazy"]\')'
    + '.forEach((i) => { i.loading = "eager"; });'
    // An image that failed to load (complete, no pixels) is asked for once more: a transient
    // refusal under load is not what the page shows.
    + ' [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src)'
    + ' .forEach((i) => { const src = i.src; i.removeAttribute("src"); i.src = src; });'
    + ' const pending = [...document.images].filter((i) => !i.complete)'
    + ' .map((i) => i.decode().catch(() => {}));'
    + ' await Promise.race([Promise.all(pending),'
    + ` new Promise((r) => setTimeout(r, ${IMAGE_SETTLE_MS}))]);`
    + ' return JSON.stringify(location.href); })()';
}

/** Where the proxy stores a URL's body, relative to the cache directory. */
export function cacheRelativePath(url) {
  const u = new URL(url);
  const dir = `${u.hostname}_${createHash('sha256').update(u.origin).digest('hex').slice(0, 8)}`;
  let seg = u.pathname.slice(1);
  if (seg === '' || seg.endsWith('/')) seg += 'index.html';
  else if (!path.extname(seg)) seg += '/index~.html';
  let rel = `${dir}/${seg}`;
  if (u.search) {
    let qs = u.search.slice(1);
    if (rel.length + qs.length > 200) qs = createHash('md5').update(qs).digest('hex');
    const ext = path.extname(rel);
    rel = ext ? `${rel.slice(0, -ext.length)}!${qs}${ext}` : `${rel}!${qs}`;
  }
  return rel;
}

/** A proxied href back to the site's URL. */
export function siteUrl(href, origin) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const viaLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (viaLocal) u.searchParams.delete('_origin');
  return `${viaLocal ? origin : u.origin}${u.pathname}${u.search}`;
}

/**
 * What a URL is, from the stored response and where the browser landed. A landing on the
 * same path with another query string or fragment is the page itself (a script writing
 * its state into the URL), not a redirect.
 */
export function classify({ url, sidecar, finalUrl }) {
  if (!sidecar || typeof sidecar.status !== 'number') return 'unreachable';
  const { status } = sidecar;
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400) return 'error';
  const type = (sidecar.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type && !/html|xhtml/.test(type)) return 'binary';
  if (finalUrl && samePath(finalUrl, url) === false) return 'redirect';
  return 'page';
}

const samePath = (a, b) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
};

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

/** The facts the stored response gives: http, redirect (chain followed), the path. */
export async function storedFacts(dir, url, origin) {
  const rel = cacheRelativePath(url);
  const sidecar = await readJson(path.join(dir, `${rel}.json`));
  if (!sidecar) return { sidecar: null, http: null, redirect: null, path: rel };
  const bytes = await stat(path.join(dir, rel)).then((s) => s.size, () => 0);
  const headers = sidecar.headers ?? {};
  const contentType = (headers['content-type'] ?? '').split(';')[0].trim() || null;
  const http = { status: sidecar.status, contentType, bytes };
  let redirect = null;
  if (sidecar.status >= 300 && sidecar.status < 400 && headers.location) {
    let next = siteUrl(new URL(headers.location, url).href, origin);
    for (let hop = 0; next && hop < 10; hop += 1) {
      // eslint-disable-next-line no-await-in-loop
      const hopSidecar = await readJson(path.join(dir, `${cacheRelativePath(next)}.json`));
      const loc = hopSidecar?.headers?.location;
      if (!(hopSidecar?.status >= 300 && hopSidecar.status < 400 && loc)) break;
      next = siteUrl(new URL(loc, next).href, origin);
    }
    redirect = { status: sidecar.status, target: next ?? headers.location };
  }
  return { sidecar, http, redirect, path: rel };
}

const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim()) ?? '';

/**
 * The stored facts of a URL — or, when the site only redirected it to the same path with
 * or without a trailing slash, of the page it landed on: that is the page, not a redirect.
 */
export async function landedFacts(dir, url, origin) {
  const stored = await storedFacts(dir, url, origin);
  const target = stored.redirect?.target;
  if (!target || !samePath(target, url)) return stored;
  const landed = await storedFacts(dir, target, origin);
  if (!landed.sidecar) return stored;
  return { ...landed, redirect: null };
}

/**
 * Caches one selection: visits every page of it not yet cached (all with `force`) online
 * through the proxy, then verifies offline and records each on the table. `io` is the
 * browser and proxy, injectable: `startProxy({ offline })`, `browser`, `sleep`.
 */
export async function cacheSelection(cwd, name, { io, force = false, pace } = {}) {
  const { pages, selections } = await data(cwd);
  const sel = await selections.read(cwd, name);
  if (!sel) throw new Error(`no selection ${name}`);
  const table = await pages.read(cwd);
  const byId = new Map(table.pages.map((p) => [p.id, p]));
  const targets = sel.pages.map((id) => byId.get(id)).filter(Boolean)
    .filter((p) => force || !p.cache);
  return visit(cwd, { name, targets, input: { selection: name, force }, io, pace });
}

/**
 * Fills the cache for the pages already in it: one more online pass, so what is missing —
 * the assets on origins named since (`source.assetOrigins`), a page stored under another
 * key — is stored. What is there is served from the cache; only what is missing is fetched.
 */
export async function fill(cwd, { io, pace } = {}) {
  const { migration, pages } = await data(cwd);
  const m = await migration.open(cwd);
  const targets = (await pages.read(cwd)).pages.filter((p) => p.cache);
  return visit(cwd, { name: 'fill', targets, input: { fill: true,
    assetOrigins: m.source.assetOrigins ?? [] }, io, pace });
}

async function visit(cwd, { name, targets, input, io, pace }) {
  const { migration, runs, website, notes } = await data(cwd);
  const m = await migration.open(cwd);
  const access = await website.readAccess(cwd);
  if (!access) throw new Error('no website/access.json; run the access step first');
  const run = await runs.start(cwd, 'cache', { ...input, pace: pace ?? m.settings.pace },
    { pid: process.pid });
  await runs.update(cwd, run.id, { state: 'running', total: targets.length });
  const origin = new URL(m.source.origin).origin;
  const dir = cacheDir(cwd);
  const finals = new Map();
  const failures = new Map();
  let visited = 0;
  let streak = 0;
  const online = await io.startProxy({ offline: false });
  try {
    const config = await writeBrowserConfig(cwd, 'cache', access, online.port);
    let opened = false;
    for (const page of targets) {
      // eslint-disable-next-line no-await-in-loop
      await runs.update(cwd, run.id, { current: page.id });
      const url = viaProxy(page.url, origin, online.port);
      const binary = BINARY_EXT.test(new URL(page.url).pathname);
      try {
        if (!opened) {
          // eslint-disable-next-line no-await-in-loop
          await io.browser.open(url, { config, persistent: access.browser.persistent === true });
          opened = true;
        } else {
          // eslint-disable-next-line no-await-in-loop
          await io.browser.goto(url);
        }
        if (!binary) {
          // eslint-disable-next-line no-await-in-loop
          const landed = parseEval(await io.browser.eval(pageExpression(access)));
          if (typeof landed === 'string') finals.set(page.id, siteUrl(landed, origin));
        }
        streak = 0;
      } catch (err) {
        failures.set(page.id, firstLine(err.message));
        streak += 1;
        // A browser that is gone (crashed, closed) is opened again for the next page.
        if (/not open|closed|Target page, context or browser/i.test(err.message)) opened = false;
        // eslint-disable-next-line no-await-in-loop
        await runs.update(cwd, run.id, { fail: { id: page.id, error: firstLine(err.message) } });
        if (streak >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error(`${streak} navigations failed in a row — the browser or the proxy`
            + ' is gone');
        }
      }
      visited += 1;
      // eslint-disable-next-line no-await-in-loop
      await runs.update(cwd, run.id, { done: visited, current: null });
      // eslint-disable-next-line no-await-in-loop
      await io.sleep(pace ?? m.settings.pace);
    }
  } catch (err) {
    await io.browser.close().catch(() => {});
    await online.stop();
    const asked = targets.slice(0, visited).filter((p) => !failures.has(p.id));
    await record(cwd, { targets: asked, finals, dir, origin, name, io });
    await runs.finish(cwd, run.id, { state: 'failed', error: firstLine(err.message),
      summary: `${visited} of ${targets.length} visited before the failure; recorded` });
    throw err;
  }
  await io.browser.close().catch(() => {});
  await online.stop();
  // A page whose navigation failed was never asked of the site: no fact, no verdict; it
  // stays uncached and the next run visits it.
  const asked = targets.filter((p) => !failures.has(p.id));
  const kinds = await record(cwd, { targets: asked, finals, dir, origin, name, io });
  const counts = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
  const summary = `${targets.length} URLs of ${name} visited (${counts}); `
    + `${failures.size} navigation failure(s).`;
  const assets = await assetOriginsInCache(cwd);
  await notes.add(cwd, { step: 'cache', author: 'runner', summary: `cached ${name}`,
    body: `# Cache ${name}\n\n${summary}\n\n${assetsInWords(assets, m.source)}\n` });
  await runs.finish(cwd, run.id, { state: 'done', summary });
  return { run: run.id, visited: targets.length, kinds, failures: [...failures.entries()],
    assets };
}

const HTML_URL = /\b(?:src|srcset|href|poster|data-src|data-srcset)=["']?(https?:\/\/[^/"'\s>]+)/g;
const SCRIPT_TAG = /<script\b[^>]*\bsrc=["']?(https?:\/\/[^/"'\s>]+)/g;

/**
 * The other origins the cached pages reference, from their HTML: how many references each
 * carries, scripts counted apart (analytics and tag managers lose nothing offline; an
 * image CDN loses every picture). What `migration.mjs assets` decides on.
 */
export async function assetOriginsInCache(cwd) {
  const { migration } = await data(cwd);
  const m = await migration.open(cwd);
  const origin = new URL(m.source.origin).origin;
  const root = path.join(cacheDir(cwd), cacheRelativePath(origin).split('/')[0]);
  const counts = new Map();
  const bump = (o, kind) => {
    const c = counts.get(o) ?? { assets: 0, scripts: 0 };
    c[kind] += 1;
    counts.set(o, c);
  };
  for (const file of await htmlFiles(root)) {
    // eslint-disable-next-line no-await-in-loop
    const text = await readFile(file, 'utf8').catch(() => '');
    const scripts = [...text.matchAll(SCRIPT_TAG)].map(([, o]) => o).filter((o) => o !== origin);
    for (const o of scripts) bump(o, 'scripts');
    const refs = [...text.matchAll(HTML_URL)].map(([, o]) => o).filter((o) => o !== origin);
    for (const o of refs) bump(o, 'assets');
    for (const o of scripts) counts.get(o).assets -= 1;
  }
  return [...counts].map(([o, c]) => ({ origin: o, ...c }))
    .sort((a, b) => b.assets - a.assets || b.scripts - a.scripts);
}

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    // eslint-disable-next-line no-await-in-loop
    if (entry.isDirectory()) out.push(...await htmlFiles(file));
    else if (entry.name.endsWith('.html')) out.push(file);
  }
  return out;
}

/** The asset origins as words for the note: named ones, and the ones worth naming. */
export function assetsInWords(assets, source) {
  const named = new Set(source.assetOrigins ?? []);
  const lines = ['## Assets from other origins', ''];
  if (!assets.length) return `${lines.join('\n')}None referenced.`;
  lines.push('| origin | references | scripts | stored |', '|---|---|---|---|',
    ...assets.slice(0, 12).map((a) => (
      `| ${a.origin} | ${a.assets} | ${a.scripts} | ${named.has(a.origin) ? 'yes' : 'no'} |`)), '');
  const missing = assets.filter((a) => a.assets >= 10 && !named.has(a.origin));
  if (missing.length) {
    lines.push(`Not stored: ${missing.map((a) => a.origin).join(', ')}. An origin that serves`
      + ' images or fonts leaves them out of every offline render: name it with'
      + ' `migration.mjs assets <origin>...`, then `pipeline cache fill`. Analytics and tag'
      + ' managers lose nothing.');
  }
  return lines.join('\n');
}

/** Verifies offline and records every visited page on the table; kinds counted. */
async function record(cwd, { targets, finals, dir, origin, name, io }) {
  const { pages, website } = await data(cwd);
  const offline = await io.startProxy({ offline: true });
  const kinds = {};
  try {
    const at = new Date().toISOString();
    const entries = [];
    for (const page of targets) {
      const url = viaProxy(page.url, origin, offline.port);
      // eslint-disable-next-line no-await-in-loop
      const res = await io.fetch(url).catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      if (res) await res.arrayBuffer().catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      const stored = await landedFacts(dir, page.url, origin);
      const finalUrl = finals.get(page.id) ?? null;
      const kind = classify({ url: page.url, sidecar: stored.sidecar, finalUrl });
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      entries.push({
        url: page.url, http: stored.http, redirect: stored.redirect, finalUrl, kind,
        cache: stored.sidecar && res ? { at, path: stored.path, selection: name } : null,
      });
    }
    if (entries.length) {
      await pages.upsert(cwd, entries);
      await website.refresh(cwd);
    }
  } finally {
    await offline.stop();
  }
  return kinds;
}

/** The selections approved and not fully cached, in approval order. */
export async function pendingSelections(cwd) {
  const { migration, pages, selections } = await data(cwd);
  const m = await migration.open(cwd);
  const approved = Array.isArray(m.approvals.cache) ? m.approvals.cache : [];
  const table = await pages.read(cwd);
  const cached = new Set(table.pages.filter((p) => p.cache).map((p) => p.id));
  const out = [];
  for (const name of approved) {
    // eslint-disable-next-line no-await-in-loop
    const sel = await selections.read(cwd, name);
    if (!sel) throw new Error(`approved selection ${name} does not exist`);
    if (sel.pages.some((id) => !cached.has(id))) out.push(name);
  }
  return out;
}

/** Done when every page of every approved selection is cached and no cache run is open. */
export async function check(cwd) {
  const { migration, runs } = await data(cwd);
  const m = await migration.open(cwd);
  const approved = Array.isArray(m.approvals.cache) ? m.approvals.cache : [];
  if (!approved.length) return { pass: false, note: 'no selection approved for the cache' };
  const newest = await runs.newest(cwd, 'cache');
  if (newest && ['queued', 'running'].includes(runs.liveness(newest))) {
    return { pass: false, note: `caching ${newest.input.selection ?? 'the assets (fill)'}` };
  }
  const pending = await pendingSelections(cwd);
  if (pending.length) return { pass: false, note: `not yet cached: ${pending.join(', ')}` };
  return { pass: true };
}

/** The real io: the proxy from setup, playwright-cli in this project's session. */
export async function realIo(cwd) {
  const { proxyScript, cli } = await tools(cwd);
  const { migration } = await data(cwd);
  const also = (await migration.open(cwd)).source.assetOrigins ?? [];
  const work = path.join(cwd, 'migration', '.work');
  return {
    ...defaultIo,
    startProxy: proxyStarter(proxyScript, cacheDir(cwd), defaultIo, { also }),
    browser: playwright(cli, { io: defaultIo, cwd: work, session: sessionName(cwd, 'cache') }),
  };
}

/** What `cache [fill]` has to do: the pending selections, or the cached pages to fill. */
export async function pending(cwd, mode) {
  if (mode === undefined) return pendingSelections(cwd);
  if (mode !== 'fill') throw new Error(`cache knows no mode ${mode}; fill, status or stop`);
  const { pages } = await data(cwd);
  return (await pages.read(cwd)).pages.filter((p) => p.cache).map((p) => p.id);
}

/** The worker: caches every pending selection in turn, or fills, then exits. */
export async function workerMain(cwd, mode) {
  const io = await realIo(cwd);
  if (mode === 'fill') {
    await fill(cwd, { io });
    return;
  }
  for (const name of await pendingSelections(cwd)) {
    // eslint-disable-next-line no-await-in-loop
    await cacheSelection(cwd, name, { io });
  }
}

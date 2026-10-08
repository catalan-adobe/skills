// cache: the approved selections' pages fetched once, through the page-cache proxy, in one
// browser session with the access recipe applied — then verified offline and recorded on
// the page table (http, redirect, final URL, kind, cache), the verdicts following. One run
// per selection, heartbeating; a detached worker so the caller returns at once.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
export function pageExpression(access) {
  const css = [
    ...access.overlays.filter((o) => o.action === 'hide').flatMap((o) => o.css ?? []),
    ...(access.scrollFix ? [access.scrollFix] : []),
  ].join('\n');
  return '(async () => { const s = document.createElement(\'style\');'
    + ` s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s);`
    + ` const step = Math.max(200, window.innerHeight * ${SCROLL_STEP_SHARE});`
    + ' for (let y = 0; y < document.body.scrollHeight; y += step) {'
    + ' window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }'
    + ' window.scrollTo(0, document.body.scrollHeight);'
    + ' document.querySelectorAll(\'img[loading="lazy"]\')'
    + '.forEach((i) => { i.loading = "eager"; });'
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
  else if (!path.extname(seg)) seg += '/index.html';
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
 * Caches one selection: visits every page of it not yet cached (all with `force`) online
 * through the proxy, then verifies offline and records each on the table. `io` is the
 * browser and proxy, injectable: `startProxy({ offline })`, `browser`, `sleep`.
 */
export async function cacheSelection(cwd, name, { io, force = false, pace } = {}) {
  const { migration, pages, selections, runs, website, notes } = await data(cwd);
  const m = await migration.open(cwd);
  const sel = await selections.read(cwd, name);
  if (!sel) throw new Error(`no selection ${name}`);
  const access = await website.readAccess(cwd);
  if (!access) throw new Error('no website/access.json; run the access step first');
  const table = await pages.read(cwd);
  const byId = new Map(table.pages.map((p) => [p.id, p]));
  const targets = sel.pages.map((id) => byId.get(id)).filter(Boolean)
    .filter((p) => force || !p.cache);
  const run = await runs.start(cwd, 'cache', { selection: name, pace: pace ?? m.settings.pace,
    force }, { pid: process.pid });
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
    await record(cwd, { targets: targets.slice(0, visited), finals, dir, origin, name, io });
    await runs.finish(cwd, run.id, { state: 'failed', error: firstLine(err.message),
      summary: `${visited} of ${targets.length} visited before the failure; recorded` });
    throw err;
  }
  await io.browser.close().catch(() => {});
  await online.stop();
  const kinds = await record(cwd, { targets, finals, dir, origin, name, io });
  const counts = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
  const summary = `${targets.length} URLs of ${name} visited (${counts}); `
    + `${failures.size} navigation failure(s).`;
  await notes.add(cwd, { step: 'cache', author: 'runner', summary: `cached ${name}`,
    body: `# Cache ${name}\n\n${summary}\n` });
  await runs.finish(cwd, run.id, { state: 'done', summary });
  return { run: run.id, visited: targets.length, kinds, failures: [...failures.entries()] };
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
      const stored = await storedFacts(dir, page.url, origin);
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
    return { pass: false, note: `caching ${newest.input.selection}` };
  }
  const pending = await pendingSelections(cwd);
  if (pending.length) return { pass: false, note: `not yet cached: ${pending.join(', ')}` };
  return { pass: true };
}

/** The real io: the proxy from setup, playwright-cli in this project's session. */
export async function realIo(cwd) {
  const { proxyScript, cli } = await tools(cwd);
  const work = path.join(cwd, 'migration', '.work');
  return {
    ...defaultIo,
    startProxy: proxyStarter(proxyScript, cacheDir(cwd), defaultIo),
    browser: playwright(cli, { io: defaultIo, cwd: work, session: sessionName(cwd, 'cache') }),
  };
}

/** The worker: caches every pending selection in turn, then exits. */
export async function workerMain(cwd) {
  const io = await realIo(cwd);
  for (const name of await pendingSelections(cwd)) {
    // eslint-disable-next-line no-await-in-loop
    await cacheSelection(cwd, name, { io });
  }
}

export const WORKER_SCRIPT = fileURLToPath(new URL('../pipeline.mjs', import.meta.url));

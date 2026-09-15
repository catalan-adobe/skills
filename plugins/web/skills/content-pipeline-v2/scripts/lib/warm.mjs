import {
  mkdir, readFile, readdir, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { cacheRelativePath, resolveSelection } from './checks.mjs';
import { readInventory, recordVisits, writeInventory } from './inventory.mjs';
import { readProject, upsertSection } from './project.mjs';
import { refreshUrlsMd } from './urls.mjs';

const ASSET = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm)$/i;
const BINARY_EXT = new RegExp(
  '\\.(pdf|zip|docx?|xlsx?|pptx?|csv|xml|txt|json|png|jpe?g|gif|webp|svg|mp4|mp3)$', 'i',
);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
/** This many navigations failing in a row means the browser or the proxy is gone. */
export const MAX_CONSECUTIVE_FAILURES = 5;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** One expression for `playwright-cli eval`: hide the overlays, fix the scroll, scroll down. */
export function pageExpression(recipe) {
  const css = [
    ...(recipe.overlays ?? []).flatMap((o) => o.hide?.css ?? []),
    ...(recipe.scroll_fix ? [recipe.scroll_fix] : []),
  ].join('\n');
  return '(() => { const s = document.createElement(\'style\');'
    + ` s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s);`
    + ' window.scrollTo(0, document.body.scrollHeight); return "ok"; })()';
}

/**
 * A browser address back as a site URL: the proxy prefix and its `_origin` parameter
 * removed, the fragment dropped; another host is kept as is; `null` when unparsable.
 *
 * @param {string} href
 * @param {string} origin The site origin the proxy fronts.
 * @returns {string|null}
 */
export function siteUrl(href, origin) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const viaProxy = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (viaProxy) u.searchParams.delete('_origin');
  const base = viaProxy ? origin : u.origin;
  return `${base}${u.pathname}${u.search}`;
}

/**
 * What a URL is, from the proxy's stored response and where the browser landed.
 *
 * @param {{url: string, sidecar: {status: number, headers: object}|null,
 *   finalUrl: string|null}} facts
 * @returns {{kind: 'page'|'binary'|'redirect'|'error'|'unreachable',
 *   migrate: 'yes'|'asset'|'target'|'no'}}
 */
export function classify({ url, sidecar, finalUrl }) {
  if (!sidecar || typeof sidecar.status !== 'number') return { kind: 'unreachable', migrate: 'no' };
  const { status } = sidecar;
  if (status >= 300 && status < 400) return { kind: 'redirect', migrate: 'target' };
  if (status >= 400) return { kind: 'error', migrate: 'no' };
  const type = (sidecar.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type && !/html|xhtml/.test(type)) return { kind: 'binary', migrate: 'asset' };
  const noFragment = (u) => String(u).split('#')[0];
  if (finalUrl && noFragment(finalUrl) !== noFragment(url)) {
    return { kind: 'redirect', migrate: 'target' };
  }
  return { kind: 'page', migrate: 'yes' };
}

const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
const failedUrls = (rows) => rows.filter((r) => r.status === 'failed').map((r) => r.url).join(', ');

async function countAssets(dir) {
  let n = 0;
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else if (ASSET.test(e.name)) n += 1;
    }
  }
  await walk(dir);
  return n;
}

/** The stored response of `url`: its sidecar, body size, and the redirect chain it starts. */
async function storedFacts(cacheDir, url, origin, inList) {
  const rel = cacheRelativePath(url);
  const sidecar = await readJson(path.join(cacheDir, `${rel}.json`), null);
  if (!sidecar) return { sidecar: null, http: null, redirect: null, path: rel };
  const bytes = await stat(path.join(cacheDir, rel)).then((s) => s.size, () => 0);
  const headers = sidecar.headers ?? {};
  const http = {
    status: sidecar.status,
    contentType: (headers['content-type'] ?? '').split(';')[0].trim() || null,
    bytes,
    lastModified: headers['last-modified'] ?? null,
    etag: headers.etag ?? null,
  };
  let redirect = null;
  if (sidecar.status >= 300 && sidecar.status < 400 && headers.location) {
    const chain = [];
    let next = siteUrl(new URL(headers.location, url).href, origin);
    for (let hop = 0; next && hop < 10; hop += 1) {
      const hopFile = path.join(cacheDir, `${cacheRelativePath(next)}.json`);
      const hopSidecar = await readJson(hopFile, null);
      const loc = hopSidecar?.headers?.location;
      if (!(hopSidecar?.status >= 300 && hopSidecar.status < 400 && loc)) break;
      chain.push(next);
      next = siteUrl(new URL(loc, next).href, origin);
    }
    redirect = {
      status: sidecar.status, target: next, chain, targetInList: next ? inList.has(next) : false,
    };
  }
  return {
    sidecar, http, redirect, path: rel,
  };
}

function renderCacheMd({
  selection, rows, port, pace, status, assets,
}) {
  const counts = ['cached', 'unverified', 'failed', 'skipped']
    .map((s) => `${rows.filter((r) => r.status === s).length} ${s}`).join(', ');
  const selections = [...new Set(rows.map((r) => r.selection).filter(Boolean))];
  return [
    '# cache', '',
    `Last selection: ${selection}. Visited so far: ${rows.length} URLs over `
      + `${selections.length || 1} selection(s) (${selections.join('; ') || selection}). `
      + `${counts}; ${assets} asset file(s) stored.`, '',
    '| url | status | kind | ms | selection | note |', '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.url} | ${r.status} | ${r.kind} | ${r.ms} | ${r.selection} | `
      + `${r.note ?? ''} |`), '',
    `Proxy \`/__status\` after the offline check: \`${JSON.stringify(status)}\`.`, '',
    `Settings: port ${port}, one browser session, ${pace} ms between pages, hide rules and `
      + 'scroll on every page; kind and note from the stored responses and where the browser '
      + 'landed; ms = time in the browser until the hide rules applied.', '',
  ].join('\n');
}

/**
 * The value of a browser eval. The CLI prints the value JSON-encoded, and our expressions
 * return JSON strings themselves, so a string result that parses again is unwrapped once more.
 */
export function parseEval(raw) {
  const text = String(raw ?? '').trim();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text || null;
  }
  if (typeof value === 'string') {
    try {
      const inner = JSON.parse(value);
      if (typeof inner === 'string' || (inner && typeof inner === 'object')) return inner;
    } catch { /* a plain string */ }
  }
  return value;
}

/**
 * The cache step in one process: start the proxy, drive the browser through it over the
 * approved selection, restart the proxy offline, verify every URL from the cache, classify
 * each URL from its stored response and where the browser landed, record it in the
 * inventory, write `cache/cache.md` and the `## cache` report section.
 *
 * @param {import('./project.mjs').Project} project
 * @param {object} io Every external call, injectable: `startProxy({ offline })` →
 *   `{ port, stop }`; `browser` with `open(url, { config, persistent })`, `goto`, `eval`
 *   (returns the evaluated value as text), `close`; `pace` in ms between pages (default
 *   1500); `fetchImpl` (default `fetch`); `now` (default the clock).
 * @param {object} [job] A queued job: `{ selection, urls }` replaces the approved selection;
 *   `onProgress({ done, failed, current })` is called around every URL; `shouldStop()` ends
 *   the visits early (the URLs visited so far are still verified and recorded).
 * @returns {Promise<{cached: number, failed: number, skipped: number, assets: number,
 *   kinds: Record<string, number>, pass: boolean, file: string}>}
 */
export async function warm(project, io, job = {}) {
  const { selection, urls } = job.urls ? job : await approvedJob(project);
  if (!urls.length) throw new Error(`the selection ${selection} resolves to no URLs`);
  const {
    startProxy, browser, pace = 1500, fetchImpl = fetch, now = () => new Date().toISOString(),
  } = io;
  const recipe = await readJson(path.join(project.step('prep'), 'page-prep.json'), {
    overlays: [],
  });
  const probe = await readJson(path.join(project.step('probe'), 'browser-recipe.json'), {});
  const urlsDir = project.step('urls');
  const run = {
    project,
    selection,
    urls,
    browser,
    pace,
    fetchImpl,
    now,
    onProgress: job.onProgress ?? (() => {}),
    shouldStop: job.shouldStop ?? (() => false),
    config: path.join(project.step('probe'), 'playwright-config.json'),
    persistent: probe.persistent === true,
    cacheDir: path.join(project.step('cache'), '.page-cache'),
    origin: new URL(urls[0]).origin,
    expression: pageExpression(recipe),
    inList: new Set((await readInventory(urlsDir)).map((r) => r.url)),
    timings: new Map(),
    finals: new Map(),
    navFailed: new Map(),
    visited: [],
    // Our records, re-applied onto a fresh read at every write: another command (a re-scan
    // merge) may write urls.json while a job runs, and must not be clobbered.
    recorded: new Map(),
    persist: async () => {
      const inventory = recordVisits(await readInventory(urlsDir), run.recorded);
      await writeInventory(urlsDir, inventory);
      return inventory;
    },
  };
  const online = await startProxy({ offline: false });
  run.port = online.port;
  const loopError = await visitAll(run).finally(async () => {
    await browser.close().catch(() => {});
    await online.stop();
  });
  const offline = await startProxy({ offline: true });
  run.port = offline.port;
  const { rows, status } = await verifyVisited(run).finally(() => offline.stop());
  const inventory = await run.persist();
  const outcome = await writeOutcome(run, { rows, status, inventory, port: online.port });
  if (loopError) {
    throw new Error(`${firstLine(loopError.message)} — after ${run.visited.length} of `
      + `${urls.length} URLs; what was visited is recorded, a rerun resumes the rest`);
  }
  return outcome;
}

/** The proxy URL that fetches `url` from the origin (or serves it, offline). */
const via = (run, url) => {
  const u = new URL(url);
  return `http://127.0.0.1:${run.port}${u.pathname}${u.search}`
    + `${u.search ? '&' : '?'}_origin=${encodeURIComponent(run.origin)}`;
};

/** The record of `url` from what is stored so far; `verified` once served offline. */
async function factsFor(run, url, { res = null, verified }) {
  const {
    cacheDir, origin, inList, finals, timings, navFailed, selection, now,
  } = run;
  const stored = await storedFacts(cacheDir, url, origin, inList);
  const finalUrl = finals.get(url) ?? null;
  const { kind, migrate } = classify({ url, sidecar: stored.sidecar, finalUrl });
  const ms = timings.get(url) ?? 0;
  const note = navFailed.has(url) ? `navigation failed: ${firstLine(navFailed.get(url))}`
    : kind === 'redirect' && stored.redirect
      ? `${stored.redirect.status} → ${stored.redirect.target ?? '?'}`
      : kind === 'redirect' ? `landed on ${finalUrl}`
        : kind === 'error' ? `${stored.http.status}`
          : kind === 'unreachable' ? (res ? `${res.status}` : 'no response') : '';
  const cachedNow = verified ? Boolean(stored.sidecar && res) : Boolean(stored.sidecar);
  return {
    row: {
      url, status: cachedNow ? 'cached' : 'failed', kind, ms, note,
    },
    facts: {
      http: stored.http,
      redirect: stored.redirect,
      finalUrl,
      kind,
      migrate,
      cache: {
        at: now(),
        selection,
        path: stored.sidecar ? stored.path : null,
        durationMs: ms,
        verified: verified && !navFailed.has(url),
        ...(navFailed.has(url) ? { note } : {}),
      },
    },
  };
}

/** One navigation: open the session on the first URL, then goto; binaries via fetch. */
async function navigate(run, url) {
  const { browser, expression } = run;
  const binary = BINARY_EXT.test(new URL(url).pathname);
  if (!run.opened) {
    await browser.open(via(run, binary ? run.urls[0] : url), {
      config: run.config, persistent: run.persistent,
    });
    run.opened = true;
    if (binary) await fetchFromPage(browser, via(run, url));
    else await browser.eval(expression).catch(() => {});
  } else if (binary) {
    await fetchFromPage(browser, via(run, url));
  } else {
    await browser.goto(via(run, url));
    await browser.eval(expression).catch(() => {});
  }
}

/**
 * Visits every URL through the online proxy, recording each one provisionally as it goes.
 * A navigation that fails marks its URL and the loop goes on; too many in a row, or anything
 * else going wrong, ends the visits — the error is returned so the caller records what was
 * visited before rethrowing it.
 */
async function visitAll(run) {
  const {
    urls, browser, pace, onProgress, shouldStop, timings, finals, navFailed, visited, recorded,
  } = run;
  let streak = 0;
  try {
    for (const url of urls) {
      if (shouldStop()) break;
      await onProgress({ current: url });
      visited.push(url);
      const started = Date.now();
      const binary = BINARY_EXT.test(new URL(url).pathname);
      const navigated = await navigate(run, url)
        .then(() => true, (err) => { navFailed.set(url, err.message); return false; });
      streak = navigated ? 0 : streak + 1;
      if (streak >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`${streak} navigations failed in a row (last: `
          + `${firstLine(navFailed.get(url))}) — the browser or the proxy is gone`);
      }
      timings.set(url, Date.now() - started);
      await sleep(pace);
      if (navigated && !binary) {
        const raw = await browser.eval('JSON.stringify(location.href)').catch(() => null);
        const landed = parseEval(raw);
        finals.set(url, typeof landed === 'string' ? siteUrl(landed, run.origin) : null);
        await browser.eval('window.scrollTo(0, 0)').catch(() => {});
      }
      // Recorded now, provisionally, so progress is visible per URL; verified after the loop.
      recorded.set(url, (await factsFor(run, url, { verified: false })).facts);
      await run.persist();
      await onProgress({ done: visited.length, current: null });
    }
    return null;
  } catch (err) {
    return err;
  }
}

/** Requests every visited URL from the offline proxy and records the verified facts. */
async function verifyVisited(run) {
  const rows = [];
  for (const url of run.visited) {
    const res = await run.fetchImpl(via(run, url)).catch(() => null);
    if (res) await res.arrayBuffer().catch(() => {});
    const { row, facts } = await factsFor(run, url, { res, verified: true });
    rows.push(row);
    run.recorded.set(url, facts);
  }
  const status = await run.fetchImpl(`http://127.0.0.1:${run.port}/__status`)
    .then((r) => r.json()).catch(() => null);
  return { rows, status };
}

/** cache.md, the report section, and the result of the run. */
async function writeOutcome(run, {
  rows, status, inventory, port,
}) {
  const {
    project, selection, urls, visited, pace, cacheDir, onProgress,
  } = run;
  const assets = await countAssets(cacheDir);
  const cached = rows.filter((r) => r.status === 'cached').length;
  const failed = rows.length - cached;
  await onProgress({ failed });
  const kinds = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const all = inventory.filter((r) => r.cache).map(rowOf);
  const file = path.join(project.step('cache'), 'cache.md');
  await mkdir(project.step('cache'), { recursive: true });
  await writeFile(file, renderCacheMd({
    selection, rows: all, port, pace, status, assets,
  }));
  const kindText = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
  const allCached = all.filter((r) => r.status === 'cached').length;
  const body = `Selection ${selection}: ${cached} cached, ${failed} failed, `
    + `${urls.length - visited.length} skipped; ${kindText || 'nothing visited'}. `
    + `In total ${allCached} of ${all.length} visited URLs cached; ${assets} asset file(s) `
    + `stored through the proxy (port ${port}, ${pace} ms pace). Each visited URL's `
    + 'record in urls/urls.json carries http, redirect, finalUrl, kind, migrate and cache. '
    + (failed ? `Failed: ${failedUrls(rows)}. ` : '')
    + 'Serve offline with the page-cache proxy `--offline` on the same cache directory.';
  await upsertSection(project, 'cache', body);
  const { cacheAllUpTo = 500 } = (await readProject(project)) ?? {};
  await refreshUrlsMd(project.step('urls'), { cacheAllUpTo }).catch(() => {});
  return {
    cached,
    failed,
    skipped: urls.length - visited.length,
    assets,
    kinds,
    pass: failed === 0 && assets > 0,
    file,
  };
}

/** The approved selection from project.json, as a job `{ selection, urls }`. */
export async function approvedJob(project) {
  const { urls, reasons } = await resolveSelection(project);
  if (reasons.length) throw new Error(reasons.join('; '));
  if (!urls.length) throw new Error('the cache selection resolves to no URLs');
  const picked = (await readJson(project.projectFile, {})).cacheSelection;
  return { selection: picked === 'all' ? 'all' : (picked ?? []).join(', '), urls };
}

/**
 * The URLs still to visit: those without a stored, verified body, whichever selection stored
 * it. A rerun after an interruption or a stop resumes where it left off (a record left
 * unverified by a killed job is visited again, from disk); overlapping selections do not
 * visit a page twice.
 */
export function pendingUrls(inventory, urls) {
  const stored = new Set(inventory
    .filter((r) => r.cache?.path && r.cache.verified !== false).map((r) => r.url));
  return urls.filter((u) => !stored.has(u));
}

/** A cache.md row from an inventory record that was visited. */
function rowOf(r) {
  const note = r.cache?.note ? r.cache.note
    : r.kind === 'redirect' && r.redirect
    ? `${r.redirect.status} → ${r.redirect.target ?? '?'}`
      : r.kind === 'redirect' ? `landed on ${r.finalUrl}`
        : r.kind === 'error' ? `${r.http?.status ?? ''}`
          : r.kind === 'unreachable' ? 'no response' : '';
  return {
    url: r.url,
    status: !r.cache?.path ? 'failed' : r.cache.verified === false ? 'unverified' : 'cached',
    kind: r.kind,
    ms: r.cache?.durationMs ?? 0,
    note,
    selection: r.cache?.selection ?? '',
    at: r.cache?.at ?? '',
  };
}

/** Fetches a binary through the proxy from the open page: cached, no download prompt. */
async function fetchFromPage(browser, proxyUrl) {
  const expr = `fetch(${JSON.stringify(proxyUrl)}).then(async (r) => { await r.arrayBuffer(); `
    + 'return JSON.stringify({ status: r.status, contentType: r.headers.get("content-type") }); })';
  return parseEval(await browser.eval(expr).catch(() => null));
}

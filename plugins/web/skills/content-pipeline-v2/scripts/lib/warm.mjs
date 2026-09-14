import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheRelativePath, resolveSelection } from './checks.mjs';
import { upsertSection } from './project.mjs';

const ASSET = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm)$/i;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

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

function renderCacheMd({
  selection, rows, port, pace, status, assets,
}) {
  const counts = ['cached', 'failed', 'skipped']
    .map((s) => `${rows.filter((r) => r.status === s).length} ${s}`).join(', ');
  return [
    '# cache', '',
    `Selection: ${selection} (${rows.length} URLs). ${counts}; ${assets} asset file(s) stored.`, '',
    '| url | status | note |', '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.url} | ${r.status} | ${r.note ?? ''} |`), '',
    `Proxy \`/__status\` after the offline check: \`${JSON.stringify(status)}\`.`, '',
    `Settings: port ${port}, one browser session, ${pace} ms between pages, hide rules and `
      + 'scroll on every page, statuses from the offline replay.', '',
  ].join('\n');
}

/**
 * The cache step in one process: start the proxy, drive the browser through it over the
 * approved selection, restart the proxy offline, verify every URL from the cache, write
 * `cache/cache.md` and the `## cache` report section.
 *
 * @param {import('./project.mjs').Project} project
 * @param {object} io Every external call, injectable: `startProxy({ offline })` →
 *   `{ port, stop }`; `browser` with `open(url, { config, persistent })`, `goto`, `eval`,
 *   `close`; `pace` in ms between pages (default 1500); `fetchImpl` (default `fetch`).
 * @returns {Promise<{cached: number, failed: number, skipped: number, assets: number,
 *   pass: boolean, file: string}>}
 */
export async function warm(project, io) {
  const { urls, reasons } = await resolveSelection(project);
  if (reasons.length) throw new Error(reasons.join('; '));
  if (!urls.length) throw new Error('the cache selection resolves to no URLs');
  const data = await readJson(project.projectFile, {});
  const picked = data.cacheSelection;
  const selection = picked === 'all' ? 'all' : (picked ?? []).join(', ');
  const { startProxy, browser, pace = 1500, fetchImpl = fetch } = io;
  const prepFile = path.join(project.step('prep'), 'page-prep.json');
  const recipe = await readJson(prepFile, { overlays: [] });
  const probe = await readJson(path.join(project.step('probe'), 'browser-recipe.json'), {});
  const config = path.join(project.step('probe'), 'playwright-config.json');
  const cacheDir = path.join(project.step('cache'), '.page-cache');
  const origin = new URL(urls[0]).origin;
  const expression = pageExpression(recipe);

  const online = await startProxy({ offline: false });
  const via = (url) => {
    const u = new URL(url);
    return `http://127.0.0.1:${online.port}${u.pathname}${u.search}`
      + `${u.search ? '&' : '?'}_origin=${encodeURIComponent(origin)}`;
  };
  try {
    for (const [i, url] of urls.entries()) {
      if (i === 0) await browser.open(via(url), { config, persistent: probe.persistent === true });
      else await browser.goto(via(url));
      await browser.eval(expression).catch(() => {});
      await sleep(pace);
      await browser.eval('window.scrollTo(0, 0)').catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    await online.stop();
  }

  const offline = await startProxy({ offline: true });
  const rows = [];
  let status = null;
  try {
    for (const url of urls) {
      const u = new URL(url);
      const res = await fetchImpl(`http://127.0.0.1:${offline.port}${u.pathname}${u.search}`
        + `${u.search ? '&' : '?'}_origin=${encodeURIComponent(origin)}`).catch(() => null);
      if (res) await res.arrayBuffer().catch(() => {});
      rows.push(res?.ok
        ? { url, status: 'cached' }
        : { url, status: 'failed', note: res ? `${res.status}` : 'no response' });
    }
    status = await fetchImpl(`http://127.0.0.1:${offline.port}/__status`)
      .then((r) => r.json()).catch(() => null);
  } finally {
    await offline.stop();
  }

  const assets = await countAssets(cacheDir);
  const cached = rows.filter((r) => r.status === 'cached').length;
  const failed = rows.length - cached;
  const file = path.join(project.step('cache'), 'cache.md');
  await writeFile(file, renderCacheMd({
    selection, rows, port: online.port, pace, status, assets,
  }));
  const body = `Selection ${selection}: ${cached} cached, ${failed} failed, 0 skipped; `
    + `${assets} asset file(s) stored through the proxy (port ${online.port}, ${pace} ms pace). `
    + (failed ? `Failed: ${failedUrls(rows)}. ` : '')
    + 'Serve offline with the page-cache proxy `--offline` on the same cache directory.';
  await upsertSection(project, 'cache', body);
  return {
    cached, failed, skipped: 0, assets, pass: failed === 0 && assets > 0, file,
  };
}

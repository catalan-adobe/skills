import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { STEPS } from './steps.mjs';
import { detect, missingReasons } from './setup.mjs';
import { relativeSegments, scopeOf } from './urls.mjs';

/** Parses JSON; with `object: true` it must also be a plain object (not null or an array). */
function safeJson(text, { object = false } = {}) {
  try {
    const data = JSON.parse(text);
    if (object && (typeof data !== 'object' || data === null || Array.isArray(data))) {
      return { error: 'not a JSON object' };
    }
    return { data };
  } catch (err) {
    return { error: err.message };
  }
}

const jsonReason = (rel, error) => (error === 'not a JSON object'
  ? `migration/${rel} is not a JSON object`
  : `migration/${rel} is not valid JSON`);

/**
 * The first path segment of `url` below the scope every URL of `urls/urls.json` shares (the
 * scope root itself counts as its own prefix); the absolute first segment when there is no
 * URL list yet.
 */
function prefixBelowScope(url, files) {
  const list = files['urls/urls.json'] === undefined ? [] : safeJson(files['urls/urls.json']).data;
  const scope = scopeOf(Array.isArray(list) ? list.filter((u) => u?.url) : []);
  return relativeSegments(url, scope)[0] ?? '/';
}

/**
 * Reads `probe/browser-recipe.json` and `probe/probe.md`.
 *
 * @param {Record<string, string>} files Relative path (as in `STEPS[].writes`) → text.
 * @returns {{pass: boolean, reasons: string[]}}
 */
export function checkProbe(files) {
  const reasons = [];
  const recipe = files['probe/browser-recipe.json'];
  if (recipe === undefined) {
    reasons.push('missing migration/probe/browser-recipe.json');
  } else if (safeJson(recipe, { object: true }).error) {
    reasons.push(jsonReason('probe/browser-recipe.json', safeJson(recipe, { object: true }).error));
  }
  const probeMd = files['probe/probe.md'];
  if (probeMd === undefined) {
    reasons.push('missing migration/probe/probe.md');
  } else if (!probeMd.trim()) {
    reasons.push('migration/probe/probe.md is empty');
  } else if (!/main content/i.test(probeMd)) {
    reasons.push('migration/probe/probe.md must say whether the main content is in the initial '
      + 'HTML (the probe report\'s hasMainContent); later steps read that');
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * `page-prep.json`'s content: `checked` URLs and every `overlays[]` entry has a `selector`.
 * Shared by `prep` (>= 1 checked) and `prep-verify` (>= 3 checked, >= 2 path prefixes).
 */
function checkPrepManifest(files, { minChecked, minPrefixes, minShots }, shots) {
  const rel = 'prep/page-prep.json';
  const text = files[rel];
  if (text === undefined) return { pass: false, reasons: [`missing migration/${rel}`] };
  const { data, error } = safeJson(text, { object: true });
  if (error) return { pass: false, reasons: [jsonReason(rel, error)] };
  const reasons = [];
  const checked = Array.isArray(data.checked) ? data.checked : [];
  if (checked.length < minChecked) {
    reasons.push(`migration/${rel} has ${checked.length} checked URL(s), needs >= ${minChecked}`);
  }
  if (minPrefixes > 0) {
    const prefixes = new Set(checked.map((url) => prefixBelowScope(url, files)));
    if (prefixes.size < minPrefixes) {
      reasons.push(
        `migration/${rel} checked URLs cover ${prefixes.size} path prefix(es), `
        + `needs >= ${minPrefixes}`,
      );
    }
  }
  const overlays = Array.isArray(data.overlays) ? data.overlays : [];
  overlays.forEach((overlay, i) => {
    if (!overlay || typeof overlay.selector !== 'string' || !overlay.selector) {
      reasons.push(`migration/${rel} overlay ${i} has no selector`);
    }
  });
  const pngs = shots.filter((f) => /\.png$/i.test(f)).length;
  if (pngs < minShots) {
    reasons.push(pngs === 0
      ? 'no screenshot of a cleaned page under migration/prep/ (a .png is the evidence)'
      : `${pngs} screenshot(s) under migration/prep/, needs >= ${minShots}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * `prep`: `page-prep.json` has >= 1 checked URL, every overlay has a selector, and one
 * screenshot of the cleaned page sits under `prep/`.
 *
 * @param {Record<string, string>} files Text files under `migration/`.
 * @param {string[]} [prepFiles] Paths under `prep/` (`prep/<name>`).
 */
export function checkPrep(files, prepFiles = []) {
  return checkPrepManifest(files, { minChecked: 1, minPrefixes: 0, minShots: 1 }, prepFiles);
}

/** `prep-verify`: `page-prep.json` has >= 3 checked URLs from >= 2 first path segments. */
export function checkPrepVerify(files, prepFiles = []) {
  return checkPrepManifest(files, { minChecked: 3, minPrefixes: 2, minShots: 2 }, prepFiles);
}

/** `scan`: `urls/urls.json` is a non-empty `URLExtended[]`; `urls/urls.md` exists. */
export function checkScan(files) {
  const reasons = [];
  const json = files['urls/urls.json'];
  if (json === undefined) {
    reasons.push('missing migration/urls/urls.json');
  } else {
    const { data, error } = safeJson(json);
    if (error) {
      reasons.push('migration/urls/urls.json is not valid JSON');
    } else if (!Array.isArray(data) || data.length === 0) {
      reasons.push('migration/urls/urls.json has no URLs');
    } else if (!data.every((u) => u && typeof u.url === 'string' && u.url)) {
      reasons.push('migration/urls/urls.json has an entry without a "url"');
    }
  }
  if (files['urls/urls.md'] === undefined) reasons.push('missing migration/urls/urls.md');
  return { pass: reasons.length === 0, reasons };
}

function urlsFromUrlsJson(text, asMap = false) {
  const { data } = text === undefined ? { data: [] } : safeJson(text);
  const records = Array.isArray(data) ? data.filter((u) => u?.url) : [];
  if (asMap) return new Map(records.map((u) => [u.url, u]));
  return records.map((u) => u.url);
}

/** The approved caching selection from `project.json.cacheSelection` ("all" or subset names). */
function approvedSelection(files) {
  const reasons = [];
  const { data: project, error } = files['project.json']
    ? safeJson(files['project.json'], { object: true })
    : { data: {} };
  if (error) return { urls: [], reasons: [jsonReason('project.json', error)] };
  if (project.approved?.cache !== true) {
    reasons.push('cache was not approved; run status.mjs approve cache [<subset>...]');
  }
  const pick = project.cacheSelection ?? 'all';
  if (pick === 'all') {
    const urls = urlsFromUrlsJson(files['urls/urls.json']);
    if (urls.length === 0) reasons.push('migration/urls/urls.json has no URLs to select');
    return { urls, reasons };
  }
  if (Array.isArray(pick)) {
    const urls = new Set();
    for (const name of pick) {
      const rel = `urls/subsets/${name}.txt`;
      const text = files[rel];
      if (text === undefined) {
        reasons.push(`missing migration/${rel}`);
        continue;
      }
      text.split('\n').map((line) => line.trim()).filter(Boolean).forEach((u) => urls.add(u));
    }
    if (urls.size === 0 && reasons.length === 0) {
      reasons.push('migration/project.json.cacheSelection resolves to no URLs');
    }
    return { urls: [...urls], reasons };
  }
  reasons.push('project.json.cacheSelection must be "all" or subset names');
  return { urls: [], reasons };
}

/**
 * Splits a markdown table row into trimmed, non-empty cells; a URL cell wrapped as `<url>`
 * (what a markdown autofix does to bare URLs) counts as the URL.
 */
function tableCells(line) {
  return line.split('|')
    .map((cell) => cell.trim().replace(/^<(https?:\/\/[^>]+)>$/, '$1'))
    .filter((cell) => cell.length > 0);
}

/**
 * Where the page-cache proxy stores the body of `url`, relative to its cache directory:
 * `<host>_<sha256(origin)[0:8]>/<path>`, `index.html` for `/` and extension-less paths, the
 * query string before the extension after `!` (md5 when the path would exceed 200 chars).
 *
 * @param {string} url
 * @returns {string}
 */
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

const ASSET = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm)$/i;

/**
 * `cache`: `cache/cache.md` lists every URL of the approved selection as cached, failed or
 * skipped; every `cached` row has its body in the proxy's cache directory and a `kind` in
 * the inventory (the driver records it); and the cache holds at least one asset — a browser
 * requests CSS, scripts and images through the proxy, a plain HTTP fetch does not.
 *
 * @param {Record<string, string>} files Text files under `migration/`.
 * @param {string[]} [cacheFiles] Paths under `cache/.page-cache/`, relative to it.
 */
export function checkCache(files, cacheFiles = []) {
  const { urls, reasons: selectionReasons } = approvedSelection(files);
  const md = files['cache/cache.md'];
  if (md === undefined) {
    return { pass: false, reasons: ['missing migration/cache/cache.md', ...selectionReasons] };
  }
  const statusPattern = /^(cached|failed|skipped)$/i;
  const rows = md.split('\n').map(tableCells);
  const stored = new Set(cacheFiles);
  const inventory = urlsFromUrlsJson(files['urls/urls.json'], true);
  const kinds = new Set(['page', 'binary', 'redirect', 'error', 'unreachable']);
  let cachedRows = 0;
  const rowReasons = urls.flatMap((url) => {
    const cells = rows.find((row) => row[0] === url);
    if (!cells) return [`migration/cache/cache.md has no row for ${url}`];
    if (!cells[1] || !statusPattern.test(cells[1])) {
      return [`migration/cache/cache.md row for ${url} has no cached|failed|skipped status`];
    }
    if (cells[1].toLowerCase() !== 'cached') return [];
    cachedRows += 1;
    const reasons = [];
    if (!stored.has(cacheRelativePath(url))) reasons.push(`no stored body for ${url} in the cache`);
    if (!kinds.has(inventory.get(url)?.kind)) {
      reasons.push(`urls/urls.json has no kind for ${url}; the cache driver records it`);
    }
    return reasons;
  });
  const assetReasons = cachedRows && !cacheFiles.some((f) => ASSET.test(f))
    ? ['the cache holds pages but no CSS, JS, image or font: warmed without a browser']
    : [];
  const reasons = [...selectionReasons, ...rowReasons, ...assetReasons];
  return { pass: reasons.length === 0, reasons };
}

/** The files directly under `dir`, as `<prefix>/<name>` (empty when the directory is absent). */
async function listDir(dir, prefix) {
  const names = await readdir(dir).catch(() => []);
  return names.map((n) => `${prefix}/${n}`);
}

/** Every file under `cache/.page-cache/`, relative to it (empty when the directory is absent). */
async function listCacheFiles(project) {
  const root = path.join(project.step('cache'), '.page-cache');
  const out = [];
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else out.push(rel);
    }
  }
  await walk(root, '');
  return out;
}

const nonDirWrites = (step) => step.writes.filter((w) => !w.endsWith('/'));

/**
 * The steps that ran, from the same file map: their declared file artefacts exist. `prep-verify`
 * shares `prep`'s files, so it counts as ran only once its own check passes.
 */
function stepsThatRan(files) {
  return STEPS
    .filter((step) => step.id !== 'report')
    .filter((step) => nonDirWrites(step).every((w) => files[w] !== undefined))
    .filter((step) => step.id !== 'prep-verify'
      || checkPrepManifest(files, { minChecked: 3, minPrefixes: 2, minShots: 0 }, []).pass)
    .map((step) => step.id);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `report`: `REPORT.md` has a `## <step>` section for every step whose artefacts exist. */
export function checkReport(files) {
  const md = files['REPORT.md'];
  if (md === undefined) return { pass: false, reasons: ['missing migration/REPORT.md'] };
  // `## next` is the report step's own output; without it the step has not run.
  const reasons = [...stepsThatRan(files), 'next'].flatMap((id) => {
    const count = (md.match(new RegExp(`^##\\s+${escapeRegExp(id)}\\s*$`, 'gm')) ?? []).length;
    if (count === 0) return [`migration/REPORT.md has no "## ${id}" section`];
    if (count > 1) return [`migration/REPORT.md has ${count} "## ${id}" sections; keep one`];
    return [];
  });
  // A shell variable that never expanded is a body that was never read back.
  for (const literal of new Set(md.match(/\$[A-Z_][A-Z0-9_]*\b/g) ?? [])) {
    reasons.push(`migration/REPORT.md contains the unexpanded shell variable ${literal}`);
  }
  const next = md.split(/^## next\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  if (next && !STEPS.some((s) => new RegExp(`\\b${escapeRegExp(s.id)}\\b`).test(next))) {
    reasons.push('migration/REPORT.md "## next" names no step; say what is pending or done');
  }
  return { pass: reasons.length === 0, reasons };
}

const CONTENT_CHECKS = {
  probe: checkProbe,
  prep: checkPrep,
  scan: checkScan,
  'prep-verify': checkPrepVerify,
  cache: checkCache,
  report: checkReport,
};

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Every relative artefact path a content check reads, `/`-separated as in `STEPS[].writes`. */
function knownPaths() {
  const paths = new Set(['project.json', 'REPORT.md']);
  for (const step of STEPS) {
    for (const w of nonDirWrites(step)) paths.add(w);
  }
  return paths;
}

async function listSubsetFiles(project) {
  const dir = path.join(project.dir, 'urls', 'subsets');
  const names = await readdir(dir).catch(() => []);
  return names.filter((n) => n.endsWith('.txt')).map((n) => `urls/subsets/${n}`);
}

/**
 * Reads every artefact a content check needs into `{ relPath: text }`; missing files are
 * simply absent from the map. The small loader `runCheck` and `runAllChecks` use.
 */
async function loadFiles(project) {
  const relPaths = [...knownPaths(), ...(await listSubsetFiles(project))];
  const entries = await Promise.all(
    relPaths.map(async (rel) => [rel, await readText(path.join(project.dir, rel))]),
  );
  return Object.fromEntries(entries.filter(([, text]) => text !== undefined));
}

/** `setup`: every precondition `detect()` looks for is ok, re-checked, never trusted from disk. */
async function checkSetup(project) {
  const detection = await detect({ cwd: project.root });
  const reasons = missingReasons(detection);
  return { pass: reasons.length === 0, reasons };
}

/**
 * The approved cache selection of a project on disk: its URLs and the reasons it cannot be
 * used (not approved, no URLs, a missing subset file).
 *
 * @param {import('./project.mjs').Project} project
 * @returns {Promise<{urls: string[], reasons: string[]}>}
 */
export async function resolveSelection(project) {
  return approvedSelection(await loadFiles(project));
}

/** Step id → `async (project) => { pass, reasons }`. */
export const CHECKS = Object.fromEntries(
  STEPS.map((step) => {
    if (step.id === 'setup') return [step.id, checkSetup];
    const contentCheck = CONTENT_CHECKS[step.id];
    if (!contentCheck) throw new Error(`Step "${step.id}" has no done-check`);
    if (step.id === 'cache') {
      return [step.id, async (project) => checkCache(
        await loadFiles(project), await listCacheFiles(project),
      )];
    }
    if (step.id === 'prep' || step.id === 'prep-verify') {
      return [step.id, async (project) => contentCheck(
        await loadFiles(project), await listDir(project.step('prep'), 'prep'),
      )];
    }
    return [step.id, async (project) => contentCheck(await loadFiles(project))];
  }),
);

export async function runCheck(id, project) {
  const check = CHECKS[id];
  if (!check) throw new Error(`No done-check for step "${id}"`);
  const result = await check(project);
  return { step: id, ...result };
}

/** Every step's done-check, as `{ id: pass }`. */
export async function runAllChecks(project) {
  const entries = await Promise.all(
    Object.keys(CHECKS).map(async (id) => [id, (await runCheck(id, project)).pass]),
  );
  return Object.fromEntries(entries);
}

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const COVER_THRESHOLD = 0.8;
const TWO_LETTER_CODE = /^[a-z]{2}$/i;

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/** Path segments of a URL, the `.html` of the last one dropped (`/a/b.html` → `[a, b]`). */
export function pathSegments(url) {
  let pathname;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return [];
  }
  return pathname.replace(/\.html$/, '').split('/').filter(Boolean);
}

/**
 * The path segments every URL shares — the site's scope, e.g. `['en', 'section']` when
 * all pages live under `/en/section/`. Empty for a site crawled from its root.
 *
 * @param {{url: string}[]} urls
 * @returns {string[]}
 */
export function scopeOf(urls) {
  if (!urls.length) return [];
  let scope = pathSegments(urls[0].url);
  for (const { url } of urls.slice(1)) {
    const segments = pathSegments(url);
    let i = 0;
    while (i < scope.length && i < segments.length && scope[i] === segments[i]) i += 1;
    scope = scope.slice(0, i);
    if (!scope.length) break;
  }
  return scope;
}

/** The segments of `url` below `scope` (the scope root itself yields `[]`). */
export function relativeSegments(url, scope) {
  return pathSegments(url).slice(scope.length);
}

function languageOf(url, segments) {
  if (url.lang) return url.lang;
  const first = pathSegments(url.url ?? '')[0] ?? segments[0];
  if (first && TWO_LETTER_CODE.test(first)) return first;
  return 'unknown';
}

/**
 * Counts a list of `URLExtended` entries (see the site-scan skill) by first and second path
 * segment **below the scope every URL shares** (so a site under `/en/section/` is counted
 * by what comes after it) and by language.
 *
 * @param {{url: string, lang?: string}[]} urls
 * @returns {{total: number, scope: string, byFirstSegment: Record<string, number>,
 *   bySecondSegment: Record<string, number>, byLanguage: Record<string, number>}}
 */
export function distribution(urls) {
  const scope = scopeOf(urls);
  const byFirstSegment = {};
  const bySecondSegment = {};
  const byLanguage = {};
  for (const url of urls) {
    const segments = relativeSegments(url.url, scope);
    bump(byFirstSegment, segments[0] ?? '');
    bump(bySecondSegment, segments[1] ?? '');
    bump(byLanguage, languageOf(url, segments));
  }
  return {
    total: urls.length, scope: `/${scope.join('/')}`, byFirstSegment, bySecondSegment, byLanguage,
  };
}

function sortedEntries(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function round(fraction) {
  return Math.round(fraction * 10000) / 10000;
}

function coverGroups(map, total) {
  const groups = [];
  let cumulative = 0;
  for (const [prefix, count] of sortedEntries(map)) {
    groups.push({ prefix, count, share: round(count / total) });
    cumulative += count;
    if (cumulative / total >= COVER_THRESHOLD) break;
  }
  return groups;
}

/**
 * The caching proposal: every URL when the total is at or under `cacheAllUpTo`, otherwise
 * the largest first-path-segment groups that together cover at least 80% of the URLs.
 *
 * @param {ReturnType<typeof distribution>} dist
 * @param {{cacheAllUpTo?: number}} [options]
 * @returns {{all: true, total: number} | {all: false, scope: string,
 *   groups: {prefix: string, count: number, share: number}[]}} `prefix` is the first path
 *   segment below `scope`.
 */
export function proposal(dist, { cacheAllUpTo = 500 } = {}) {
  const { total } = dist;
  if (total <= cacheAllUpTo) return { all: true, total };
  const groups = coverGroups(dist.byFirstSegment, total);
  return { all: false, scope: dist.scope, groups };
}

function label(key) {
  return key === '' ? '(root)' : key;
}

const TABLE_ROWS = 25;

/** A count table, the long tail folded into one row so the file stays readable in full. */
function tableOf(title, map) {
  const entries = sortedEntries(map);
  const shown = entries.slice(0, TABLE_ROWS);
  const rest = entries.slice(TABLE_ROWS);
  const rows = shown.map(([key, count]) => `| ${label(key)} | ${count} |`);
  if (rest.length) {
    const total = rest.reduce((sum, [, count]) => sum + count, 0);
    rows.push(`| … and ${rest.length} more | ${total} |`);
  }
  return [`## ${title}`, '', '| value | count |', '| --- | --- |', ...rows].join('\n');
}

function sentenceOf(dist, prop) {
  const { total } = dist;
  if (prop.all) {
    return `All ${total} URLs are at or under the caching threshold, so cache every URL.`;
  }
  const named = prop.groups.map((g) => `"${label(g.prefix)}" (${g.count})`).join(', ');
  const covered = prop.groups.reduce((sum, g) => sum + g.count, 0);
  const percent = Math.round((covered / total) * 100);
  return `${total} URLs exceed the caching threshold, so cache the ${prop.groups.length} `
    + `largest groups covering ${percent}% of URLs: ${named}.`;
}

/**
 * Markdown for `urls/urls.md`: the caching proposal in one sentence first (for the agent to
 * put to the operator), then a count table per breakdown, each capped at 25 rows.
 *
 * @param {ReturnType<typeof distribution>} dist
 * @param {ReturnType<typeof proposal>} prop
 */
export function renderUrlsMd(dist, prop) {
  return [
    '# URL distribution',
    '',
    sentenceOf(dist, prop),
    '',
    `Total URLs: ${dist.total}`,
    '',
    ...(dist.scope !== '/'
      ? [`All URLs share the prefix \`${dist.scope}\`; the segments below are relative to it.`, '']
      : []),
    tableOf('By first path segment', dist.byFirstSegment),
    '',
    tableOf('By second path segment', dist.bySecondSegment),
    '',
    tableOf('By language', dist.byLanguage),
    '',
  ].join('\n');
}

function fileName(prefix) {
  return prefix === '' ? 'root' : prefix.replace(/[^\w.-]+/g, '-');
}

function hasUrl(entry) {
  return !!entry && typeof entry.url === 'string' && entry.url !== '';
}

function linesOf(list) {
  const valid = list.filter(hasUrl);
  return valid.length ? `${valid.map((u) => u.url).join('\n')}\n` : '';
}

/**
 * Writes one URL-per-line file per proposed group under `<dir>/subsets/`, after clearing
 * every file left over from a previous proposal. Writes nothing and returns an empty list
 * when the proposal is to cache everything. Entries without a usable `url` are skipped.
 *
 * @param {{url: string, level1?: string, level2?: string}[]} urls
 * @param {ReturnType<typeof proposal>} prop
 * @param {string} dir The `urls/` directory the subsets belong under.
 * @returns {Promise<string[]>} The paths written.
 */
export async function writeSubsets(urls, prop, dir) {
  const subsetsDir = path.join(dir, 'subsets');
  await rm(subsetsDir, { recursive: true, force: true });
  if (prop.all) return [];
  await mkdir(subsetsDir, { recursive: true });
  const files = [];
  const scope = prop.scope === '/' ? [] : prop.scope.split('/').filter(Boolean);
  for (const group of prop.groups) {
    const matching = urls.filter((u) => (relativeSegments(u.url, scope)[0] ?? '') === group.prefix);
    const file = path.join(subsetsDir, `${fileName(group.prefix)}.txt`);
    await writeFile(file, linesOf(matching));
    files.push(file);
  }
  return files;
}

/** True when a GET to `url` answers 2xx (the response body is discarded). */
export async function reachableByFetch(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    await res.arrayBuffer().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Picks representative pages: one reachable URL from each of the largest groups (first
 * path segment below the shared scope), skipping the groups of the `exclude` URLs — the
 * homepage's, typically — so a check runs on pages that differ from what was already seen.
 *
 * @param {{url: string}[]} urls `URLExtended[]`.
 * @param {{count?: number, exclude?: string[], fill?: boolean,
 *   reachable?: (url: string) => Promise<boolean>}} [options] `fill` keeps rounding over the
 *   groups until `count` pages are picked (HTML pages only), for building a cache selection.
 * @returns {Promise<{url: string, group: string, count: number}[]>} At most `count` picks,
 *   fewer when the site has fewer groups.
 */
export async function pick(urls, {
  count = 2, exclude = [], fill = false, reachable = reachableByFetch,
} = {}) {
  const scope = scopeOf(urls);
  const groupOf = (url) => relativeSegments(url, scope)[0] ?? '';
  const skip = new Set(exclude.map(groupOf));
  const byGroup = new Map();
  for (const { url } of urls) {
    const group = groupOf(url);
    if (skip.has(group) || (fill && !isPage(url))) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), url]);
  }
  // Larger groups first; on a tie by name, the scope root ('') last.
  const ranked = [...byGroup].sort((a, b) => b[1].length - a[1].length
    || (a[0] === '') - (b[0] === '') || a[0].localeCompare(b[0]));
  // Pages inside the group before its landing page: they are what the group looks like.
  const inside = (url) => (relativeSegments(url, scope).length >= 2 ? 0 : 1);
  const queues = ranked.map(([group, members]) => ({
    group, count: members.length, rest: [...members].sort((a, b) => inside(a) - inside(b)),
  }));
  const picks = [];
  let progressed = true;
  while (picks.length < count && progressed) {
    progressed = false;
    for (const q of queues) {
      if (picks.length >= count) break;
      while (q.rest.length) {
        const url = q.rest.shift();
        if (await reachable(url)) {
          picks.push({ url, group: q.group, count: q.count });
          progressed = true;
          break;
        }
      }
    }
    if (!fill) break;
  }
  return picks;
}

const NOT_A_PAGE = /\.(pdf|xml|txt|php|json|csv|zip|jpe?g|png|gif|svg|mp4|css|js)$/i;

/** True for URLs that render as pages; documents and scripts are not worth a browser visit. */
function isPage(url) {
  try {
    return !NOT_A_PAGE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Writes an operator selection as `urls/subsets/<name>.txt`, one URL per line, for
 * `approve cache <name>`.
 *
 * @param {string} urlsDir `migration/urls`.
 * @param {string} name Subset name (letters, digits, `-`, `_`).
 * @param {string[]} urls
 * @returns {Promise<string>} The file written.
 */
export async function writeSubset(urlsDir, name, urls) {
  if (!/^[\w-]+$/.test(name)) throw new Error(`subset name "${name}" must be [A-Za-z0-9_-]`);
  const dir = path.join(urlsDir, 'subsets');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.txt`);
  await writeFile(file, linesOf(urls.map((url) => ({ url }))));
  return file;
}

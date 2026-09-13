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

function tableOf(title, map) {
  const rows = sortedEntries(map).map(([key, count]) => `| ${label(key)} | ${count} |`);
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
 * Markdown for `urls/urls.md`: count tables for each breakdown and one sentence stating the
 * caching proposal for the agent to put to the operator.
 *
 * @param {ReturnType<typeof distribution>} dist
 * @param {ReturnType<typeof proposal>} prop
 */
export function renderUrlsMd(dist, prop) {
  return [
    '# URL distribution',
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
    sentenceOf(dist, prop),
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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathSegments, relativeSegments, scopeOf } from './urls.mjs';

const SCAN_FIELDS = ['origin', 'status', 'level1', 'level2', 'level3', 'filename', 'search', 'lang',
  'message'];

/**
 * The URL inventory: `migration/urls/urls.json`, one record per URL for the whole project.
 * The runner is its only writer. A record starts as the crawler's `URLExtended` entry plus
 * `group` (first path segment below the shared scope), `firstSeen` and `inLastScan`, and is
 * augmented by the cache visit (`http`, `redirect`, `finalUrl`, `kind`, `migrate`, `cache`).
 */
export async function readInventory(urlsDir) {
  const file = path.join(urlsDir, 'urls.json');
  const text = await readFile(file, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (text === null) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); restore it or rerun the scan`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`${file} must be a JSON array of URLExtended entries (URL records)`);
  }
  return data;
}

export async function writeInventory(urlsDir, records) {
  await mkdir(urlsDir, { recursive: true });
  await writeFile(path.join(urlsDir, 'urls.json'), `${JSON.stringify(records, null, 2)}\n`);
  return records;
}

function withGroups(records) {
  const scope = scopeOf(records);
  return records.map((r) => ({ ...r, group: relativeSegments(r.url, scope)[0] ?? '' }));
}

/**
 * Gives records written before the inventory existed (a bare crawl result) their `group`,
 * `inLastScan` and `firstSeen`; records that already have them are returned unchanged.
 *
 * @param {object[]} records
 * @param {{now?: () => string}} [options]
 * @returns {object[]}
 */
export function normalise(records, { now = () => new Date().toISOString() } = {}) {
  if (records.every((r) => 'group' in r && 'inLastScan' in r)) return records;
  return withGroups(records.map((r) => ({
    firstSeen: now(), inLastScan: true, ...r,
  })));
}

/**
 * Merges a crawl result into the inventory: new URLs are added, known URLs keep every
 * enrichment and refresh their crawler fields, URLs absent from this crawl are marked
 * `inLastScan: false` and kept.
 *
 * @param {object[]} existing Current inventory records.
 * @param {object[]} scanned `URLExtended[]` from the crawler or {@link fromList}.
 * @param {{now?: () => string}} [options]
 * @returns {object[]} The merged inventory, groups recomputed over the whole set.
 */
export function mergeScan(existing, scanned, { now = () => new Date().toISOString() } = {}) {
  const byUrl = new Map(existing.map((r) => [r.url, { ...r, inLastScan: false }]));
  for (const entry of scanned) {
    if (!entry?.url) continue;
    const current = byUrl.get(entry.url) ?? { url: entry.url, firstSeen: now() };
    const crawler = Object.fromEntries(
      SCAN_FIELDS.filter((k) => k in entry).map((k) => [k, entry[k]]),
    );
    byUrl.set(entry.url, { ...current, ...crawler, inLastScan: true });
  }
  return withGroups([...byUrl.values()]);
}

/**
 * Operator-provided URLs (one per line) as scan entries, so they merge like a crawl result.
 *
 * @param {string} text
 * @returns {object[]}
 */
export function fromList(text) {
  const seen = new Set();
  const entries = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    let u;
    try {
      u = new URL(line);
    } catch {
      continue;
    }
    const url = `${u.origin}${u.pathname}${u.search}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const segments = pathSegments(url);
    const raw = u.pathname.split('/').filter(Boolean);
    entries.push({
      url, origin: u.origin, status: 'valid',
      level1: raw[0] ?? '', level2: raw[1] ?? '', level3: raw[2] ?? '',
      filename: raw.at(-1) ?? '', search: u.search,
      lang: /^[a-z]{2}$/i.test(segments[0] ?? '') ? segments[0] : '',
      message: 'operator-provided list',
    });
  }
  return entries;
}

/**
 * Merges what a cache visit learned about `url` into its record; a URL the inventory did
 * not know (a redirect target, say) is added as `discovered: 'cache'`.
 *
 * @param {object[]} records
 * @param {string} url
 * @param {object} facts `http`, `redirect`, `finalUrl`, `kind`, `migrate`, `cache` — any subset.
 * @returns {object[]}
 */
export function recordVisit(records, url, facts) {
  const index = records.findIndex((r) => r.url === url);
  if (index >= 0) {
    return records.map((r, i) => (i === index ? { ...r, ...facts } : r));
  }
  const added = [...records, {
    url, inLastScan: false, discovered: 'cache', firstSeen: facts.cache?.at ?? null, ...facts,
  }];
  return withGroups(added);
}

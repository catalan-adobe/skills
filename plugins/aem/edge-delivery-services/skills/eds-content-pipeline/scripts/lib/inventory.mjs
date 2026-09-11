import { pathToFileURL } from 'node:url';
import { positiveIntFlag } from './args.mjs';
import { loadConfig } from './config.mjs';
import { createClient } from './http.mjs';
import { mapPool } from './pool.mjs';
import {
  parseSitemap,
  sitemapTypeFromUrl,
  collectSitemaps,
} from './sitemap.mjs';
import { resolvePaths } from './paths.mjs';
import { readJson, upsertRecords } from './state.mjs';

/**
 * Applies configuration-driven exclusions that need no network access.
 * @param {{url: string, path: string, sitemapType: string}} record
 * @param {{queryStrings?: boolean, pathPatterns?: string[],
 *   sitemapTypes?: Record<string, string>}} exclusions
 * @param {string[]} [include] Inclusive path patterns; if set, all others
 *   are excluded (not-included).
 * @returns {{reason: string} | null}
 */
export function classifyStatic(record, exclusions, include = []) {
  if (
    include.length &&
    !include.some((p) => new RegExp(p).test(record.path))
  ) {
    return { reason: 'not-included' };
  }
  if (exclusions.queryStrings && record.url.includes('?')) {
    return { reason: 'query-string' };
  }
  if (
    (exclusions.pathPatterns ?? []).some((p) =>
      new RegExp(p).test(record.path)
    )
  ) {
    return { reason: 'path-pattern' };
  }
  const typeReason = exclusions.sitemapTypes?.[record.sitemapType];
  return typeReason ? { reason: typeReason } : null;
}

/**
 * Turns a probe result into URL record fields (status, redirects, exclusion).
 * @param {{status: number, finalUrl: string, redirectChain: object[], external: boolean}} probe
 * @returns {{httpStatus: number, finalUrl: string, redirectTo: string | null,
 *   excluded: {reason: string} | null}}
 */
export function classifyProbe(probe) {
  const fields = {
    httpStatus: probe.status, finalUrl: probe.finalUrl, redirectTo: null, excluded: null,
  };
  if (probe.redirectChain.length) {
    fields.redirectTo = probe.finalUrl;
    fields.excluded = { reason: probe.external ? 'external-redirect' : 'internal-redirect' };
  } else if (probe.status === 404 || probe.status === 410) {
    fields.excluded = { reason: 'http-404' };
  }
  return fields;
}

async function fetchXml(client, url) {
  const res = await client.get(url, { cache: false });
  if (res.status !== 200) throw new Error(`Sitemap ${url} returned HTTP ${res.status}`);
  return res.body;
}

async function collectEntries(client, config, log) {
  const failed = [];
  const failedSet = new Set();
  let rootError = null;
  const textWithTracking = async (u) => {
    try {
      return await fetchXml(client, u);
    } catch (err) {
      if (u === config.sitemapIndex) rootError = err;
      failedSet.add(u);
      failed.push({ url: u, error: err.message });
      log(`sitemap ${u} skipped: ${err.message}`);
      return '';
    }
  };
  const sitemaps = await collectSitemaps(
    { text: textWithTracking },
    config.sitemapIndex
  );
  if (rootError) throw rootError;
  const perSitemap = await mapPool(
    sitemaps.filter((s) => !failedSet.has(s)),
    config.concurrency.fetch,
    async (loc) => {
      try {
        const parsed = parseSitemap(await fetchXml(client, loc));
        return parsed.entries.map((e) => ({
          ...e,
          sitemapType: sitemapTypeFromUrl(loc),
        }));
      } catch (err) {
        if (!failedSet.has(loc)) {
          failed.push({ url: loc, error: err.message });
          failedSet.add(loc);
        }
        log(`sitemap ${loc} skipped: ${err.message}`);
        return [];
      }
    }
  );
  return {
    entries: perSitemap.flat(),
    sitemaps: { total: sitemaps.length, failed },
  };
}

function toRecord(entry, config, existing) {
  const u = new URL(entry.loc);
  const pathWithQuery = `${u.pathname}${u.search}`;
  const seed = config.templateSeeds[entry.sitemapType] ?? entry.sitemapType;
  const staticExclusion = classifyStatic(
    {
      url: entry.loc,
      path: pathWithQuery,
      sitemapType: entry.sitemapType,
    },
    config.exclusions,
    config.include,
  );
  const excluded = staticExclusion ?? existing?.excluded ?? null;
  return {
    url: entry.loc,
    path: pathWithQuery,
    sitemapType: entry.sitemapType,
    template: existing?.template ?? seed,
    status: excluded ? 'excluded' : (existing?.status ?? 'todo'),
    lastmod: entry.lastmod,
    excluded,
    inventoriedAt: new Date().toISOString(),
  };
}

async function probeRecords(records, client, config, log) {
  const targets = records.filter((r) => !r.excluded);
  let done = 0;
  await mapPool(
    targets,
    config.concurrency.fetch,
    async (record) => {
      try {
        Object.assign(
          record,
          classifyProbe(await client.probe(record.url))
        );
        if (record.excluded) record.status = 'excluded';
      } catch (err) {
        record.probeError = err.message;
      }
      done += 1;
      if (done % 100 === 0) log(`probed ${done}/${targets.length}`);
    }
  );
}

function summarize(records, sitemaps) {
  const excludedByReason = {};
  const byType = {};
  for (const r of records) {
    byType[r.sitemapType] = (byType[r.sitemapType] ?? 0) + 1;
    if (r.excluded) {
      excludedByReason[r.excluded.reason] =
        (excludedByReason[r.excluded.reason] ?? 0) + 1;
    }
  }
  const sortKeys = (o) =>
    Object.fromEntries(
      Object.entries(o).sort(([a], [b]) => a.localeCompare(b))
    );
  return {
    total: records.length,
    active: records.filter((r) => !r.excluded).length,
    byType: sortKeys(byType),
    excludedByReason: sortKeys(excludedByReason),
    probeErrors: records.filter((r) => r.probeError).length,
    sitemaps,
  };
}

/**
 * Builds or refreshes `urls.json` from the site's sitemaps.
 *
 * @param {object} options
 * @param {object} options.config Loaded site configuration.
 * @param {ReturnType<typeof createClient>} options.client
 * @param {ReturnType<typeof resolvePaths>} options.paths
 * @param {number} [options.limit=Infinity] Cap on entries (smoke runs).
 * @param {boolean} [options.probe=true] Probe each URL for status and redirects.
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{total: number, active: number, byType: object,
 *   excludedByReason: object, probeErrors: number, sitemaps: {total:
 *   number, failed: {url: string, error: string}[]}}>} Summary.
 */
export async function runInventory({
  config, client, paths, limit = Infinity, probe = true, log = () => {},
}) {
  const result = await collectEntries(client, config, log);
  const entries = result.entries.slice(0, limit);
  log(`discovered ${entries.length} sitemap entries`);
  const existing = new Map((await readJson(paths.stateFile('urls'), [])).map((r) => [r.url, r]));
  const records = entries.map((e) => toRecord(e, config, existing.get(e.loc)));
  if (probe) await probeRecords(records, client, config, log);
  await upsertRecords('urls', records, paths);
  return summarize(records, result.sitemaps);
}

async function cli(argv) {
  const paths = resolvePaths();
  const config = await loadConfig(paths.configPath);
  const client = createClient({
    requestsPerSecond: config.rateLimit.requestsPerSecond,
    cacheDir: paths.cacheDir,
  });
  const summary = await runInventory({
    config,
    client,
    paths,
    probe: !argv.includes('--no-probe'),
    limit: positiveIntFlag(argv, '--limit', Infinity),
    log: (msg) => console.error(`[inventory] ${msg}`),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

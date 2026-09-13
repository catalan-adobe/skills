import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { positiveIntFlag } from './args.mjs';
import { loadConfig } from './config.mjs';
import { createClient } from './http.mjs';
import { resolvePaths } from './paths.mjs';
import {
  captureSlug, listRecords, upsertRecords, writeCapture,
} from './state.mjs';

const USAGE = 'Usage: capture.mjs <template> [--limit 3] [--check]';
const exists = (file) => access(file).then(() => true, () => false);

/**
 * The representative URLs of a template: the records flagged `representative: true`, or when
 * none is flagged (a template renamed before `cluster` picked them, or seeded by hand) the
 * first `limit` records of the template in `urls.json` order. Records marked
 * `representative: false` (by an operator, or by a failed capture) are never picked.
 *
 * @param {object[]} records Every URL record of the template.
 * @param {number} limit Fallback size.
 * @returns {object[]} Representative records.
 */
export function representatives(records, limit) {
  const active = records.filter((r) => !r.excluded && r.status !== 'excluded'
    && r.representative !== false);
  const flagged = active.filter((r) => r.representative === true);
  return (flagged.length ? flagged : active).slice(0, limit);
}

/**
 * Reports which representatives have no capture on disk.
 *
 * @param {string} template Template name.
 * @param {object[]} reps Representative records.
 * @param {ReturnType<typeof resolvePaths>} paths
 * @returns {Promise<{template: string, missing: string[]}>}
 */
export async function checkCaptures(template, reps, paths) {
  const missing = [];
  for (const rep of reps) {
    const file = path.join(paths.dataDir, 'captures', template, `${captureSlug(rep.url)}.html`);
    if (!(await exists(file))) missing.push(rep.url);
  }
  return { template, missing };
}

/**
 * Fetches every representative page and stores it under `data/captures/<template>/`, so the
 * `analyse` unit has real markup to descend into before any transformer exists.
 *
 * @param {string} template Template name.
 * @param {object[]} reps Representative records.
 * @param {{get: Function}} client HTTP client.
 * @param {ReturnType<typeof resolvePaths>} paths
 * @returns {Promise<{template: string, captured: string[],
 *   failed: {url: string, error: string}[]}>}
 */
export async function captureRepresentatives(template, reps, client, paths) {
  const captured = [];
  const failed = [];
  for (const rep of reps) {
    try {
      const res = await client.get(rep.url, { cache: false });
      if (res.status !== 200) throw new Error(`GET ${rep.url} -> HTTP ${res.status}`);
      await writeCapture(paths, template, rep.url, res.body);
      captured.push(rep.url);
    } catch (err) {
      failed.push({ url: rep.url, error: err.message });
    }
  }
  return { template, captured, failed };
}

/**
 * A page that cannot be fetched cannot represent anything: clear its flag, keep the reason on
 * the record, and let the analyst work from the pages that are there.
 */
async function dropFailed(result, paths) {
  if (!result.failed.length) return;
  await upsertRecords('urls', result.failed.map((f) => ({
    url: f.url, representative: false, note: `capture failed: ${f.error}`,
  })), paths);
  console.error(`[capture] ${result.failed.length} representative(s) dropped: `
    + result.failed.map((f) => `${f.url} (${f.error})`).join(', '));
}

async function cli(argv) {
  const [template] = argv.filter((a) => !a.startsWith('--'));
  if (!template) throw new Error(USAGE);
  const paths = resolvePaths();
  const config = await loadConfig(paths.configPath);
  const limit = positiveIntFlag(argv, '--limit', config.thresholds.representativesPerTemplate);
  const reps = representatives(await listRecords('urls', { where: { template }, paths }), limit);
  if (!reps.length) throw new Error(`No URLs carry template "${template}" in urls.json`);
  if (argv.includes('--check')) {
    const result = await checkCaptures(template, reps, paths);
    if (result.missing.length) process.exitCode = 1;
    return result;
  }
  const client = createClient({
    requestsPerSecond: config.rateLimit.requestsPerSecond, cacheDir: paths.cacheDir,
  });
  const result = await captureRepresentatives(template, reps, client, paths);
  await dropFailed(result, paths);
  if (!result.captured.length && reps.some((r) => r.representative === true)) {
    // Every flagged representative is gone: fall back to the first pages of the template.
    const records = await listRecords('urls', { where: { template }, paths });
    const fallback = representatives(records, limit);
    const second = await captureRepresentatives(template, fallback, client, paths);
    await dropFailed(second, paths);
    result.captured.push(...second.captured);
    result.failed.push(...second.failed);
  }
  if (!result.captured.length) process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

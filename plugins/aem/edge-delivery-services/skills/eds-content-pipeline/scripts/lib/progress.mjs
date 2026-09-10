import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePaths } from './paths.mjs';
import { readJson, updateJson } from './state.mjs';
import { flag } from './args.mjs';

/** Resolves the progress file for a run id under `<dataDir>/runs/<runId>.json`. */
function progressFile(runId, paths) {
  return path.join(paths.dataDir, 'runs', `${runId}.json`);
}

/**
 * Appends or updates one unit's status in a run's progress file, creating the file on first call.
 *
 * @param {object} update
 * @param {string} update.runId Run identifier, e.g. `template-case-study-20260904`.
 * @param {string} update.stage Stage name, e.g. `template` or `bulk`.
 * @param {string} update.unit Unit label, e.g. `blocks:tabs`.
 * @param {string} update.status Unit status, e.g. `started`, `passed`, `failed`.
 * @param {string} [update.detail] Free-form detail for the dashboard.
 * @param {number} [update.cost] Cumulative cost so far; overwrites the stored value when given.
 * @param {ReturnType<typeof resolvePaths>} [paths]
 * @returns {Promise<object>} The full progress record after the update.
 * @throws {Error} When `runId`, `stage`, `unit` or `status` is missing.
 */
export async function writeProgress({
  runId, stage, unit, status, detail, cost,
}, paths = resolvePaths()) {
  if (!runId || !stage || !unit || !status) {
    throw new Error('writeProgress requires runId, stage, unit and status');
  }
  const file = progressFile(runId, paths);
  const now = new Date().toISOString();
  return updateJson(file, null, (existing) => {
    const record = existing ?? {
      runId, stage, startedAt: now, updatedAt: now, units: [], cost: 0,
    };
    record.stage = stage;
    record.updatedAt = now;
    if (cost !== undefined) record.cost = cost;
    const idx = record.units.findIndex((u) => u.unit === unit);
    const row = {
      unit, status, detail: detail ?? null, at: now,
    };
    if (idx >= 0) record.units[idx] = row; else record.units.push(row);
    return record;
  });
}

/** Reads a run's progress file, or `null` when the run has not started. */
export async function readProgress(runId, paths = resolvePaths()) {
  return readJson(progressFile(runId, paths), null);
}

async function cli(argv) {
  const [cmd, runId, stage, unit, status, ...rest] = argv;
  if (cmd === 'set' && runId && stage && unit && status) {
    const detail = flag(rest, '--detail');
    const costRaw = flag(rest, '--cost');
    const cost = costRaw === undefined ? undefined : Number(costRaw);
    const record = await writeProgress({
      runId, stage, unit, status, detail, cost,
    });
    console.log(JSON.stringify({
      ok: true, runId, unit, status, updatedAt: record.updatedAt,
    }));
    return;
  }
  throw new Error('Usage: progress.mjs set <runId> <stage> <unit> <status> [--detail text]'
    + ' [--cost n]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

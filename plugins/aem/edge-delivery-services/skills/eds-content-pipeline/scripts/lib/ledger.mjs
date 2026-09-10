import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePaths } from './paths.mjs';
import {
  countBy, readJson, stateFileFor, withLock, writeJsonAtomic,
} from './state.mjs';
import { assertRecord } from './shapes.mjs';

/**
 * Appends one validated row to a JSONL ledger (`runs` or `units`).
 * @param {string} name Ledger name.
 * @param {object} row Row to append.
 * @param {ReturnType<typeof resolvePaths>} [paths]
 */
export async function appendRow(name, row, paths = resolvePaths()) {
  assertRecord(name, row);
  const file = paths.ledgerFile(name);
  await mkdir(path.dirname(file), { recursive: true });
  await withLock(file, () => appendFile(file, `${JSON.stringify(row)}\n`));
}

/** Reads all rows of a ledger; a missing ledger yields an empty array. */
export async function readRows(name, paths = resolvePaths()) {
  try {
    const text = await readFile(paths.ledgerFile(name), 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Builds the dashboard overview from state files and ledgers. */
export async function buildSummary(paths = resolvePaths()) {
  const [urls, templates, feedback, runs, units] = await Promise.all([
    readJson(paths.stateFile('urls'), []),
    readJson(paths.stateFile('templates'), []),
    readJson(stateFileFor('feedback', paths), []),
    readRows('runs', paths),
    readRows('units', paths),
  ]);
  const openStatuses = ['received', 'acknowledged'];
  return {
    generatedAt: new Date().toISOString(),
    urls: {
      total: urls.length,
      byStatus: countBy(urls, 'status'),
      byTemplate: countBy(urls, 'template'),
    },
    templates: { total: templates.length, byStatus: countBy(templates, 'status') },
    runs: {
      total: runs.length,
      lastRun: runs.at(-1) ?? null,
      costTotal: runs.reduce((sum, r) => sum + (Number(r.cost) || 0), 0),
    },
    units: { total: units.length, byVerdict: countBy(units, 'verdict') },
    feedback: { open: feedback.filter((f) => openStatuses.includes(f.status)).length },
  };
}

/** Builds the summary and writes it to `data/summary.json`. */
export async function writeSummary(paths = resolvePaths()) {
  const summary = await buildSummary(paths);
  await writeJsonAtomic(paths.stateFile('summary'), summary);
  return summary;
}

async function cli(argv) {
  const [cmd, name, json] = argv;
  if (cmd === 'append' && name && json) {
    await appendRow(name, JSON.parse(json));
    console.log(JSON.stringify({ ok: true, ledger: name }));
    return;
  }
  if (cmd === 'summary') {
    console.log(JSON.stringify(await writeSummary(), null, 2));
    return;
  }
  throw new Error("Usage: ledger.mjs append <runs|units> '<json>' | ledger.mjs summary");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

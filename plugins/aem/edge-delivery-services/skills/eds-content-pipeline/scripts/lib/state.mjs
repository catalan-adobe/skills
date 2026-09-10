import {
  mkdir, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { resolvePaths } from './paths.mjs';
import { assertRecord } from './shapes.mjs';
import { flag } from './args.mjs';

const KEY_FIELDS = {
  urls: 'url', templates: 'name', blocks: 'name', feedback: 'id',
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Reads a JSON file, returning `fallback` when it does not exist.
 * @param {string} file
 * @param {*} fallback
 */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Writes JSON atomically (temp file + rename) so readers never see a partial file. */
export async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, file);
}

async function lockAgeMs(lockDir) {
  try {
    return Date.now() - (await stat(lockDir)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Runs `fn` while holding a directory lock next to `file` (mkdir is atomic across processes).
 * Stale locks older than `staleMs` are broken; waiting longer than `timeoutMs` throws.
 */
export async function withLock(file, fn, { timeoutMs = 10000, staleMs = 60000 } = {}) {
  const lockDir = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if ((await lockAgeMs(lockDir)) > staleMs) {
        await rm(lockDir, { recursive: true, force: true });
      } else if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock ${lockDir}; remove it if no runner is active`);
      } else {
        await sleep(50);
      }
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/** Locked read-modify-write of a JSON file; `updater` returns the next value. */
export async function updateJson(file, fallback, updater) {
  return withLock(file, async () => {
    const data = await readJson(file, fallback);
    const next = (await updater(data)) ?? data;
    await writeJsonAtomic(file, next);
    return next;
  });
}

/** Returns the unique key field of a state file, e.g. `url` for `urls`. */
export function keyFieldFor(name) {
  const key = KEY_FIELDS[name];
  if (!key) {
    throw new Error(`Unknown state file "${name}" `
      + `(expected ${Object.keys(KEY_FIELDS).join(', ')})`);
  }
  return key;
}

/**
 * Inserts or merges records by key, validating the merged result and stamping `updatedAt`.
 * @param {string} name State file name.
 * @param {object[]} records Partial or full records.
 * @param {ReturnType<typeof resolvePaths>} [paths]
 */
export async function upsertRecords(name, records, paths = resolvePaths()) {
  const key = keyFieldFor(name);
  return updateJson(paths.stateFile(name), [], (existing) => {
    const byKey = new Map(existing.map((r) => [r[key], r]));
    const now = new Date().toISOString();
    for (const rec of records) {
      const merged = { ...(byKey.get(rec[key]) ?? {}), ...rec, updatedAt: now };
      assertRecord(name, merged);
      byKey.set(rec[key], merged);
    }
    return [...byKey.values()];
  });
}

/** Lists records, optionally filtered by exact field values (compared as strings). */
export async function listRecords(name, { where = {}, paths = resolvePaths() } = {}) {
  const all = await readJson(paths.stateFile(name), []);
  return all.filter((r) => Object.entries(where).every(([k, v]) => String(r[k]) === String(v)));
}

function parseAssignments(pairs) {
  return Object.fromEntries(pairs.map((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) throw new Error(`Expected field=value, got "${pair}"`);
    const raw = pair.slice(idx + 1);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    return [pair.slice(0, idx), value];
  }));
}

export function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const k = String(row[field]);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  );
}

/**
 * Slugs the whole URL pathname: strips .html/.htm, drops leading/trailing
 * slashes, lowercases, replaces runs of non [a-z0-9] with '-', collapses
 * dashes, and maps '/' → 'index'. Used as the capture file name.
 */
export function captureSlug(url) {
  const pathname = new URL(url).pathname
    .replace(/\/+$/, '')
    .replace(/\.html?$/i, '')
    .replace(/^\/+/, '');
  if (!pathname) return 'index';
  return pathname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Verifies every block of `template` has ≥ 1 evidence selector
 * resolving on a captured representative. Captures are
 * `data/captures/<template>/<slug>.html`.
 */
export async function checkEvidence(
  template,
  paths = resolvePaths()
) {
  const blocks = (await listRecords('blocks', { paths }))
    .filter((b) => b.templates && template in b.templates);
  const missing = [];
  for (const block of blocks) {
    let ok = false;
    for (const ev of block.evidence ?? []) {
      const file = path.join(
        paths.dataDir,
        'captures',
        template,
        `${captureSlug(ev.url)}.html`
      );
      const html = await readFile(file, 'utf8').catch(() => null);
      if (html) {
        try {
          if (new JSDOM(html).window.document.querySelector(
            ev.selector
          )) {
            ok = true;
            break;
          }
        } catch {
          // Malformed selector; treat as unresolved, continue
        }
      }
    }
    if (!ok) {
      missing.push({
        name: block.name,
        ...(block.evidence?.[0] ?? {}),
      });
    }
  }
  return {
    template,
    blocks: blocks.length,
    missing,
    pass: blocks.length > 0 && !missing.length,
  };
}

const FEEDBACK_STATUS = [
  'received', 'acknowledged', 'applied', 'verified',
];

/**
 * Appends a feedback item; returns it.
 */
export async function addFeedback(
  { scope, decision, note = '' },
  paths = resolvePaths()
) {
  const scope_re = /^(global|template:[\w-]+|block:[\w-]+|page:\/.*)$/;
  if (!scope_re.test(scope)) {
    throw new Error(
      `feedback scope must be global | template:<t> | ` +
      `block:<b> | page:<path>, got "${scope}"`
    );
  }
  const item = {
    id: randomUUID().slice(0, 8),
    scope,
    decision,
    note,
    status: 'received',
  };
  await updateJson(
    path.join(paths.projectDir, 'feedback.json'),
    [],
    (all) => [...all, item]
  );
  return item;
}

export async function listFeedback(
  where = {},
  paths = resolvePaths()
) {
  const all = await readJson(
    path.join(paths.projectDir, 'feedback.json'),
    []
  );
  return all.filter((r) =>
    Object.entries(where).every(
      ([k, v]) => String(r[k]) === String(v)
    )
  );
}

export async function setFeedback(
  id,
  fields,
  paths = resolvePaths()
) {
  if (fields.status && !FEEDBACK_STATUS.includes(fields.status)) {
    throw new Error(
      `feedback status must be one of ${FEEDBACK_STATUS.join(', ')}`
    );
  }
  return updateJson(
    path.join(paths.projectDir, 'feedback.json'),
    [],
    (all) => {
      const hit = all.find((r) => r.id === id);
      if (!hit) throw new Error(`feedback item ${id} not found`);
      Object.assign(hit, fields);
      return all;
    }
  );
}

async function cli(argv) {
  const [cmd, nameOrSub, ...rest] = argv;
  if (cmd === 'list' && nameOrSub) {
    const filter = rest.filter(
      (a) => !a.startsWith('--') && a.includes('=')
    );
    const where = parseAssignments(filter);
    const rows = await listRecords(nameOrSub, { where });
    if (rest.includes('--count')) {
      console.log(JSON.stringify({ count: rows.length }, null, 2));
      return;
    }
    const countByIdx = rest.indexOf('--count-by');
    const result = countByIdx >= 0 ?
      countBy(rows, rest[countByIdx + 1]) : rows;
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === 'set' && nameOrSub && rest.length >= 2) {
    const [key, ...pairs] = rest;
    const updates = parseAssignments(pairs);
    await upsertRecords(nameOrSub, [
      { [keyFieldFor(nameOrSub)]: key, ...updates },
    ]);
    console.log(
      JSON.stringify(
        { ok: true, [keyFieldFor(nameOrSub)]: key },
        null,
        2
      )
    );
    return;
  }
  if (cmd === 'check-evidence' && nameOrSub) {
    const result = await checkEvidence(nameOrSub);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === 'feedback') {
    const sub = nameOrSub;
    const [a, b, ...rest2] = rest;
    if (sub === 'list') {
      const where = parseAssignments(rest2);
      const result = await listFeedback(where);
      console.log(JSON.stringify(result, null, 2));
    } else if (sub === 'add') {
      const noteVal = flag(rest2, '--note', '');
      const item = await addFeedback(
        { scope: a, decision: b, note: noteVal }
      );
      console.log(JSON.stringify(item, null, 2));
    } else if (sub === 'set') {
      const fields = parseAssignments(rest2);
      await setFeedback(a, fields);
      console.log(JSON.stringify({ ok: true, id: a }));
    } else {
      throw new Error(
        'Usage: state.mjs feedback list [field=value] | ' +
        'add <scope> <decision> [--note t] | ' +
        'set <id> field=value'
      );
    }
    return;
  }
  throw new Error(
    'Usage: state.mjs list <urls|templates|blocks|feedback> ' +
    '[field=value ...] [--count] [--count-by field] | ' +
    'state.mjs set <name> <key> field=value ... | ' +
    'state.mjs check-evidence <template> | ' +
    'state.mjs feedback list|add|set'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

// The store: the only code that touches `migration/` on disk. Reads validate, writes
// validate and are atomic (temp file, rename), every entity id is made here.
import { createHash } from 'node:crypto';
import {
  access, mkdir, readdir, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { validate } from './schema.mjs';

export const ROOT = 'migration';

/** `<prefix>-<12 hex of sha1(seed)>`: pag-, typ-, chr-, frg-, sel-, not-, mig-. */
export const id = (prefix, seed) => (
  `${prefix}-${createHash('sha1').update(seed).digest('hex').slice(0, 12)}`);

/** A run id: the moment and the step, readable and sortable. */
export const runId = (step, now = new Date()) => (
  `run-${now.toISOString().replace(/[-:]|\.\d+/g, '')}-${step}`);

const exists = (file) => access(file).then(() => true, () => false);

/**
 * Opens the store at `<cwd>/migration`. Nothing is created until the first write; `init`
 * is the migration layer's business.
 *
 * @returns {{root: string, path: (rel: string) => string, exists, read, write, list,
 *   remove, now: () => Date}}
 */
export function openStore(cwd = process.cwd(), { now = () => new Date() } = {}) {
  const root = path.join(cwd, ROOT);
  const abs = (rel) => path.join(root, rel);
  return {
    root,
    now,
    path: abs,
    exists: (rel) => exists(abs(rel)),
    /** Reads and validates; `expected` pins the schema the caller wants; null when absent. */
    async read(rel, expected = null) {
      const text = await readFile(abs(rel), 'utf8').catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (text === null) return null;
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error(`${path.join(ROOT, rel)} is not valid JSON (${err.message})`);
      }
      validate(data, path.join(ROOT, rel), expected);
      return data;
    },
    /** Validates, stamps `updatedAt`, writes atomically. Returns what was written. */
    async write(rel, data) {
      const stamped = { ...data, updatedAt: now().toISOString() };
      validate(stamped, path.join(ROOT, rel));
      const file = abs(rel);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(stamped, null, 2)}\n`);
      await rename(tmp, file);
      return stamped;
    },
    /** The files directly under a directory of the store, by name; [] when absent. */
    async list(rel) {
      return (await readdir(abs(rel)).catch(() => [])).filter((f) => !f.endsWith('.tmp')).sort();
    },
    remove: (rel) => rm(abs(rel), { force: true, recursive: true }),
  };
}

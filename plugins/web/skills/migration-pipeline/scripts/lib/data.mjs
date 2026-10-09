// The data layer, loaded from the migration-data sibling: installed beside this skill
// (`../migration-data`), or where setup recorded it. Every module of the layer is
// re-exported from here so the pipeline imports one thing.
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSetupJson } from './setup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exists = (file) => access(file).then(() => true, () => false);

/** The migration-data skill's `scripts/lib/` directory, or an error naming the fix. */
export async function layerDir(cwd = process.cwd()) {
  const beside = path.resolve(here, '..', '..', '..', 'migration-data', 'scripts', 'lib');
  if (await exists(path.join(beside, 'store.mjs'))) return beside;
  const setup = await readSetupJson(cwd);
  const skill = setup?.skills?.['migration-data']?.path;
  if (skill) {
    const dir = path.join(path.dirname(skill), 'scripts', 'lib');
    if (await exists(path.join(dir, 'store.mjs'))) return dir;
  }
  throw new Error('the migration-data skill is not installed beside this one; run'
    + ' pipeline setup --install');
}

const cache = new Map();

/** One module of the layer: `await layer('pages')` → the module's exports. */
export async function layer(name, cwd = process.cwd()) {
  const key = `${cwd}:${name}`;
  if (!cache.has(key)) {
    const dir = await layerDir(cwd);
    cache.set(key, import(pathToFileURL(path.join(dir, `${name}.mjs`)).href));
  }
  return cache.get(key);
}

/** The whole layer at once, for a script that uses several modules. */
export async function data(cwd = process.cwd()) {
  const names = ['migration', 'runs', 'state', 'pages', 'selections', 'composition', 'website',
    'elements', 'inventory', 'notes', 'views', 'store', 'trees', 'triage', 'chrome', 'bands'];
  const modules = await Promise.all(names.map((n) => layer(n, cwd)));
  return Object.fromEntries(names.map((n, i) => [n, modules[i]]));
}

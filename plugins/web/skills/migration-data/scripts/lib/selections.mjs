// Selections: a named set of pages, frozen as ids, with the criteria that chose them —
// what the operator approves for caching, what a phase runs on, what the plan names once
// the pages to migrate are decided. Frozen ids make a run reproducible; the criteria make
// the selection readable and remakeable.
import { HEAD, register } from './schema.mjs';
import { id as makeId, openStore } from './store.mjs';

export const DIR = 'pages/selections';
export const SCHEMA = 'pages/selection@1';
export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

register('pages/selection', 1, 'decision', {
  type: 'object',
  required: ['schema', 'id', 'name', 'created', 'criteria', 'pages'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    id: { type: 'string', pattern: '^sel-[0-9a-f]{12}$' },
    name: { type: 'string', pattern: NAME.source },
    created: { type: 'string', format: 'date-time' },
    summary: { type: 'string' },
    criteria: { type: 'object' },
    pages: { type: 'array', items: { type: 'string', pattern: '^pag-[0-9a-f]{12}$' } },
  },
});

const file = (name) => `${DIR}/${name}.json`;

/**
 * Creates a selection: a name, the page ids it freezes, the criteria that chose them (free
 * form: `{ count, groups, exclude, audit }`, whatever the chooser used) and a summary in
 * words. Refuses a name already taken — a selection is frozen; make another.
 */
export async function create(cwd, name, pages, { criteria = {}, summary } = {}) {
  if (!NAME.test(name)) {
    throw new Error(`selection name "${name}": lowercase letters, digits and dashes, 1–64 chars`);
  }
  const store = openStore(cwd);
  if (await store.exists(file(name))) {
    throw new Error(`selection ${name} exists and is frozen; create another name`);
  }
  const ids = [...new Set(pages)];
  if (!ids.length) throw new Error(`selection ${name}: no pages`);
  const now = store.now();
  return store.write(file(name), {
    schema: SCHEMA,
    id: makeId('sel', `${name}|${now.toISOString()}`),
    name,
    created: now.toISOString(),
    summary: summary ?? `${ids.length} pages`,
    criteria,
    pages: ids,
  });
}

/** The selection by name, or null. */
export const read = (cwd, name) => openStore(cwd).read(file(name), SCHEMA);

/** Every selection, by name. */
export async function list(cwd) {
  const store = openStore(cwd);
  const names = (await store.list(DIR)).filter((n) => n.endsWith('.json'));
  return Promise.all(names.map((n) => store.read(`${DIR}/${n}`, SCHEMA)));
}

/** The page ids of several selections at once, as a set; an unknown name is an error. */
export async function pagesOf(cwd, names) {
  const out = new Set();
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    const sel = await read(cwd, name);
    if (!sel) {
      const names = (await list(cwd)).map((s) => s.name).join(', ') || 'none';
      throw new Error(`no selection ${name}; existing: ${names}`);
    }
    for (const id of sel.pages) out.add(id);
  }
  return out;
}

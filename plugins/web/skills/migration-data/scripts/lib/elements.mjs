// The elements: the site's vocabulary of element types as a method found them (derived),
// what each type is in EDS terms (one decision file, six kinds), and each method's own
// knobs. Nothing here knows a site: a type's identity is the method's string for "these
// two elements are the same thing".
import { HEAD, register } from './schema.mjs';
import { id as makeId, openStore } from './store.mjs';

export const TYPES_FILE = 'elements/types.json';
export const TYPES_SCHEMA = 'elements/types@1';
export const ELEMENTS_FILE = 'elements/elements.json';
export const ELEMENTS_SCHEMA = 'elements/elements@1';
export const METHOD_SCHEMA = 'elements/method@1';
export const methodFile = (name) => `elements/methods/${name}.json`;

/** The EDS words a type can be, plus wrapper (no element: look inside) and skip. */
export const KINDS = ['section', 'block', 'default-content', 'fragment', 'wrapper', 'skip'];
export const RESERVED_NAMES = ['header', 'footer', 'section', 'fragment'];
const NAME = '^[a-z][a-z0-9-]*$';

const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });
const count = { type: 'integer', minimum: 0 };

export const typeId = (identity) => makeId('typ', identity);

register('elements/types', 1, 'derived', {
  type: 'object',
  required: ['schema', 'summary', 'method', 'recurrence', 'types'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    method: {
      type: 'object',
      required: ['name', 'at'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: NAME }, version: { type: 'string' },
        at: { type: 'string', format: 'date-time' }, inputs: { type: 'string' },
      },
    },
    recurrence: { type: 'integer', minimum: 1 },
    types: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'identity', 'pages', 'instances', 'recurring', 'variants', 'sample'],
        additionalProperties: false,
        properties: {
          id: idPattern('typ'),
          identity: { type: 'string' },
          pages: count,
          instances: count,
          support: { type: 'number', minimum: 0, maximum: 1 },
          recurring: { type: 'boolean' },
          heights: {
            type: 'object',
            required: ['median', 'min', 'max'],
            additionalProperties: false,
            properties: {
              median: { type: 'number' }, min: { type: 'number' }, max: { type: 'number' },
            },
          },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'children', 'instances', 'pages'],
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                children: { type: 'array', items: { type: 'string' } },
                instances: count,
                pages: count,
              },
            },
          },
          sample: {
            type: 'object',
            required: ['page', 'selector'],
            additionalProperties: false,
            properties: { page: idPattern('pag'), selector: { type: 'string' } },
          },
          evidence: { type: 'array', items: { type: 'string' } },
          mergedFrom: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
});

const decision = (kind, extra = {}) => ({
  type: 'object',
  required: ['kind', ...Object.keys(extra)],
  additionalProperties: false,
  properties: { kind: { const: kind }, ...extra, notes: { type: 'string' } },
});

register('elements/elements', 1, 'decision', {
  type: 'object',
  required: ['schema', 'types'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    types: {
      type: 'object',
      additionalProperties: {
        oneOf: [
          decision(null),
          decision('section', { style: { type: ['string', 'null'] } }),
          decision('block', { block: { type: 'string', pattern: NAME } }),
          decision('default-content'),
          decision('fragment', { fragment: { type: 'string', pattern: NAME } }),
          decision('wrapper'),
          decision('skip'),
        ],
      },
    },
  },
});

register('elements/method', 1, 'decision', {
  type: 'object',
  required: ['schema', 'name', 'rules'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    name: { type: 'string', pattern: NAME },
    rules: { type: 'object' },
  },
});

/** The types in words. */
export function summariseTypes(types, recurrence) {
  const recurring = types.filter((t) => t.recurring);
  const variants = types.reduce((n, t) => n + t.variants.length, 0);
  return `${types.length} element types, ${recurring.length} recurring (on ${recurrence}+ pages),`
    + ` ${variants} variants; ${types.filter((t) => t.pages === 1).length} seen on one page only.`;
}

/**
 * Writes the vocabulary a method found: types with their ids (made here from the
 * identity when absent), counts, variants, sample and evidence; the recurrence threshold
 * the method used. The decisions file is seeded with every recurring type undecided.
 */
export async function writeTypes(cwd, { method, recurrence = 2, types, summary }) {
  const withIds = types.map((t) => ({ ...t, id: t.id ?? typeId(t.identity) }));
  const written = await openStore(cwd).write(TYPES_FILE, {
    schema: TYPES_SCHEMA, method, recurrence, types: withIds,
    summary: summary ?? summariseTypes(withIds, recurrence),
  });
  await seedDecisions(cwd, withIds);
  return written;
}

export const readTypes = (cwd) => openStore(cwd).read(TYPES_FILE, TYPES_SCHEMA);

/** The decisions, or an empty set. */
export async function readDecisions(cwd) {
  const data = await openStore(cwd).read(ELEMENTS_FILE, ELEMENTS_SCHEMA);
  return data ?? { schema: ELEMENTS_SCHEMA, types: {} };
}

/**
 * Every recurring type present in the decisions, undecided (`kind: null`) when new;
 * decided entries for types no longer recurring are kept, undecided ones go.
 */
export async function seedDecisions(cwd, types) {
  const current = await readDecisions(cwd);
  const recurring = new Set(types.filter((t) => t.recurring).map((t) => t.id));
  const kept = Object.fromEntries(Object.entries(current.types)
    .filter(([id, d]) => recurring.has(id) || d.kind));
  for (const id of recurring) kept[id] ??= { kind: null };
  return openStore(cwd).write(ELEMENTS_FILE, { schema: ELEMENTS_SCHEMA, types: kept });
}

/**
 * Decides what a type is: `{ kind, block | style | fragment, notes }`. A block or a
 * fragment needs its name, never a reserved one; a section may name its style.
 */
export async function decide(cwd, id, what) {
  const current = await readDecisions(cwd);
  if (!(id in current.types)) {
    throw new Error(`${id} is not a type to decide (not recurring, or not in types.json)`);
  }
  const name = what.block ?? what.fragment;
  if (name && RESERVED_NAMES.includes(name)) {
    throw new Error(`"${name}" is not a name for a ${what.kind}: header and footer are the`
      + ' template\'s fragments, section and fragment are kinds');
  }
  return openStore(cwd).write(ELEMENTS_FILE, {
    schema: ELEMENTS_SCHEMA, types: { ...current.types, [id]: what },
  });
}

/** The types still undecided. */
export const undecided = async (cwd) => Object.entries((await readDecisions(cwd)).types)
  .filter(([, d]) => d.kind === null).map(([id]) => id);

/** A method's own knobs: what adapts it to this site. Free-form under `rules`. */
export async function writeMethod(cwd, name, rules) {
  return openStore(cwd).write(methodFile(name), { schema: METHOD_SCHEMA, name, rules });
}

export const readMethod = (cwd, name) => openStore(cwd).read(methodFile(name), METHOD_SCHEMA);

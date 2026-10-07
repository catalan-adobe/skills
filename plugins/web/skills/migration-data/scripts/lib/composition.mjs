// A document's composition — a page's, or a fragment's: the document in EDS shape. The
// shared documents the template places (header, footer) at the top; sections in order,
// each with its items (default content, a block of the site's vocabulary, or a fragment
// embedded in the page); and what the method saw and left out. One schema whatever
// method found it; the schema fixes the depth as a document's is fixed.
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';
import { read as readTable, write as writeTable } from './pages.mjs';

export const SCHEMA = 'documents/composition@1';
export const ROLES = ['content', 'block', 'fragment'];
export const DOCUMENT_KINDS = ['page', 'fragment'];
const dirOf = { page: 'pages', fragment: 'fragments' };
export const file = (kind, id, method = null) => (
  `${dirOf[kind]}/${id}/composition${method ? `.${method}` : ''}.json`);

const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });

/** The rendered rectangle, present when the method rendered the page. */
export const BOUNDS = {
  type: 'object',
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
  properties: {
    x: { type: 'number' }, y: { type: 'number' },
    width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 },
  },
};

/** Every node locates itself: a selector always, bounds when rendered. */
const LOCATED = { selector: { type: 'string' }, bounds: BOUNDS };

const ITEM = {
  oneOf: [
    {
      type: 'object',
      required: ['role', 'selector'],
      additionalProperties: false,
      properties: { role: { const: 'content' }, ...LOCATED },
    },
    {
      type: 'object',
      required: ['role', 'selector', 'type'],
      additionalProperties: false,
      properties: {
        role: { const: 'block' }, ...LOCATED, type: idPattern('typ'), variant: { type: 'string' },
      },
    },
    {
      type: 'object',
      required: ['role', 'selector', 'ref'],
      additionalProperties: false,
      properties: { role: { const: 'fragment' }, ...LOCATED, ref: idPattern('frg') },
    },
  ],
};

const SECTION = {
  type: 'object',
  required: ['id', 'selector', 'items'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^s\\d+$' },
    ...LOCATED,
    style: { type: 'object', additionalProperties: { type: 'string' } },
    items: { type: 'array', items: ITEM },
  },
};

register('documents/composition', 1, 'derived', {
  type: 'object',
  required: ['schema', 'document', 'method', 'fragments', 'sections', 'omitted'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    document: {
      oneOf: [
        { type: 'object', required: ['kind', 'id'], additionalProperties: false,
          properties: { kind: { const: 'page' }, id: idPattern('pag') } },
        { type: 'object', required: ['kind', 'id'], additionalProperties: false,
          properties: { kind: { const: 'fragment' }, id: idPattern('frg') } },
      ],
    },
    method: {
      type: 'object',
      required: ['name', 'at'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
        version: { type: 'string' },
        at: { type: 'string', format: 'date-time' },
        inputs: { type: 'string' },
      },
    },
    fragments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'selector'],
        additionalProperties: false,
        properties: { ref: idPattern('frg'), ...LOCATED },
      },
    },
    sections: { type: 'array', items: SECTION },
    omitted: {
      type: 'array',
      items: {
        type: 'object',
        required: ['selector', 'reason'],
        additionalProperties: false,
        properties: { ...LOCATED, reason: { type: 'string' } },
      },
    },
  },
});

/** Every shared document a composition uses: template-placed and embedded alike. */
export const fragmentRefs = (composition) => [...new Set([
  ...composition.fragments.map((f) => f.ref),
  ...composition.sections.flatMap((s) => s.items.filter((i) => i.role === 'fragment')
    .map((i) => i.ref)),
])];

/**
 * Writes a page's composition and reflects it on the page record: the shared documents it
 * uses and a summary (method, when, sections, omitted). `current` (default true) makes
 * this method the page's current composition; another method's can sit beside it as
 * `composition.<method>.json`.
 */
export async function write(cwd, pageId, composition, { current = true } = {}) {
  const store = openStore(cwd);
  const table = await readTable(cwd);
  const page = table.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`no page ${pageId} in the table`);
  const data = { ...composition, schema: SCHEMA, document: { kind: 'page', id: pageId } };
  const written = await store.write(file('page', pageId, current ? null : data.method.name), data);
  if (current) {
    const summary = {
      method: written.method.name, at: written.method.at,
      sections: written.sections.length, omitted: written.omitted.length,
    };
    await writeTable(cwd, table.pages.map((p) => (
      p.id === pageId ? { ...p, fragments: fragmentRefs(written), composition: summary } : p)));
  }
  return written;
}

/**
 * Writes a fragment's composition: a shared document has sections and items like a page;
 * a fragment placed by the template (a header) does not itself place others.
 */
export async function writeFragment(cwd, fragmentId, composition, { current = true } = {}) {
  const data = {
    ...composition, schema: SCHEMA, document: { kind: 'fragment', id: fragmentId },
  };
  const rel = file('fragment', fragmentId, current ? null : data.method.name);
  return openStore(cwd).write(rel, data);
}

/** A document's composition — the current one, or a named method's; null when absent. */
export const read = (cwd, pageId, method = null) => (
  openStore(cwd).read(file('page', pageId, method), SCHEMA));
export const readFragment = (cwd, fragmentId, method = null) => (
  openStore(cwd).read(file('fragment', fragmentId, method), SCHEMA));

/** Every item of every section, flat, with its section id. */
export const items = (composition) => composition.sections
  .flatMap((s) => s.items.map((item) => ({ section: s.id, ...item })));

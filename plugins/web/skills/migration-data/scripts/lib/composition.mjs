// A page's composition: the page in EDS document shape — chrome at the page level, sections
// in order, each with its items (default content, a block of the site's vocabulary, or a
// fragment referring to another document), and what the method saw and left out. One
// schema whatever method found it; the schema fixes the depth as a document's is fixed.
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';
import { read as readTable, write as writeTable } from './pages.mjs';

export const SCHEMA = 'pages/composition@1';
export const ROLES = ['content', 'block', 'fragment'];
export const file = (pageId, method = null) => (
  `pages/${pageId}/composition${method ? `.${method}` : ''}.json`);

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

register('pages/composition', 1, 'derived', {
  type: 'object',
  required: ['schema', 'page', 'method', 'chrome', 'sections', 'omitted'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    page: idPattern('pag'),
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
    chrome: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'selector'],
        additionalProperties: false,
        properties: { ref: idPattern('chr'), ...LOCATED },
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

/**
 * Writes a page's composition and reflects it on the page record: the chrome variants it
 * carries and a summary of the composition (method, when, sections, omitted). `current`
 * (default true) makes this method the page's current composition; another method's can
 * sit beside it as `composition.<method>.json`.
 */
export async function write(cwd, pageId, composition, { current = true } = {}) {
  const store = openStore(cwd);
  const table = await readTable(cwd);
  const page = table.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`no page ${pageId} in the table`);
  const data = { ...composition, schema: SCHEMA, page: pageId };
  const written = await store.write(file(pageId, current ? null : data.method.name), data);
  if (current) {
    const chrome = [...new Set(written.chrome.map((c) => c.ref))];
    const summary = {
      method: written.method.name, at: written.method.at,
      sections: written.sections.length, omitted: written.omitted.length,
    };
    await writeTable(cwd, table.pages.map((p) => (
      p.id === pageId ? { ...p, chrome, composition: summary } : p)));
  }
  return written;
}

/** A page's composition — the current one, or a named method's; null when absent. */
export const read = (cwd, pageId, method = null) => (
  openStore(cwd).read(file(pageId, method), SCHEMA));

/** Every item of every section, flat, with its section id. */
export const items = (composition) => composition.sections
  .flatMap((s) => s.items.map((item) => ({ section: s.id, ...item })));

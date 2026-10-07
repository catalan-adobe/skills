// The inventory: the EDS reading of the site, derived from the types, the decisions and
// the pages' compositions — the blocks with their types and counts, the sections and their
// styles, the fragments and their reuse, default content, wrappers, skipped, undecided,
// and which pages are fully read. The numbers a migration is budgeted on.
import { read as readComposition } from './composition.mjs';
import { readDecisions, readTypes } from './elements.mjs';
import { read as readTable } from './pages.mjs';
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';
import { readFragments } from './website.mjs';

export const FILE = 'elements/inventory.json';
export const SCHEMA = 'elements/inventory@1';

const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });
const count = { type: 'integer', minimum: 0 };
const ids = (prefix) => ({ type: 'array', items: idPattern(prefix) });

const named = (nameKey) => ({
  type: 'object',
  required: [nameKey, 'types', 'instances', 'pages'],
  additionalProperties: false,
  properties: {
    [nameKey]: { type: ['string', 'null'] }, types: ids('typ'), instances: count, pages: count,
    variants: count, sample: { type: 'object' },
    evidence: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
});

register('elements/inventory', 1, 'derived', {
  type: 'object',
  required: ['schema', 'summary', 'derivedFrom', 'blocks', 'sections', 'fragments',
    'defaultContent', 'wrappers', 'skipped', 'undecided', 'orphaned', 'coverage'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    derivedFrom: {
      type: 'object',
      required: ['types', 'elements'],
      additionalProperties: false,
      properties: { types: { type: 'string' }, elements: { type: 'string' } },
    },
    blocks: { type: 'array', items: named('block') },
    sections: { type: 'array', items: named('style') },
    fragments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fragment', 'types', 'instances', 'pages'],
        additionalProperties: false,
        properties: {
          fragment: { type: 'string' }, id: { type: ['string', 'null'] }, types: ids('typ'),
          instances: count, pages: count,
        },
      },
    },
    defaultContent: {
      type: 'object',
      required: ['types', 'instances', 'pages'],
      additionalProperties: false,
      properties: { types: ids('typ'), instances: count, pages: count },
    },
    wrappers: ids('typ'),
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'identity', 'pages', 'instances'],
        additionalProperties: false,
        properties: {
          id: idPattern('typ'), identity: { type: 'string' }, pages: count, instances: count,
          notes: { type: 'string' },
        },
      },
    },
    undecided: ids('typ'),
    orphaned: ids('typ'),
    coverage: {
      type: 'object',
      required: ['pages', 'composed', 'read', 'open'],
      additionalProperties: false,
      properties: {
        pages: count, composed: count, read: count,
        open: {
          type: 'array',
          items: {
            type: 'object',
            required: ['page', 'types'],
            additionalProperties: false,
            properties: { page: idPattern('pag'), types: ids('typ'), empty: { type: 'boolean' } },
          },
        },
      },
    },
  },
});

const sum = (list, f) => list.reduce((n, t) => n + f(t), 0);

/** Types grouped by a decision field (block name, section style, fragment name). */
function grouped(types, decisions, kind, key) {
  const groups = new Map();
  for (const t of types) {
    const d = decisions[t.id];
    if (d?.kind !== kind) continue;
    const name = d[key] ?? null;
    const g = groups.get(name) ?? { [key]: name, types: [], notes: [] };
    g.types.push(t);
    if (d.notes) g.notes.push(d.notes);
    groups.set(name, g);
  }
  return [...groups.values()].map((g) => {
    const lead = [...g.types].sort((a, b) => b.pages - a.pages)[0];
    return {
      [key]: g[key], types: g.types.map((t) => t.id),
      instances: sum(g.types, (t) => t.instances), pages: sum(g.types, (t) => t.pages),
      variants: sum(g.types, (t) => t.variants.length), sample: lead.sample,
      evidence: g.types.flatMap((t) => t.evidence?.slice(0, 1) ?? []), notes: g.notes,
    };
  }).sort((a, b) => b.pages - a.pages || String(a[key]).localeCompare(String(b[key])));
}

/**
 * Derives the inventory and writes it. Coverage reads the compositions: a page is read
 * when it has a composition, and every block item's type is decided a block, no item's
 * type is undecided or skipped, and the page is not empty.
 */
export async function write(cwd) {
  const typesFile = await readTypes(cwd);
  if (!typesFile) throw new Error('no elements/types.json; a decomposition method writes it');
  const { types } = typesFile;
  const decisions = (await readDecisions(cwd)).types;
  const knownFragments = (await readFragments(cwd))?.fragments ?? [];
  const byId = new Map(types.map((t) => [t.id, t]));
  const recurring = types.filter((t) => t.recurring);
  const kindOf = (id) => decisions[id]?.kind ?? null;

  const blocks = grouped(recurring, decisions, 'block', 'block');
  const sections = grouped(recurring, decisions, 'section', 'style');
  const fragments = grouped(recurring, decisions, 'fragment', 'fragment').map((g) => ({
    fragment: g.fragment, types: g.types, instances: g.instances, pages: g.pages,
    id: knownFragments.find((f) => f.placement === 'inline' && f.name === g.fragment)?.id ?? null,
  }));
  const dc = recurring.filter((t) => kindOf(t.id) === 'default-content');
  const defaultContent = {
    types: dc.map((t) => t.id), instances: sum(dc, (t) => t.instances),
    pages: sum(dc, (t) => t.pages),
  };
  const wrappers = recurring.filter((t) => kindOf(t.id) === 'wrapper').map((t) => t.id);
  const skipped = recurring.filter((t) => kindOf(t.id) === 'skip').map((t) => ({
    id: t.id, identity: t.identity, pages: t.pages, instances: t.instances,
    ...(decisions[t.id].notes ? { notes: decisions[t.id].notes } : {}),
  }));
  const undecided = recurring.filter((t) => kindOf(t.id) === null && t.id in decisions)
    .map((t) => t.id);
  const orphaned = Object.keys(decisions).filter((id) => !byId.get(id)?.recurring);

  const { pages } = await readTable(cwd);
  const composed = pages.filter((p) => p.composition);
  const open = [];
  for (const p of composed) {
    // eslint-disable-next-line no-await-in-loop
    const c = await readComposition(cwd, p.id);
    const items = c.sections.flatMap((s) => s.items);
    if (!items.length && !c.fragments.length) {
      open.push({ page: p.id, types: [], empty: true });
      continue;
    }
    const blockTypes = items.filter((i) => i.role === 'block').map((i) => i.type);
    const bad = [...new Set(blockTypes
      .filter((id) => !['block', 'default-content'].includes(kindOf(id))))];
    if (bad.length) open.push({ page: p.id, types: bad });
  }
  const coverage = { pages: pages.length, composed: composed.length,
    read: composed.length - open.length, open };

  const summary = `${blocks.length} blocks, ${sections.length} section styles, ${fragments.length}`
    + ` inline fragments, ${dc.length} default content types, ${wrappers.length} wrappers,`
    + ` ${skipped.length} skipped, ${undecided.length} undecided; ${coverage.read} of`
    + ` ${coverage.composed} composed pages fully read (${pages.length} known).`;
  const store = openStore(cwd);
  return store.write(FILE, {
    schema: SCHEMA, summary,
    derivedFrom: {
      types: typesFile.updatedAt, elements: (await readDecisions(cwd)).updatedAt ?? '',
    },
    blocks, sections, fragments, defaultContent, wrappers, skipped, undecided, orphaned, coverage,
  });
}

export const read = (cwd) => openStore(cwd).read(FILE, SCHEMA);

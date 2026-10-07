// The website as a whole: a summary of what is known about the source (derived from the
// page table), how to open one of its pages (a decision: the browser recipe and the
// overlays), and its chrome variants (derived: definitions, not page lists — a page says
// which variants it carries; "pages with variant X" is a query).
import { open as openMigration } from './migration.mjs';
import { list as listPages, read as readTable } from './pages.mjs';
import { HEAD, register } from './schema.mjs';
import { id as makeId, openStore } from './store.mjs';

export const WEBSITE_FILE = 'website/website.json';
export const WEBSITE_SCHEMA = 'website/website@1';
export const ACCESS_FILE = 'website/access.json';
export const ACCESS_SCHEMA = 'website/access@1';
export const CHROME_FILE = 'website/chrome.json';
export const CHROME_SCHEMA = 'website/chrome@1';
export const OVERLAY_ACTIONS = ['hide', 'click', 'remove'];
export const CHROME_PARTS = ['header', 'footer'];

const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });
const count = { type: 'integer', minimum: 0 };

register('website/website', 1, 'derived', {
  type: 'object',
  required: ['schema', 'summary', 'source', 'discovery', 'counts', 'groups'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    source: {
      type: 'object',
      required: ['origin', 'scope'],
      additionalProperties: false,
      properties: { origin: { type: 'string' }, scope: { type: 'string' } },
    },
    discovery: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'urls'],
        additionalProperties: false,
        properties: { from: { type: 'string' }, source: { type: 'string' }, urls: count },
      },
    },
    counts: {
      type: 'object',
      required: ['urls', 'inScope', 'in', 'out', 'undecided', 'cached', 'composed'],
      additionalProperties: false,
      properties: {
        urls: count, inScope: count, in: count, out: count, undecided: count,
        cached: count, composed: count,
      },
    },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'urls', 'in', 'cached', 'composed'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' }, urls: count, in: count, cached: count, composed: count,
        },
      },
    },
  },
});

register('website/access', 1, 'decision', {
  type: 'object',
  required: ['schema', 'browser', 'overlays', 'verifiedOn'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    browser: {
      type: 'object',
      required: ['engine'],
      properties: { engine: { type: 'string' } },
    },
    overlays: {
      type: 'array',
      items: {
        type: 'object',
        required: ['selector', 'action'],
        additionalProperties: false,
        properties: {
          selector: { type: 'string' },
          action: { enum: OVERLAY_ACTIONS },
          css: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
    },
    scrollFix: { type: 'string' },
    verifiedOn: { type: 'array', items: idPattern('pag') },
  },
});

register('website/chrome', 1, 'derived', {
  type: 'object',
  required: ['schema', 'summary', 'method', 'variants', 'rejected'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    method: {
      type: 'object',
      required: ['name', 'at'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' }, version: { type: 'string' },
        at: { type: 'string', format: 'date-time' }, inputs: { type: 'string' },
      },
    },
    variants: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'part', 'selectors', 'optional', 'pages'],
        additionalProperties: false,
        properties: {
          id: idPattern('chr'),
          part: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
          label: { type: 'string' },
          selectors: { type: 'array', items: { type: 'string' }, minItems: 1 },
          optional: { type: 'array', items: { type: 'string' } },
          pages: count,
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        required: ['selector', 'reason'],
        additionalProperties: false,
        properties: { selector: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
});

/** A chrome variant's id: of its part and its first member selector. */
export const chromeId = (part, selectors) => makeId('chr', `${part}|${selectors[0]}`);

/**
 * Rewrites website.json from the migration and the page table: discovery sources, counts
 * by verdict, cache and composition, the groups (in-scope pages only), a summary.
 */
export async function refresh(cwd) {
  const migration = await openMigration(cwd);
  const { pages } = await readTable(cwd);
  const inScope = pages.filter((p) => p.group !== null);
  const by = (list, f) => list.filter(f).length;
  const discovery = [...pages.reduce((m, p) => {
    const key = `${p.discovered.from}|${p.discovered.source ?? ''}`;
    m.set(key, (m.get(key) ?? 0) + 1);
    return m;
  }, new Map())].map(([key, urls]) => {
    const [from, source] = key.split('|');
    return { from, ...(source ? { source } : {}), urls };
  });
  const groups = [...new Set(inScope.map((p) => p.group))].sort().map((name) => {
    const members = inScope.filter((p) => p.group === name);
    return {
      name, urls: members.length,
      in: by(members, (p) => p.verdict.status === 'in'),
      cached: by(members, (p) => p.cache), composed: by(members, (p) => p.composition),
    };
  }).sort((a, b) => b.urls - a.urls || a.name.localeCompare(b.name));
  const counts = {
    urls: pages.length, inScope: inScope.length,
    in: by(pages, (p) => p.verdict.status === 'in'),
    out: by(pages, (p) => p.verdict.status === 'out'),
    undecided: by(pages, (p) => p.verdict.status === 'undecided'),
    cached: by(pages, (p) => p.cache), composed: by(pages, (p) => p.composition),
  };
  const summary = `${migration.source.scope}: ${counts.inScope} URLs in scope`
    + ` (${pages.length} known) in ${groups.length} groups; ${counts.in} in, ${counts.out} out,`
    + ` ${counts.undecided} undecided; ${counts.cached} cached, ${counts.composed} composed.`;
  return openStore(cwd).write(WEBSITE_FILE, {
    schema: WEBSITE_SCHEMA, summary, source: migration.source, discovery, counts, groups,
  });
}

export const readWebsite = (cwd) => openStore(cwd).read(WEBSITE_FILE, WEBSITE_SCHEMA);

/**
 * How to open a page of this site: the browser recipe (engine and whatever the probe
 * found necessary), the overlays to hide, click or remove, an optional scroll fix, and
 * the pages the recipe was verified on. One decision file; a page is opened one way.
 */
export async function writeAccess(cwd, {
  browser, overlays = [], scrollFix, verifiedOn = [], summary,
}) {
  return openStore(cwd).write(ACCESS_FILE, {
    schema: ACCESS_SCHEMA, browser, overlays, ...(scrollFix ? { scrollFix } : {}),
    verifiedOn: [...new Set(verifiedOn)],
    summary: summary ?? `${browser.engine}; ${overlays.length} overlay rule(s); verified on`
      + ` ${new Set(verifiedOn).size} page(s)`,
  });
}

export const readAccess = (cwd) => openStore(cwd).read(ACCESS_FILE, ACCESS_SCHEMA);

/**
 * The chrome variants a site has — any number, each a part (header, footer, or a named
 * other), its member selectors, optional members, the count of pages carrying it and its
 * evidence — with the method that found them and the candidates it rejected. Ids are
 * made here from part and first selector; a variant given an id keeps it.
 */
export async function writeChrome(cwd, { method, variants, rejected = [], summary }) {
  const withIds = variants.map((v) => ({ ...v, id: v.id ?? chromeId(v.part, v.selectors) }));
  const parts = [...new Set(withIds.map((v) => v.part))];
  return openStore(cwd).write(CHROME_FILE, {
    schema: CHROME_SCHEMA, method, variants: withIds, rejected,
    summary: summary ?? `${withIds.length} chrome variant(s) over ${parts.join(', ') || 'no part'};`
      + ` ${rejected.length} candidate(s) rejected`,
  });
}

export const readChrome = (cwd) => openStore(cwd).read(CHROME_FILE, CHROME_SCHEMA);

/** The pages carrying a chrome variant — a query over the table, never a stored list. */
export const pagesWith = (cwd, chromeVariantId) => listPages(cwd, { chrome: chromeVariantId });

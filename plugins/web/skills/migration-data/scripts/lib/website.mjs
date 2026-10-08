// The website as a whole: a summary of what is known about the source (derived from the
// page table), how to open one of its pages (a decision: the browser recipe and the
// overlays), and its shared documents — the fragments: header and footer placed by the
// template, banners embedded in pages (derived: definitions, not page lists — a page says
// which fragments it uses; "pages using fragment X" is a query).
import { open as openMigration } from './migration.mjs';
import { composed, list as listPages, read as readTable } from './pages.mjs';
import { HEAD, register } from './schema.mjs';
import { id as makeId, openStore } from './store.mjs';

export const WEBSITE_FILE = 'website/website.json';
export const WEBSITE_SCHEMA = 'website/website@1';
export const ACCESS_FILE = 'website/access.json';
export const ACCESS_SCHEMA = 'website/access@1';
export const FRAGMENTS_FILE = 'website/fragments.json';
export const FRAGMENTS_SCHEMA = 'website/fragments@1';
export const OVERLAY_ACTIONS = ['hide', 'click', 'remove'];
export const PLACEMENTS = ['template', 'inline'];

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
      properties: {
        origin: { type: 'string' }, scope: { type: 'string' },
        assetOrigins: { type: 'array', items: { type: 'string' } },
      },
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

/**
 * The shared documents of the site. A fragment placed by the template (`template`) has a
 * `part`: `header`, `footer`, or a named other; one header is one document however many
 * bands compose it — two header fragments are two designs, never two bands of one. A
 * fragment embedded in pages (`inline`) is placed by a fragment block where the page
 * wants it. Each fragment has its own composition under `fragments/<id>/`.
 */
register('website/fragments', 1, 'derived', {
  type: 'object',
  required: ['schema', 'summary', 'method', 'fragments', 'rejected'],
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
    fragments: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['id', 'placement', 'part', 'selectors', 'optional', 'pages'],
            additionalProperties: false,
            properties: {
              id: idPattern('frg'),
              placement: { const: 'template' },
              part: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
              label: { type: 'string' },
              selectors: { type: 'array', items: { type: 'string' }, minItems: 1 },
              optional: { type: 'array', items: { type: 'string' } },
              pages: count,
              evidence: { type: 'array', items: { type: 'string' } },
            },
          },
          {
            type: 'object',
            required: ['id', 'placement', 'name', 'selectors', 'pages'],
            additionalProperties: false,
            properties: {
              id: idPattern('frg'),
              placement: { const: 'inline' },
              name: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
              label: { type: 'string' },
              selectors: { type: 'array', items: { type: 'string' }, minItems: 1 },
              type: idPattern('typ'),
              pages: count,
              evidence: { type: 'array', items: { type: 'string' } },
            },
          },
        ],
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

/** A fragment's id: a template one of its part, an inline one of its name. */
export const fragmentId = (placement, partOrName) => makeId('frg', `${placement}|${partOrName}`);

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
      cached: by(members, (p) => p.cache), composed: by(members, composed),
    };
  }).sort((a, b) => b.urls - a.urls || a.name.localeCompare(b.name));
  const counts = {
    urls: pages.length, inScope: inScope.length,
    in: by(pages, (p) => p.verdict.status === 'in'),
    out: by(pages, (p) => p.verdict.status === 'out'),
    undecided: by(pages, (p) => p.verdict.status === 'undecided'),
    cached: by(pages, (p) => p.cache), composed: by(pages, composed),
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
 * Adds one overlay rule to the access decision — what an agent does on seeing, in a
 * capture, an element the recipe should have hidden: a chat widget, a late banner. A
 * `hide` rule without CSS gets the plain one; a rule for a selector already there is
 * replaced. The rule is not verified: `verifiedOn` stays as it was.
 */
export async function addOverlay(cwd, { selector, action, css, note }) {
  const access = await readAccess(cwd);
  if (!access) throw new Error('no website/access.json yet; run the access step first');
  if (!selector || !OVERLAY_ACTIONS.includes(action)) {
    throw new Error(`an overlay needs a selector and one of ${OVERLAY_ACTIONS.join(', ')}`);
  }
  const rule = {
    selector, action,
    ...(action === 'hide' ? { css: css ?? [`${selector} { display: none !important; }`] } : {}),
    ...(note ? { note } : {}),
  };
  const overlays = [...access.overlays.filter((o) => o.selector !== selector), rule];
  const { schema, updatedAt, summary, ...rest } = access;
  return writeAccess(cwd, { ...rest, overlays });
}

/**
 * The shared documents a site has — header, footer and other template-placed parts, and
 * the fragments embedded in pages — with the method that found them and the candidates
 * it rejected. Ids are made here from placement and part or name; a fragment given an id
 * keeps it. Two template fragments of one part are two designs: refused unless labelled.
 */
export async function writeFragments(cwd, { method, fragments, rejected = [], summary }) {
  const withIds = fragments.map((f) => ({
    ...f, id: f.id ?? fragmentId(f.placement, f.placement === 'template' ? f.part : f.name),
  }));
  const parts = withIds.filter((f) => f.placement === 'template').map((f) => f.part);
  const twice = parts.filter((p, i) => parts.indexOf(p) !== i);
  for (const part of new Set(twice)) {
    const same = withIds.filter((f) => f.placement === 'template' && f.part === part);
    if (same.some((f) => !f.label) || new Set(same.map((f) => f.id)).size !== same.length) {
      throw new Error(`two template fragments for part ${part}: one header is one document,`
        + ' however many bands; a second design needs its own id and label');
    }
  }
  const inline = withIds.filter((f) => f.placement === 'inline').length;
  const named = [...new Set(parts)].join(', ') || 'none';
  return openStore(cwd).write(FRAGMENTS_FILE, {
    schema: FRAGMENTS_SCHEMA, method, fragments: withIds, rejected,
    summary: summary ?? `${parts.length} template fragment(s) (${named}), ${inline} inline;`
      + ` ${rejected.length} candidate(s) rejected`,
  });
}

export const readFragments = (cwd) => openStore(cwd).read(FRAGMENTS_FILE, FRAGMENTS_SCHEMA);

/** The pages using a fragment — a query over the table, never a stored list. */
export const pagesUsing = (cwd, fragmentIdValue) => listPages(cwd, { fragment: fragmentIdValue });

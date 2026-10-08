// The pages: one record per URL the migration knows, with the facts the units produced and
// a verdict — in, out or undecided, and above all why — computed from those facts, the
// plan and the operator's decisions. One table, `pages/pages.json`; the layer hides it.
import { open as openMigration } from './migration.mjs';
import { HEAD, register } from './schema.mjs';
import { read as readSelection } from './selections.mjs';
import { id as makeId, openStore } from './store.mjs';

export const FILE = 'pages/pages.json';
export const SCHEMA = 'pages/table@1';
export const DECISIONS_FILE = 'pages/decisions.json';
export const DECISIONS_SCHEMA = 'pages/decisions@1';

export const KINDS = ['page', 'binary', 'redirect', 'error', 'unreachable', 'unknown'];
export const DISCOVERED_FROM = ['sitemap', 'crawl', 'list', 'link'];
export const STATUSES = ['in', 'out', 'undecided'];
export const REASON_KINDS = ['exclude', 'flag'];
export const REASON_BY = ['discover', 'plan', 'cache', 'chrome', 'composition', 'operator'];
/** The closed vocabulary of reasons; the schema is their documentation. */
export const REASONS = {
  'off-scope': 'the URL is not under source.scope',
  'over-budget': 'beyond plan.pages: not in the plan\'s selection',
  'not-a-page': 'a binary or an asset, not an HTML page',
  redirect: 'the URL redirects elsewhere',
  'http-error': 'the site answered with an error status',
  unreachable: 'the site did not answer',
  duplicate: 'the same final URL as another page',
  'no-header': 'no header chrome found on the page',
  'no-footer': 'no footer chrome found on the page',
  empty: 'nothing between the chrome',
  broken: 'the capture failed',
  'too-tall': 'the rendered page is taller than a browser can screenshot whole',
  operator: 'the operator decided',
};
export const REASON_CODES = Object.keys(REASONS);

const nullable = (type) => ({ type: [type, 'null'] });
const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });

const REASON = {
  type: 'object',
  required: ['code', 'kind', 'by', 'at'],
  additionalProperties: false,
  properties: {
    code: { enum: REASON_CODES },
    kind: { enum: REASON_KINDS },
    by: { enum: REASON_BY },
    at: { type: 'string', format: 'date-time' },
    detail: { type: 'string' },
  },
};

export const RECORD = {
  type: 'object',
  required: ['id', 'url', 'group', 'discovered', 'http', 'redirect', 'finalUrl', 'kind',
    'verdict', 'cache', 'fragments', 'composition'],
  additionalProperties: false,
  properties: {
    id: idPattern('pag'),
    url: { type: 'string', pattern: '^https?://' },
    group: { type: ['string', 'null'] },
    discovered: {
      type: 'object',
      required: ['from', 'at'],
      additionalProperties: false,
      properties: {
        from: { enum: DISCOVERED_FROM },
        at: { type: 'string', format: 'date-time' },
        source: { type: 'string' },
      },
    },
    http: {
      type: ['object', 'null'],
      required: ['status'],
      additionalProperties: false,
      properties: {
        status: { type: 'integer', minimum: 100, maximum: 599 },
        contentType: nullable('string'),
        bytes: { type: 'integer', minimum: 0 },
      },
    },
    redirect: {
      type: ['object', 'null'],
      required: ['status', 'target'],
      additionalProperties: false,
      properties: { status: { type: 'integer' }, target: { type: 'string' } },
    },
    finalUrl: nullable('string'),
    kind: { enum: KINDS },
    verdict: {
      type: 'object',
      required: ['status', 'reasons'],
      additionalProperties: false,
      properties: { status: { enum: STATUSES }, reasons: { type: 'array', items: REASON } },
    },
    cache: {
      type: ['object', 'null'],
      required: ['at', 'path', 'selection'],
      additionalProperties: false,
      properties: {
        at: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
        selection: nullable('string'),
      },
    },
    fragments: { type: 'array', items: idPattern('frg') },
    composition: {
      type: ['object', 'null'],
      required: ['method', 'at', 'sections', 'omitted'],
      additionalProperties: false,
      properties: {
        method: { type: 'string' },
        at: { type: 'string', format: 'date-time' },
        sections: { type: 'integer', minimum: 0 },
        omitted: { type: 'integer', minimum: 0 },
      },
    },
  },
};

register('pages/table', 1, 'derived', {
  type: 'object',
  required: ['schema', 'summary', 'pages'],
  additionalProperties: false,
  properties: { ...HEAD, summary: { type: 'string' }, pages: { type: 'array', items: RECORD } },
});

register('pages/decisions', 1, 'decision', {
  type: 'object',
  required: ['schema', 'pages'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    pages: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['status', 'reason', 'at'],
        additionalProperties: false,
        properties: {
          status: { enum: ['in', 'out'] },
          reason: { type: 'string' },
          at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
});

/** A URL in its canonical form: no fragment, no trailing slash on a path (kept on roots). */
export function canonical(url) {
  const u = new URL(url);
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

export const pageId = (url) => makeId('pag', canonical(url));

/** The group: the first path segment below the scope; '' at the scope root. */
export function groupOf(url, scope) {
  if (!url.startsWith(scope)) return null;
  const rest = url.slice(scope.length).split(/[?#]/)[0];
  const segments = rest.split('/').filter(Boolean);
  return segments.length > 1 ? segments[0] : '';
}

/** A fresh record for a URL just discovered; off-scope pages have no group. */
export function record(url, { from, source, at }, scope) {
  const href = canonical(url);
  return {
    id: pageId(href), url: href, group: groupOf(href, scope),
    discovered: { from, at, ...(source ? { source } : {}) },
    http: null, redirect: null, finalUrl: null, kind: 'unknown',
    verdict: { status: 'undecided', reasons: [] },
    cache: null, fragments: [], composition: null,
  };
}

const reason = (code, kind, by, at, detail) => (
  { code, kind, by, at, ...(detail ? { detail } : {}) });

/**
 * The reasons the table itself can see from a record's facts: out of scope, not a page, a
 * redirect, an error, unreachable, a duplicate final URL. Other units add theirs.
 */
export function factReasons(rec, { scope, finalUrls, at }) {
  const out = [];
  if (!rec.url.startsWith(scope)) out.push(reason('off-scope', 'exclude', 'discover', at));
  if (rec.kind === 'binary') out.push(reason('not-a-page', 'exclude', 'cache', at));
  if (rec.kind === 'redirect') {
    out.push(reason('redirect', 'exclude', 'cache', at, rec.redirect?.target ?? rec.finalUrl));
  }
  if (rec.kind === 'error') {
    out.push(reason('http-error', 'exclude', 'cache', at, `HTTP ${rec.http?.status}`));
  }
  if (rec.kind === 'unreachable') out.push(reason('unreachable', 'exclude', 'cache', at));
  if (rec.kind === 'page' && rec.finalUrl && finalUrls.get(rec.finalUrl) !== rec.id
    && finalUrls.has(rec.finalUrl)) {
    out.push(reason('duplicate', 'exclude', 'cache', at,
      `same final URL as ${finalUrls.get(rec.finalUrl)}`));
  }
  return out;
}

/**
 * The verdict: the operator's decision wins; else an exclude reason puts the page out;
 * else the plan decides — in the plan's selection: in; a selection named and the page not
 * in it: out, over budget; a budget without a selection: undecided; no plan: in.
 */
export function verdict(rec, reasons, { decision, plan, selected, at }) {
  const all = reasons.filter((r) => r.by !== 'operator');
  if (decision) {
    all.push(reason('operator', decision.status === 'out' ? 'exclude' : 'flag', 'operator',
      decision.at, decision.reason));
    return { status: decision.status, reasons: all };
  }
  if (all.some((r) => r.kind === 'exclude')) return { status: 'out', reasons: all };
  if (plan.selection) {
    if (selected.has(rec.id)) return { status: 'in', reasons: all };
    all.push(reason('over-budget', 'exclude', 'plan', at, `not in selection ${plan.selection}`));
    return { status: 'out', reasons: all };
  }
  return { status: plan.pages ? 'undecided' : 'in', reasons: all };
}

/** The table in words: counts by status, by reason, cached and composed. */
/** Composed: a composition with sections — one of fragments only is not the page read. */
export const composed = (p) => (p.composition?.sections ?? 0) > 0;

export function summarise(pages) {
  const n = pages.length;
  const by = (f) => pages.filter(f).length;
  const reasons = new Map();
  for (const p of pages) {
    for (const r of p.verdict.reasons) reasons.set(r.code, (reasons.get(r.code) ?? 0) + 1);
  }
  const list = [...reasons].sort((a, b) => b[1] - a[1]).map(([c, k]) => `${k} ${c}`).join(', ');
  const groups = new Set(pages.filter((p) => p.group !== null).map((p) => p.group));
  return `${n} URLs in ${groups.size} groups: `
    + `${by((p) => p.verdict.status === 'in')} in, ${by((p) => p.verdict.status === 'out')} out, `
    + `${by((p) => p.verdict.status === 'undecided')} undecided; `
    + `${by((p) => p.cache)} cached, ${by(composed)} composed`
    + (list ? `. Reasons: ${list}.` : '.');
}

/** The table, or an empty one. */
export async function read(cwd) {
  const data = await openStore(cwd).read(FILE, SCHEMA);
  return data ?? { schema: SCHEMA, summary: summarise([]), pages: [] };
}

/** The operator's decisions, or none. */
export async function decisions(cwd) {
  return (await openStore(cwd).read(DECISIONS_FILE, DECISIONS_SCHEMA))?.pages ?? {};
}

/**
 * Writes the table from `pages`, recomputing every verdict against the migration's scope
 * and plan, the operator's decisions and the plan's selection when one is named.
 */
export async function write(cwd, pages) {
  const store = openStore(cwd);
  const migration = await openMigration(cwd);
  const decided = await decisions(cwd);
  let selected = null;
  if (migration.plan.selection) {
    const sel = await readSelection(cwd, migration.plan.selection);
    if (!sel) {
      throw new Error(`plan.selection names ${migration.plan.selection}, which does not exist`);
    }
    selected = new Set(sel.pages);
  }
  const at = store.now().toISOString();
  const finalUrls = new Map();
  for (const p of pages) {
    if (p.kind === 'page' && p.finalUrl && !finalUrls.has(p.finalUrl)) {
      finalUrls.set(p.finalUrl, p.id);
    }
  }
  const recomputed = new Set(['discover', 'cache', 'plan', 'operator']);
  const judged = pages.map((p) => {
    const kept = p.verdict.reasons.filter((r) => !recomputed.has(r.by));
    const facts = factReasons(p, { scope: migration.source.scope, finalUrls, at });
    const v = verdict(p, [...kept, ...facts], {
      decision: decided[p.id], plan: migration.plan, selected, at,
    });
    return { ...p, verdict: v };
  });
  return store.write(FILE, { schema: SCHEMA, summary: summarise(judged), pages: judged });
}

/** Recomputes every verdict (after a plan change, a new selection, a decision). */
export const rejudge = async (cwd) => write(cwd, (await read(cwd)).pages);

/**
 * Adds or updates records: by id, a patch merges over the existing record; a new URL
 * becomes a record. Returns the written table.
 */
export async function upsert(cwd, entries) {
  const migration = await openMigration(cwd);
  const table = await read(cwd);
  const byId = new Map(table.pages.map((p) => [p.id, p]));
  const at = openStore(cwd).now().toISOString();
  for (const e of entries) {
    const url = canonical(e.url);
    const id = pageId(url);
    const current = byId.get(id) ?? record(url, {
      from: e.discovered?.from ?? 'list', source: e.discovered?.source, at: e.discovered?.at ?? at,
    }, migration.source.scope);
    const { url: _u, discovered: _d, id: _i, verdict: _v, ...patch } = e;
    byId.set(id, { ...current, ...patch });
  }
  return write(cwd, [...byId.values()]);
}

/**
 * Replaces one unit's reasons on some pages: `by` names the unit, `flags` maps page id →
 * reasons it found (code, kind, detail); pages not in `flags` lose that unit's reasons.
 */
export async function setReasons(cwd, by, flags) {
  const table = await read(cwd);
  const at = openStore(cwd).now().toISOString();
  const pages = table.pages.map((p) => ({
    ...p,
    verdict: {
      ...p.verdict,
      reasons: [
        ...p.verdict.reasons.filter((r) => r.by !== by),
        ...(flags[p.id] ?? []).map((f) => reason(f.code, f.kind, by, at, f.detail)),
      ],
    },
  }));
  return write(cwd, pages);
}

/** One record, by id or URL; null when unknown. */
export async function get(cwd, idOrUrl) {
  const id = idOrUrl.startsWith('pag-') ? idOrUrl : pageId(idOrUrl);
  return (await read(cwd)).pages.find((p) => p.id === id) ?? null;
}

/** Records matching every given filter. */
export async function list(cwd, {
  group, kind, status, reason: code, cached, composed, fragment,
} = {}) {
  return (await read(cwd)).pages.filter((p) => (
    (group === undefined || p.group === group)
    && (kind === undefined || p.kind === kind)
    && (status === undefined || p.verdict.status === status)
    && (code === undefined || p.verdict.reasons.some((r) => r.code === code))
    && (cached === undefined || Boolean(p.cache) === cached)
    && (composed === undefined || Boolean(p.composition) === composed)
    && (fragment === undefined || p.fragments.includes(fragment))));
}

/** Records the operator's word on a page; `status` in or out, with the reason. */
export async function decide(cwd, idOrUrl, status, why) {
  const store = openStore(cwd);
  const page = await get(cwd, idOrUrl);
  if (!page) throw new Error(`no page ${idOrUrl} in the table`);
  if (!why) throw new Error('a decision needs its reason, in words');
  const current = await decisions(cwd);
  await store.write(DECISIONS_FILE, {
    schema: DECISIONS_SCHEMA,
    pages: { ...current, [page.id]: { status, reason: why, at: store.now().toISOString() } },
  });
  return rejudge(cwd);
}

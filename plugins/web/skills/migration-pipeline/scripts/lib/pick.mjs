// pick: representative pages — one from each of the largest groups in turn, inside pages
// before a group's landing page, one URL shape at a time (depth, extension, query) — from
// the pages not yet cached and not out. Writes a selection when asked. Nothing is
// fetched: whether a page answers is the cache step's finding.
import { createHash } from 'node:crypto';
import { data } from './data.mjs';

const NOT_A_PAGE = /\.(pdf|xml|txt|php|json|csv|zip|jpe?g|png|gif|svg|mp4|css|js)$/i;
const isPage = (url) => !NOT_A_PAGE.test(new URL(url).pathname);

/** A URL's shape below its group: depth, extension, a query string. */
export function stratum(url, scope) {
  const u = new URL(url);
  const rest = u.href.startsWith(scope) ? u.href.slice(scope.length) : u.pathname;
  const segments = rest.split(/[?#]/)[0].split('/').filter(Boolean);
  const ext = (segments.at(-1) ?? '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
  return `${segments.length}|${ext}|${u.search ? 'q' : ''}`;
}

/** One from each list in turn, each list in its own order. */
export function interleave(lists) {
  const out = [];
  const total = lists.reduce((n, l) => n + l.length, 0);
  for (let i = 0; out.length < total; i += 1) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

const byHash = (a, b) => createHash('sha1').update(a.url).digest('hex')
  .localeCompare(createHash('sha1').update(b.url).digest('hex'));

/**
 * Picks `count` pages: round-robin over the groups, largest first, skipping `exclude`d
 * groups; within a group, pages inside it before its landing page, strata interleaved.
 * `audit` adds that many pages from the excluded groups, one group at a time, by hash.
 */
export function choose(pages, scope, { count = 2, exclude = [], audit = 0 } = {}) {
  const candidates = pages.filter((p) => p.group !== null && !p.cache
    && p.verdict.status !== 'out' && isPage(p.url));
  const byGroup = new Map();
  for (const p of candidates) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
  const skip = new Set(exclude);
  const ranked = [...byGroup].filter(([g]) => !skip.has(g))
    .sort((a, b) => b[1].length - a[1].length || (a[0] === '') - (b[0] === '')
      || a[0].localeCompare(b[0]));
  const depth = (p) => stratum(p.url, scope).split('|')[0];
  const queues = ranked.map(([group, members]) => {
    const inside = members.filter((p) => Number(depth(p)) >= 2);
    const landing = members.filter((p) => Number(depth(p)) < 2);
    const strata = [...Map.groupBy(inside, (p) => stratum(p.url, scope)).values()];
    return { group, rest: [...interleave(strata), ...landing] };
  });
  const picks = [];
  let progressed = true;
  while (picks.length < count && progressed) {
    progressed = false;
    for (const q of queues) {
      if (picks.length >= count || !q.rest.length) continue;
      picks.push({ page: q.rest.shift(), group: q.group });
      progressed = true;
    }
  }
  const picked = new Set(picks.map((p) => p.page.id));
  const pool = interleave([...byGroup].filter(([g]) => !skip.size || skip.has(g))
    .map(([group, members]) => members.filter((p) => !picked.has(p.id)).sort(byHash)
      .map((page) => ({ page, group, audit: true }))));
  return [...picks, ...pool.slice(0, audit)];
}

/** The command: picks, and writes a selection when `write` names one. */
export async function pick(cwd, { count = 2, exclude = [], audit = 0, write } = {}) {
  const { migration, pages, selections } = await data(cwd);
  const m = await migration.open(cwd);
  const table = await pages.read(cwd);
  const picks = choose(table.pages, m.source.scope, { count, exclude, audit });
  const out = picks.map((p) => ({
    id: p.page.id, url: p.page.url, group: p.group, ...(p.audit ? { audit: true } : {}),
  }));
  if (!write) return { picks: out };
  const selection = await selections.create(cwd, write, out.map((p) => p.id), {
    criteria: { count, exclude, audit },
    summary: `${out.length} pages, one per group in turn (${new Set(out.map((p) => p.group)).size}`
      + ` groups)${audit ? `, ${out.filter((p) => p.audit).length} as audit` : ''}`,
  });
  return { picks: out, selection: selection.name, pages: selection.pages.length };
}

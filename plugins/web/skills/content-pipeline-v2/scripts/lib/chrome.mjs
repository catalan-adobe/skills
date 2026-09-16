// Chrome detection over the captures: a structural fingerprint per element, then the
// elements that recur across pages at a stable position — the candidates for header and
// footer. Pure functions over capture objects ({ url, tree, nodeMap }).
import { createHash } from 'node:crypto';

export const FINGERPRINT_DEPTH = 3;
export const POSITION_TOLERANCE_PX = 40;

// Class tokens that say "state", not "what": the current menu item or an open panel must
// not make the same header look like another one.
const STATE_TOKEN = new RegExp('^(active|current|selected|open|opened|closed|show|shown|hidden'
  + '|expanded|collapsed|focus|hover|visible|is-|has-|js-)');
// Generated identifiers (component hashes, cache busters) differ between pages or locales.
const HASHED = /[0-9a-f]{6,}|\d{4,}/i;

/** The class tokens worth comparing: no state, no generated names, sorted. */
export function tokens(className) {
  return [...new Set(String(className ?? '').split(/\s+/).filter(Boolean)
    .filter((t) => !STATE_TOKEN.test(t) && !HASHED.test(t)))].sort();
}

/** An element's id when it is a real name, not a generated one. */
export const stableId = (id) => (id && !HASHED.test(id) ? id : '');

/**
 * A structural fingerprint: tag, stable id, class tokens and the same for children down to
 * `depth`. Text, bounds, hrefs and generated ids are left out on purpose.
 */
export function fingerprint(node, depth = FINGERPRINT_DEPTH) {
  const own = `${node.tag}#${stableId(node.id)}.${tokens(node.className).join('.')}`;
  const kids = depth > 0 ? (node.children ?? []).map((c) => fingerprint(c, depth - 1)) : [];
  return createHash('sha1').update(`${own}[${kids.join(',')}]`).digest('hex').slice(0, 12);
}

/** Every node with its depth and parent fingerprint, for one capture. */
export function walk(tree, pageHeight, depth = 0, parent = null, out = []) {
  const fp = fingerprint(tree);
  const { x, y, width, height } = tree.bounds;
  out.push({
    fp, parent, depth, node: tree, y, height, width, x,
    bottomOffset: pageHeight - (y + height),
  });
  for (const child of tree.children ?? []) walk(child, pageHeight, depth + 1, fp, out);
  return out;
}

const spread = (values) => Math.max(...values) - Math.min(...values);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// ponytail: fixed-width position buckets; two occurrences 1 px apart across a bucket edge
// split. Cluster by gaps if a real site shows that.
const bucket = (value, tolerance) => Math.round(value / tolerance);

/**
 * Recurring elements across the captures. A candidate is a fingerprint at a position: the
 * same structure at the top of every page and again at its bottom are two candidates (page
 * tree prunes narrow children, so a bare wrapper looks like any other). Each occurrence
 * joins a top-anchored and a bottom-anchored bucket; a bucket becomes a candidate with the
 * pages carrying it, support, median bounds, spreads, selectors, parent fingerprint. When a
 * fingerprint's top and bottom buckets hold the same occurrences, the tighter one stays.
 * The root (`body`) is never a candidate; nor is anything seen on one page only.
 */
export function candidates(captures, { tolerance = POSITION_TOLERANCE_PX } = {}) {
  const buckets = new Map();
  for (const capture of captures) {
    const pageHeight = capture.tree.bounds.height;
    for (const n of walk(capture.tree, pageHeight).slice(1)) {
      const keys = [
        `${n.fp}|top:${bucket(n.y, tolerance)}`,
        `${n.fp}|bottom:${bucket(n.bottomOffset, tolerance)}`,
      ];
      for (const key of keys) {
        const entry = buckets.get(key) ?? {
          fp: n.fp, anchored: key.includes('|top:') ? 'top' : 'bottom', parent: n.parent,
          depth: n.depth, occurrences: [], pages: new Set(), selectors: new Set(),
          tags: new Set(), sample: null,
        };
        if (entry.pages.has(capture.url)) continue; // a repeated card counts once per page
        entry.pages.add(capture.url);
        entry.occurrences.push(n);
        entry.selectors.add(n.node.selector);
        entry.tags.add(n.node.tag);
        entry.sample ??= { url: capture.url, selector: n.node.selector, node: n.node };
        buckets.set(key, entry);
      }
    }
  }
  const total = captures.length;
  // One page is not a recurrence: a lone bucket is stable only trivially.
  const list = [...buckets.values()].filter((e) => e.pages.size >= 2).map((e) => {
    const ys = e.occurrences.map((o) => o.y);
    const bottoms = e.occurrences.map((o) => o.bottomOffset);
    const topSpread = spread(ys);
    const bottomSpread = spread(bottoms);
    return {
      fp: e.fp, anchored: e.anchored, parent: e.parent, depth: e.depth, pages: [...e.pages],
      support: e.pages.size / total, tags: [...e.tags], selectors: [...e.selectors],
      bounds: {
        y: median(ys), height: median(e.occurrences.map((o) => o.height)),
        width: median(e.occurrences.map((o) => o.width)), bottomOffset: median(bottoms),
      },
      topSpread, bottomSpread,
      stable: e.anchored === 'top' ? topSpread <= tolerance : bottomSpread <= tolerance,
      sample: e.sample,
    };
  });
  return dedupeAnchors(list).sort((a, b) => b.support - a.support || a.depth - b.depth);
}

/** Of a fingerprint's top and bottom buckets over the same pages, keep the tighter one. */
function dedupeAnchors(list) {
  const byFpPages = new Map();
  for (const c of list) {
    const key = `${c.fp}|${[...c.pages].sort().join(',')}`;
    const other = byFpPages.get(key);
    const tighter = (a) => (a.anchored === 'top' ? a.topSpread : a.bottomSpread);
    if (!other || tighter(c) < tighter(other)) byFpPages.set(key, c);
  }
  return [...byFpPages.values()];
}

/**
 * Candidates worth looking at: recurring on at least `minSupport` of the pages, at a stable
 * position, and not merely the child of a candidate that already recurs on the same pages.
 */
export function chromeCandidates(all, { minSupport = 0.5 } = {}) {
  const byFp = new Map();
  for (const c of all) byFp.set(c.fp, [...(byFp.get(c.fp) ?? []), c]);
  return all.filter((c) => c.support >= minSupport && c.stable).filter((c) => {
    const parents = c.parent ? byFp.get(c.parent) ?? [] : [];
    return !parents.some((p) => p.stable && p.support >= minSupport
      && p.pages.length === c.pages.length);
  });
}

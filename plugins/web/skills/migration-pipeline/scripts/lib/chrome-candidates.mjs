// Chrome detection over the captures: a structural fingerprint per element, then the
// elements that recur across pages at a stable position — the candidates for header and
// footer. Pure functions over capture objects ({ url, tree, nodeMap }).
import { createHash } from 'node:crypto';

export const FINGERPRINT_DEPTH = 3;
// A child this thin is a border, a rule or a progress bar, not structure.
export const HAIRLINE_PX = 6;
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
 * The children that count as structure: hairlines dropped, and a single-child chain
 * collapsed the way page-tree collapses one when it prunes — so a wrapper whose only
 * visible child is the nav, and the same wrapper rendered with a 5 px progress bar next
 * to the nav on another page, are the same structure.
 */
export function structuralChildren(node) {
  let kids = (node.children ?? []).filter((c) => (c.bounds?.height ?? Infinity) > HAIRLINE_PX);
  while (kids.length === 1) {
    kids = (kids[0].children ?? []).filter((c) => (c.bounds?.height ?? Infinity) > HAIRLINE_PX);
  }
  return kids;
}

/**
 * An element's own identity: tag, stable id and class tokens (`keepToken` filters them
 * further). A node page-tree collapsed carries the chain of elements it absorbed and may have
 * taken the box of the innermost one; its identity is the outermost element, the same on
 * every page however deep the collapse went.
 */
export function own(node, keepToken = () => true) {
  const head = node.collapsed?.[0] ?? node;
  return `${head.tag}#${stableId(head.id)}.${tokens(head.className).filter(keepToken).join('.')}`;
}

/**
 * A structural fingerprint: the element's own identity and the set of its structural
 * children's fingerprints down to `depth` — a set, so a footer with four link columns and
 * one with five are one footer (repetition is variation, as the elements engine reads it).
 * Text, bounds, hrefs and generated ids are left out on purpose.
 */
export function fingerprint(node, depth = FINGERPRINT_DEPTH) {
  const kids = depth > 0
    ? [...new Set(structuralChildren(node).map((c) => fingerprint(c, depth - 1)))].sort() : [];
  return createHash('sha1').update(`${own(node)}[${kids.join(',')}]`).digest('hex').slice(0, 12);
}

/** Every node with its depth and parent fingerprint, for one capture. */
export function walk(tree, pageHeight, depth = 0, ancestors = [], out = []) {
  const fp = fingerprint(tree);
  const { x, y, width, height } = tree.bounds;
  out.push({
    fp, parent: ancestors.at(-1) ?? null, ancestors, depth, node: tree, y, height, width, x,
    bottomOffset: pageHeight - (y + height),
  });
  for (const child of tree.children ?? []) {
    walk(child, pageHeight, depth + 1, [...ancestors, fp], out);
  }
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
  for (const [ci, capture] of captures.entries()) {
    const pageHeight = capture.tree.bounds.height;
    for (const [ni, n] of walk(capture.tree, pageHeight).slice(1).entries()) {
      n.id = `${ci}:${ni}`;
      const keys = [
        `${n.fp}|top:${bucket(n.y, tolerance)}`,
        `${n.fp}|bottom:${bucket(n.bottomOffset, tolerance)}`,
      ];
      for (const key of keys) {
        const entry = buckets.get(key) ?? {
          fp: n.fp, anchored: key.includes('|top:') ? 'top' : 'bottom', parent: n.parent,
          ancestors: n.ancestors, depth: n.depth, occurrences: [], pages: new Set(),
          selectors: new Set(), tags: new Set(), sample: null,
        };
        if (entry.pages.has(capture.url)) continue; // a repeated card counts once per page
        entry.pages.add(capture.url);
        entry.occurrences.push(n);
        entry.selectors.add(n.node.selector);
        for (const c of n.node.collapsed ?? []) entry.selectors.add(c.selector);
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
      occurrences: e.occurrences.map((o) => o.id).sort().join(' '),
      fp: e.fp, anchored: e.anchored, parent: e.parent, ancestors: e.ancestors, depth: e.depth,
      pages: [...e.pages],
      support: e.pages.size / total, tags: [...e.tags], selectors: [...e.selectors],
      bounds: {
        y: median(ys), height: median(e.occurrences.map((o) => o.height)),
        width: median(e.occurrences.map((o) => o.width)), bottomOffset: median(bottoms),
      },
      topSpread, bottomSpread,
      stable: e.anchored === 'top' ? topSpread <= tolerance : bottomSpread <= tolerance,
      sample: { ...e.sample, text: e.sample.node.text ?? '' },
    };
  });
  return dedupeAnchors(list).sort((a, b) => b.support - a.support || a.depth - b.depth);
}

/** Of the top and bottom buckets holding the very same occurrences, keep the tighter one. */
function dedupeAnchors(list) {
  const byOccurrences = new Map();
  for (const c of list) {
    const other = byOccurrences.get(c.occurrences);
    const tighter = (a) => (a.anchored === 'top' ? a.topSpread : a.bottomSpread);
    if (!other || tighter(c) < tighter(other)) byOccurrences.set(c.occurrences, c);
  }
  return [...byOccurrences.values()].map(({ occurrences, ...c }) => c);
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

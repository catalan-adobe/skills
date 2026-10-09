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
  + '|expanded|collapsed|focus|hover|visible|appear|appeared|loaded|loading|ready|in-view'
  + '|inview|revealed|animated|lazyloaded|sticky|stuck|scrolled|is-|has-|js-)$|^(is-|has-|js-)');
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

/**
 * An element's key across pages: its own identity under its parent's tag and id. Looser
 * than the fingerprint — a footer whose link columns differ by locale is one footer — and
 * tighter than the identity alone, which a generic grid cell shares with every other. The
 * parent's classes stay out: a body carries the page's own (`single-post`, `home`).
 */
export const keyOf = (node, parentNode) => {
  const parent = parentNode ? `${parentNode.tag}#${stableId(parentNode.id)}` : '';
  return `${parent}>${own(node)}`;
};

/**
 * The text an element shows — its own and, for a container with none, what is inside it,
 * up to `limit` characters — normalised, for comparing one page's with another's.
 */
export function textOf(node, limit = 300) {
  const parts = [];
  let length = 0;
  const take = (n) => {
    const t = String(n.text ?? '').replace(/\s+/g, ' ').trim();
    if (t) { parts.push(t); length += t.length; }
    for (const c of n.children ?? []) {
      if (length >= limit) return;
      take(c);
    }
  };
  take(node);
  return parts.join(' ').toLowerCase().slice(0, limit);
}

/** Drawn entirely above or left of the page: a skip link parked off-screen. */
export const offScreen = (b) => b.y + b.height <= 0 || b.x + b.width <= 0;

/** Every node with its depth, key, parent key and bottom offset, for one capture. */
export function walk(tree, pageHeight, depth = 0, ancestors = [], out = [], parentNode = null) {
  const fp = fingerprint(tree);
  const key = keyOf(tree, parentNode);
  const { x, y, width, height } = tree.bounds;
  out.push({
    fp, key, parent: ancestors.at(-1) ?? null, ancestors, depth, node: tree, y, height, width, x,
    bottomOffset: pageHeight - (y + height), text: textOf(tree),
  });
  for (const child of tree.children ?? []) {
    walk(child, pageHeight, depth + 1, [...ancestors, key], out, tree);
  }
  return out;
}

const spread = (values) => Math.max(...values) - Math.min(...values);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Stable: this share of an element's occurrences sit within twice the tolerance of its
// median position. A banner pushing the header down on a fifth of the pages is no drift.
export const STABLE_SHARE = 0.75;
export const STABLE_WITHIN = 2;
// Occurrences of one key further apart than this are different elements (the same wrapper
// used for the nav and for the footer); nearer, the same element shifted by a banner.
export const SPLIT_GAP_PX = 150;

/** Groups sorted positions into runs no two neighbours of which are further than `gap`. */
function clusters(items, position, gap) {
  const sorted = [...items].sort((a, b) => position(a) - position(b));
  const out = [];
  for (const item of sorted) {
    const last = out.at(-1);
    if (last && position(item) - position(last.at(-1)) <= gap) last.push(item);
    else out.push([item]);
  }
  return out;
}
const withinOfMedian = (values, tolerance) => {
  const m = median(values);
  return values.filter((v) => Math.abs(v - m) <= tolerance).length / values.length;
};

const modalShare = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Math.max(...counts.values()) / values.length;
};

// A group this small says nothing about stability on its own (one page agrees with
// itself): smaller groups are pooled and judged together.
export const MIN_GROUP_FOR_TEXT = 3;

/**
 * How stable a text is across pages, judged within each group of pages and weighted by
 * the group's size: a header reads in ten languages on a ten-locale site and is still the
 * same header; a title band differs on every page of its own group.
 */
export function textStabilityOf(occurrences, groupOf) {
  const groups = new Map();
  // An occurrence without text is no evidence either way (the capture kept none).
  const spoken = occurrences.filter((o) => o.text);
  if (!spoken.length) return 1;
  for (const o of spoken) {
    const g = groupOf(o.url) ?? '';
    groups.set(g, [...(groups.get(g) ?? []), o.text]);
  }
  const pooled = [];
  let weighted = 0;
  for (const texts of groups.values()) {
    if (texts.length >= MIN_GROUP_FOR_TEXT) weighted += modalShare(texts) * texts.length;
    else pooled.push(...texts);
  }
  if (pooled.length) weighted += modalShare(pooled) * pooled.length;
  return weighted / spoken.length;
}

/**
 * Recurring elements across the captures. A candidate is an element (by key), anchored to
 * the top or to the bottom of the page: the same element measured both ways, the tighter
 * anchor kept. A candidate has the pages carrying it, support, median bounds, spreads,
 * whether it is stable (most occurrences within the tolerance of its median position),
 * selectors, its structural variants (distinct fingerprints), the share of the page's
 * width it spans and how stable its text is across pages (chrome says the same thing
 * everywhere; a title band never does). Off-screen elements, the root, and anything seen
 * on one page only are no candidates.
 */
export function candidates(captures, {
  tolerance = POSITION_TOLERANCE_PX, groupOf = () => '',
} = {}) {
  const byKey = new Map();
  const pageWidth = median(captures.map((c) => c.tree.bounds.width || 1280));
  for (const [ci, capture] of captures.entries()) {
    const pageHeight = capture.tree.bounds.height;
    for (const [ni, n] of walk(capture.tree, pageHeight).slice(1).entries()) {
      if (offScreen(n.node.bounds)) continue;
      n.id = `${ci}:${ni}`;
      n.url = capture.url;
      byKey.set(n.key, [...(byKey.get(n.key) ?? []), n]);
    }
  }
  // A key's occurrences, anchored top and bottom, clustered by position: one element per
  // cluster, counted once per page (a repeated card counts once).
  const buckets = [];
  for (const [key, nodes] of byKey) {
    for (const anchored of ['top', 'bottom']) {
      const position = (n) => (anchored === 'top' ? n.y : n.bottomOffset);
      for (const cluster of clusters(nodes, position, SPLIT_GAP_PX)) {
        const entry = {
          key, anchored, parent: cluster[0].parent, ancestors: cluster[0].ancestors,
          depth: cluster[0].depth, occurrences: [], pages: new Set(), selectors: new Set(),
          tags: new Set(), fps: new Map(), sample: null,
        };
        for (const n of cluster) {
          if (entry.pages.has(n.url)) continue;
          entry.pages.add(n.url);
          entry.occurrences.push(n);
          entry.selectors.add(n.node.selector);
          for (const c of n.node.collapsed ?? []) entry.selectors.add(c.selector);
          entry.tags.add(n.node.tag);
          entry.fps.set(n.fp, (entry.fps.get(n.fp) ?? 0) + 1);
          entry.sample ??= { url: n.url, selector: n.node.selector, node: n.node };
        }
        buckets.push(entry);
      }
    }
  }
  const total = captures.length;
  // One page is not a recurrence: a lone bucket is stable only trivially.
  const list = buckets.filter((e) => e.pages.size >= 2).map((e) => {
    const ys = e.occurrences.map((o) => o.y);
    const bottoms = e.occurrences.map((o) => o.bottomOffset);
    const topSpread = spread(ys);
    const bottomSpread = spread(bottoms);
    const width = median(e.occurrences.map((o) => o.width));
    const fp = [...e.fps.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return {
      occurrences: e.occurrences.map((o) => o.id).sort().join(' '),
      key: e.key, fp, variants: e.fps.size, anchored: e.anchored, parent: e.parent,
      ancestors: e.ancestors, depth: e.depth, pages: [...e.pages],
      support: e.pages.size / total, tags: [...e.tags], selectors: [...e.selectors],
      bounds: {
        y: median(ys), height: median(e.occurrences.map((o) => o.height)),
        width, bottomOffset: median(bottoms),
      },
      widthShare: Math.min(1, width / pageWidth),
      textStability: textStabilityOf(e.occurrences, groupOf),
      topSpread, bottomSpread,
      stable: withinOfMedian(e.anchored === 'top' ? ys : bottoms, tolerance * STABLE_WITHIN)
        >= STABLE_SHARE,
      sample: { ...e.sample, text: e.sample.node.text ?? '' },
    };
  });
  return dedupeAnchors(list).sort((a, b) => b.support - a.support || a.depth - b.depth);
}

/** Of an element's top and bottom anchors (the same occurrences), keep the tighter one. */
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
 * position, and not merely the child of an `eligible` candidate that already recurs on the
 * same pages — a page's main grid wrapper recurs everywhere too, but is no chrome, and
 * must not swallow the footer inside it.
 */
export function chromeCandidates(all, { minSupport = 0.5, eligible = () => true } = {}) {
  const byKey = new Map();
  for (const c of all) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  return all.filter((c) => c.support >= minSupport && c.stable).filter((c) => {
    const parents = c.parent ? byKey.get(c.parent) ?? [] : [];
    return !parents.some((p) => p.stable && p.support >= minSupport
      && p.pages.length === c.pages.length && eligible(p));
  });
}

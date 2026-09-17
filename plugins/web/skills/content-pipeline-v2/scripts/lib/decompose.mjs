// Decomposition: a captured page minus its chrome, cut into sections. Pure functions over a
// capture ({ url, tree }) and the chrome step's member selectors.
import { HAIRLINE_PX } from './chrome.mjs';
import { mergeRules } from './elements-rules.mjs';

const PEEL_LIMIT = 12;

/** Every selector a node stands for: its own and the chain page-tree collapsed into it. */
export const selectorsOf = (n) => [n.selector, ...(n.collapsed ?? []).map((c) => c.selector)]
  .filter(Boolean);

/** A node whose visible children are all text-level elements: the peel stops here. */
export const isLeafComponent = (n, rules) => {
  const kids = n.children ?? [];
  return kids.length > 0 && kids.every((k) => rules.leafTags.has(k.tag));
};

/**
 * The sections of a page and what was dropped on the way, each with its reason: chrome
 * members (`chrome`, or `rules.chrome` for one the chrome step missed) and `rules.reject`
 * selectors go first, wrappers around chrome are peeled, a lone node or a dominant container
 * is peeled unless it is a leaf component; then `hairline`, `zero-width` and `off-page` nodes
 * go, and a `part` (a node page-tree promoted out of a sibling section) is attached back.
 *
 * @param {{tree: object}} capture
 * @param {{chromeSelectors?: Iterable<string>, rules?: object}} [options]
 * @returns {{sections: object[], rejected: {selector: string, reason: string}[]}}
 */
export function decompose(capture, { chromeSelectors = [], rules = mergeRules() } = {}) {
  const stepChrome = new Set(chromeSelectors);
  const rejected = [];
  const drop = (n, reason) => { rejected.push({ selector: n.selector, reason }); return false; };
  const dropReason = (n) => {
    const own = selectorsOf(n);
    if (own.some((s) => stepChrome.has(s))) return 'chrome';
    if (own.some((s) => rules.chrome.has(s))) return 'rules.chrome';
    if (own.some((s) => rules.reject.has(s))) return 'rules.reject';
    return null;
  };
  const isChrome = (n) => dropReason(n) !== null;
  // The chrome step's own members are its business; only the rules' drops are reported.
  const keep = (n) => {
    const reason = dropReason(n);
    return reason === null || (reason === 'chrome' ? false : drop(n, reason));
  };
  const hasChromeBelow = (n) => (n.children ?? []).some((c) => isChrome(c) || hasChromeBelow(c));
  const page = capture.tree.bounds;
  let nodes = [capture.tree];
  for (let guard = 0; guard < PEEL_LIMIT; guard += 1) {
    let peeled = false;
    const out = [];
    for (const n of nodes.filter(keep)) {
      if (hasChromeBelow(n)) { out.push(...(n.children ?? [])); peeled = true; continue; }
      out.push(n);
    }
    nodes = out.filter(keep);
    const lone = nodes.length === 1 ? nodes[0] : null;
    if (!peeled && lone && (lone.children ?? []).length && !isLeafComponent(lone, rules)) {
      nodes = lone.children;
      peeled = true;
    }
    const big = nodes.find((n) => n.bounds.height >= page.height * rules.containerShare
      && (n.children ?? []).length && !isLeafComponent(n, rules));
    if (!peeled && big) {
      nodes = nodes.flatMap((n) => (n === big ? n.children : [n]));
      peeled = true;
    }
    if (!peeled) break;
  }
  const onPage = (b) => b.x + b.width > 0 && b.x < page.width && b.y + b.height > 0
    && b.y < page.height;
  const kept = nodes.filter((n) => (n.bounds.height > HAIRLINE_PX || drop(n, 'hairline'))
    && (n.bounds.width > 0 || drop(n, 'zero-width'))
    && (onPage(n.bounds) || drop(n, 'off-page')));
  const partOf = (n) => kept.find((o) => o !== n
    && selectorsOf(o).some((sel) => n.selector.startsWith(`${sel} >`)));
  const sections = kept.filter((n) => !partOf(n) || drop(n, `part of ${partOf(n).selector}`));
  return { sections, rejected };
}

/** The sections alone. */
export const sections = (capture, options) => decompose(capture, options).sections;

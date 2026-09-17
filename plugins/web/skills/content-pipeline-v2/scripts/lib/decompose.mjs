// Decomposition: a captured page minus its chrome, cut into sections. Pure functions over a
// capture ({ url, tree }) and the chrome step's member selectors.
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
 * The sections of a page: chrome members dropped, wrappers around chrome peeled, a lone
 * node or a dominant container peeled unless it is a leaf component; then hairlines,
 * zero-width and off-page nodes dropped, and parts (nodes page-tree promoted out of a
 * sibling section) attached back. Returns the section nodes in document order.
 *
 * @param {{tree: object}} capture
 * @param {{chromeSelectors?: Iterable<string>, rules?: object}} [options]
 */
export function sections(capture, { chromeSelectors = [], rules = mergeRules() } = {}) {
  const chrome = new Set([...chromeSelectors, ...rules.chrome]);
  const isChrome = (n) => selectorsOf(n).some((s) => chrome.has(s));
  const hasChromeBelow = (n) => (n.children ?? []).some((c) => isChrome(c) || hasChromeBelow(c));
  const page = capture.tree.bounds;
  let nodes = [capture.tree];
  for (let guard = 0; guard < PEEL_LIMIT; guard += 1) {
    let peeled = false;
    const out = [];
    for (const n of nodes) {
      if (isChrome(n) || selectorsOf(n).some((s) => rules.reject.has(s))) continue;
      if (hasChromeBelow(n)) { out.push(...(n.children ?? [])); peeled = true; continue; }
      out.push(n);
    }
    nodes = out.filter((n) => !isChrome(n));
    const lone = nodes.length === 1 ? nodes[0] : null;
    if (!peeled && lone && (lone.children ?? []).length && !isLeafComponent(lone, rules)) {
      nodes = lone.children;
      peeled = true;
    }
    const big = nodes.find((n) => n.bounds.height >= page.height * rules.containerShare
      && (n.children ?? []).length > 1 && !isLeafComponent(n, rules));
    if (!peeled && big) {
      nodes = nodes.flatMap((n) => (n === big ? n.children : [n]));
      peeled = true;
    }
    if (!peeled) break;
  }
  const onPage = (b) => b.x + b.width > 0 && b.x < page.width;
  const kept = nodes.filter((n) => n.bounds.height > rules.hairlinePx && n.bounds.width > 0
    && onPage(n.bounds));
  return kept.filter((n) => !kept.some((o) => o !== n
    && selectorsOf(o).some((sel) => n.selector.startsWith(`${sel} >`))));
}

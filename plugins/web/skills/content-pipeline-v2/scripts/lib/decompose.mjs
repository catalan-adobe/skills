// Decomposition: a captured page minus its chrome, cut into sections. Pure functions over a
// capture ({ url, tree }) and the chrome step's member selectors.
import { HAIRLINE_PX, own } from './chrome.mjs';
import { mergeRules } from './elements-rules.mjs';

const PEEL_LIMIT = 12;

/**
 * A node's identity: the outermost element of its collapsed chain — tag, stable id, class
 * tokens minus state, generated names, the rules' exclusions and noise. Children never
 * enter it, so repetition never splits a type.
 */
export function identity(node, rules = mergeRules()) {
  return own(node, (t) => !rules.noiseClasses.has(t)
    && !rules.identityExclusions.some((re) => re.test(t)));
}

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
 * go, a section whose identity is a container or a fragment (`rules.containers`,
 * `rules.fragments`) is replaced by its children — each carrying `within`, the chain of
 * containers and fragments it sat in — and a `part` (a node page-tree promoted out of a
 * sibling section, named in `of`) is attached back.
 *
 * @param {{tree: object}} capture
 * @param {{chromeSelectors?: Iterable<string>, rules?: object, seen?: Set<string>}} [options]
 *   `seen`, when given, collects every identity met while decomposing through containers.
 * @returns {{sections: object[], rejected: {selector: string, reason: string}[]}}
 */
export function decompose(capture,
  { chromeSelectors = [], rules = mergeRules(), seen = null } = {}) {
  const stepChrome = new Set(chromeSelectors);
  const rejected = [];
  const drop = (n, reason, of) => {
    rejected.push({ selector: n.selector, reason, ...(of ? { of } : {}) });
    return false;
  };
  // A node is under a selector when it is that node or one of its descendants (page-tree
  // sometimes keeps a wrapper's children without the wrapper); a rule that matched is
  // recorded in `seen` so an unmatched one can be reported.
  const under = (own, set, record = false) => {
    const hit = [...set].find((m) => own.some((s) => s === m || s.startsWith(`${m} > `)));
    if (hit && record) seen?.add(hit);
    return hit !== undefined;
  };
  const dropReason = (n) => {
    const own = selectorsOf(n);
    if (under(own, stepChrome)) return 'chrome';
    if (under(own, rules.chrome, true)) return 'rules.chrome';
    if (under(own, rules.reject, true)) return 'rules.reject';
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
  const visible = (list) => list.filter((n) => (
    (n.bounds.height > HAIRLINE_PX || drop(n, 'hairline'))
    && (n.bounds.width > 0 || drop(n, 'zero-width'))
    && (onPage(n.bounds) || drop(n, 'off-page'))));
  const kept = visible(nodes.filter(keep))
    .flatMap((n) => through(n, rules, visible, keep, [], seen));
  const partOf = (n) => kept.find((o) => o !== n
    && selectorsOf(o).some((sel) => n.selector.startsWith(`${sel} >`)));
  const sections = kept.filter((n) => !partOf(n) || drop(n, 'part', partOf(n).selector));
  return { sections, rejected };
}

/**
 * A container or fragment section is decomposed through: a collapsed chain (page-tree folds
 * single-child wrappers into one node, outermost first) is walked first — each element that
 * is itself a container or fragment is peeled, the first that is not becomes the section,
 * re-headed at that element so its identity and selectors are its own; when the chain is
 * exhausted the visible children are the sections. Each carries `within`, the chain so far.
 * A re-headed section keeps the node's box (the chain shares one box) but takes the chain
 * element's selector, so its parts and its crop are its own. A declared container with no
 * visible children is a leaf and stays a section under its own identity. `seen` collects
 * every identity met, so a rule that matches nothing can be reported.
 */
function through(node, rules, visible, keep, within = [], seen = null) {
  const chain = node.collapsed ?? [];
  let trail = within;
  for (let head = 0; head < Math.max(1, chain.length); head += 1) {
    const selector = chain[head]?.selector ?? node.selector;
    const current = head === 0 ? node : { ...node, collapsed: chain.slice(head), selector };
    const id = identity(current, rules);
    seen?.add(id);
    const kind = rules.fragments.has(id) ? 'fragment'
      : rules.containers.has(id) ? 'container' : null;
    if (!kind) return [trail.length ? { ...current, within: trail } : current];
    trail = [...trail, { kind, identity: id, selector }];
    if (head >= chain.length - 1) break;
  }
  const children = visible((node.children ?? []).filter(keep));
  if (!children.length) return [within.length ? { ...node, within } : node];
  return children.flatMap((c) => through(c, rules, visible, keep, trail, seen));
}

/** The sections alone. */
export const sections = (capture, options) => decompose(capture, options).sections;

const NOISE = new Set([
  'row', 'container', 'wrapper', 'd-none', 'd-flex', 'd-block', 'text-center',
  'w-100', 'm-auto', 'flex-column',
]);
const NOISE_PREFIX = /^(wp-|col-|mb-|mt-|py-|px-|p-|m-|elementor-element-|e-con)/;

function heightBucket(h) {
  if (h < 80) return 'xs';
  if (h < 400) return 'sm';
  if (h < 1500) return 'md';
  if (h < 5000) return 'lg';
  return 'xl';
}

function classTokens(node) {
  const raw = typeof node.className === 'string' ? node.className : '';
  return [...new Set(
    raw.split(/\s+/).filter(
      (c) => c && !NOISE.has(c) && !NOISE_PREFIX.test(c),
    ),
  )].sort();
}

function nodeToken(node) {
  const parts = [node.tag ?? '?'];
  if (node.layout) parts.push(`[${node.layout}]`);
  if (node.background?.type) parts.push(`[bg:${node.background.type}]`);
  const cls = classTokens(node);
  if (cls.length) parts.push(`[${cls.join('+')}]`);
  parts.push(`[${heightBucket(node.bounds?.height ?? 0)}]`);
  return parts.join('');
}

function childId(parentId, index) {
  return parentId === 'r' ? `rc${index}` : `${parentId}c${index}`;
}

/**
 * Structural fingerprint of a `page-tree` capture.
 *
 * @param {{data: object, nodeMap?: Record<string, object>}} tree
 * @param {{maxDepth?: number}} [options] Depth of `fine` tokens
 * below the root (default 2).
 * @returns {{fine: string, coarse: string, sectionCount: number,
 *   features: string[]}}
 */
export function fingerprintFromTree(tree, { maxDepth = 2 } = {}) {
  const nodeMap = tree?.nodeMap ?? {};
  const fine = [];
  const features = new Set();
  const walk = (node, id, depth) => {
    if (depth > maxDepth) return;
    fine.push(nodeToken(node));
    classTokens(node).forEach((c) => features.add(c));
    if (node.layout) features.add(node.layout);
    (node.children ?? []).forEach((child, i) => {
      const cid = childId(id, i + 1);
      if (nodeMap[cid]?.overlay) return;
      walk(child, cid, depth + 1);
    });
  };
  const root = tree?.data ?? { children: [] };
  walk(root, 'r', 0);
  const topLevel = (root.children ?? []).filter(
    (_, i) => !nodeMap[childId('r', i + 1)]?.overlay,
  );
  return {
    fine: fine.join('|'),
    coarse: topLevel
      .map((n) => `${n.tag}[${heightBucket(n.bounds?.height ?? 0)}]`)
      .join('|'),
    sectionCount: topLevel.length,
    features: [...features].sort(),
  };
}

function lcsLength(a, b) {
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(above, prev[j - 1]);
      diagonal = above;
    }
  }
  return prev[b.length];
}

/**
 * Normalized longest-common-subsequence similarity between two `|`-separated fingerprints.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function similarity(a, b) {
  const ta = a ? a.split('|') : [];
  const tb = b ? b.split('|') : [];
  if (!ta.length && !tb.length) return 1;
  return (2 * lcsLength(ta, tb)) / (ta.length + tb.length);
}

/**
 * Greedy single-pass clustering per sitemap type: a record joins the first cluster whose
 * seed fingerprint is at least `threshold` similar, otherwise starts a new cluster.
 * @param {{url: string, sitemapType: string, fingerprint: string}[]} records
 * @param {{threshold?: number}} [options]
 */
export function clusterRecords(records, { threshold = 0.8 } = {}) {
  const byType = new Map();
  for (const record of records) {
    if (!byType.has(record.sitemapType)) byType.set(record.sitemapType, []);
    const clusters = byType.get(record.sitemapType);
    const home = clusters.find((c) => similarity(c.fingerprint, record.fingerprint) >= threshold);
    if (home) {
      home.members.push(record.url);
    } else {
      clusters.push({
        sitemapType: record.sitemapType, fingerprint: record.fingerprint, members: [record.url],
      });
    }
  }
  return [...byType.keys()].sort().flatMap((type) => byType.get(type)
    .sort((a, b) => b.members.length - a.members.length)
    .map((cluster, index) => ({ ...cluster, index })));
}

/**
 * Greedy set cover: picks members that add the most unseen features first.
 * @param {{url: string, features: string[]}[]} members
 * @param {number} count
 * @returns {string[]} URLs
 */
export function pickRepresentatives(members, count) {
  const remaining = [...members];
  const seen = new Set();
  const picked = [];
  const gain = (m) => (m.features ?? []).filter((f) => !seen.has(f)).length;
  while (picked.length < count && remaining.length) {
    let best = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      if (gain(remaining[i]) > gain(remaining[best])) best = i;
    }
    const [chosen] = remaining.splice(best, 1);
    (chosen.features ?? []).forEach((f) => seen.add(f));
    picked.push(chosen.url);
  }
  return picked;
}

/**
 * Names a cluster from its template seed: first cluster keeps the seed, others get a suffix.
 * @param {string} seed
 * @param {number} index
 * @returns {string}
 */
export function nameCluster(seed, index) {
  return index === 0 ? seed : `${seed}-${index + 1}`;
}

// The elements inventory: sections resolved to element types by identity, variants by the
// set of their children's identities, coverage per page, compositions across pages. Pure
// functions over captures; the rules object comes from elements-rules.mjs.
import { createHash } from 'node:crypto';
import { structuralChildren, stableId, tokens } from './chrome.mjs';
import { sections } from './decompose.mjs';
import { mergeRules } from './elements-rules.mjs';

/**
 * A node's identity: the outermost element of its collapsed chain — tag, stable id, class
 * tokens minus state, generated names, the rules' exclusions and noise. Children never
 * enter it, so repetition never splits a type.
 */
export function identity(node, rules = mergeRules()) {
  const head = node.collapsed?.[0] ?? node;
  const classes = tokens(head.className).filter((t) => !rules.noiseClasses.has(t)
    && !rules.identityExclusions.some((re) => re.test(t)));
  return `${head.tag}#${stableId(head.id)}.${classes.join('.')}`;
}

export const typeId = (id) => `t-${createHash('sha1').update(id).digest('hex').slice(0, 8)}`;

/** The variant of a section: the sorted set of its structural children's identities. */
export function variantKey(node, rules = mergeRules()) {
  return [...new Set(structuralChildren(node).map((c) => identity(c, rules)))].sort();
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const coverageBucket = (share) => (share >= 0.999 ? 'full' : share > 0 ? 'partial' : 'none');

/**
 * The inventory over captured pages.
 *
 * @param {object[]} captures `{ url, tree }` each.
 * @param {{chromeSelectors?: Iterable<string>, rules?: object, groupOf?: (url) => string}}
 * @returns {{types: object[], pages: object[], compositions: object[]}}
 */
export function inventory(captures, { chromeSelectors = [], rules = mergeRules(),
  groupOf = () => '/' } = {}) {
  const resolveId = (id) => rules.merge[id] ?? id;
  const types = new Map();
  const pages = [];
  for (const capture of captures) {
    const group = groupOf(capture.url) || '/';
    const page = { url: capture.url, group, sections: [], contentHeight: 0 };
    for (const node of sections(capture, { chromeSelectors, rules })) {
      const ident = identity(node, rules);
      const id = resolveId(typeId(ident));
      const t = types.get(id) ?? {
        id, identity: ident, identities: new Set(), pages: new Set(), instances: 0, heights: [],
        sample: null, groups: {}, variants: new Map(),
      };
      t.identities.add(ident);
      t.pages.add(capture.url);
      t.instances += 1;
      t.heights.push(node.bounds.height);
      t.sample ??= { url: capture.url, selector: node.selector };
      t.groups[group] = (t.groups[group] ?? 0) + 1;
      const children = variantKey(node, rules);
      const vk = children.join(',');
      const v = t.variants.get(vk) ?? { children, instances: 0, pages: new Set(), sample: null };
      v.instances += 1;
      v.pages.add(capture.url);
      v.sample ??= { url: capture.url, selector: node.selector };
      t.variants.set(vk, v);
      types.set(id, t);
      page.sections.push({ type: id, selector: node.selector, height: node.bounds.height,
        variant: vk });
      page.contentHeight += node.bounds.height;
    }
    pages.push(page);
  }
  const total = captures.length;
  const typeList = [...types.values()].map((t) => ({
    id: t.id,
    identity: t.identity,
    ...(t.identities.size > 1 ? { mergedFrom: [...t.identities] } : {}),
    pages: t.pages.size,
    support: total ? Math.round((t.pages.size / total) * 1000) / 1000 : 0,
    recurring: t.pages.size >= rules.recurrence,
    instances: t.instances,
    medianHeight: median(t.heights),
    heightRange: [Math.min(...t.heights), Math.max(...t.heights)],
    sample: t.sample,
    groups: t.groups,
    variants: [...t.variants.values()].map((v) => ({
      children: v.children, instances: v.instances, pages: v.pages.size, sample: v.sample,
    })).sort((a, b) => b.instances - a.instances),
  })).sort((a, b) => b.pages - a.pages || a.identity.localeCompare(b.identity));
  const recurring = new Set(typeList.filter((t) => t.recurring).map((t) => t.id));
  const compositions = new Map();
  for (const page of pages) {
    const covered = page.sections.filter((s) => recurring.has(s.type))
      .reduce((sum, s) => sum + s.height, 0);
    page.coverage = page.contentHeight ? Math.round((covered / page.contentHeight) * 1000) / 1000
      : 0;
    page.covered = coverageBucket(page.coverage);
    page.composition = page.sections.map((s) => s.type).join(' ');
    const c = compositions.get(page.composition)
      ?? { key: page.composition, types: page.sections.map((s) => s.type), pages: 0, groups: {} };
    c.pages += 1;
    c.groups[page.group] = (c.groups[page.group] ?? 0) + 1;
    compositions.set(page.composition, c);
  }
  return {
    types: typeList,
    pages,
    compositions: [...compositions.values()].sort((a, b) => b.pages - a.pages),
  };
}

/** The numbers that summarise an inventory: what a replay compares. */
export function summary({ types, pages }) {
  const unique = types.filter((t) => t.pages === 1);
  return {
    pages: pages.length,
    sections: pages.reduce((n, p) => n + p.sections.length, 0),
    types: types.length,
    recurring: types.filter((t) => t.recurring).length,
    covered: {
      full: pages.filter((p) => p.covered === 'full').length,
      partial: pages.filter((p) => p.covered === 'partial').length,
      none: pages.filter((p) => p.covered === 'none').length,
    },
    unique: { types: unique.length, pages: new Set(unique.map((t) => t.sample.url)).size },
  };
}

// The mapping: which element types are blocks (and what they are called), which are
// default content, which are skipped. Sections and fragments are the rules' business
// (containers, fragments); header and footer the chrome step's. Pure functions over an
// elements inventory and the decisions file; nothing here knows a site.

export const KINDS = ['block', 'default-content', 'skip'];
export const RESERVED_BLOCKS = ['header', 'footer', 'section', 'fragment'];
const BLOCK_NAME = /^[a-z][a-z0-9-]*$/;

/** The types a fragment delivers: documents, not mapped. */
export function fragmentContentTypes(elements) {
  return new Set((elements.fragments ?? []).flatMap((f) => f.contents.flatMap((c) => c.types)));
}

/** The types to decide on: recurring, and not a fragment's content. */
export function mappableTypes(elements) {
  const inside = fragmentContentTypes(elements);
  return elements.types.filter((t) => t.recurring && !inside.has(t.id));
}

/**
 * Every mappable type present, with its previous decision or `kind: null`; previous
 * decisions for types no longer mappable are kept (they may come back after a rules
 * change) and reported as orphaned by `deriveInventory`.
 */
export function seedMapping(elements, previous = { types: {} }) {
  const types = { ...(previous.types ?? {}) };
  for (const t of mappableTypes(elements)) types[t.id] ??= { kind: null };
  return { types };
}

/** Why a decisions file is not one: shape, kinds, block names. Empty when it is. */
export function validateMapping(mapping) {
  const reasons = [];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return ['mapping.json must be an object with a "types" map'];
  }
  if (!mapping.types || typeof mapping.types !== 'object' || Array.isArray(mapping.types)) {
    return ['mapping.json: "types" must be an object keyed by type id'];
  }
  for (const [id, d] of Object.entries(mapping.types)) {
    if (!d || typeof d !== 'object') {
      reasons.push(`${id}: a decision must be an object`);
      continue;
    }
    if (d.kind !== null && !KINDS.includes(d.kind)) {
      reasons.push(`${id}: kind must be one of ${KINDS.join(', ')} (or null while undecided)`);
    }
    if (d.kind === 'block') {
      if (typeof d.block !== 'string' || !BLOCK_NAME.test(d.block)) {
        reasons.push(`${id}: a block needs a name — lowercase, digits and dashes, starting`
          + ' with a letter');
      } else if (RESERVED_BLOCKS.includes(d.block)) {
        reasons.push(`${id}: "${d.block}" is not a block name — header and footer are the`
          + ' chrome step\'s, section and fragment are rules');
      }
    } else if (d.block !== undefined) {
      reasons.push(`${id}: only a block has a block name`);
    }
    if (d.notes !== undefined && typeof d.notes !== 'string') {
      reasons.push(`${id}: notes must be a string`);
    }
  }
  return reasons;
}

const byPages = (a, b) => b.pages - a.pages || a.name.localeCompare(b.name);

/**
 * The block inventory the mapping makes of the elements inventory.
 *
 * @returns {{blocks: object[], defaultContent: object, skipped: object[], undecided:
 *   string[], orphaned: string[], coverage: {pages: number, covered: number,
 *   uncovered: {url: string, types: string[]}[]}}} A page is covered when every section
 *   is a block or default content; sections inside a fragment do not count against it.
 */
export function deriveInventory(elements, mapping) {
  const typeById = new Map(elements.types.map((t) => [t.id, t]));
  const mappable = new Set(mappableTypes(elements).map((t) => t.id));
  const decisions = mapping.types ?? {};
  const kindOf = (id) => decisions[id]?.kind ?? null;
  const groups = new Map();
  for (const id of mappable) {
    const d = decisions[id];
    if (d?.kind !== 'block') continue;
    const g = groups.get(d.block) ?? { name: d.block, types: [], notes: [] };
    g.types.push(typeById.get(id));
    if (d.notes) g.notes.push(d.notes);
    groups.set(d.block, g);
  }
  const blocks = [...groups.values()].map((g) => summarise(g, elements.pages)).sort(byPages);
  const of = (kind) => [...mappable].filter((id) => kindOf(id) === kind)
    .map((id) => typeById.get(id));
  const dc = of('default-content');
  const defaultContent = {
    types: dc.map((t) => t.id),
    instances: dc.reduce((n, t) => n + t.instances, 0),
    pages: pagesWith(elements.pages, new Set(dc.map((t) => t.id))),
  };
  const skipped = of('skip').map((t) => ({
    id: t.id, identity: t.identity, pages: t.pages, instances: t.instances,
    notes: decisions[t.id].notes ?? '',
  }));
  const undecided = [...mappable].filter((id) => kindOf(id) === null);
  const orphaned = Object.keys(decisions).filter((id) => !mappable.has(id));
  const covering = (id) => ['block', 'default-content'].includes(kindOf(id));
  const uncovered = elements.pages.flatMap((p) => {
    const open = p.sections.filter((s) => !s.within?.length && !covering(s.type))
      .map((s) => s.type);
    return open.length ? [{ url: p.url, types: [...new Set(open)] }] : [];
  });
  const coverage = {
    pages: elements.pages.length, covered: elements.pages.length - uncovered.length, uncovered,
  };
  return { blocks, defaultContent, skipped, undecided, orphaned, coverage };
}

function pagesWith(pages, ids) {
  return pages.filter((p) => p.sections.some((s) => ids.has(s.type))).length;
}

function summarise({ name, types, notes }, pages) {
  const ids = new Set(types.map((t) => t.id));
  const heights = types.map((t) => t.medianHeight).sort((a, b) => a - b);
  const lead = [...types].sort((a, b) => b.pages - a.pages)[0];
  return {
    name,
    types: types.map((t) => t.id),
    identities: types.map((t) => t.identity),
    instances: types.reduce((n, t) => n + t.instances, 0),
    pages: pagesWith(pages, ids),
    variants: types.reduce((n, t) => n + (t.variants?.length ?? 0), 0),
    medianHeight: heights[Math.floor(heights.length / 2)],
    sample: lead.sample,
    screenshots: types.flatMap((t) => t.screenshots?.instances?.slice(0, 1) ?? []),
    notes,
  };
}

const pct = (n, of) => (of ? `${Math.round((100 * n) / of)} %` : '–');

/** The block inventory as a document for the operator. */
export function renderMappingMd(inventory, elements) {
  const total = elements.pages.length;
  const identity = (id) => elements.types.find((t) => t.id === id)?.identity ?? id;
  const out = ['# Block inventory', ''];
  out.push(`${inventory.blocks.length} blocks, ${inventory.defaultContent.types.length} default`
    + ` content types, ${inventory.skipped.length} skipped, ${inventory.undecided.length}`
    + ` undecided; ${inventory.coverage.covered} of ${total} pages covered`
    + ` (${pct(inventory.coverage.covered, total)}).`, '');
  out.push('## Blocks', '', '| block | types | instances | pages | variants | height | sample |',
    '|---|---|---|---|---|---|---|');
  for (const b of inventory.blocks) {
    out.push(`| ${b.name} | ${b.identities.map((i) => `\`${i}\``).join('<br>')} | ${b.instances} | `
      + `${b.pages} (${pct(b.pages, total)}) | ${b.variants} | ${b.medianHeight} px | `
      + `${b.sample?.url ?? ''} |`);
  }
  if (!inventory.blocks.length) out.push('| – | | | | | | |');
  const notes = inventory.blocks.filter((b) => b.notes.length);
  if (notes.length) {
    out.push('', ...notes.map((b) => `- **${b.name}**: ${b.notes.join(' · ')}`));
  }
  const dc = inventory.defaultContent;
  out.push('', '## Default content', '', `${dc.types.length} types, ${dc.instances} instances`
    + ` on ${dc.pages} pages.`, '', ...dc.types.map((id) => `- \`${identity(id)}\` (${id})`));
  out.push('', '## Skipped', '', ...(inventory.skipped.length
    ? inventory.skipped.map((s) => `- \`${s.identity}\` (${s.id}): ${s.pages} pages, `
      + `${s.instances} instances${s.notes ? ` — ${s.notes}` : ''}`)
    : ['None.']));
  out.push('', '## Coverage', '', `${inventory.coverage.covered} of ${total} pages have every`
    + ' section mapped to a block or default content', '(sections inside a fragment aside).');
  if (inventory.coverage.uncovered.length) {
    out.push('', '| page | open types |', '|---|---|');
    for (const u of inventory.coverage.uncovered.slice(0, 25)) {
      out.push(`| ${u.url} | ${u.types.map((id) => `\`${identity(id)}\``).join(', ')} |`);
    }
    const rest = inventory.coverage.uncovered.length - 25;
    if (rest > 0) out.push(`| … and ${rest} more | |`);
  }
  out.push('', '## Undecided', '', ...(inventory.undecided.length
    ? inventory.undecided.map((id) => `- \`${identity(id)}\` (${id})`)
    : ['None — every recurring type has a kind.']));
  if (inventory.orphaned.length) {
    out.push('', '## Orphaned decisions', '', 'Types no longer recurring (a rules change,'
      + ' more pages); the decision is kept in case they return.', '',
    ...inventory.orphaned.map((id) => `- ${id}`));
  }
  return `${out.join('\n')}\n`;
}

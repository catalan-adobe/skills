// The elements step's outputs: the inventory over the store, merged with the previous run
// (type ids are stable, so a run is a delta), written as elements.json, elements.md and the
// REPORT.md section.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCaptures, readRun } from './capture.mjs';
import { readRules } from './elements-rules.mjs';
import { inventory, summary } from './elements.mjs';
import { readInventory } from './inventory.mjs';
import { upsertSection } from './project.mjs';

export const elementsJson = (project) => path.join(project.step('elements'), 'elements.json');
export const elementsMd = (project) => path.join(project.step('elements'), 'elements.md');

// A group with this many new pages and no new type in a run has stopped teaching us.
// ponytail: one fixed number; a per-site value if a real run shows it wrong.
export const SATURATION_PAGES = 10;

export const LIMITS = [
  'Types are identities of the source markup with a first structural reading, not EDS blocks;'
    + ' naming and mapping are the content expert\'s.',
  'A part promoted from under an element with an id is not recognised as a part (page-tree'
    + ' selectors stop at the nearest id) and becomes a type of its own.',
  'Coverage counts recurring types by height; a page whose content region is empty after'
    + ' chrome removal counts as not covered.',
];

/** The chrome step's member selectors, or none when chrome.json is absent. */
async function chromeSelectors(project) {
  const chrome = await readFile(path.join(project.step('chrome'), 'chrome.json'), 'utf8')
    .then(JSON.parse, () => null);
  if (!chrome) return [];
  return [...chrome.header, ...chrome.footer].flatMap((v) => v.members.flatMap((m) => m.selectors));
}

const typeSet = (pages) => new Set(pages.flatMap((p) => p.sections.map((s) => s.type)));
const compositionSet = (pages) => new Set(pages.map((p) => p.composition));

/**
 * The per-group table: pages, types, compositions, the dominant composition's share, and the
 * delta against the previous run's pages of that group; `saturated` when the run added
 * pages to the group and no new type.
 */
export function groupTable(pages, previousPages = []) {
  const groups = new Map();
  for (const p of pages) {
    const g = groups.get(p.group) ?? { group: p.group, pages: [] };
    g.pages.push(p);
    groups.set(p.group, g);
  }
  const before = new Map();
  for (const p of previousPages) {
    const g = before.get(p.group) ?? { pages: [] };
    g.pages.push(p);
    before.set(p.group, g);
  }
  return [...groups.values()].map(({ group, pages: list }) => {
    const prev = before.get(group)?.pages ?? [];
    const prevTypes = typeSet(prev);
    const prevCompositions = compositionSet(prev);
    const counts = new Map();
    for (const p of list) counts.set(p.composition, (counts.get(p.composition) ?? 0) + 1);
    const dominant = [...counts.values()].sort((a, b) => b - a)[0] ?? 0;
    const newPages = list.length - prev.length;
    const newTypes = [...typeSet(list)].filter((t) => !prevTypes.has(t)).length;
    const newCompositions = [...compositionSet(list)]
      .filter((c) => !prevCompositions.has(c)).length;
    return {
      group,
      pages: list.length,
      types: typeSet(list).size,
      compositions: counts.size,
      dominantShare: list.length ? Math.round((dominant / list.length) * 100) / 100 : 0,
      newPages,
      newTypes,
      newCompositions,
      saturated: newPages >= SATURATION_PAGES && newTypes === 0,
    };
  }).sort((a, b) => b.pages - a.pages);
}

/** The inventory over the store, as a run on top of the previous elements.json. */
export async function buildElements(project, { now = () => new Date() } = {}) {
  const captures = await readCaptures(project);
  if (!captures.length) throw new Error('the visual-tree store is empty; run capture.mjs first');
  const rules = await readRules(project);
  const urls = await readInventory(project.step('urls'));
  const groups = new Map(urls.map((r) => [r.url, r.group]));
  const previous = await readFile(elementsJson(project), 'utf8').then(JSON.parse, () => null);
  const result = inventory(captures, {
    chromeSelectors: await chromeSelectors(project), rules, groupOf: (u) => groups.get(u),
  });
  const prevTypes = new Set((previous?.types ?? []).map((t) => t.id));
  const prevCompositions = compositionSet(previous?.pages ?? []);
  const run = {
    at: now().toISOString(),
    ...summary(result),
    newTypes: result.types.filter((t) => !prevTypes.has(t.id)).map((t) => t.id),
    newCompositions: result.compositions.filter((c) => !prevCompositions.has(c.key)).length,
  };
  return {
    generatedAt: run.at,
    capturedPages: captures.length,
    minWidth: (await readRun(project))?.minWidth ?? captures[0].minWidth ?? null,
    recurrence: rules.recurrence,
    ...result,
    groups: groupTable(result.pages, previous?.pages ?? []),
    runs: [...(previous?.runs ?? []), run],
    limits: LIMITS,
  };
}

/** Builds and writes elements.json, elements.md and the REPORT.md section. */
export async function writeElements(project, options = {}) {
  const result = await buildElements(project, options);
  await writeFile(elementsJson(project), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(elementsMd(project), renderElementsMd(result));
  await upsertSection(project, 'elements', renderSection(result));
  return result;
}

const pct = (x) => `${Math.round(x * 100)} %`;
const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function renderTypes(types) {
  return [
    '| id | pages | support | instances | variants | median h | identity | sample |',
    '|---|---|---|---|---|---|---|---|',
    ...types.map((t) => `| ${t.id} | ${t.pages} | ${pct(t.support)} | ${t.instances} `
      + `| ${t.variants.length} | ${t.medianHeight} | \`${short(t.identity)}\` `
      + `| \`${short(t.sample.selector, 50)}\` |`),
  ];
}

function renderGroups(groups) {
  return [
    '| group | pages | types | compositions | dominant | new pages | new types | saturated |',
    '|---|---|---|---|---|---|---|---|',
    ...groups.map((g) => `| ${g.group} | ${g.pages} | ${g.types} | ${g.compositions} `
      + `| ${pct(g.dominantShare)} | ${g.newPages} | ${g.newTypes} `
      + `| ${g.saturated ? 'yes' : ''} |`),
  ];
}

/** The operator's view of the inventory. */
export function renderElementsMd(r) {
  const recurring = r.types.filter((t) => t.recurring);
  const unique = r.types.filter((t) => !t.recurring);
  const last = r.runs.at(-1);
  const covered = last.covered;
  const rejected = new Map();
  for (const x of r.pages.flatMap((p) => p.rejected)) {
    const reason = x.reason.replace(/^part of .*/, 'part of a sibling section');
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
  }
  return [
    '# Elements inventory',
    '',
    `${r.capturedPages} pages decomposed from the visual-tree store (min-width ${r.minWidth}`
      + ` px); ${last.sections} sections; ${r.types.length} element types, ${recurring.length}`
      + ` recurring (on at least ${r.recurrence} pages).`,
    '',
    `Coverage by recurring types: ${covered.full} pages fully covered, ${covered.partial}`
      + ` partially, ${covered.none} not at all.`,
    '',
    '## Recurring types', '', ...renderTypes(recurring), '',
    '## Groups', '',
    'Dominant: the share of the group\'s pages carrying its most common composition. A group'
      + ` is saturated when a run added ${SATURATION_PAGES}+ pages and no new type.`,
    '', ...renderGroups(r.groups), '',
    '## Runs', '',
    '| at | pages | types | recurring | new types | new compositions |',
    '|---|---|---|---|---|---|',
    ...r.runs.map((x) => `| ${x.at.slice(0, 16)}Z | ${x.pages} | ${x.types} | ${x.recurring} `
      + `| ${x.newTypes.length} | ${x.newCompositions} |`),
    '',
    '## Unique types', '',
    unique.length ? renderTypes(unique).join('\n') : '_none_', '',
    '## Rejected', '',
    rejected.size ? [...rejected].map(([k, n]) => `- ${k}: ${n}`).join('\n') : '_none_', '',
    '## Warnings', '',
    r.warnings.length ? r.warnings.map((w) => `- ${w}`).join('\n') : '_none_', '',
    '## Limits', '', ...r.limits.map((l) => `- ${l}`), '',
  ].join('\n');
}

/** The REPORT.md section body (no heading). */
export function renderSection(r) {
  const last = r.runs.at(-1);
  const saturated = r.groups.filter((g) => g.saturated).map((g) => g.group);
  return [
    `${r.capturedPages} cached pages decomposed into ${last.sections} sections; `
      + `${r.types.length} element types, ${last.recurring} recurring.`,
    `Coverage by recurring types: ${last.covered.full} pages full, ${last.covered.partial}`
      + ` partial, ${last.covered.none} none. ${r.compositions.length} distinct compositions.`,
    `This run: +${last.newTypes.length} types, +${last.newCompositions} compositions`
      + ` (run ${r.runs.length}). Saturated groups: ${saturated.join(', ') || 'none yet'}.`,
    'Types, groups and runs: `migration/elements/elements.md`.',
  ].join('\n');
}

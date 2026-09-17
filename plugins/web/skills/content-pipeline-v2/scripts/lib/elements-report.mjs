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

// A group whose last pages, in capture order, brought no type absent from its earlier pages
// has stopped teaching us. ponytail: one fixed number; a per-site value if a run shows it wrong.
export const SATURATION_PAGES = 10;

export const LIMITS = [
  'Types are identities of the source markup, not EDS blocks; classification, naming and'
    + ' mapping are the content expert\'s.',
  'A part promoted from under an element with an id is not recognised as a part (page-tree'
    + ' selectors stop at the nearest id) and becomes a type of its own.',
  'Coverage counts recurring types by height; a page whose content region is empty after'
    + ' chrome removal counts as not covered.',
  'Saturation reads the capture order: a --force recapture re-dates every page, so the last'
    + ` ${SATURATION_PAGES} of a group are then arbitrary until new pages are captured.`,
  'Crops show alt text or a blank where the cache holds no image (lazy-loaded sources the'
    + ' cache never fetched); fixed widgets of the page sit inside tall crops.',
  'A fragment nested in a fragment is counted for the inner one; the outer content does not'
    + ' record that it held a fragment.',
];

/** The chrome step's member selectors. */
export async function chromeSelectors(project) {
  const chrome = await readFile(path.join(project.step('chrome'), 'chrome.json'), 'utf8')
    .then(JSON.parse, () => null);
  if (!chrome) throw new Error('chrome/chrome.json missing; run chrome.mjs first');
  return [...chrome.header, ...chrome.footer].flatMap((v) => v.members.flatMap((m) => m.selectors));
}

const typeSet = (pages) => new Set(pages.flatMap((p) => p.sections.map((s) => s.type)));
const byCapture = (a, b) => String(a.capturedAt ?? '').localeCompare(String(b.capturedAt ?? ''));

/**
 * The per-group table from the pages alone: pages, types, compositions, the dominant
 * composition's share, and `saturated` when the group's last SATURATION_PAGES pages (in
 * capture order) brought no type its earlier pages lack.
 */
export function groupTable(pages) {
  return [...Map.groupBy(pages, (p) => p.group)].map(([group, list]) => {
    const counts = Map.groupBy(list, (p) => p.composition);
    const dominant = Math.max(0, ...[...counts.values()].map((l) => l.length));
    const ordered = [...list].sort(byCapture);
    const recent = ordered.slice(-SATURATION_PAGES);
    const earlier = typeSet(ordered.slice(0, -SATURATION_PAGES));
    const novel = [...typeSet(recent)].filter((t) => !earlier.has(t)).length;
    return {
      group,
      pages: list.length,
      types: typeSet(list).size,
      compositions: counts.size,
      dominantShare: Math.round((dominant / list.length) * 100) / 100,
      recentNewTypes: novel,
      saturated: list.length > SATURATION_PAGES && novel === 0,
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
  const prevCompositions = new Set((previous?.compositions ?? []).map((c) => c.key));
  const rulesChanged = previous ? previous.rulesHash !== rules.hash : false;
  const run = {
    at: now().toISOString(),
    rulesHash: rules.hash,
    ...(rulesChanged ? { rulesChanged: true } : {}),
    ...summary(result),
    newTypes: result.types.filter((t) => !prevTypes.has(t.id)).map((t) => t.id),
    removedTypes: [...prevTypes].filter((id) => !result.types.some((t) => t.id === id)),
    // Compositions are renamed wholesale by a rule change; the count means nothing then.
    newCompositions: rulesChanged ? null
      : result.compositions.filter((c) => !prevCompositions.has(c.key)).length,
  };
  const seenGroups = new Set(result.pages.map((p) => p.group));
  const pageGroups = new Set(urls.filter((r) => r.kind === 'page').map((r) => r.group));
  return {
    generatedAt: run.at,
    capturedPages: captures.length,
    storeCapturedAt: captures.map((c) => c.capturedAt ?? '').sort().at(-1) || null,
    minWidth: (await readRun(project))?.minWidth ?? captures[0].minWidth ?? null,
    rulesHash: rules.hash,
    recurrence: rules.recurrence,
    ...result,
    groups: groupTable(result.pages),
    groupsWithoutPages: [...pageGroups].filter((g) => !seenGroups.has(g)).sort(),
    runs: [...(previous?.runs ?? []), run],
    limits: LIMITS,
  };
}

/** Writes a result as elements.json, elements.md and the REPORT.md section. */
export async function writeOutputs(project, result) {
  await writeFile(elementsJson(project), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(elementsMd(project), renderElementsMd(result));
  await upsertSection(project, 'elements', renderSection(result));
  return result;
}

/** Builds and writes, without screenshots. */
export const writeElements = async (project, options = {}) => (
  writeOutputs(project, await buildElements(project, options)));

const pct = (x) => `${Math.round(x * 100)} %`;
const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function renderTypes(types) {
  return [
    '| id | pages | support | instances | variants | median h | identity |',
    '|---|---|---|---|---|---|---|',
    ...types.map((t) => `| ${t.id} | ${t.pages} | ${pct(t.support)} | ${t.instances} `
      + `| ${t.variants.length} | ${t.medianHeight} | \`${short(t.identity)}\` |`),
  ];
}

function renderGroups(groups) {
  return [
    '| group | pages | types | compositions | dominant | new types in last pages | saturated |',
    '|---|---|---|---|---|---|---|',
    ...groups.map((g) => `| ${g.group} | ${g.pages} | ${g.types} | ${g.compositions} `
      + `| ${pct(g.dominantShare)} | ${g.recentNewTypes} | ${g.saturated ? 'yes' : ''} |`),
  ];
}

/** Per fragment identity its distinct contents: the reuse candidates. */
function renderFragments(fragments) {
  return fragments.flatMap((f) => [
    `### \`${f.identity}\` — ${f.instances} instances on ${f.pages} pages, `
      + `${f.contents.length} distinct contents`,
    '',
    '| pages | instances | content (types in order) | sample |',
    '|---|---|---|---|',
    ...f.contents.map((c) => (
      `| ${c.pages} | ${c.instances} | ${c.types.join(' ')} | ${c.sample} |`)),
    '',
  ]);
}

const renderRun = (x) => `| ${x.at.slice(0, 16)}Z | ${x.pages} | ${x.types} | ${x.recurring} `
  + `| ${x.newTypes.length} | ${x.removedTypes.length} `
  + `| ${x.rulesChanged ? 'rules changed' : x.newCompositions} |`;

/** The operator's view of the inventory. */
export function renderElementsMd(r) {
  const recurring = r.types.filter((t) => t.recurring);
  const unique = r.types.filter((t) => !t.recurring);
  const last = r.runs.at(-1);
  const covered = last.covered;
  const rejected = new Map();
  for (const x of r.pages.flatMap((p) => p.rejected)) {
    rejected.set(x.reason, (rejected.get(x.reason) ?? 0) + 1);
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
      + ` is saturated when its last ${SATURATION_PAGES} captured pages brought no type its`
      + ' earlier pages lack.',
    '', ...renderGroups(r.groups), '',
    r.groupsWithoutPages.length
      ? `Groups without a captured page: ${r.groupsWithoutPages.join(', ')}.` : '',
    '',
    '## Runs', '',
    '| at | pages | types | recurring | new types | removed | new compositions |',
    '|---|---|---|---|---|---|---|',
    ...r.runs.map(renderRun),
    '',
    '## Fragments', '',
    r.fragments.length ? renderFragments(r.fragments).join('\n')
      : '_none declared — `fragments` in rules.json names the identities that are fragments_',
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
      + ` partial, ${last.covered.none} none. ${r.compositions.length} distinct compositions`
      + (r.fragments.length ? `; ${r.fragments.length} fragment type(s), ${
        r.fragments.reduce((n, f) => n + f.contents.length, 0)} distinct contents.` : '.'),
    `Run ${r.runs.length}: +${last.newTypes.length} types, -${last.removedTypes.length}`
      + (last.rulesChanged ? ' (rules changed)' : `, +${last.newCompositions} compositions`)
      + `. Saturated groups: ${saturated.join(', ') || 'none yet'}; groups without a page: `
      + `${r.groupsWithoutPages.length}.`,
    'Types, groups and runs: `migration/elements/elements.md`.',
  ].join('\n');
}

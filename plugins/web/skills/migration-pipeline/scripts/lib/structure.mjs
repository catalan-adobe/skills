// structure, iteration 1: a page's body bands grouped into EDS sections and typed. Code
// starts a section where the background changes; every other boundary between two body
// bands is one yes/no question to a System 1 model ("do B1 and B2 form one part?"); what
// each band holds is one choice question (default content, block, chrome, other). Two
// neighbours of one type on one background stay together unless the white space between
// them reaches the page's own section spacing. The census's level 1 and 2, as it measured
// them; its level 0 (header and footer by shared text) is ours: the chrome step located
// them on every page, so the body is given. Written as the page's composition.
import { createHash } from 'node:crypto';
import { bandState, contentLeaves, inBand } from './band-state.mjs';
import { bodyEdges } from './crops.mjs';
import { data } from './data.mjs';
import { askQuestions, deployment } from './system1.mjs';

export const METHOD = 'bands-system1';
export const JOIN = 0.5; // a boundary at or above this merges the two bands into one section
export const SECTION_GAP = 3; // × the page's band gap: white space that ends a section anyway
export const MAX_BANDS = 12; // bands per request

export const TYPES = {
  default_content: 'Plain document content only: headings, paragraphs, lists, a single image,'
    + ' links or buttons, one after another as in an article, possibly on a coloured background',
  block: 'A component a plain document cannot express: side-by-side columns, a grid or row of'
    + ' alike items, text laid over a full-width image, a slideshow, tabs, an accordion, a'
    + ' table, a form, a search box, a video or an embedded frame',
  site_chrome: 'The site header or footer: logo, main navigation menu, language or sign-in'
    + ' links, legal links, copyright',
  other: 'None of the above: empty or decorative only',
};

/** The questions for a page: one type per band, one boundary per neighbouring pair. */
export function questions(ids, pairList = []) {
  const qs = {};
  for (const id of ids) {
    const p = `bands.${id}`;
    qs[`${id}_type`] = {
      type: 'choice',
      instructions: `What kind of content does \`${p}\` hold? Judge from \`${p}.content\`,`
        + ` \`${p}.layout\`, \`${p}.background\` and where it sits, \`${p}.at\`.`,
      criteria: TYPES,
    };
  }
  for (const [a, b] of pairList) {
    const [pa, pb] = [`\`bands.${a}\``, `\`bands.${b}\``];
    qs[`${b}_joins`] = {
      type: 'noul',
      instructions: `Do ${pa} and ${pb} form one part of the page? Yes when ${pa} is a heading`
        + ` or short introduction for the content in ${pb}, or when ${pb} continues what ${pa}`
        + ' shows, for example more entries of the same list, grid or set of results. No when'
        + ` ${pb} starts a different part of the page under a heading of its own.`,
    };
  }
  return qs;
}

/** The wording's hash: answers from different wordings are never read together unnoticed. */
export const WORDING = createHash('sha256')
  .update(JSON.stringify(questions(['B1'], [['B1', 'B2']]))).digest('hex').slice(0, 8);

const sectionBg = (b) => ('sbg' in b ? b.sbg : b.bg);

/** The body's bands: those whose middle lies between the header's bottom and the footer's top. */
export const bodyBands = (bands, body) => bands.filter((b) => (
  b.y + b.h / 2 >= body.top && b.y + b.h / 2 < body.bottom));

/** Neighbouring body bands on the same section background: the model decides. */
export const pairs = (bands) => bands.slice(1).map((b, i) => [bands[i], b])
  .filter(([a, b]) => sectionBg(a) === sectionBg(b));

/** A choice answer's second most likely option, as [option, probability]. */
const runnerUp = (a) => Object.entries(a?.probabilities ?? {}).filter(([o]) => o !== a.choice)
  .sort((x, y) => y[1] - x[1])[0];

/**
 * The model's boundary answers split running text at every heading of its own. Two
 * neighbours of the same type on the same background are one section unless the white space
 * between them reaches the page's section spacing, or the second sits clearly closer to the
 * band after it (a heading goes with what it introduces). Returns the bands joined that way.
 */
export function spacingJoins(bands, leaves, gap, pairList, joins, typeOf) {
  const content = contentLeaves(leaves);
  const top = (b) => Math.min(...inBand(content, b).map((l) => l.y));
  const bottom = (b) => Math.max(...inBand(content, b).map((l) => l.y + l.h));
  const between = (a, b) => top(b) - bottom(a);
  const after = new Map(pairList.map(([a, b]) => [a, b]));
  return new Set(pairList.filter(([a, b]) => (joins.get(b) ?? 0) < JOIN && a.bg === b.bg
    && typeOf(a) === typeOf(b) && ['default_content', 'block'].includes(typeOf(a))
    && between(a, b) < SECTION_GAP * gap
    && !(after.has(b) && between(b, after.get(b)) < (2 / 3) * between(a, b)))
    .map(([, b]) => b));
}

/**
 * Sections of the body: a section starts where the background changes; any other band
 * starts one unless the model (or the spacing) says it forms one part with the band before.
 */
export function sections(bands, joins) {
  const out = [];
  for (const b of bands) {
    if (!out.length || (joins.get(b) ?? 0) < JOIN) out.push({ bg: sectionBg(b), bands: [] });
    out.at(-1).bands.push(b);
  }
  return out;
}

/**
 * A section's children: a band joined to a block is more of that block; a band joined to
 * default content extends it; an intro followed by a block stays two children.
 */
export function children(bands, joins, typeOf) {
  const out = [];
  for (const b of bands) {
    const last = out.at(-1);
    const joined = (joins.get(b) ?? 0) >= JOIN;
    if (last && joined && (last.type === 'block' || last.type === typeOf(b))) last.bands.push(b);
    else out.push({ type: typeOf(b), bands: [b] });
  }
  return out;
}

/** Each band's boundary question travels with that band's chunk; every chunk has the state. */
async function askAll(dep, state, ids, pairList, io) {
  const answers = {};
  let inputTokens = 0;
  for (let i = 0; i < ids.length; i += MAX_BANDS) {
    const chunk = ids.slice(i, i + MAX_BANDS);
    const qs = questions(chunk, pairList.filter(([, b]) => chunk.includes(b)));
    // eslint-disable-next-line no-await-in-loop
    const reply = await io.askQuestions(dep, { state, questions: qs });
    Object.assign(answers, reply.answers);
    inputTokens += reply.usage.inputTokens ?? 0;
  }
  return { answers, inputTokens };
}

const CSS_PATH = (paths, leaf) => (paths?.[leaf?.p] ?? '').split(' > ').map((step) => {
  const [tag, ...classes] = step.split(' ');
  return tag + classes.filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 2)
    .map((c) => `.${c}`).join('');
}).join(' > ');

/** A band's locator: the path of its first content leaf, as a CSS selector. */
function selectorOf(band, leaves, paths) {
  const inside = inBand(contentLeaves(leaves), band).sort((a, b) => a.y - b.y || a.x - b.x);
  return CSS_PATH(paths, inside[0]) || `band@${band.y}`;
}

const box = (bands, W) => {
  const first = bands[0];
  const last = bands.at(-1);
  return { x: 0, y: first.y, width: W, height: last.y + last.h - first.y };
};

/**
 * One page: its body bands asked, grouped and typed; the structure artefact written under
 * the page, and the page's composition — fragments as chrome placed them, sections with
 * their style and items. `io.askQuestions` is the model, injectable.
 */
export async function structurePage(cwd, pageId, { io, dep, now = () => new Date() }) {
  const { bands: layer, composition, website, trees, pages } = await data(cwd);
  const capture = await layer.readCapture(cwd, pageId);
  const chromeComp = await composition.read(cwd, pageId);
  const tree = await trees.read(cwd, pageId);
  if (!capture || !chromeComp || !tree) return null;
  const page = await pages.get(cwd, pageId);
  const fragments = (await website.readFragments(cwd))?.fragments ?? [];
  const body = bodyEdges(chromeComp, fragments, capture.H);
  const bands = bodyBands(capture.analysis.bands, body);
  const own = capture.leaves.filter((l) => l.y + l.h > body.top && l.y < body.bottom);
  const state = { url: new URL(page.url).pathname,
    bands: Object.fromEntries(bands.map((b) => [b.id, bandState(b, own, capture.H)])) };
  const pairList = pairs(bands);
  const { answers, inputTokens } = bands.length
    ? await askAll(dep, state, bands.map((b) => b.id), pairList.map(([a, b]) => [a.id, b.id]), io)
    : { answers: {}, inputTokens: 0 };
  const joins = new Map(pairList.map(([, b]) => [b, answers[`${b.id}_joins`]?.noul ?? 0]));
  // Chrome was cut before the model saw the body: a band it still calls chrome is content of
  // its second most likely kind.
  const typeOf = (b) => {
    const a = answers[`${b.id}_type`];
    return a?.choice === 'site_chrome' ? (runnerUp(a)?.[0] ?? 'other') : (a?.choice ?? 'other');
  };
  const joined = spacingJoins(bands, capture.leaves, capture.analysis.gap, pairList, joins, typeOf);
  const allJoins = new Map([...joins, ...[...joined].map((b) => [b, 1])]);
  const secs = sections(bands, allJoins);
  const at = now().toISOString();
  const W = capture.W;
  const items = (kids) => kids.map((k) => ({
    role: k.type === 'block' ? 'block' : 'content',
    selector: selectorOf(k.bands[0], capture.leaves, capture.paths),
    bounds: box(k.bands, W),
    ...(k.type === 'block' ? { type: 'typ-000000000000' } : {}),
  }));
  const comp = {
    method: { name: METHOD, version: WORDING, at, inputs: capture.updatedAt ?? at },
    fragments: chromeComp.fragments,
    sections: secs.map((s, i) => ({
      id: `s${i + 1}`, selector: selectorOf(s.bands[0], capture.leaves, capture.paths),
      bounds: box(s.bands, W), style: { background: s.bg ?? 'none' },
      items: items(children(s.bands, allJoins, typeOf)),
    })),
    omitted: [],
  };
  const sectionOf = new Map(secs.flatMap((s, i) => s.bands.map((b) => [b.id, i + 1])));
  const structure = {
    page: pageId, method: { name: METHOD, model: dep.model, wording: WORDING, at }, body,
    bands: bands.map((b) => {
      const a = answers[`${b.id}_type`];
      return { id: b.id, y: b.y, h: b.h, cols: b.cols, bg: sectionBg(b) ?? null,
        section: sectionOf.get(b.id), type: typeOf(b), said: a?.choice ?? null,
        confidence: a?.confidence ?? null, probabilities: a?.probabilities ?? null,
        joins: joins.has(b) ? joins.get(b) : null, joinedBySpacing: joined.has(b),
        text: b.text };
    }),
    sections: comp.sections.map((s, i) => ({ id: s.id, background: s.style.background,
      bands: secs[i].bands.map((b) => b.id),
      children: children(secs[i].bands, allJoins, typeOf)
        .map((k) => ({ type: k.type, bands: k.bands.map((b) => b.id) })) })),
    usage: { inputTokens },
  };
  await layer.writeStructure(cwd, pageId, structure);
  return { structure, composition: comp };
}

/** The lab command: every page of a selection, sequentially; compositions written. */
export async function structure(cwd, selectionName, { io, dep } = {}) {
  const { selections, composition } = await data(cwd);
  const sel = await selections.read(cwd, selectionName);
  if (!sel) throw new Error(`no selection ${selectionName}`);
  const model = dep ?? deployment();
  const ask = io ?? { askQuestions };
  const out = [];
  for (const id of sel.pages) {
    // eslint-disable-next-line no-await-in-loop
    const result = await structurePage(cwd, id, { io: ask, dep: model });
    if (!result) continue;
    // eslint-disable-next-line no-await-in-loop
    await composition.write(cwd, id, result.composition);
    const s = result.structure;
    out.push({ id, bands: s.bands.length, sections: s.sections.length,
      blocks: s.sections.reduce((n, x) => (
        n + x.children.filter((c) => c.type === 'block').length), 0),
      tokens: s.usage.inputTokens });
  }
  return out;
}

// Level 1 of a page's structure: the body's first vertical bands, each a section, a block or
// default content, with its layout. Candidates come from the visual tree — siblings stacked
// or side by side, so no band cuts through an element; facts a reader needs and a model
// cannot count come from the band capture, as words; a System 1 model answers five yes/no
// questions per candidate from the words and two crops; rules compose the answer. Measured
// against Haiku 5.5 on 70 pages of seven sites: kind 90 %, merge 85 %, 69 % identical pages.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { columnsOf } from './band-analysis.mjs';
import { bandState, contentLeaves, inBand } from './band-state.mjs';
import { sharpOf } from './browser.mjs';
import { bodyEdges } from './crops.mjs';
import { data } from './data.mjs';
import { askQuestions, deployment } from './system1.mjs';

export const METHOD = 'candidates-system1';
export const MERGE = 0.75; // the merge answer at or above this joins a candidate to the previous
export const TITLE_ABOVE = 0.6; // a block with a heading introducing it this surely is a section
export const MIN_LAYOUT_PX = 300; // a side column needs this much height to be a layout
export const MIN_SIDE_RATIO = 1.6; // a part this much wider than its neighbour is the main column
export const FULL_BLEED = 0.9; // an image-only band this wide is a hero; narrower, an image in flow
export const IMAGE_WIDTH = 1280; // crops are fitted in IMAGE_WIDTH × 0.6 IMAGE_WIDTH
export const KINDS = ['default_content', 'block', 'section'];
export const LAYOUTS = ['single', 'main-left', 'main-right', 'main-centre', 'columns'];

// Level 2: a side column is a child narrower than this share of its container and taller
// than this share of the band, at an edge; EDS default content is a run of these elements.
export const MAX_DEPTH = 3; // sections are opened this deep: section → children → grandchildren
export const SIDE_MAX_WIDTH = 0.4;
export const SIDE_MIN_HEIGHT = 0.4; // of the band, starting in its upper fifth
export const TEXT_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE',
  'BLOCKQUOTE', 'PICTURE', 'IMG', 'HR', 'A', 'SPAN', 'EM', 'STRONG', 'CODE', 'FIGURE', 'DL']);

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const count = (n) => WORDS[n] ?? 'many';

/**
 * The level of the tree at which the body's parts are siblings: from the root, through
 * wrapper chains (one child inside the body, or one child covering the body with only
 * slivers beside it) to the first node with two or more children inside the body.
 */
export function siblings(tree, body) {
  const inBody = (n) => (
    n.bounds.y + n.bounds.height > body.top + 2 && n.bounds.y < body.bottom - 2);
  let node = tree;
  for (let i = 0; i < 12; i += 1) {
    const kids = (node.children ?? []).filter((k) => k.bounds.height > 0 && inBody(k));
    if (kids.length === 0) return [node];
    if (kids.length === 1) { node = kids[0]; continue; }
    const big = kids.filter((k) => k.bounds.height >= 0.95 * (body.bottom - body.top));
    if (big.length === 1 && kids.length <= 3) { node = big[0]; continue; }
    return kids;
  }
  return [node];
}

/**
 * Candidate bands from the siblings: those sharing a vertical range form one candidate
 * with parts side by side; the others stack. Gaps belong to the band above; the first
 * starts at the body's top, the last ends at its bottom.
 */
export function candidates(tree, body) {
  const sorted = siblings(tree, body).sort((a, b) => a.bounds.y - b.bounds.y);
  const out = [];
  for (const n of sorted) {
    const y0 = Math.max(body.top, n.bounds.y);
    const y1 = Math.min(body.bottom, n.bounds.y + n.bounds.height);
    if (y1 - y0 < 4) continue;
    const last = out.at(-1);
    if (last && y0 < last.bottom - 8) {
      last.bottom = Math.max(last.bottom, y1);
      last.nodes.push(n);
    } else out.push({ top: y0, bottom: y1, nodes: [n] });
  }
  for (let i = 1; i < out.length; i += 1) out[i - 1].bottom = out[i].top;
  if (out.length) { out[0].top = body.top; out.at(-1).bottom = body.bottom; }
  return out.map((b, i) => {
    const parts = b.nodes
      .map((n) => ({ x: n.bounds.x, w: n.bounds.width, selector: n.selector }))
      .sort((p, q) => p.x - q.x)
      .filter((p, j, all) => !all.slice(0, j).some((q) => Math.abs(q.x - p.x) < 40));
    return { id: `C${i + 1}`, top: b.top, bottom: b.bottom, parts, nodes: b.nodes };
  });
}

/**
 * The children of a section band, for level 2: the band's node's children inside it, side
 * columns set aside (the layout), the rest cut into candidates as at level 1, then
 * consecutive runs of text elements merged — in EDS, default content is such a run
 * between blocks. A band merged from several candidates is opened into its members.
 */
export function open(band, cands, tree) {
  const members = band.members.map((id) => cands.find((c) => c.id === id));
  if (members.some((m) => !m)) return { side: [], children: [], leaf: true };
  if (members.length > 1) {
    return { side: [], children: members.map((c, i) => (
      { ...c, id: `${band.id}.${i + 1}`, from: c.id })) };
  }
  const [c] = members;
  const main = c.parts.length > 1 ? c.parts.reduce((a, p) => (p.w > a.w ? p : a)) : c.parts[0];
  // The other parts beside the main one are side columns already.
  const asides = c.parts.filter((p) => p !== main)
    .map((p) => ({ selector: p.selector, x: p.x, w: p.w, top: band.top, bottom: band.bottom }));
  let node = main?.selector ? findSelector(tree, main.selector) : null;
  const range = { top: band.top, bottom: band.bottom };
  const H = band.bottom - band.top;
  let side = [];
  let cut = [];
  // Through the wrapper chains, as at level 1, to the level where the parts are siblings;
  // when the siblings fold into one candidate as tall as the band (a background layer under
  // the content), into that candidate's largest node, a few times.
  for (let depth = 0; node && depth < 4; depth += 1) {
    const level = siblings(node, range);
    const kids = level.length > 1 ? level : [];
    if (!kids.length) break;
    const W = node.bounds.width;
    const x0 = node.bounds.x;
    const atEdge = (k) => k.bounds.x <= x0 + 0.1 * W || k.bounds.x + k.bounds.width >= x0 + 0.9 * W;
    side = kids.filter((k) => k.bounds.width < SIDE_MAX_WIDTH * W
      && k.bounds.height >= SIDE_MIN_HEIGHT * H && k.bounds.y <= band.top + 0.2 * H && atEdge(k));
    const rest = kids.filter((k) => !side.includes(k));
    cut = candidates({ ...node, children: rest }, range);
    if (cut.length !== 1 || cut[0].bottom - cut[0].top < 0.95 * H) break;
    node = cut[0].nodes.reduce((a, n) => (
      n.bounds.width * n.bounds.height > a.bounds.width * a.bounds.height ? n : a));
    cut = [];
  }
  if (!cut.length) return { side: asides, children: [], leaf: true };
  const isText = (cc) => cc.nodes.every((n) => TEXT_TAGS.has(n.tag));
  const runs = [];
  for (const cc of cut) {
    const last = runs.at(-1);
    if (last && isText(last) && isText(cc)) {
      last.bottom = cc.bottom;
      last.nodes.push(...cc.nodes);
      last.parts.push(...cc.parts);
    } else runs.push({ ...cc, nodes: [...cc.nodes], parts: [...cc.parts] });
  }
  // A run's parts are its columns (distinct x); its selectors are every element in it.
  const children = runs.map((r, i) => ({ id: `${band.id}.${i + 1}`, top: r.top, bottom: r.bottom,
    parts: r.parts.filter((p, j, all) => !all.slice(0, j).some((q) => Math.abs(q.x - p.x) < 40)),
    selectors: [...new Set(r.nodes.map((n) => n.selector).filter(Boolean))], text: isText(r) }));
  return { side: [...asides, ...side.map((k) => ({ selector: k.selector, x: k.bounds.x,
    w: k.bounds.width, top: Math.max(band.top, k.bounds.y),
    bottom: Math.min(band.bottom, k.bounds.y + k.bounds.height) }))], children };
}

function findSelector(node, selector) {
  if (node.selector === selector) return node;
  for (const c of node.children ?? []) {
    const found = findSelector(c, selector);
    if (found) return found;
  }
  return null;
}

const sideOf = (boxes) => {
  const sorted = [...boxes].sort((p, q) => q.w - p.w);
  if (sorted[0].w <= MIN_SIDE_RATIO * sorted[1].w) return 'columns';
  const byX = [...boxes].sort((p, q) => p.x - q.x);
  if (byX[0] === sorted[0]) return 'main-left';
  return byX.at(-1) === sorted[0] ? 'main-right' : 'main-centre';
};

/**
 * The layout, read from the page: the candidate's parts side by side; else the columns of
 * its leaves; else a rail the dump set aside that overlaps it. A narrow part beside a wide
 * one is a side column; a layout needs height to be one (a byline is not).
 */
export function layoutOf(c, capture, cols, { grid = false } = {}) {
  const h = c.bottom - c.top;
  const parts = c.parts.filter((p) => p.w >= 120);
  // Columns read from the leaves of a grid of alike items are the grid's, not the band's.
  const fromLeaves = !grid && cols.length >= 2;
  const boxes = parts.length >= 2 ? parts
    : fromLeaves ? cols.map((k) => ({ x: k.x0, w: k.x1 - k.x0 })) : [];
  let layout = boxes.length >= 2 ? sideOf(boxes) : 'single';
  if (layout === 'single') {
    const rails = (capture.analysis?.rails ?? []).filter((r) => (
      Math.min(r.y1, c.bottom) - Math.max(r.y0, c.top) >= 0.3 * Math.min(h, r.y1 - r.y0)));
    if (rails.length) {
      layout = rails.every((r) => r.side === 'right') ? 'main-left'
        : rails.every((r) => r.side === 'left') ? 'main-right' : 'main-centre';
    }
  }
  if (layout.startsWith('main') && h < MIN_LAYOUT_PX) return 'single';
  return layout;
}

const covering = (bgs, c) => bgs.filter((b) => b.y <= c.top + 2 && b.y + b.h >= c.bottom - 2
  && b.bg.startsWith('color:')).sort((a, b) => a.h - b.h)[0]?.bg ?? null;

/**
 * What a reader needs to know and a System 1 model cannot count, from the band capture:
 * columns, images by size and likeness, headings, text amount, links, inputs, embeds.
 */
export function facts(c, capture, { inside: within = false } = {}) {
  const { W } = capture;
  const h = c.bottom - c.top;
  const inside = inBand(contentLeaves(capture.leaves), { y: c.top, h });
  const cols = columnsOf(inside.filter((l) => !l.m || l.w >= 40), c.top, c.bottom, W,
    capture.analysis?.gutter ?? 24);
  const images = inside.filter((l) => l.m && l.e !== 'svg' && l.w >= 100 && l.h >= 80);
  const big = images.filter((l) => l.w >= 0.6 * W || l.w * l.h >= 0.35 * W * h);
  const groups = new Map();
  for (const im of images) {
    const key = `${Math.round(im.w / 20)}x${Math.round(im.h / 20)}`;
    groups.set(key, [...(groups.get(key) ?? []), im]);
  }
  const alike = [...groups.values()].filter((g) => g.length >= 3
    && new Set(g.map((im) => Math.round(im.x / 30))).size >= 2)
    .sort((a, b) => b.length - a.length)[0];
  const headings = inside.filter((l) => /^H[1-6]$/.test(l.e)).length;
  const texts = inside.filter((l) => l.t && !/^H[1-6]$/.test(l.e)
    && !['A', 'BUTTON'].includes(l.e));
  const chars = texts.reduce((n, l) => n + l.t.length, 0);
  const long = texts.filter((l) => l.t.length >= 80).length;
  const links = inside.filter((l) => ['A', 'BUTTON'].includes(l.e)).length;
  const inputs = inside.filter((l) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(l.e)).length;
  const embeds = inside.filter((l) => l.e === 'IFRAME' || l.e === 'VIDEO').length;
  return {
    inside, cols, images: images.length, big: big.length, alike: alike?.length ?? 0, headings,
    chars, long, links, inputs, embeds,
    // Inside a section its side column is set aside already: a child's layout is its own parts'.
    layout: within ? (c.parts.filter((p) => p.w >= 120).length >= 2
      ? sideOf(c.parts.filter((p) => p.w >= 120)) : 'single')
      : layoutOf(c, capture, cols, { grid: (alike?.length ?? 0) >= 3 }),
    imageOnly: images.length >= 1 && chars === 0 && headings === 0 && links <= 1 && inputs === 0,
    fullBleed: big.some((im) => im.w >= FULL_BLEED * W),
    loneHeading: headings === 1 && chars === 0 && images.length === 0 && links <= 1,
    background: covering(capture.bgs ?? [], c),
  };
}

const LAYOUT_WORDS = {
  'main-left': 'a main column with a narrower side column on the right',
  'main-right': 'a narrower side column on the left of the main column',
  'main-centre': 'a main column with narrower side columns on both sides',
};

/** The facts as words: the state a System 1 model reads about one candidate. */
export function stateOf(c, capture, f = facts(c, capture)) {
  const base = bandState({ y: c.top, h: c.bottom - c.top, bg: f.background, cols: f.cols.length,
    columns: f.cols }, capture.leaves, capture.H);
  const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
  const picture = f.big ? (f.images === f.big
    ? `${plural(f.big, 'large image')} covering most of the band`
    : `${count(f.big)} large image and ${count(f.images - f.big)} smaller`)
    : f.alike ? `${count(f.alike)} alike images of one size in a row or grid`
      : f.images ? plural(f.images, 'image') : 'no image';
  const text = f.chars === 0 ? 'no text'
    : f.long === 0 ? 'short texts only (titles, labels, captions)'
      : f.long < 3 ? 'a few lines of text'
        : `paragraphs of running text (${count(Math.min(f.long, 8))}${f.long > 8 ? '+' : ''})`;
  const layout = f.layout === 'columns' && base.layout !== 'one column' ? base.layout
    : LAYOUT_WORDS[f.layout]
      ?? (f.layout === 'columns' ? 'equal columns side by side' : base.layout);
  return {
    at: base.at, height: base.height, background: base.background, layout, picture, text,
    headings: plural(f.headings, 'heading'),
    links: `${count(f.links)} link${f.links === 1 ? '' : 's'} or button`
      + (f.links === 1 ? '' : 's'),
    ...(f.inputs ? { inputs: plural(f.inputs, 'input field') } : {}),
    ...(f.embeds ? { embeds: `${count(f.embeds)} embedded video or frame` } : {}),
    content: base.content,
  };
}

export const CRITERIA = {
  default_content: 'plain document content only: headings, paragraphs, lists, links or buttons,'
    + ' a breadcrumb, a small image in the flow of the text — one after another as in an article',
  block: 'one component and nothing else: a large image or video with at most a title, a short'
    + ' text and a button (a hero); a short call-to-action banner on its own background (a'
    + ' heading, a line, a button); a slideshow; a row or grid of alike cards or tiles; tabs; an'
    + ' accordion of collapsed questions; a form; a table; an embedded video or frame',
  section: 'several different things together: a heading or paragraphs above or beside a'
    + ' component, two components one above the other, or a main column of running text beside'
    + ' a narrower side column',
};

/** The five questions about one candidate; the merge one only when there is a previous. */
export function questions(hasPrevious) {
  const img1 = ' Image 1 shows `band`.';
  const qs = {
    is_default: { type: 'noul', instructions: `Is \`band\` ${CRITERIA.default_content}?${img1}` },
    is_block: { type: 'noul', instructions: `Is \`band\` ${CRITERIA.block}?${img1}` },
    is_section: { type: 'noul', instructions: `Does \`band\` hold ${CRITERIA.section}?${img1}` },
    title_above: { type: 'noul', instructions: 'Does `band` start with a heading (alone or with a'
      + ' short introduction) that sits above and introduces a component below it — a row or'
      + ` grid of cards, a list of items, a slideshow, a form?${img1}` },
  };
  if (hasPrevious) {
    qs.merge = { type: 'noul', instructions: 'Do `previous` and `band` form one part of the page'
      + ' for an author? Yes when `previous` is a heading or a short introduction for `band`,'
      + ' when `band` continues what `previous` shows (more items of the same list or grid), or'
      + ' when the two are the pieces of one component. No when `band` starts a different part'
      + ' under a heading of its own, or on a different background. Image 2 shows `previous`'
      + ' above `band`.' };
  }
  return qs;
}

/** The wording's hash: answers from different wordings are never read together unnoticed. */
export const WORDING = createHash('sha256')
  .update(JSON.stringify([questions(true), CRITERIA, MERGE, TITLE_ABOVE])).digest('hex')
  .slice(0, 8);

/**
 * One candidate's kind from the answers and the facts: the most probable of the three, a
 * block with a heading introducing it is a section; then what the page itself settles — a
 * side layout is a section unless one block fills it, equal columns of plain content are a
 * columns block, a lone
 * heading is default content, an image alone is a hero when full-bleed and an image in flow
 * when not.
 */
export function decide(answers, f) {
  const probabilities = {
    default_content: answers.is_default.noul, block: answers.is_block.noul,
    section: answers.is_section.noul, title_above: answers.title_above.noul,
  };
  let judged = KINDS.map((k) => [k, probabilities[k]]).sort((a, b) => b[1] - a[1])[0][0];
  if (judged === 'block' && probabilities.title_above >= TITLE_ABOVE) judged = 'section';
  let kind = judged;
  // A side layout is a section — prose beside a side column — unless the model saw one
  // component in both parts (a hero's image beside its text panel).
  if (f.layout.startsWith('main') && judged !== 'block') kind = 'section';
  else if (f.layout === 'columns' && judged === 'default_content') kind = 'block';
  if (f.loneHeading) kind = 'default_content';
  if (f.imageOnly) kind = f.fullBleed ? 'block' : 'default_content';
  const merge = f.inside.length === 0 ? 1 : (answers.merge?.noul ?? 0);
  return { kind, judged, layout: f.layout, probabilities, merge, empty: f.inside.length === 0 };
}

/**
 * The bands after merging: a candidate joins the one before it when its merge answer says
 * so (inside a section, only a candidate of the same kind); a band of one kind keeps it, of
 * mixed kinds is a section; the layout is the widest named among its members.
 */
export function derive(cands, decisions, { sameKind = false } = {}) {
  const out = [];
  cands.forEach((c, i) => {
    const d = decisions[i];
    // Inside a section (sameKind), two children are one item only when they are pieces of
    // the same kind of thing — more cards of one grid, more paragraphs of one text — never a
    // heading and the block it introduces: those are two items of the section.
    const joins = d.merge >= MERGE && (!sameKind
      || (d.kind === decisions[i - 1]?.kind && d.kind !== 'section'));
    if (i > 0 && joins) {
      const last = out.at(-1);
      last.bottom = c.bottom;
      last.members.push(c.id);
      last.kinds.push(d.kind);
      last.layouts.push(d.layout);
    } else {
      out.push({ top: c.top, bottom: c.bottom, members: [c.id], kinds: [d.kind],
        layouts: [d.layout] });
    }
  });
  return out.map((b, i) => ({
    id: `B${i + 1}`, top: b.top, bottom: b.bottom, members: b.members,
    kind: new Set(b.kinds).size === 1 ? b.kinds[0] : 'section',
    layout: b.layouts.find((l) => l !== 'single') ?? 'single',
  }));
}

/** A crop of the page's screenshot between two heights, fitted for the model, as a data URI. */
export async function cropOf(sharp, shot, top, bottom, { W, H }) {
  const y0 = Math.max(0, top);
  const height = Math.max(8, Math.min(bottom, H) - y0);
  const buf = await sharp(shot).extract({ left: 0, top: y0, width: W, height })
    .resize({ width: IMAGE_WIDTH, height: Math.round(IMAGE_WIDTH * 0.6), fit: 'inside' })
    .jpeg({ quality: 70 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const selectorOf = (c) => (
  c.parts.map((p) => p.selector).filter(Boolean).join(', ') || `band@${c.top}`);
const boxOf = (top, bottom, W) => ({ x: 0, y: top, width: W, height: bottom - top });

/**
 * One page: candidates from its tree, each asked with its facts and crops, the bands
 * derived; the structure artefact written under the page and its composition — fragments
 * as chrome placed them, one section per band with its layout as a style, the members as
 * items. `io.askQuestions` is the model and `io.crop` the picture, both injectable.
 */
export async function structurePage(cwd, pageId, { io, dep, now = () => new Date() }) {
  const { bands: layer, composition, website, trees, pages } = await data(cwd);
  const [capture, chromeComp, tree, page] = await Promise.all([layer.readCapture(cwd, pageId),
    composition.read(cwd, pageId), trees.read(cwd, pageId), pages.get(cwd, pageId)]);
  if (!capture || !chromeComp || !tree || !tree.page?.shot) return null;
  const fragments = (await website.readFragments(cwd))?.fragments ?? [];
  const body = bodyEdges(chromeComp, fragments, capture.H);
  const shot = path.join(cwd, 'migration', tree.page.shot);
  const usage = { inputTokens: 0, requests: 0 };
  const ask = async (list, { within = false } = {}) => {
    const decisions = [];
    for (const [i, c] of list.entries()) {
      const f = facts(c, capture, { within });
      const prev = list[i - 1];
      if (c.from) {
        // A member of a band merged at level 1 is a child by construction: asked its kind,
        // never merged again.
        const d = await askOne(c, f, null);
        decisions.push({ ...d, merge: 0 });
        continue;
      }
      if (c.text) {
        // A run of text elements between blocks is default content, as EDS defines it.
        decisions.push({ kind: 'default_content', judged: 'default_content', layout: f.layout,
          probabilities: null, merge: 0, empty: f.inside.length === 0,
          state: stateOf(c, capture, f), answers: null, rule: 'text run' });
        continue;
      }
      decisions.push(await askOne(c, f, prev));
    }
    return decisions;
  };
  async function askOne(c, f, prev) {
    const state = { band: stateOf(c, capture, f) };
    if (prev) state.previous = stateOf(prev, capture);
    const images = [await io.crop(shot, c.top, c.bottom, capture)];
    if (prev) images.push(await io.crop(shot, prev.top, c.bottom, capture));
    const { answers, usage: u } = await io.askQuestions(dep,
      { state, questions: questions(Boolean(prev)), images });
    usage.inputTokens += u.inputTokens ?? 0;
    usage.requests += 1;
    return { ...decide(answers, f), state: state.band,
      answers: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.noul])) };
  }
  const record = (c, d, within = false) => {
    const { inside, cols, ...rest } = facts(c, capture, { within });
    const { state, ...decision } = d;
    return { id: c.id, top: c.top, bottom: c.bottom, parts: c.parts,
      ...(c.selectors ? { selectors: c.selectors } : {}), columns: cols.length,
      facts: { ...rest, leaves: inside.length }, state, ...decision };
  };
  // Level 1: the body's candidates, asked, derived into bands.
  const cands = candidates(tree.tree, body);
  const decisions = await ask(cands);
  const bands = derive(cands, decisions);
  // Levels 2 and 3: each section opened into its children, asked the same way; a child
  // that is a section again is opened once more. Every candidate asked is on record.
  const opened = [];
  const pool = [...cands];
  const queue = bands.filter((b) => b.kind === 'section').map((b) => ({ band: b, depth: 2 }));
  while (queue.length) {
    const { band, depth } = queue.shift();
    const { side, children, leaf } = open(band, pool, tree.tree);
    if (leaf || !children.length) { band.leaf = true; band.side = side; continue; }
    // eslint-disable-next-line no-await-in-loop
    const kids = await ask(children, { within: true });
    band.side = side;
    // What opening found is the layout: a side column on the left makes the main column right.
    if (side.length) {
      const mid = (sd) => sd.x + sd.w / 2 < capture.W / 2;
      band.layout = side.every(mid) ? 'main-right' : side.every((sd) => !mid(sd)) ? 'main-left'
        : 'main-centre';
    }
    band.children = derive(children, kids, { sameKind: true })
      .map((b, i) => ({ ...b, id: `${band.id}.${i + 1}` }));
    pool.push(...children);
    opened.push(...children.map((c, i) => record(c, kids[i], true)));
    if (depth < MAX_DEPTH) {
      queue.push(...band.children.filter((k) => k.kind === 'section')
        .map((k) => ({ band: k, depth: depth + 1 })));
    }
  }
  const at = now().toISOString();
  const { W } = capture;
  const byId = new Map(cands.map((c, i) => [c.id, { c, d: decisions[i] }]));
  // A section's items are the leaves of its opened children — EDS has no nested sections —
  // plus its side columns, in reading order.
  const selectorFor = (ids) => ids.flatMap((m) => {
    const o = opened.find((x) => x.id === m);
    return o ? (o.selectors ?? o.parts.map((p) => p.selector)) : [selectorOf(byId.get(m).c)];
  }).filter(Boolean).join(', ');
  const items = (band) => {
    const aside = (band.side ?? []).map((sd) => ({ role: 'content', selector: sd.selector,
      bounds: { x: sd.x, y: sd.top, width: sd.w, height: sd.bottom - sd.top } }));
    if (!band.children) {
      const own = band.members.map((m) => {
        const { c, d } = byId.get(m);
        return { role: d.kind === 'block' ? 'block' : 'content', selector: selectorOf(c),
          bounds: boxOf(c.top, c.bottom, W) };
      });
      return [...own, ...aside];
    }
    const own = band.children.flatMap((k) => (k.children ? items(k)
      : [{ role: k.kind === 'block' ? 'block' : 'content',
        selector: selectorFor(k.members) || `band@${k.top}`, bounds: boxOf(k.top, k.bottom, W) }]));
    return [...own, ...aside];
  };
  const comp = {
    method: { name: METHOD, version: WORDING, at, inputs: capture.updatedAt ?? at },
    fragments: chromeComp.fragments,
    sections: bands.map((b, i) => ({
      id: `s${i + 1}`, selector: selectorOf(byId.get(b.members[0]).c),
      bounds: boxOf(b.top, b.bottom, W),
      style: { background: byId.get(b.members[0]).d.state.background, layout: b.layout },
      items: items(b),
    })),
    omitted: [],
  };
  const structure = {
    page: pageId, method: { name: METHOD, model: dep.model, wording: WORDING, at }, body,
    candidates: cands.map((c, i) => record(c, decisions[i])),
    bands, children: opened, usage,
  };
  await layer.writeStructure(cwd, pageId, structure);
  return { structure, composition: comp };
}

/** The real pictures: crops from the screenshot with sharp. */
export const realCrop = (cwd) => {
  const sharp = sharpOf(cwd);
  return (shot, top, bottom, capture) => cropOf(sharp, shot, top, bottom, capture);
};

/** The lab command: every page of a selection, sequentially; compositions written. */
export async function structure(cwd, selectionName, { io, dep } = {}) {
  const { selections, composition } = await data(cwd);
  const sel = await selections.read(cwd, selectionName);
  if (!sel) throw new Error(`no selection ${selectionName}`);
  const model = dep ?? deployment();
  const reader = io ?? { askQuestions, crop: realCrop(cwd) };
  const out = [];
  for (const id of sel.pages) {
    // eslint-disable-next-line no-await-in-loop
    const result = await structurePage(cwd, id, { io: reader, dep: model });
    if (!result) continue;
    // eslint-disable-next-line no-await-in-loop
    await composition.write(cwd, id, result.composition);
    const s = result.structure;
    out.push({ id, candidates: s.candidates.length, bands: s.bands.length,
      kinds: s.bands.map((b) => b.kind[0] + (b.layout === 'single' ? '' : `/${b.layout}`)
        + (b.children ? `[${b.children.map((k) => k.kind[0]).join('')}]` : b.leaf ? '[leaf]' : ''))
        .join(' '),
      children: s.children.length, tokens: s.usage.inputTokens });
  }
  return out;
}

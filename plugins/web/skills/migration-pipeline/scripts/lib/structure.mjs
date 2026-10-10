// A page's structure, as one operation applied until it has nothing left to do: cut a part
// of the page into candidates, qualify each — section, block, default content, or layout —
// and cut again inside every section and layout. The cut is the visual tree's: siblings
// stacked or side by side, so no cut passes through an element; facts a reader needs and a
// model cannot count come from the band capture, as words; a System 1 model answers yes/no
// questions per candidate from the words and crops; rules settle what the page settles. A
// layout is a container whose parts sit side by side, asked only when they do. Measured at
// the first level against Haiku 5.5 on 70 pages of seven sites: kind 90 %, merge 85 %.
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
export const LAYOUT = 0.5; // the layout answer at or above this makes parts side by side a layout
export const MIN_LAYOUT_PX = 300; // a side column needs this much height to be named one
export const MIN_SIDE_RATIO = 1.6; // a part this much wider than its neighbour is the main column
export const MIN_PART_WIDTH = 120; // narrower parts beside a wide one are decoration, not columns
export const FULL_BLEED = 0.9; // an image-only band this wide is a hero; narrower, an image in flow
export const IMAGE_WIDTH = 1280; // crops are fitted in IMAGE_WIDTH × 0.6 IMAGE_WIDTH
export const MAX_DEPTH = 12; // a guard: every cut goes strictly inside, the tree ends sooner
export const KINDS = ['default_content', 'block', 'section', 'layout'];
export const CONTAINERS = new Set(['section', 'layout']);
// Prose: in EDS, default content is a run of these between blocks. Lists, links and spans
// are not here — they can be a nav, tabs or cards; the reader is asked about them.
export const TEXT_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE',
  'PICTURE', 'IMG', 'HR', 'EM', 'STRONG', 'CODE', 'FIGURE']);

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const count = (n) => WORDS[n] ?? 'many';

/**
 * The level of the tree at which a range's parts are siblings: from the node, through
 * wrapper chains (one child inside the range, or one child covering it with only slivers
 * beside it) to the first node with two or more children inside the range.
 */
export function siblings(tree, range) {
  const inside = (n) => (
    n.bounds.y + n.bounds.height > range.top + 2 && n.bounds.y < range.bottom - 2);
  let node = tree;
  for (let i = 0; i < 12; i += 1) {
    const kids = (node.children ?? []).filter((k) => k.bounds.height > 0 && inside(k));
    if (kids.length === 0) return [node];
    if (kids.length === 1) { node = kids[0]; continue; }
    const big = kids.filter((k) => k.bounds.height >= 0.95 * (range.bottom - range.top));
    // Through a child as tall as the range, unless another sits beside it: clear of it
    // across and more than a sliver (a side column, not a layer over it or a skip link).
    const beside = (k) => k !== big[0] && k.bounds.width * k.bounds.height
      >= 0.05 * big[0].bounds.width * big[0].bounds.height
      && (k.bounds.x >= big[0].bounds.x + big[0].bounds.width - 8
        || k.bounds.x + k.bounds.width <= big[0].bounds.x + 8);
    if (big.length === 1 && kids.length <= 3 && !kids.some(beside)) { node = big[0]; continue; }
    return kids;
  }
  return [node];
}

const dedupeX = (parts) => parts.sort((p, q) => p.x - q.x)
  .filter((p, j, all) => !all.slice(0, j).some((q) => Math.abs(q.x - p.x) < 40));
const partOf = (n) => ({ x: n.bounds.x, w: n.bounds.width, selector: n.selector });
const extentOf = (nodes) => ({ left: Math.min(...nodes.map((n) => n.bounds.x)),
  right: Math.max(...nodes.map((n) => n.bounds.x + n.bounds.width)) });

/**
 * Nodes stacked into candidates within a range: those sharing a vertical range form one
 * candidate with parts side by side; the others stack. Gaps belong to the candidate above;
 * the first starts at the range's top, the last ends at its bottom.
 */
export function stack(nodes, range) {
  const sorted = [...nodes].sort((a, b) => a.bounds.y - b.bounds.y);
  const out = [];
  for (const n of sorted) {
    const y0 = Math.max(range.top, n.bounds.y);
    const y1 = Math.min(range.bottom, n.bounds.y + n.bounds.height);
    if (y1 - y0 < 4) continue;
    const last = out.at(-1);
    if (last && y0 < last.bottom - 8) {
      last.bottom = Math.max(last.bottom, y1);
      last.nodes.push(n);
    } else out.push({ top: y0, bottom: y1, nodes: [n] });
  }
  for (let i = 1; i < out.length; i += 1) out[i - 1].bottom = out[i].top;
  if (out.length) { out[0].top = range.top; out.at(-1).bottom = range.bottom; }
  return out.map((b) => ({ top: b.top, bottom: b.bottom, ...extentOf(b.nodes),
    parts: dedupeX(b.nodes.map(partOf)), nodes: b.nodes }));
}

/**
 * The body's candidates: its siblings stacked, runs of prose as one, each as wide as the
 * page — the cut of every depth, at the first.
 */
export function candidates(tree, body, W = 1280) {
  return runs(stack(siblings(tree, body), body))
    .map((c, i) => ({ ...c, id: `C${i + 1}`, left: 0, right: W }));
}

const isText = (c) => c.nodes.every((n) => TEXT_TAGS.has(n.tag));
// Side by side: two wide parts mostly clear of each other across — a grid's columns may
// overlap by a margin, a layer lies over most of what is under it.
export const SIDE_OVERLAP = 0.25;
const sideBySide = (c) => {
  const wide = c.parts.filter((p) => p.w >= MIN_PART_WIDTH);
  return wide.some((p, i) => wide.slice(i + 1).some((q) => (
    Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) <= SIDE_OVERLAP * Math.min(p.w, q.w))));
};
const weight = (n) => 1 + (n.children ?? []).reduce((s, k) => s + weight(k), 0);
export const MIN_ALIKE = 3; // this many parts of one shape are a list of items: one component
export const ALIKE_SHARE = 0.8; // of the nodes inside: a grid with its pagination still is one
// Parts of one shape — the same tag and first class, most within a quarter of their median
// size along the axis they repeat on — making up most of what is inside: cards of a grid
// (in rows or not), items of a list, columns of one kind.
export function alike(kids, side) {
  const nodes = kids.flatMap((k) => k.nodes);
  // The first class names the component; the others are its modifiers (a card's category).
  const shape = (n) => `${n.tag}.${String(n.className ?? '').trim().split(/\s+/)[0]}`;
  const counts = new Map();
  // Prose is no item: a run of paragraphs counts in what is inside, never as the items.
  for (const n of kids.filter((k) => !k.text).flatMap((k) => k.nodes)) {
    counts.set(shape(n), (counts.get(shape(n)) ?? 0) + 1);
  }
  const [top, n] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
  if (n < MIN_ALIKE || n < ALIKE_SHARE * nodes.length) return false;
  // Most of them about one size: an odd one (a link styled like the cards) does not undo it.
  const size = nodes.filter((x) => shape(x) === top)
    .map((x) => (side ? x.bounds.width : x.bounds.height)).sort((x, y) => x - y);
  const median = size[Math.floor(size.length / 2)];
  const near = size.filter((x) => x >= 0.75 * median && x <= 1.25 * median).length;
  return near >= MIN_ALIKE && near >= ALIKE_SHARE * size.length;
}

// Consecutive runs of text elements are one candidate: default content, as EDS defines it.
function runs(cands) {
  const out = [];
  for (const c of cands) {
    const last = out.at(-1);
    if (last && isText(last) && isText(c)) {
      last.bottom = c.bottom;
      last.nodes.push(...c.nodes);
      Object.assign(last, extentOf(last.nodes));
      last.parts = dedupeX([...last.parts, ...c.parts]);
    } else out.push({ ...c, nodes: [...c.nodes], parts: [...c.parts] });
  }
  return out.map((c) => (isText(c) ? { ...c, text: true } : c));
}

// A side-by-side group's columns: its nodes by x, each column its own range.
function columns(c) {
  const cols = [];
  for (const n of [...c.nodes].sort((a, b) => a.bounds.x - b.bounds.x)) {
    const col = cols.find((k) => Math.abs(k[0].bounds.x - n.bounds.x) < 40);
    if (col) col.push(n); else cols.push([n]);
  }
  return cols.map((nodes) => ({
    top: Math.max(c.top, Math.min(...nodes.map((n) => n.bounds.y))),
    bottom: Math.min(c.bottom, Math.max(...nodes.map((n) => n.bounds.y + n.bounds.height))),
    ...extentOf(nodes), parts: dedupeX(nodes.map(partOf)), nodes,
  }));
}

/**
 * What is inside a candidate, one level down, for every depth alike: its columns when its
 * parts sit side by side; else its nodes stacked; else, for one node, through the wrapper
 * chains to its siblings — a group of siblings side by side making it side by side, layers
 * (a background under its content) passed through into the one with most content. `side`
 * tells which; `kids` is empty when the tree ends: there is nothing to cut.
 */
export function cut(c) {
  if (sideBySide(c)) return { side: true, kids: columns(c) };
  let level = c.nodes.length > 1 ? c.nodes : null;
  let [node] = c.nodes;
  let carry = [];
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (!level) {
      const below = siblings(node, c);
      const leaf = below.length === 1 && !(below[0].children ?? []).length;
      if (leaf && !carry.length) return { side: false, kids: [] };
      level = [...carry, ...(leaf ? [] : below)];
    }
    let inner = stack(level, c);
    if (inner.length === 1 && carry.length) {
      // The layers carried along still lie over the content: the content alone.
      level = level.filter((n) => !carry.includes(n));
      inner = stack(level, c);
    }
    carry = [];
    if (inner.length !== 1) return { side: false, kids: runs(inner) };
    const [only] = inner;
    if (sideBySide(only)) return { side: true, kids: columns(only) };
    // One candidate, one column: layers over each other, or a wrapper — into the one with
    // most content, the other layers carried along once to be stacked with its children.
    const next = only.nodes.reduce((a, n) => (weight(n) > weight(a) ? n : a));
    if (next === node && level.length === 1) return { side: false, kids: [] };
    carry = only.nodes.filter((n) => n !== next);
    node = next;
    level = null;
  }
  return { side: false, kids: [] };
}

const sideOf = (boxes) => {
  const sorted = [...boxes].sort((p, q) => q.w - p.w);
  if (sorted[0].w <= MIN_SIDE_RATIO * sorted[1].w) return 'columns';
  const byX = [...boxes].sort((p, q) => p.x - q.x);
  if (byX[0] === sorted[0]) return 'main-left';
  return byX.at(-1) === sorted[0] ? 'main-right' : 'main-centre';
};

/**
 * The arrangement, as a fact for the reader: the candidate's parts side by side; else the
 * columns of its leaves (not a grid's); else a rail the dump set aside that overlaps it. A
 * narrow part beside a wide one is a side column; a side column needs height to be one.
 */
export function layoutOf(c, capture, cols, { grid = false } = {}) {
  const h = c.bottom - c.top;
  const parts = c.parts.filter((p) => p.w >= MIN_PART_WIDTH);
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
// The capture's leaves within a candidate's horizontal extent: a column sees its own,
// a side rail's included — the dump sets a rail aside from the page's bands, but a column
// of a layout is its own part.
const leavesOf = (c, capture) => {
  if (c.left === undefined) return capture.leaves;
  const column = c.right - c.left < capture.W - 2;
  return capture.leaves.filter((l) => l.x + l.w / 2 >= c.left - 2
    && l.x + l.w / 2 <= c.right + 2).map((l) => (column && l.r ? { ...l, r: undefined } : l));
};

/**
 * What a reader needs to know and a System 1 model cannot count, from the band capture:
 * columns, images by size and likeness, headings, text amount, links, inputs, embeds.
 */
export function facts(c, capture) {
  const { W } = capture;
  const h = c.bottom - c.top;
  const inside = inBand(contentLeaves(leavesOf(c, capture)), { y: c.top, h });
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
    layout: layoutOf(c, capture, cols, { grid: (alike?.length ?? 0) >= 3 }),
    sideBySide: sideBySide(c),
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

// The parts side by side in words: how many, and each one's share of the width.
function partsWords(c) {
  const parts = c.parts.filter((p) => p.w >= MIN_PART_WIDTH);
  const total = c.right - c.left || 1;
  const shares = parts.map((p) => `${Math.round((100 * p.w) / total)} %`).join(', ');
  const same = c.inner?.side && alike(c.inner.kids, true) ? 'alike ' : '';
  return `${count(parts.length)} ${same}parts side by side, ${shares} of the width`;
}

// What is inside, one level down, in words: a model cannot count the parts of a tall band.
function stackWords(c) {
  const kids = c.inner?.side ? [] : c.inner?.kids ?? [];
  if (kids.length < 2) return null;
  const text = kids.filter((k) => k.text).length;
  const side = kids.filter((k) => !k.text && (sideBySide(k) || cut(k).side)).length;
  const rest = kids.length - text - side;
  const of = [text && `${count(text)} of text`, side && `${count(side)} with parts side by side`,
    rest && `${count(rest)} other`].filter(Boolean);
  if (alike(kids, false)) return `${count(kids.length)} alike parts one above another`;
  return `${count(kids.length)} parts one above another: ${of.join(', ')}`;
}

/** The facts as words: the state a System 1 model reads about one candidate. */
export function stateOf(c, capture, f = facts(c, capture)) {
  const base = bandState({ y: c.top, h: c.bottom - c.top, bg: f.background, cols: f.cols.length,
    columns: f.cols }, leavesOf(c, capture), capture.H);
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
    at: base.at, height: base.height, background: base.background, layout,
    ...(f.sideBySide ? { parts: partsWords(c) } : {}),
    ...(stackWords(c) ? { stack: stackWords(c) } : {}), picture, text,
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
    + ' a breadcrumb, a small image in the flow of the text, a code sample — one after another as'
    + ' in an article',
  block: 'one component and nothing else: a large image or video with at most a title, a short'
    + ' text and a button (a hero); a short call-to-action banner on its own background (a'
    + ' heading, a line, a button); a slideshow; a row or grid of alike cards or tiles; tabs; an'
    + ' accordion of collapsed questions; a form; a table; an embedded video or frame',
  section: 'several different things together: a heading or paragraphs above or beside a'
    + ' component, two components one above the other, or a main column of running text beside'
    + ' a narrower side column',
  layout: 'separate things placed next to each other — a main column beside a narrower side'
    + ' column, or columns that each hold content of their own — and not one component laid out'
    + ' in a row (cards or tiles of one grid, a slideshow, a hero\'s image beside its text)',
};

/**
 * The questions about one candidate: the three kinds and a heading introducing a component;
 * whether parts side by side are a layout, only when they are; the merge, only when there
 * is a candidate above in the same stack.
 */
export function questions(hasPrevious, side = false) {
  const img1 = ' Image 1 shows `band`.';
  const qs = {
    is_default: { type: 'noul', instructions: `Is \`band\` ${CRITERIA.default_content}?${img1}` },
    is_block: { type: 'noul', instructions: `Is \`band\` ${CRITERIA.block}?${img1}` },
    is_section: { type: 'noul', instructions: `Does \`band\` hold ${CRITERIA.section}?${img1}` },
    title_above: { type: 'noul', instructions: 'Does `band` start with a heading (alone or with a'
      + ' short introduction) that sits above and introduces a component below it — a row or'
      + ` grid of cards, a list of items, a slideshow, a form?${img1}` },
  };
  if (side) {
    qs.is_layout = { type: 'noul', instructions: 'Are the parts of `band` that sit side by side'
      + ` ${CRITERIA.layout}?${img1}` };
  }
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
  .update(JSON.stringify([questions(true, true), CRITERIA, MERGE, TITLE_ABOVE, LAYOUT]))
  .digest('hex').slice(0, 8);

/**
 * One candidate's kind from the answers and the facts: the most probable of the three, a
 * block with a heading introducing it a section; parts side by side a layout when the model
 * says so, or when it saw several things in them; then what the content settles — a lone
 * heading is default content, an image alone a hero when full-bleed and an image in flow
 * when not, parts of one shape repeated a block. `rule` names what changed the judgement.
 */
export function decide(answers, f) {
  const p = {
    default_content: answers.is_default.noul, block: answers.is_block.noul,
    section: answers.is_section.noul, title_above: answers.title_above.noul,
    ...(answers.is_layout ? { layout: answers.is_layout.noul } : {}),
  };
  let judged = KINDS.slice(0, 3).map((k) => [k, p[k]]).sort((a, b) => b[1] - a[1])[0][0];
  if (judged === 'block' && p.title_above >= TITLE_ABOVE) judged = 'section';
  if (f.sideBySide && (p.layout ?? 0) >= LAYOUT) judged = 'layout';
  let kind = judged;
  let rule = null;
  if (f.sideBySide && kind === 'section') { kind = 'layout'; rule = 'section side by side'; }
  if (f.loneHeading) { kind = 'default_content'; rule = 'lone heading'; }
  if (f.imageOnly) {
    kind = f.fullBleed ? 'block' : 'default_content';
    rule = f.fullBleed ? 'full-bleed image' : 'image in flow';
  }
  // Parts of one shape repeated are a list of items — cards, tiles, a gallery: one component.
  if (f.alikeParts) { kind = 'block'; rule = 'alike items'; }
  if (kind === judged) rule = null;
  const merge = f.inside.length === 0 ? 1 : (answers.merge?.noul ?? 0);
  return { kind, judged, rule, probabilities: p, merge, empty: f.inside.length === 0 };
}

/**
 * Candidates into bands: a candidate joins the one before it when its merge answer says so,
 * or when both are default content — in EDS consecutive default content is one run — inside
 * a container always (`runs`), at the first level on the same background: a section break
 * there is a change of style, or it is nothing an author sees. A band of one kind keeps it,
 * of mixed kinds — or of several containers — is a section.
 */
export function derive(cands, decisions, { runs: oneRun = false, ground = false } = {}) {
  const out = [];
  cands.forEach((c, i) => {
    const d = decisions[i];
    const prev = decisions[i - 1];
    // Default content still to be checked inside is not plain default content yet.
    const plain = (x) => x?.kind === 'default_content' && !x.check;
    const run = plain(d) && plain(prev)
      && (oneRun || (ground && (d.background ?? null) === (prev.background ?? null)));
    if (i > 0 && (d.merge >= MERGE || run)) {
      const last = out.at(-1);
      last.bottom = c.bottom;
      last.left = Math.min(last.left, c.left);
      last.right = Math.max(last.right, c.right);
      last.members.push(c.id);
      last.kinds.push(d.kind);
    } else {
      out.push({ top: c.top, bottom: c.bottom, left: c.left, right: c.right, members: [c.id],
        kinds: [d.kind] });
    }
  });
  return out.map(({ kinds, ...b }) => {
    const one = new Set(kinds).size === 1 ? kinds[0] : 'section';
    return { ...b, kind: kinds.length > 1 && CONTAINERS.has(one) ? 'section' : one };
  });
}

/** A crop of the page's screenshot, fitted for the model, as a data URI. */
export async function cropOf(sharp, shot, box, { W, H }) {
  const y0 = Math.max(0, box.top);
  const height = Math.max(8, Math.min(box.bottom, H) - y0);
  const left = Math.max(0, Math.floor(box.left ?? 0));
  const width = Math.max(8, Math.min(W, Math.ceil(box.right ?? W)) - left);
  const buf = await sharp(shot).extract({ left, top: y0, width, height })
    .resize({ width: IMAGE_WIDTH, height: Math.round(IMAGE_WIDTH * 0.6), fit: 'inside' })
    .jpeg({ quality: 70 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const selectorsOf = (c) => (c.text ? [...new Set(c.nodes.map((n) => n.selector))]
  : c.parts.map((p) => p.selector)).filter(Boolean);

/**
 * The reader of one page: asks a stack of candidates (columns are not a stack: no merge),
 * records every candidate asked, and qualifies inside each container until nothing is one.
 */
function reader({ capture, shot, io, dep }) {
  const usage = { inputTokens: 0, requests: 0 };
  const asked = [];
  async function askOne(c, f, prev) {
    const state = { band: stateOf(c, capture, f) };
    if (prev) state.previous = stateOf(prev, capture);
    const images = [await io.crop(shot, c, capture)];
    if (prev) {
      images.push(await io.crop(shot, { top: prev.top, bottom: c.bottom,
        left: Math.min(prev.left, c.left), right: Math.max(prev.right, c.right) }, capture));
    }
    const { answers, usage: u } = await io.askQuestions(dep,
      { state, questions: questions(Boolean(prev), f.sideBySide), images });
    usage.inputTokens += u.inputTokens ?? 0;
    usage.requests += 1;
    return { ...decide(answers, f), state: state.band,
      answers: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.noul])) };
  }
  // A column without content is the page's grid, not a part: with fewer than two columns
  // of content left the candidate is not side by side, and what remains is its inside.
  function seeColumns(c) {
    const full = c.inner.kids.filter((k) => inBand(contentLeaves(leavesOf(k, capture)
      .map((l) => ({ ...l, r: undefined }))), { y: k.top, h: k.bottom - k.top }).length > 0);
    c.inner = { side: full.length >= 2, kids: full };
    c.parts = full.length >= 2 ? full.map((k) => ({ x: k.left, w: k.right - k.left,
      selector: k.parts.map((q) => q.selector).join(', ') })) : full[0]?.parts ?? c.parts;
  }
  async function qualify(cands, { parent = null, depth = 1, stacked = true } = {}) {
    const decisions = [];
    for (const [i, c] of cands.entries()) {
      // Look before asking: what is inside, one level down. Siblings side by side under
      // wrappers make the candidate side by side; the reader is told its parts and asked.
      c.inner = c.text ? { side: false, kids: [] } : cut(c);
      if (c.inner.side) seeColumns(c);
      const f = facts(c, capture);
      // A list of bullets is prose, a list of cards is not: list items count as alike items
      // only when the list holds pictures or headings.
      const bullets = c.inner.kids.every((k) => k.nodes[0]?.tag === 'LI')
        && f.images === 0 && f.headings === 0;
      f.alikeParts = !bullets && alike(c.inner.kids, c.inner.side);
      // A run of text elements is default content, as EDS defines it: no model is asked.
      const d = c.text ? { kind: 'default_content', judged: null, rule: 'text run',
        probabilities: null, merge: 0, empty: f.inside.length === 0, state: null, answers: null }
        // eslint-disable-next-line no-await-in-loop
        : await askOne(c, f, stacked ? cands[i - 1] : null);
      d.background = f.background;
      d.check = d.kind === 'default_content' && !c.inner.side && c.inner.kids.length >= 2
        && c.inner.kids.some((k) => !k.text);
      decisions.push(d);
      const { inside, cols, ...rest } = f;
      asked.push({ id: c.id, parent, depth, top: c.top, bottom: c.bottom, left: c.left,
        right: c.right, parts: c.parts, selectors: selectorsOf(c), columns: cols.length,
        facts: { ...rest, leaves: inside.length }, ...d });
    }
    // Default content with parts inside, one of them not text, is dug into to check before
    // anything is merged: what comes back all default content is plain default content (and
    // runs with its neighbours); a block inside makes it a section.
    const checked = new Map();
    for (const [i, c] of cands.entries()) {
      const d = decisions[i];
      if (!d.check) continue;
      const node = { id: c.id, members: [c.id], kind: d.kind };
      // eslint-disable-next-line no-await-in-loop
      await dig(node, c, depth + 1);
      d.check = false;
      if (node.children) {
        Object.assign(d, { kind: 'section', rule: 'checked: holds more than text' });
        checked.set(c.id, node);
      } else if (node.kind !== 'default_content') {
        Object.assign(d, { kind: node.kind, rule: 'checked: one component' });
      }
      Object.assign(asked.find((a) => a.id === c.id), { kind: d.kind, rule: d.rule,
        check: false });
    }
    const prefix = parent ? `${parent}.` : 'B';
    const bands = derive(cands, decisions, { runs: depth > 1 && stacked, ground: depth === 1 })
      .map((b, i) => ({ id: `${prefix}${i + 1}`, ...b }));
    const byId = new Map(cands.map((c, i) => [c.id, { c, d: decisions[i] }]));
    // A checked candidate's children, under the id the node now has.
    const adopt = (node, id) => {
      const from = checked.get(node.members[0]);
      for (const a of asked) {
        if (a.parent === from.id || a.parent?.startsWith(`${from.id}.`)) {
          a.parent = id + a.parent.slice(from.id.length);
        }
      }
      Object.assign(node, { checked: true, children: renumber(from.children, from.id, id) });
    };
    // A band merged from several candidates has its members as children, as decided; a
    // container among them, or a container band of one candidate, is dug into — a checked
    // one has been already.
    for (const band of bands.filter((b) => CONTAINERS.has(b.kind))) {
      if (band.members.length > 1) {
        band.children = band.members.map((m, j) => {
          const { c, d } = byId.get(m);
          return { id: `${band.id}.${j + 1}`, top: c.top, bottom: c.bottom, left: c.left,
            right: c.right, members: [m], kind: d.kind };
        });
      }
      const containers = band.children?.filter((k) => CONTAINERS.has(k.kind)) ?? [band];
      for (const k of containers) {
        if (checked.has(k.members[0])) { adopt(k, k.id); continue; }
        // eslint-disable-next-line no-await-in-loop
        await dig(k, byId.get(k.members[0]).c, depth + 1);
      }
    }
    return bands;
  }
  // Inside a container: its cut, qualified; nothing to cut leaves it unresolved, one child
  // makes it that child.
  async function dig(node, c, depth) {
    const { side, kids } = c.inner;
    if (!kids.length || depth > MAX_DEPTH) { node.unresolved = true; return; }
    const named = kids.map((k, i) => ({ ...k, id: `${node.id}:C${i + 1}` }));
    const children = await qualify(named, { parent: node.id, depth, stacked: !side });
    if (children.length === 1) {
      const [only] = children;
      Object.assign(node, { kind: only.kind, collapsed: true });
      if (only.unresolved) node.unresolved = true;
      if (only.children) node.children = renumber(only.children, only.id, node.id);
      for (const a of asked) {
        if (a.parent === only.id || a.parent?.startsWith(`${only.id}.`)) {
          a.parent = node.id + a.parent.slice(only.id.length);
        }
      }
      return;
    }
    node.children = children;
  }
  return { qualify, asked, usage };
}

// A collapsed container's grandchildren take its place in the numbering: B3.1.2 → B3.2.
const renumber = (nodes, from, to) => nodes.map((n) => ({ ...n, id: to + n.id.slice(from.length),
  ...(n.children ? { children: renumber(n.children, from, to) } : {}) }));

const boxOf = (n) => ({ x: n.left, y: n.top, width: n.right - n.left, height: n.bottom - n.top });

/**
 * The composition read off the tree: a section per band of the first level, its items the
 * leaves of the tree under it in reading order. Flattening nested sections into EDS's one
 * level is a later phase's; the structure keeps the tree.
 */
export function compositionOf(bands, asked, { method, chrome, W }) {
  const byId = new Map(asked.map((a) => [a.id, a]));
  const selectorOf = (n) => n.members.flatMap((m) => byId.get(m)?.selectors ?? [])
    .join(', ') || `band@${n.top}`;
  const leaves = (n) => (n.children ? n.children.flatMap(leaves)
    : [{ role: n.kind === 'block' ? 'block' : 'content', selector: selectorOf(n),
      bounds: boxOf(n) }]);
  return {
    method, fragments: chrome.fragments,
    sections: bands.map((b, i) => ({
      id: `s${i + 1}`, selector: selectorOf(b), bounds: boxOf({ ...b, left: 0, right: W }),
      style: { background: byId.get(b.members[0])?.state?.background ?? 'none' },
      items: leaves(b),
    })),
    omitted: [],
  };
}

/**
 * One page: the body's candidates from its tree, qualified and dug into; the structure
 * artefact written under the page; its composition returned. `io.askQuestions` is the
 * model and `io.crop` the picture, both injectable.
 */
export async function structurePage(cwd, pageId, { io, dep, now = () => new Date() }) {
  const { bands: layer, composition, website, trees } = await data(cwd);
  const [capture, chromeComp, tree] = await Promise.all([layer.readCapture(cwd, pageId),
    composition.read(cwd, pageId), trees.read(cwd, pageId)]);
  if (!capture || !chromeComp || !tree || !tree.page?.shot) return null;
  const fragments = (await website.readFragments(cwd))?.fragments ?? [];
  const body = bodyEdges(chromeComp, fragments, capture.H);
  const shot = path.join(cwd, 'migration', tree.page.shot);
  const read = reader({ capture, shot, io, dep });
  const bands = await read.qualify(candidates(tree.tree, body, capture.W));
  const at = now().toISOString();
  const comp = compositionOf(bands, read.asked, { W: capture.W, chrome: chromeComp,
    method: { name: METHOD, version: WORDING, at, inputs: capture.updatedAt ?? at } });
  const structure = {
    page: pageId, method: { name: METHOD, model: dep.model, wording: WORDING, at }, body,
    candidates: read.asked, bands, usage: read.usage,
  };
  await layer.writeStructure(cwd, pageId, structure);
  return { structure, composition: comp };
}

/** The real pictures: crops from the screenshot with sharp. */
export const realCrop = (cwd) => {
  const sharp = sharpOf(cwd);
  return (shot, box, capture) => cropOf(sharp, shot, box, capture);
};

/** A band tree in letters: `s[d l[d b]]` — kind, then its children; `?` when unresolved. */
export const treeOf = (n) => (n.kind === 'default_content' ? 'd' : n.kind[0])
  + (n.children ? `[${n.children.map(treeOf).join(' ')}]` : n.unresolved ? '?' : '');

/** The lab command: every page of a selection, sequentially; compositions written. */
export async function structure(cwd, selectionName, { io, dep } = {}) {
  const { selections, composition } = await data(cwd);
  const sel = await selections.read(cwd, selectionName);
  if (!sel) throw new Error(`no selection ${selectionName}`);
  const model = dep ?? deployment();
  const read = io ?? { askQuestions, crop: realCrop(cwd) };
  const out = [];
  for (const id of sel.pages) {
    // eslint-disable-next-line no-await-in-loop
    const result = await structurePage(cwd, id, { io: read, dep: model });
    if (!result) continue;
    // eslint-disable-next-line no-await-in-loop
    await composition.write(cwd, id, result.composition);
    const s = result.structure;
    out.push({ id, candidates: s.candidates.length, bands: s.bands.length,
      tree: s.bands.map(treeOf).join(' '), tokens: s.usage.inputTokens });
  }
  return out;
}


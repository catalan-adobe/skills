// The body cut into bands by the visual tree: a band boundary is a horizontal line that no
// wide element crosses. Side columns are narrow and do not block cuts; a column that runs
// most of the body's height is a persistent side column, said apart. Per band: its extent
// (a background spanning the page, or contained), its background, the columns it is made
// of. Pure functions over a tree and the body's edges.
export const WIDE_SHARE = 0.4;
export const FULL_SHARE = 0.98;
export const SIDE_MAX_SHARE = 0.35;
export const SIDE_MIN_HEIGHT_SHARE = 0.6;
export const CUT_TOLERANCE_PX = 4;
export const MERGE_CUTS_PX = 12;
export const MIN_BAND_PX = 16;
export const EQUAL_RATIO = 1.25;

/** Every node with bounds, flattened, with its depth. */
export function flatten(tree, depth = 0, out = []) {
  if (tree.bounds) out.push({ node: tree, depth, ...tree.bounds });
  for (const c of tree.children ?? []) flatten(c, depth + 1, out);
  return out;
}

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/** Positions within `gap` of each other merged to their median. */
export function mergeCuts(ys, gap = MERGE_CUTS_PX) {
  const sorted = [...new Set(ys)].sort((a, b) => a - b);
  const groups = [];
  for (const y of sorted) {
    const last = groups.at(-1);
    if (last && y - last.at(-1) <= gap) last.push(y);
    else groups.push([y]);
  }
  return groups.map(median);
}

/** Wide, and with no wide element inside: a block, not a container of blocks. */
export function atomicWide(nodes, pageWidth) {
  const wide = nodes.filter((n) => n.width >= pageWidth * WIDE_SHARE);
  const contains = (o, n) => o !== n && o.x <= n.x + 1 && o.y <= n.y + 1
    && o.x + o.width >= n.x + n.width - 1 && o.y + o.height >= n.y + n.height - 1
    && (o.height > n.height || o.width > n.width);
  return wide.filter((n) => !wide.some((w) => contains(n, w)));
}

/**
 * The cut lines: the top and bottom edges of the atomic wide blocks inside the body that
 * no such block crosses — containers hold many bands and never block a cut — the body's
 * own edges included.
 */
export function cutsOf(nodes, body, pageWidth) {
  const wide = atomicWide(nodes, pageWidth)
    .filter((n) => n.y + n.height > body.top && n.y < body.bottom);
  const candidates = new Set([body.top, body.bottom]);
  for (const n of wide) {
    for (const y of [n.y, n.y + n.height]) {
      if (y > body.top + CUT_TOLERANCE_PX && y < body.bottom - CUT_TOLERANCE_PX) candidates.add(y);
    }
  }
  const crossed = (y) => wide.some((n) => n.y < y - CUT_TOLERANCE_PX
    && n.y + n.height > y + CUT_TOLERANCE_PX);
  const kept = [...candidates].filter((y) => y === body.top || y === body.bottom || !crossed(y));
  return mergeCuts(kept.map(Math.round));
}

/** The nodes that make up a band: inside it, and not inside another such node. */
function membersOf(nodes, band, pageWidth) {
  const inside = nodes.filter((n) => n.y >= band.top - CUT_TOLERANCE_PX
    && n.y + n.height <= band.bottom + CUT_TOLERANCE_PX && n.width >= pageWidth * 0.08
    && n.height >= 8);
  const outermost = inside.filter((n) => !inside.some((o) => o !== n && o.x <= n.x
    && o.y <= n.y && o.x + o.width >= n.x + n.width && o.y + o.height >= n.y + n.height
    && (o.width > n.width || o.height > n.height)));
  return outermost;
}

/** Distinct values, within `tol` of each other counted as one. */
const distinct = (values, tol) => mergeCuts(values.map(Math.round), tol).length;

/**
 * The band's columns: its tallest members tiling the width side by side; or a grid when
 * its members line up in several columns and several rows (cards, a gallery).
 */
export function columnsOf(members, band, pageWidth) {
  const height = band.bottom - band.top;
  const cells = members.filter((m) => m.width < pageWidth * 0.6 && m.height < height * 0.6);
  if (cells.length >= 4) {
    const columns = distinct(cells.map((c) => c.x), 16);
    const rows = distinct(cells.map((c) => c.y), 16);
    if (columns >= 2 && rows >= 2 && columns * rows >= cells.length * 0.6) {
      return { count: columns, structure: 'grid' };
    }
  }
  const tall = members.filter((m) => m.height >= height * 0.6)
    .sort((a, b) => a.x - b.x);
  const cols = [];
  for (const m of tall) {
    const last = cols.at(-1);
    if (last && m.x < last.x + last.width - 8) continue; // overlapping: the same column
    cols.push(m);
  }
  if (cols.length <= 1) return { count: Math.max(cols.length, 1), structure: 'one' };
  const widths = cols.map((c) => c.width);
  const ratio = Math.max(...widths) / Math.min(...widths);
  if (cols.length === 2 && ratio >= 1 / 0.6) {
    const side = cols[0].width < cols[1].width ? 'left' : 'right';
    return { count: 2, structure: `main-side-${side}` };
  }
  return { count: cols.length, structure: ratio <= EQUAL_RATIO ? 'equal' : 'unequal' };
}

/** A node's background colour when it states one; the nearest stated ancestor's else. */
function backgroundOf(member, nodes) {
  if (member.node.background?.value) return member.node.background.value;
  const around = nodes.filter((n) => n.node.background?.value && n.x <= member.x && n.y <= member.y
    && n.x + n.width >= member.x + member.width && n.y + n.height >= member.y + member.height)
    .sort((a, b) => (a.width * a.height) - (b.width * b.height));
  return around[0]?.node.background.value ?? null;
}

/** The lowest ancestor holding the band's members: the band's home in the DOM. */
function homeOf(members, nodes) {
  if (!members.length) return null;
  const box = {
    x: Math.min(...members.map((m) => m.x)), y: Math.min(...members.map((m) => m.y)),
    right: Math.max(...members.map((m) => m.x + m.width)),
    bottom: Math.max(...members.map((m) => m.y + m.height)),
  };
  const holders = nodes.filter((n) => n.x <= box.x + 1 && n.y <= box.y + 1
    && n.x + n.width >= box.right - 1 && n.y + n.height >= box.bottom - 1
    && !members.includes(n)).sort((a, b) => (a.width * a.height) - (b.width * b.height));
  return holders[0]?.node.selector ?? null;
}

/**
 * An interval with no member is spacing between bands, not a band: it joins the band
 * before it (the first one, the band after). Then consecutive bands of one column, the
 * same background and the same extent are one band the atomic cut split — a heading, its
 * paragraphs, a list, a table: one run of content, one section — and are merged.
 */
export function mergeAlike(bands) {
  const filled = [];
  for (const b of bands) {
    const last = filled.at(-1);
    if (b.members === 0 && last) {
      last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    } else if (b.members === 0 && bands.length > 1) {
      filled.push({ ...b, pending: true });
    } else if (last?.pending) {
      filled[filled.length - 1] = { ...b, top: last.top, height: b.bottom - last.top };
    } else filled.push({ ...b });
  }
  const out = [];
  for (const b of filled) {
    const last = out.at(-1);
    if (last && last.structure === 'one' && b.structure === 'one'
      && last.background === b.background && last.extent === b.extent) {
      last.bottom = b.bottom;
      last.height = last.bottom - last.top;
      last.members += b.members;
    } else out.push({ ...b });
  }
  return out.map(({ pending, ...b }) => b);
}

/**
 * The bands of a body, from its tree: cuts, then per band its members, extent, background
 * and columns, alike neighbours merged; and the persistent side columns, said apart.
 */
export function bandsFromTree(tree, body, { pageWidth = tree.bounds?.width || 1280,
  rootBackground = null } = {}) {
  const nodes = flatten(tree).filter((n) => n.depth > 0 && n.width > 0 && n.height > 0);
  const cuts = cutsOf(nodes, body, pageWidth);
  const bands = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const band = { top: cuts[i], bottom: cuts[i + 1] };
    if (band.bottom - band.top < MIN_BAND_PX) continue;
    const members = membersOf(nodes, band, pageWidth);
    const full = members.find((m) => m.width >= pageWidth * FULL_SHARE
      && m.height >= (band.bottom - band.top) * 0.8);
    const anchor = full ?? members.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    const background = anchor ? backgroundOf(anchor, nodes) : null;
    bands.push({
      ...band, height: band.bottom - band.top,
      extent: full ? 'full' : 'contained',
      background: background ?? rootBackground,
      ...columnsOf(members, band, pageWidth),
      selector: anchor?.node.selector ?? null,
      home: homeOf(members, nodes),
      members: members.length,
    });
  }
  const merged = mergeAlike(bands);
  const bodyHeight = body.bottom - body.top;
  const sides = nodes.filter((n) => n.width <= pageWidth * SIDE_MAX_SHARE
    && n.height >= bodyHeight * SIDE_MIN_HEIGHT_SHARE && n.y >= body.top - CUT_TOLERANCE_PX
    && n.y + n.height <= body.bottom + CUT_TOLERANCE_PX)
    .map((n) => ({ side: n.x + n.width / 2 < pageWidth / 2 ? 'left' : 'right',
      selector: n.node.selector, x: n.x, width: n.width, top: n.y, bottom: n.y + n.height }));
  const seen = new Set();
  const sideColumns = sides.filter((s) => (seen.has(s.side) ? false : seen.add(s.side)));
  return { cuts: [body.top, ...merged.slice(1).map((b) => b.top), body.bottom],
    bands: merged, sideColumns };
}

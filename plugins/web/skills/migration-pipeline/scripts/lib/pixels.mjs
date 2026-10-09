// The picture checks the reading. The dump says what the DOM claims is painted: bands with
// backgrounds, leaves with text and media. The screenshot says what was painted. Where they
// disagree the page was misread — a panel hidden by a rule the reader does not know, a scroll
// after the reading, content the DOM never showed — and a reader should look before judging.
import path from 'node:path';
import { sharpOf } from './browser.mjs';
import { data } from './data.mjs';

export const PIXEL_VERSION = 1;
export const SAMPLE_WIDTH = 320; // the screenshot is read at this width, every row kept
export const EDGE_SHARE = 0.03; // the page's margins: the outer columns on each side
// Max channel distance for two colours to agree: a section's light grey sits 7 from white,
// JPEG noise on a flat margin within 3.
export const COLOUR_TOLERANCE = 4;
export const INK_SPREAD = 40; // a pixel this far from its row's margin colour is ink
export const MIN_INK_SHARE = 0.05; // a band with content shows ink on at least this many rows
export const MIN_LEAVES = 2; // bands with fewer content leaves are not judged for ink
export const MIN_UNCLAIMED_PX = 100; // inked rows outside every band worth a flag

export const parseColour = (text) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(text ?? '');
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]),
  Math.abs(a[2] - b[2]));
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Per-row statistics of a raw RGB image: the row's pixels, the margin colour (median of the
 * outer columns on both sides) and the columns whose colour is far from it (ink), as
 * fractions of the width.
 */
export function rowStats(raw, width, height) {
  const edge = Math.max(1, Math.round(width * EDGE_SHARE));
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const px = raw.subarray(y * width * 3, (y + 1) * width * 3);
    const at = (x) => [px[x * 3], px[x * 3 + 1], px[x * 3 + 2]];
    const samples = [];
    for (let x = 0; x < edge; x += 1) samples.push(at(x), at(width - 1 - x));
    const margin = [0, 1, 2].map((c) => median(samples.map((s) => s[c])));
    const ink = [];
    for (let x = 0; x < width; x += 1) {
      if (distance(at(x), margin) > INK_SPREAD) ink.push(x / width);
    }
    rows.push({ px, margin, ink });
  }
  return rows;
}

const inkedIn = (row, x0, x1) => row.ink.some((x) => x >= x0 && x < x1);
const colourOf = (bg) => (bg?.startsWith('color:') ? parseColour(bg.slice(6)) : null);
const covers = (box, band) => box.y <= band.y && box.y + box.h >= band.y + band.h;

/**
 * What the DOM claims is painted behind a band and where: the band's own background box;
 * else the innermost wide decorated box covering it (a page-wide white wrapper over a grey
 * body); else the body's colour across the page. The colour is null when what covers the
 * band is an image or a gradient — nothing to check.
 */
export function claimedBox(capture, band) {
  const boxes = (capture.bgs ?? []).filter((b) => covers(b, band)).sort((a, b) => a.h - b.h);
  const own = band.bg ? boxes.find((b) => b.bg === band.bg) : null;
  const box = own ?? (band.bg ? null : boxes[0]);
  if (box) {
    return { colour: colourOf(box.bg), x0: box.x / capture.W, x1: (box.x + box.w) / capture.W };
  }
  return { colour: band.bg ? colourOf(band.bg) : parseColour(capture.pageBg), x0: 0, x1: 1 };
}

/**
 * The painted colour of a band's background: the median over its rows of the columns inside
 * the claimed box and outside every content leaf. Null when no column is left to read (a
 * photo bleeding to the box's edges).
 */
export function paintedColour(rows, y0, y1, box, leaves, width) {
  const mask = new Uint8Array(width);
  const from = Math.max(0, Math.ceil(box.x0 * width) + 1);
  const to = Math.min(width, Math.floor(box.x1 * width) - 1);
  for (let x = from; x < to; x += 1) mask[x] = 1;
  for (const l of leaves) {
    const a = Math.max(0, Math.floor(l.x0 * width) - 1);
    const b = Math.min(width, Math.ceil(l.x1 * width) + 1);
    for (let x = a; x < b; x += 1) mask[x] = 0;
  }
  const columns = [...mask.keys()].filter((x) => mask[x]);
  if (columns.length < 2) return null;
  const channel = (c) => {
    const values = [];
    for (let y = y0; y < y1; y += 1) for (const x of columns) values.push(rows[y].px[x * 3 + c]);
    return median(values);
  };
  return [0, 1, 2].map(channel);
}

/**
 * The claims of one page's band capture against the row statistics of its screenshot (one
 * row per page pixel; `rows.length` may be short of `H` when the shot was capped).
 */
export function checkBands(capture, rows) {
  const width = rows[0]?.px.length / 3 || SAMPLE_WIDTH;
  const bands = capture.analysis.bands.map((band) => {
    const y0 = Math.max(0, band.y);
    const y1 = Math.min(rows.length, band.y + band.h);
    if (y1 - y0 < 2) return { id: band.id, beyondShot: true };
    const inBand = capture.leaves.filter((l) => (l.t || l.m) && l.y >= band.y
      && l.y < band.y + band.h);
    const box = claimedBox(capture, band);
    // Every box the dump recorded over the band hides the background behind it: text, media
    // and decorated panels alike (a teal manual header, a gradient card).
    const content = capture.leaves.filter((l) => l.y < band.y + band.h && l.y + l.h > band.y)
      .map((l) => ({ x0: l.x / capture.W, x1: (l.x + l.w) / capture.W }));
    const pixel = box.colour ? paintedColour(rows, y0, y1, box, content, width) : null;
    const background = { claimed: box.colour, pixel,
      agree: !box.colour || !pixel || distance(box.colour, pixel) <= COLOUR_TOLERANCE };
    const slice = rows.slice(y0, y1);
    const span = band.columns?.length
      ? [Math.min(...band.columns.map((c) => c.x0)) / capture.W,
        Math.max(...band.columns.map((c) => c.x1)) / capture.W]
      : [0, 1];
    const inkRows = slice.filter((r) => inkedIn(r, span[0], span[1])).length;
    const inkShare = inkRows / slice.length;
    const embeds = [...new Set(inBand.filter((l) => l.src).map((l) => l.src))];
    const broken = [...new Set(inBand.filter((l) => l.b).map((l) => l.b))];
    return { id: band.id, background, leaves: inBand.length, inkShare: Number(inkShare.toFixed(3)),
      unpainted: inBand.length >= MIN_LEAVES && inkShare < MIN_INK_SHARE,
      ...(embeds.length ? { embeds } : {}), ...(broken.length ? { broken } : {}) };
  });
  const covered = new Uint8Array(rows.length);
  for (const b of capture.analysis.bands) {
    for (let y = Math.max(0, b.y); y < Math.min(rows.length, b.y + b.h); y += 1) covered[y] = 1;
  }
  let unclaimedRows = 0;
  for (let y = 0; y < rows.length; y += 1) {
    if (!covered[y] && rows[y].ink.length) unclaimedRows += 1;
  }
  const flags = [];
  if (bands.some((b) => b.background && !b.background.agree)) flags.push('bg-mismatch');
  if (bands.some((b) => b.unpainted)) flags.push('unpainted');
  if (unclaimedRows >= MIN_UNCLAIMED_PX) flags.push('unclaimed-ink');
  return { bands, unclaimedRows, flags };
}

/** Reads one page's screenshot into row statistics at SAMPLE_WIDTH. */
export async function readRows(file, sharp) {
  const meta = await sharp(file).metadata();
  const { data: raw, info } = await sharp(file).resize(SAMPLE_WIDTH, meta.height, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rows: rowStats(raw, info.width, info.height), shot: { width: meta.width,
    height: meta.height } };
}

/** Checks one page; writes `pages/<id>/pixel-check.json`; null without capture or shot. */
export async function checkPage(cwd, pageId, options = {}) {
  const { sharp = sharpOf(cwd), now = () => new Date() } = options;
  const { bands: layer, trees } = await data(cwd);
  const [capture, tree] = await Promise.all([layer.readCapture(cwd, pageId),
    trees.read(cwd, pageId)]);
  if (!capture || !tree?.page?.shot) {
    // No picture, no verdict: an earlier capture's check must not stand for this one.
    await layer.removePixelCheck(cwd, pageId);
    return null;
  }
  const read = await readRows(path.join(cwd, 'migration', tree.page.shot), sharp);
  const result = checkBands(capture, read.rows);
  const check = { page: pageId, version: PIXEL_VERSION, capturedAt: capture.updatedAt ?? null,
    shot: read.shot, ...result, checkedAt: now().toISOString() };
  await layer.writePixelCheck(cwd, pageId, check);
  return check;
}

/** A captured page whose check is missing or from an earlier capture (a shot is required). */
export async function stalePixelCheck(cwd, pageId) {
  const { bands: layer, trees } = await data(cwd);
  const [capture, check, tree] = await Promise.all([layer.readCapture(cwd, pageId),
    layer.readPixelCheck(cwd, pageId), trees.read(cwd, pageId)]);
  if (!capture || !tree?.page?.shot) return false;
  return !check || check.capturedAt !== (capture.updatedAt ?? null);
}

/**
 * The `misread` reasons from every stored check, replacing the last ones: a page's picture
 * disagrees with its reading, with the disagreement as the detail.
 */
export async function setMisread(cwd) {
  const { bands: layer, pages, trees } = await data(cwd);
  const flags = {};
  for (const id of await trees.list(cwd)) {
    // eslint-disable-next-line no-await-in-loop
    const [check, capture] = await Promise.all([layer.readPixelCheck(cwd, id),
      layer.readCapture(cwd, id)]);
    // A check of an earlier capture says nothing about this one.
    if (!check || check.capturedAt !== (capture?.updatedAt ?? null)) continue;
    const detail = layer.disagreement(check);
    if (detail) flags[id] = [{ code: 'misread', kind: 'flag', detail }];
  }
  await pages.setReasons(cwd, 'pixels', flags);
  return Object.keys(flags).length;
}

/** The lab command: a selection's pages, or every captured page when none is named. */
export async function pixels(cwd, selectionName, options = {}) {
  const { selections, trees } = await data(cwd);
  let ids;
  if (selectionName) {
    const sel = await selections.read(cwd, selectionName);
    if (!sel) throw new Error(`no selection ${selectionName}`);
    ids = sel.pages;
  } else {
    ids = await trees.list(cwd);
  }
  const sharp = sharpOf(cwd);
  const out = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const check = await checkPage(cwd, id, { ...options, sharp });
    if (check) out.push({ id, flags: check.flags, unclaimedRows: check.unclaimedRows,
      mismatched: check.bands.filter((b) => b.background && !b.background.agree).map((b) => b.id),
      unpainted: check.bands.filter((b) => b.unpainted).map((b) => b.id) });
  }
  await setMisread(cwd);
  return out;
}

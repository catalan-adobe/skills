// bands: the body cut into bands by two readers that owe each other nothing — the visual
// tree and the pixels — their cuts drawn side by side on the body crop so a person sees
// where they agree and where they do not. A lab command for now; what it writes is one
// method's proposal, not the migration's reading.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { bandsFromImage } from './bands-pixels.mjs';
import { bandsFromTree } from './bands-tree.mjs';
import { sharpOf } from './browser.mjs';
import { bodyEdges } from './crops.mjs';
import { data } from './data.mjs';

export const AGREE_PX = 24;
export const SHEET_WIDTH = 640;

/** How two sets of cuts agree: matched within `tolerance`, as a share of each. */
export function agreement(a, b, tolerance = AGREE_PX) {
  const matched = (xs, ys) => xs.filter((x) => ys.some((y) => Math.abs(x - y) <= tolerance));
  const inner = (xs) => xs.slice(1, -1);
  const ai = inner(a);
  const bi = inner(b);
  return {
    treeCuts: ai.length, pixelCuts: bi.length,
    treeMatched: matched(ai, bi).length, pixelMatched: matched(bi, ai).length,
    share: ai.length + bi.length
      ? (matched(ai, bi).length + matched(bi, ai).length) / (ai.length + bi.length) : 1,
  };
}

/** An SVG of the cuts over a body of `width` × `height`: tree on the left, pixels right. */
export function overlay(width, height, treeCuts, pixelCuts, bands) {
  const line = (y, x1, x2, colour) => (
    `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${colour}" stroke-width="3"/>`);
  const label = (y, x, text, colour) => (
    `<text x="${x}" y="${Math.max(12, y - 4)}" font-size="12" font-family="sans-serif"`
    + ` fill="${colour}" stroke="#fff" stroke-width="3" paint-order="stroke">${text}</text>`);
  const parts = [];
  for (const y of treeCuts) parts.push(line(y, 0, width * 0.5, '#d00'));
  for (const y of pixelCuts) parts.push(line(y, width * 0.5, width, '#06c'));
  for (const [i, b] of bands.entries()) {
    const words = `${i + 1} ${b.structure}${b.extent === 'full' ? ' · full' : ''}`;
    parts.push(label(b.top + 16, 6, words, '#d00'));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `${parts.join('')}</svg>`;
}

/**
 * Both readers on every page of a selection: the proposal under the page
 * (`bands.json`), the picture (`shots/bands.jpg`). Returns a summary per page.
 */
export async function bands(cwd, selectionName) {
  const { selections, pages, trees, website, composition, bands: bandsLayer } = await data(cwd);
  const sel = await selections.read(cwd, selectionName);
  if (!sel) throw new Error(`no selection ${selectionName}`);
  const sharp = sharpOf(cwd);
  const table = await pages.read(cwd);
  const byId = new Map(table.pages.map((p) => [p.id, p]));
  const fragments = (await website.readFragments(cwd))?.fragments ?? [];
  const out = [];
  for (const id of sel.pages) {
    const page = byId.get(id);
    const tree = await trees.read(cwd, id);
    const comp = await composition.read(cwd, id);
    if (!page || !tree?.page?.shot || !comp) continue;
    const body = bodyEdges(comp, fragments, tree.page.scrollHeight);
    const fromTree = bandsFromTree(tree.tree, body, { rootBackground: tree.rootBackground });
    const bodyFile = path.join(cwd, 'migration', trees.bodyFile(id));
    const fromPixels = await bandsFromImage(sharp, bodyFile);
    // Pixel cuts are in body coordinates; the tree's in page coordinates.
    const pixelCuts = fromPixels.cuts.map((y) => y + body.top);
    const agree = agreement(fromTree.cuts, pixelCuts);
    const proposal = {
      page: id, body, tree: fromTree,
      pixels: { ...fromPixels, cuts: pixelCuts,
        bands: fromPixels.bands.map((b) => (
          { ...b, top: b.top + body.top, bottom: b.bottom + body.top })) },
      agreement: agree,
    };
    const dir = path.join(cwd, 'migration', 'pages', id);
    await bandsLayer.writeProposal(cwd, id, proposal);
    const scale = SHEET_WIDTH / fromPixels.width;
    const h = Math.round(fromPixels.height * scale);
    const toSheet = (y) => Math.round((y - body.top) * scale);
    const svg = overlay(SHEET_WIDTH, h, fromTree.cuts.map(toSheet),
      fromPixels.cuts.map((y) => Math.round(y * scale)),
      fromTree.bands.map((b) => ({ ...b, top: Math.round((b.top - body.top) * scale) })));
    await mkdir(path.join(dir, 'shots'), { recursive: true });
    await sharp(bodyFile).resize({ width: SHEET_WIDTH })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 80 }).toFile(path.join(dir, 'shots', 'bands.jpg'));
    out.push({ id, url: page.url, treeBands: fromTree.bands.length,
      pixelBands: fromPixels.bands.length, agreement: Math.round(agree.share * 100) / 100,
      sideColumns: fromTree.sideColumns.map((s) => s.side) });
  }
  return out;
}

// The page without its chrome: the screenshot cut from the header's bottom to the footer's
// top, by the fragments located on that very page — what level 2 looks at. A thumbnail
// beside it for the report's contact sheet.
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PARTS } from './chrome-parts.mjs';

/**
 * The body's edges on a page from its located template fragments: the lowest bottom of a
 * header, the highest top of a footer; the page's edges where a part is absent.
 */
export function bodyEdges(composition, fragments, scrollHeight) {
  const partOf = new Map(fragments.map((f) => [f.id, f.part]));
  let top = 0;
  let bottom = scrollHeight;
  for (const placed of composition.fragments) {
    const part = partOf.get(placed.ref);
    if (!placed.bounds || !PARTS.includes(part)) continue;
    const { y, height } = placed.bounds;
    if (part === 'header') top = Math.max(top, y + height);
    if (part === 'footer') bottom = Math.min(bottom, y);
  }
  return { top: Math.round(top), bottom: Math.round(bottom) };
}

/**
 * Writes `shots/body.jpg` and `shots/body-thumb.jpg` for one page from its screenshot;
 * nothing when the page has no screenshot or no body (edges meet). Returns the edges.
 */
export async function cropBody(cwd, pageId, edges, { sharp, trees }) {
  const shot = path.join(cwd, 'migration', trees.shotFile(pageId));
  if (!(await access(shot).then(() => true, () => false))) return null;
  const meta = await sharp(shot).metadata();
  const top = Math.min(Math.max(0, edges.top), meta.height);
  const bottom = Math.min(Math.max(top, edges.bottom), meta.height);
  if (bottom - top < 2) return { ...edges, height: 0 };
  const region = { left: 0, top, width: meta.width, height: bottom - top };
  const body = path.join(cwd, 'migration', trees.bodyFile(pageId));
  await mkdir(path.dirname(body), { recursive: true });
  await sharp(shot).extract(region).jpeg({ quality: 80 }).toFile(body);
  await sharp(shot).extract(region).resize({ width: trees.BODY_THUMB_WIDTH })
    .jpeg({ quality: 70 }).toFile(path.join(cwd, 'migration', trees.bodyThumbFile(pageId)));
  return { top, bottom, height: bottom - top };
}

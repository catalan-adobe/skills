// The visual tree of a page: what the page-tree bundle measured on the rendered page, at
// a minimum element width — a method's artefact under the page, read by chrome and by the
// visual-tree decomposition — with the facts of the same rendering: the page's scroll
// height and its full-page screenshot when one could be taken. Big; the head of the file
// says the width it was taken at.
import { open as openFile } from 'node:fs/promises';
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';

export const SCHEMA = 'pages/visual-tree@1';
export const file = (pageId) => `pages/${pageId}/visual-tree.json`;

register('pages/visual-tree', 1, 'derived', {
  type: 'object',
  required: ['schema', 'minWidth', 'url', 'capturedAt', 'page', 'tree', 'nodeMap'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    minWidth: { type: 'integer', minimum: 0 },
    version: { type: 'integer', minimum: 1 },
    url: { type: 'string' },
    capturedAt: { type: 'string', format: 'date-time' },
    tree: { type: 'object' },
    text: { type: 'string' },
    nodeMap: { type: 'object' },
    rootBackground: { type: ['object', 'string', 'null'] },
    page: {
      type: ['object', 'null'],
      required: ['scrollHeight', 'shot'],
      additionalProperties: false,
      properties: {
        scrollHeight: { type: 'integer', minimum: 0 },
        shot: { type: ['string', 'null'] },
        timings: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      },
    },
  },
});

/** Above this, Chrome's full-page screenshot repeats the top and loses the bottom. */
export const SCREENSHOT_LIMIT = 16384;
export const shotFile = (pageId) => `pages/${pageId}/shots/page.jpg`;
/** The page without its chrome: the screenshot from the header's bottom to the footer's top. */
export const bodyFile = (pageId) => `pages/${pageId}/shots/body.jpg`;
export const bodyThumbFile = (pageId) => `pages/${pageId}/shots/body-thumb.jpg`;
export const BODY_THUMB_WIDTH = 320;

/** Stores a page's tree; `minWidth` first so the head of the file carries it. */
export function write(cwd, pageId, { minWidth, version = 1, url, capturedAt, tree, text,
  nodeMap, rootBackground = null, page = null }) {
  return openStore(cwd).write(file(pageId), {
    schema: SCHEMA, minWidth, version, url, capturedAt, page, tree, text, nodeMap,
    rootBackground,
  });
}

export const read = (cwd, pageId) => openStore(cwd).read(file(pageId), SCHEMA);

/**
 * What a stored tree says about itself, from the head of the file: the width it was taken
 * at, the capture method's version, when, and whether the page facts (height, screenshot)
 * are there — a tree taken before they were recorded is to be captured again. Null
 * without a tree.
 */
export async function head(cwd, pageId) {
  const fh = await openFile(openStore(cwd).path(file(pageId))).catch(() => null);
  if (!fh) return null;
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(512), 0, 512, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    const width = text.match(/"minWidth":\s*(\d+)/);
    const version = text.match(/"version":\s*(\d+)/);
    const at = text.match(/"capturedAt":\s*"([^"]+)"/);
    return {
      minWidth: width ? Number(width[1]) : 0,
      version: version ? Number(version[1]) : 1,
      capturedAt: at ? at[1] : null,
      facts: text.includes('"page"') && !text.includes('"page": null'),
    };
  } finally {
    await fh.close();
  }
}

/** The ids of the pages that have a tree. */
export async function list(cwd) {
  const store = openStore(cwd);
  const dirs = (await store.list('pages')).filter((d) => d.startsWith('pag-'));
  const has = await Promise.all(dirs.map((d) => store.exists(file(d))));
  return dirs.filter((_, i) => has[i]);
}

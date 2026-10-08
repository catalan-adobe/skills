// The visual tree of a page: what the page-tree bundle measured on the rendered page, at
// a minimum element width — a method's artefact under the page, read by chrome and by the
// visual-tree decomposition. Big; the head of the file says the width it was taken at.
import { open as openFile } from 'node:fs/promises';
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';

export const SCHEMA = 'pages/visual-tree@1';
export const file = (pageId) => `pages/${pageId}/visual-tree.json`;

register('pages/visual-tree', 1, 'derived', {
  type: 'object',
  required: ['schema', 'minWidth', 'url', 'capturedAt', 'tree', 'nodeMap'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    minWidth: { type: 'integer', minimum: 0 },
    url: { type: 'string' },
    capturedAt: { type: 'string', format: 'date-time' },
    tree: { type: 'object' },
    text: { type: 'string' },
    nodeMap: { type: 'object' },
    rootBackground: { type: ['object', 'string', 'null'] },
  },
});

/** Stores a page's tree; `minWidth` first so the head of the file carries it. */
export function write(cwd, pageId, { minWidth, url, capturedAt, tree, text, nodeMap,
  rootBackground = null }) {
  return openStore(cwd).write(file(pageId), {
    schema: SCHEMA, minWidth, url, capturedAt, tree, text, nodeMap, rootBackground,
  });
}

export const read = (cwd, pageId) => openStore(cwd).read(file(pageId), SCHEMA);

/** The width a stored tree was taken at, from the head of the file; null without a tree. */
export async function minWidth(cwd, pageId) {
  const fh = await openFile(openStore(cwd).path(file(pageId))).catch(() => null);
  if (!fh) return null;
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(128), 0, 128, 0);
    const m = buffer.toString('utf8', 0, bytesRead).match(/"minWidth":\s*(\d+)/);
    return m ? Number(m[1]) : 0;
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

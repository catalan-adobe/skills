// report: the migration on one page for people — views/report.md and views/report.html,
// rendered by the layer from the data and the notes. Done while nothing it was rendered
// from changed since; stale again as soon as a step writes.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { data } from './data.mjs';

const mtime = async (file) => stat(file).then((s) => s.mtimeMs, () => null);

/**
 * The newest change among the files and directories a view was rendered from — except
 * state.json, derived from the rest and rewritten by every command.
 */
async function newestSource(cwd, from) {
  const { store } = await data(cwd);
  const root = store.openStore(cwd).root;
  let newest = 0;
  for (const rel of from.filter((f) => f !== 'state.json')) {
    const abs = path.join(root, rel);
    // eslint-disable-next-line no-await-in-loop
    const own = await mtime(abs);
    if (own === null) continue;
    newest = Math.max(newest, own);
    // eslint-disable-next-line no-await-in-loop
    const inside = await store.openStore(cwd).list(rel);
    // eslint-disable-next-line no-await-in-loop
    const times = await Promise.all(inside.map((f) => mtime(path.join(abs, f))));
    newest = Math.max(newest, ...times.filter((t) => t !== null));
  }
  return newest;
}

/** Renders both views; returns their index entries. */
export async function render(cwd) {
  const { views } = await data(cwd);
  const md = await views.writeReport(cwd);
  const html = await views.writeReport(cwd, { html: true });
  return { md, html };
}

/** Done when both views exist and are newer than everything they were rendered from. */
export async function check(cwd) {
  const { store, views } = await data(cwd);
  const s = store.openStore(cwd);
  const index = await s.read(views.INDEX, views.SCHEMA);
  const entries = ['views/report.md', 'views/report.html']
    .map((file) => index?.views.find((v) => v.file === file));
  if (entries.some((e) => !e)) return { pass: false, note: 'no report rendered yet' };
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    const rendered = await mtime(s.path(entry.file));
    // eslint-disable-next-line no-await-in-loop
    if ((await newestSource(cwd, entry.from)) > rendered) {
      return { pass: false, note: 'the data changed since the report was rendered' };
    }
  }
  return { pass: true };
}

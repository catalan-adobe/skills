// Views: documents rendered for people from the data and the notes, regenerated, never
// edited. views/views.json indexes them (which file, rendered from what, when) so a client
// knows a view exists and that it is disposable.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { read as readInventory } from './inventory.mjs';
import { open as openMigration } from './migration.mjs';
import { index as notesIndex } from './notes.mjs';
import { read as readTable } from './pages.mjs';
import { HEAD, register } from './schema.mjs';
import { compute as computeState } from './state.mjs';
import { openStore } from './store.mjs';
import { readFragments, readWebsite } from './website.mjs';

export const INDEX = 'views/views.json';
export const SCHEMA = 'views/views@1';

register('views/views', 1, 'derived', {
  type: 'object',
  required: ['schema', 'views'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    views: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'from', 'at'],
        additionalProperties: false,
        properties: {
          file: { type: 'string', pattern: '^views/[a-z-]+\\.md$' },
          from: { type: 'array', items: { type: 'string' } },
          at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
});

const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (headers, rows) => [row(headers), row(headers.map(() => '---')), ...rows.map(row)];

/**
 * The report: the migration in words — state and summary, the website, the pages, the
 * shared documents, the inventory, then every note in order. Rendered from the data;
 * what is absent is said to be absent.
 */
export async function renderReport(cwd, { checks = {}, now = new Date() } = {}) {
  const migration = await openMigration(cwd);
  const state = await computeState(cwd, checks, { now });
  const site = await readWebsite(cwd);
  const pages = await readTable(cwd);
  const fragments = await readFragments(cwd);
  const inventory = await readInventory(cwd);
  const notes = (await notesIndex(cwd)).notes;
  const out = [`# Migration report — ${migration.source.scope}`, '', state.summary, ''];
  out.push('## State', '', ...table(['step', 'state', 'note'], state.steps.map((s) => [
    s.id, s.state + (s.progress ? ` (${s.progress})` : ''),
    [s.blockedBy.length ? `blocked by ${s.blockedBy.join(', ')}` : null, s.note]
      .filter(Boolean).join('; ') || '',
  ])), '');
  out.push('## Website', '', site?.summary ?? 'No website summary yet (no pages discovered).', '');
  if (site?.groups.length) {
    out.push(...table(['group', 'urls', 'in', 'cached', 'composed'],
      site.groups.slice(0, 25).map((g) => (
        [g.name || '(root)', g.urls, g.in, g.cached, g.composed]))), '');
  }
  out.push('## Pages', '', pages.summary, '');
  out.push('## Shared documents', '', fragments?.summary ?? 'None found yet.', '');
  if (fragments?.fragments.length) {
    out.push(...table(['fragment', 'placement', 'part / name', 'pages'], fragments.fragments
      .map((f) => [f.label ?? f.id, f.placement, f.part ?? f.name, f.pages])), '');
  }
  out.push('## Inventory', '', inventory?.summary ?? 'No inventory yet.', '');
  if (inventory?.blocks.length) {
    out.push(...table(['block', 'types', 'instances', 'pages'],
      inventory.blocks.map((b) => [b.block, b.types.length, b.instances, b.pages])), '');
  }
  out.push('## Notes', '');
  out.push(...(notes.length ? notes.map((n) => (
    `- ${n.at.slice(0, 16).replace('T', ' ')} · ${n.step} · ${n.author}: ${n.summary} (${n.file})`))
    : ['None yet.']), '');
  return out.join('\n');
}

/** Renders a view to `views/<name>.md` and indexes it with what it was rendered from. */
export async function write(cwd, name, text, from) {
  const store = openStore(cwd);
  const file = `views/${name}.md`;
  await mkdir(path.dirname(store.path(file)), { recursive: true });
  await writeFile(store.path(file), text.endsWith('\n') ? text : `${text}\n`);
  const current = (await store.read(INDEX, SCHEMA)) ?? { schema: SCHEMA, views: [] };
  const entry = { file, from, at: store.now().toISOString() };
  const views = [...current.views.filter((v) => v.file !== file), entry];
  await store.write(INDEX, { schema: SCHEMA, views });
  return entry;
}

/** Renders and writes the report view. */
export async function writeReport(cwd, options = {}) {
  const text = await renderReport(cwd, options);
  return write(cwd, 'report', text, ['state.json', 'website/website.json', 'pages/pages.json',
    'website/fragments.json', 'elements/inventory.json', 'notes/notes.json']);
}

// Notes: every piece of prose — what an agent decided and why, what the operator said,
// what a step reports in words. The index is JSON; a note's body is a Markdown file
// referenced from it; the report is rendered from the notes and the data, never edited.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HEAD, register } from './schema.mjs';
import { id as makeId, openStore } from './store.mjs';

export const FILE = 'notes/notes.json';
export const SCHEMA = 'notes/notes@1';
export const AUTHORS = ['agent', 'operator', 'runner'];

register('notes/notes', 1, 'history', {
  type: 'object',
  required: ['schema', 'notes'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    notes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'step', 'author', 'at', 'file', 'summary'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^not-[0-9a-f]{12}$' },
          step: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
          author: { enum: AUTHORS },
          at: { type: 'string', format: 'date-time' },
          file: { type: 'string', pattern: '^notes/not-[0-9a-f]{12}\\.md$' },
          summary: { type: 'string' },
          page: { type: 'string', pattern: '^pag-[0-9a-f]{12}$' },
        },
      },
    },
  },
});

/** The index, or an empty one. */
export async function index(cwd) {
  return (await openStore(cwd).read(FILE, SCHEMA)) ?? { schema: SCHEMA, notes: [] };
}

/**
 * Adds a note: its body goes to `notes/<id>.md`, its entry to the index. `summary` is the
 * first line of the body unless given; `page` ties a note to one page.
 */
export async function add(cwd, { step, author, body, summary, page }) {
  if (!body?.trim()) throw new Error('a note needs a body');
  const store = openStore(cwd);
  const now = store.now();
  const id = makeId('not', `${step}|${author}|${now.toISOString()}|${body}`);
  const file = `notes/${id}.md`;
  await mkdir(path.dirname(store.path(file)), { recursive: true });
  await writeFile(store.path(file), body.endsWith('\n') ? body : `${body}\n`);
  const entry = {
    id, step, author, at: now.toISOString(), file,
    summary: summary ?? body.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 120),
    ...(page ? { page } : {}),
  };
  const current = await index(cwd);
  await store.write(FILE, { schema: SCHEMA, notes: [...current.notes, entry] });
  return entry;
}

/** Notes, oldest first; optionally one step's, one author's, one page's. */
export async function list(cwd, { step, author, page } = {}) {
  return (await index(cwd)).notes.filter((n) => (
    (step === undefined || n.step === step)
    && (author === undefined || n.author === author)
    && (page === undefined || n.page === page)));
}

/** A note's body. */
export async function body(cwd, id) {
  const entry = (await index(cwd)).notes.find((n) => n.id === id);
  if (!entry) throw new Error(`no note ${id}`);
  return readFile(openStore(cwd).path(entry.file), 'utf8');
}

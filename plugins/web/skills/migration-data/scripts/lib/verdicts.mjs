// A person's word on what a page is, for the bench: the ground truth a method is measured
// against. Per page, six things a reader says in half a minute from the body crop — the
// same template as an earlier page or a new one, how much of it a plain document can
// express, the layout, the constructs seen, a band count, a note. A decision; never
// derived; kept apart from any method's reading so the comparison stays honest.
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';

export const FILE = 'pages/verdicts.json';
export const SCHEMA = 'pages/verdicts@1';
export const CATEGORIES = ['document', 'bands', 'composed'];
export const LAYOUTS = ['single', 'main-left', 'main-right', 'both'];
export const CONSTRUCTS = ['hero', 'cards', 'columns', 'accordion-tabs', 'carousel', 'form',
  'table', 'embed', 'cta-band', 'gallery', 'metadata-box', 'toc'];
// A page a person could not judge as a page: the picture is wrong, or it is not of the
// site's kind. With a problem set, the other fields may stay empty.
export const PROBLEMS = ['capture-fault', 'odd'];

const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });

register('pages/verdicts', 1, 'decision', {
  type: 'object',
  required: ['schema', 'verdicts'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['page', 'by', 'at', 'constructs'],
        additionalProperties: false,
        properties: {
          page: idPattern('pag'),
          by: { type: 'string' },
          at: { type: 'string', format: 'date-time' },
          problem: { enum: PROBLEMS },
          sameAs: { type: ['string', 'null'], pattern: '^pag-[0-9a-f]{12}$' },
          category: { enum: CATEGORIES },
          layout: { enum: LAYOUTS },
          constructs: { type: 'array', items: { enum: CONSTRUCTS } },
          bands: { type: 'integer', minimum: 0 },
          note: { type: 'string' },
        },
      },
    },
  },
});

export const read = (cwd) => openStore(cwd).read(FILE, SCHEMA);

const summarise = (verdicts) => {
  const by = (k) => CATEGORIES.map((c) => `${verdicts.filter((v) => v[k] === c).length} ${c}`)
    .join(', ');
  const judged = verdicts.filter((v) => !v.problem);
  const templates = judged.filter((v) => !v.sameAs).length;
  const problems = verdicts.length - judged.length;
  return `${verdicts.length} page(s): ${by('category')}; ${templates} template(s)`
    + (problems ? `; ${problems} with a problem` : '');
};

/**
 * Records verdicts, one per page (a later one for the same page replaces the earlier):
 * `entries` are `{ page, sameAs?, category, layout, constructs?, bands?, note? }`, `by`
 * names who judged. Validation is the schema's; the words are the closed lists above.
 */
export async function upsert(cwd, entries, { by }) {
  if (!by) throw new Error('verdicts name who judged (by)');
  const store = openStore(cwd);
  const current = (await read(cwd)) ?? { schema: SCHEMA, verdicts: [] };
  const at = store.now().toISOString();
  const byPage = new Map(current.verdicts.map((v) => [v.page, v]));
  for (const e of entries) {
    if (!e.problem && !(e.category && e.layout)) {
      throw new Error(`${e.page}: a verdict says category and layout, or names a problem`);
    }
    const v = { page: e.page, by, at, sameAs: e.sameAs ?? null,
      constructs: [...new Set(e.constructs ?? [])] };
    if (e.problem) v.problem = e.problem;
    if (e.category) v.category = e.category;
    if (e.layout) v.layout = e.layout;
    if (Number.isInteger(e.bands)) v.bands = e.bands;
    if (e.note) v.note = e.note;
    byPage.set(e.page, v);
  }
  const verdicts = [...byPage.values()];
  return store.write(FILE, { schema: SCHEMA, verdicts, summary: summarise(verdicts) });
}

/** Imports what the annotation sheet exported: `{ by, verdicts: [...] }`. */
export async function importFile(cwd, data) {
  if (!Array.isArray(data?.verdicts)) throw new Error('an export has a verdicts array');
  return upsert(cwd, data.verdicts, { by: data.by });
}
